import assert from "node:assert/strict";
import test from "node:test";

import {
  activeLimitBlockStatement,
  concurrencySlotStatement,
  enforceAcceptedInputSubmissionLimits,
  enforceAccountRequestLimits,
  enforceHumanFileUploadLimits,
  incrementQuotaWindowStatement,
  quotaWindow
} from "../src/server/caller-api-limits.ts";
import { fakeQuery } from "./helpers/fake-query.mjs";

const identity = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002"
};

test("caller request limits short-circuit active blocks without incrementing quota windows", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        operation_kind: "output_check_read",
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "output_check_read_rate_limited",
        limit_reason:
          "Output check/read requests are temporarily rate limited.",
        limit_resets_at: "2026-06-30T12:01:00.000Z",
        used_units: "121",
        limit_units: "120"
      }
    ]
  ]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "output_check_read"
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.error.limit, {
    account_id: identity.accountId,
    operation_kind: "output_check_read",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_reason: "Output check/read requests are temporarily rate limited.",
    limit_resets_at: "2026-06-30T12:01:00.000Z",
    used_units: 121,
    limit_units: 120
  });
  assert.equal(query.calls.length, 1);
});

test("caller request limits lock and persist an active block when a quota window overflows", async () => {
  const query = fakeQuery([[], [], [{ used_units: "100001" }], []]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "status"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "quota_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "authenticated_caller_api_requests_per_calendar_month"
  );
  assert.match(query.calls[1].sql, /for update/);
  assert.match(query.calls[3].sql, /agent_outbox_account_limit_blocks/);
});

test("caller request limits do not debit an earlier window when a later window overflows", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-06-30T12:34:56.789Z")
  });
  const query = fakeQuery([
    [],
    [],
    [{ used_units: "50" }],
    [{ used_units: "120" }],
    []
  ]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "output_check_read"
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "rate_limit_exceeded",
      message: "Output check/read requests are temporarily rate limited.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "output_check_read",
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "output_check_read_rate_limited",
        limit_reason:
          "Output check/read requests are temporarily rate limited.",
        limit_resets_at: "2026-06-30T12:35:00.000Z",
        used_units: 121,
        limit_units: 120
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 5);
  assert.match(query.calls[1].sql, /for update/);
  assert.match(query.calls[2].sql, /select used_units/);
  assert.match(query.calls[3].sql, /select used_units/);
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_account_quota_windows")
    ),
    false
  );
  assert.match(query.calls[4].sql, /agent_outbox_account_limit_blocks/);
});

test("send/replace request limits co-apply monthly and minute windows without partial debit", async () => {
  const query = fakeQuery([
    [],
    [],
    [{ used_units: "25" }],
    [{ used_units: "600" }],
    []
  ]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "input_send_replace"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "input_send_replace_requests_per_account_per_minute"
  );
  assert.match(query.calls[1].sql, /for update/);
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_account_quota_windows")
    ),
    false
  );
  assert.deepEqual(query.calls[4].values?.slice(1, 4), [
    "input_send_replace",
    "input_send_replace_requests_per_account_per_minute",
    "input_send_replace_rate_limited"
  ]);
});

test("output file download request limits co-apply monthly and minute windows without partial debit", async () => {
  const query = fakeQuery([
    [],
    [],
    [{ used_units: "25" }],
    [{ used_units: "60" }],
    []
  ]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "output_file_download"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "output_file_download_requests_per_account_per_minute"
  );
  assert.match(query.calls[1].sql, /for update/);
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_account_quota_windows")
    ),
    false
  );
});

test("paid and self-hosted profiles enforce send/replace minute limits while monthly quota is disabled", async () => {
  for (const profile of ["hosted-paid", "self-hosted"]) {
    const query = fakeQuery([[], [{ used_units: "601" }], []]);

    const result = await enforceAccountRequestLimits(
      query,
      identity,
      /** @type {import("../src/server/limits.ts").LimitProfileSelector} */ (
        profile
      ),
      "input_send_replace"
    );

    assert.equal(result.ok, false, profile);
    assert.equal(result.error.code, "rate_limit_exceeded", profile);
    assert.equal(
      result.error.limit && "limit_name" in result.error.limit
        ? result.error.limit.limit_name
        : null,
      "input_send_replace_requests_per_account_per_minute",
      profile
    );
    assert.equal(
      query.calls.some((call) => call.sql.includes("for update")),
      false,
      profile
    );
    assert.equal(
      query.calls.some(
        (call) =>
          call.sql.includes("agent_outbox_account_quota_windows") &&
          call.values?.includes(
            "authenticated_caller_api_requests_per_calendar_month"
          )
      ),
      false,
      profile
    );
  }
});

test("input delete request limits enforce the minute throttle without monthly quota", async () => {
  const query = fakeQuery([[], [{ used_units: "601" }], []]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "input_delete"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "input_delete_requests_per_account_per_minute"
  );
  assert.deepEqual(activeLimitBlockStatement(identity, "input_delete").values, [
    identity.accountId,
    "input_delete",
    false,
    "authenticated_caller_api_requests_per_calendar_month"
  ]);
  assert.equal(
    query.calls.some(
      (call) =>
        call.sql.includes("agent_outbox_account_quota_windows") &&
        call.values?.includes(
          "authenticated_caller_api_requests_per_calendar_month"
        )
    ),
    false
  );
});

test("paid output file downloads enforce the minute throttle with monthly quota disabled", async () => {
  const query = fakeQuery([[], [{ used_units: "61" }], []]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-paid",
    "output_file_download"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "output_file_download_requests_per_account_per_minute"
  );
  assert.equal(
    query.calls.some(
      (call) =>
        call.sql.includes("agent_outbox_account_quota_windows") &&
        call.values?.includes(
          "authenticated_caller_api_requests_per_calendar_month"
        )
    ),
    false
  );
});

test("send/replace monthly quota uses the existing shared caller API request metric", async () => {
  const query = fakeQuery([[], [], [{ used_units: "100000" }], []]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "input_send_replace"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "quota_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "authenticated_caller_api_requests_per_calendar_month"
  );
  assert.equal(
    query.calls[2].values?.[1],
    "authenticated_caller_api_requests_per_calendar_month"
  );
  assert.deepEqual(
    activeLimitBlockStatement(identity, "input_send_replace").values,
    [
      identity.accountId,
      "input_send_replace",
      true,
      "authenticated_caller_api_requests_per_calendar_month"
    ]
  );
});

test("legacy generic monthly active blocks still block send/replace requests", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        operation_kind: "caller_api_request",
        limit_name: "authenticated_caller_api_requests_per_calendar_month",
        limit_reason_code: "monthly_caller_api_quota_exceeded",
        limit_reason: "Legacy monthly caller API block.",
        limit_resets_at: "2026-07-01T00:00:00.000Z",
        used_units: "100001",
        limit_units: "100000"
      }
    ]
  ]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "input_send_replace"
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "quota_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "authenticated_caller_api_requests_per_calendar_month"
  );
  assert.equal(query.calls.length, 1);
});

test("caller request limits ignore disabled-profile blocks but still enforce enabled blocks", async () => {
  const monthlyBlock = {
    account_id: identity.accountId,
    operation_kind: "caller_api_request",
    limit_name: "authenticated_caller_api_requests_per_calendar_month",
    limit_reason_code: "monthly_caller_api_quota_exceeded",
    limit_reason: "Monthly caller API request limit reached.",
    limit_resets_at: "2026-07-01T00:00:00.000Z",
    used_units: "100001",
    limit_units: "100000"
  };
  const minuteBlock = {
    account_id: identity.accountId,
    operation_kind: "output_check_read",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "legacy_rate_limit_code",
    limit_reason: "Legacy persisted rate limit reason.",
    limit_resets_at: "2026-06-30T12:01:00.000Z",
    used_units: "121",
    limit_units: "999"
  };
  const paidStatusQuery = fakeQuery([[monthlyBlock]]);
  const paidOutputQuery = fakeQuery([[monthlyBlock, minuteBlock]]);

  const paidStatus = await enforceAccountRequestLimits(
    paidStatusQuery,
    identity,
    "hosted-paid",
    "status"
  );
  const paidOutput = await enforceAccountRequestLimits(
    paidOutputQuery,
    identity,
    "hosted-paid",
    "output_check_read"
  );

  assert.equal(paidStatus.ok, true);
  assert.equal(paidOutput.ok, false);
  if (paidOutput.ok) {
    assert.fail("expected output check/read to remain rate limited");
  }
  const outputLimit = paidOutput.error.limit;
  assert.ok(outputLimit && "limit_units" in outputLimit);
  assert.equal(
    outputLimit.limit_name,
    "output_check_read_requests_per_account_per_minute"
  );
  assert.equal(
    paidOutput.error.message,
    "Output check/read requests are temporarily rate limited."
  );
  assert.equal(outputLimit.limit_reason_code, "output_check_read_rate_limited");
  assert.equal(
    outputLimit.limit_reason,
    "Output check/read requests are temporarily rate limited."
  );
  assert.equal(outputLimit.limit_units, 120);
  assert.doesNotMatch(
    activeLimitBlockStatement(identity, "output_check_read").sql,
    /limit\s+1/i
  );
});

test("caller request limits ignore stale enabled blocks that no longer exceed the current limit", async () => {
  const staleBlock = {
    account_id: identity.accountId,
    operation_kind: "status",
    limit_name: "authenticated_caller_api_requests_per_calendar_month",
    limit_reason_code: "monthly_caller_api_quota_exceeded",
    limit_reason: "Monthly caller API request limit reached.",
    limit_resets_at: "2026-07-01T00:00:00.000Z",
    used_units: "100000",
    limit_units: "100000"
  };
  const query = fakeQuery([[staleBlock], [], [{ used_units: "1" }]]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "status"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 3);
  assert.match(query.calls[1].sql, /for update/);
  assert.match(query.calls[2].sql, /agent_outbox_account_quota_windows/);
});

test("caller request limits ignore enabled blocks without usage evidence", async () => {
  const nullUsageBlock = {
    account_id: identity.accountId,
    operation_kind: "status",
    limit_name: "authenticated_caller_api_requests_per_calendar_month",
    limit_reason_code: "monthly_caller_api_quota_exceeded",
    limit_reason: "Monthly caller API request limit reached.",
    limit_resets_at: "2026-07-01T00:00:00.000Z",
    used_units: null,
    limit_units: "100000"
  };
  const query = fakeQuery([[nullUsageBlock], [], [{ used_units: "1" }]]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "status"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 3);
  assert.match(query.calls[1].sql, /for update/);
});

test("caller request limits ignore blocks whose limit no longer applies to the operation", async () => {
  const mismatchedBlock = {
    account_id: identity.accountId,
    operation_kind: "output_ack",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_reason: "Output check/read requests are temporarily rate limited.",
    limit_resets_at: "2026-06-30T12:01:00.000Z",
    used_units: "121",
    limit_units: "120"
  };
  const query = fakeQuery([[mismatchedBlock], [{ used_units: "1" }]]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "output_ack"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 2);
  assert.match(query.calls[1].sql, /agent_outbox_account_quota_windows/);
});

test("caller request limits ignore cleanup-free blocks that require live revalidation", async () => {
  const staleCleanupBlock = {
    account_id: identity.accountId,
    operation_kind: "output_ack",
    limit_name: "unacknowledged_output_timeout_days",
    limit_reason_code: "unacknowledged_output_timeout_expired",
    limit_reason: "Unacknowledged output reached the timeout window.",
    limit_resets_at: null,
    used_units: "15",
    limit_units: "14"
  };
  const query = fakeQuery([[staleCleanupBlock], [{ used_units: "1" }]]);

  const result = await enforceAccountRequestLimits(
    query,
    identity,
    "hosted-free",
    "output_ack"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 2);
  const [blockLookup, quotaIncrement] = query.calls;
  assert.match(blockLookup?.sql ?? "", /limit_resets_at > now\(\)/);
  assert.match(quotaIncrement?.sql, /agent_outbox_account_quota_windows/);
});

test("accepted input submission limits block stock overflow before incrementing submission windows", async () => {
  const query = fakeQuery([
    [],
    [{ acquired: true }],
    [],
    [],
    [],
    [],
    [
      {
        queued_input_items: "1000",
        non_file_stored_bytes: "0",
        overall_stored_bytes: "0"
      }
    ],
    []
  ]);

  const result = await enforceAcceptedInputSubmissionLimits(
    query,
    identity,
    "hosted-free",
    {
      queuedItemDelta: 1,
      nonFilePayloadByteDelta: 100
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "storage_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "queued_input_items"
  );
  assert.equal(
    query.calls.some(
      (call) =>
        call.sql.includes("agent_outbox_account_quota_windows") &&
        call.sql.includes("insert")
    ),
    false
  );
});

test("accepted input submission limits pre-check quota windows once before incrementing", async () => {
  const query = fakeQuery([
    [],
    [{ acquired: true }],
    [],
    [],
    [],
    [],
    [
      {
        queued_input_items: "0",
        non_file_stored_bytes: "0",
        overall_stored_bytes: "0"
      }
    ],
    [{ used_units: "1" }],
    [{ used_units: "1" }],
    [{ used_units: "1" }]
  ]);

  const result = await enforceAcceptedInputSubmissionLimits(
    query,
    identity,
    "hosted-free",
    {
      queuedItemDelta: 1,
      nonFilePayloadByteDelta: 100
    }
  );

  assert.deepEqual(result, { ok: true });
  const quotaUsageReads = query.calls.filter(
    (call) =>
      call.sql.includes("select used_units") &&
      call.sql.includes("agent_outbox_account_quota_windows")
  );
  const quotaIncrements = query.calls.filter((call) =>
    call.sql.includes("insert into public.agent_outbox_account_quota_windows")
  );
  assert.equal(quotaUsageReads.length, 3);
  assert.equal(quotaIncrements.length, 3);
});

test("hosted-free file uploads return the full upgrade error", async () => {
  const freeQuery = fakeQuery([[]]);
  const freeResult = await enforceHumanFileUploadLimits(
    freeQuery,
    identity,
    "hosted-free",
    1
  );

  assert.deepEqual(freeResult, {
    ok: false,
    error: {
      status: 402,
      code: "upgrade_required",
      message: "File uploads require a paid hosted account.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "file_upload",
        limit_name: "file_upload_enabled",
        limit_reason_code: "file_upload_upgrade_required",
        limit_reason: "File uploads require a paid hosted account.",
        limit_resets_at: null,
        used_units: 1,
        limit_units: null
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(freeQuery.calls.length, 1);
});

test("human file upload limits enforce concurrency and overall storage", async () => {
  const storageQuery = fakeQuery([
    [],
    [{ acquired: true }],
    [],
    [
      {
        queued_input_items: "0",
        non_file_stored_bytes: "0",
        overall_stored_bytes: "999999990"
      }
    ],
    []
  ]);
  const storageResult = await enforceHumanFileUploadLimits(
    storageQuery,
    identity,
    "hosted-paid",
    20
  );

  assert.equal(storageResult.ok, false);
  assert.equal(storageResult.error.code, "storage_limit_exceeded");
  assert.equal(
    storageResult.error.limit && "limit_name" in storageResult.error.limit
      ? storageResult.error.limit.limit_name
      : null,
    "overall_stored_account_data_bytes"
  );
  assert.equal(
    storageQuery.calls[1].values?.[2],
    "concurrent_file_uploading_requests_per_account"
  );
  assert.match(storageQuery.calls[2].sql, /for update/);
  assert.match(storageQuery.calls[4].sql, /agent_outbox_account_limit_blocks/);
});

test("hosted-paid file uploads return the full per-file overflow error", async () => {
  const query = fakeQuery([[]]);
  const result = await enforceHumanFileUploadLimits(
    query,
    identity,
    "hosted-paid",
    10 ** 12
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 413,
      code: "request_too_large",
      message: "Uploaded file exceeds the raw byte ceiling.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "file_upload",
        limit_name: "uploaded_bytes_per_file",
        limit_reason_code: "uploaded_file_too_large",
        limit_reason: "Uploaded file exceeds the raw byte ceiling.",
        limit_resets_at: null,
        used_units: 10 ** 12,
        limit_units: 32_000_000
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 1);
});

test("file uploads return the full error when no concurrency slot is available", async () => {
  const query = fakeQuery([[], []]);
  const result = await enforceHumanFileUploadLimits(
    query,
    identity,
    "hosted-paid",
    10
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "rate_limit_exceeded",
      message: "Too many concurrent file-upload requests are in progress.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "file_upload",
        limit_name: "concurrent_file_uploading_requests_per_account",
        limit_reason_code: "concurrent_file_upload_limit_exceeded",
        limit_reason:
          "Too many concurrent file-upload requests are in progress.",
        limit_resets_at: null,
        used_units: 6,
        limit_units: 5
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 2);
});

test("input submissions return the full error when no concurrency slot is available", async () => {
  const query = fakeQuery([[], []]);
  const result = await enforceAcceptedInputSubmissionLimits(
    query,
    identity,
    "hosted-free",
    { queuedItemDelta: 1, nonFilePayloadByteDelta: 1 }
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "rate_limit_exceeded",
      message: "Too many concurrent account write requests are in progress.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "input_submission",
        limit_name: "concurrent_write_requests_per_account",
        limit_reason_code: "concurrent_write_limit_exceeded",
        limit_reason:
          "Too many concurrent account write requests are in progress.",
        limit_resets_at: null,
        used_units: 21,
        limit_units: 20
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 2);
});

test("input submissions short-circuit active blocks with the full normalized error", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        operation_kind: "input_submission",
        limit_name: "input_submissions_per_day",
        limit_reason_code: "legacy_code",
        limit_reason: "Legacy persisted reason.",
        limit_resets_at: "2999-01-01T00:00:00.000Z",
        used_units: "1001",
        limit_units: "1"
      }
    ]
  ]);
  const result = await enforceAcceptedInputSubmissionLimits(
    query,
    identity,
    "hosted-free",
    { queuedItemDelta: 1, nonFilePayloadByteDelta: 1 }
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "quota_limit_exceeded",
      message:
        "Daily input submission limit reached; wait for the next UTC day or upgrade.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "input_submission",
        limit_name: "input_submissions_per_day",
        limit_reason_code: "daily_input_submission_quota_exceeded",
        limit_reason:
          "Daily input submission limit reached; wait for the next UTC day or upgrade.",
        limit_resets_at: "2999-01-01T00:00:00.000Z",
        used_units: 1001,
        limit_units: 1000
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 1);
});

test("input submission preflight persists a full window overflow error without debiting quota", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-06-30T12:34:56.789Z")
  });
  const query = fakeQuery([
    [],
    [{ acquired: true }],
    [],
    [{ used_units: "5000" }],
    []
  ]);
  const result = await enforceAcceptedInputSubmissionLimits(
    query,
    identity,
    "hosted-free",
    { queuedItemDelta: 1, nonFilePayloadByteDelta: 1 }
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "quota_limit_exceeded",
      message:
        "Monthly input submission limit reached; wait for the next UTC calendar month or upgrade.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "input_submission",
        limit_name: "input_submissions_per_calendar_month",
        limit_reason_code: "monthly_input_submission_quota_exceeded",
        limit_reason:
          "Monthly input submission limit reached; wait for the next UTC calendar month or upgrade.",
        limit_resets_at: "2026-07-01T00:00:00.000Z",
        used_units: 5001,
        limit_units: 5000
      },
      log: { callerId: identity.callerId }
    }
  });
  assert.equal(query.calls.length, 5);
  assert.match(
    query.calls[4].sql,
    /insert into public.agent_outbox_account_limit_blocks/
  );
  assert.deepEqual(query.calls[4].values, [
    identity.accountId,
    "input_submission",
    "input_submissions_per_calendar_month",
    "monthly_input_submission_quota_exceeded",
    "Monthly input submission limit reached; wait for the next UTC calendar month or upgrade.",
    "2026-07-01T00:00:00.000Z",
    5001,
    5000
  ]);
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_account_quota_windows")
    ),
    false
  );
});

test("account-only request identities return the full active-block error without caller logging", async () => {
  const query = fakeQuery([
    [
      {
        account_id: identity.accountId,
        operation_kind: "output_check_read",
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "legacy_code",
        limit_reason: "Legacy persisted reason.",
        limit_resets_at: "2999-01-01T00:00:00.000Z",
        used_units: "121",
        limit_units: "999"
      }
    ]
  ]);
  const result = await enforceAccountRequestLimits(
    query,
    { accountId: identity.accountId },
    "hosted-free",
    "output_check_read"
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 429,
      code: "rate_limit_exceeded",
      message: "Output check/read requests are temporarily rate limited.",
      limit: {
        account_id: identity.accountId,
        operation_kind: "output_check_read",
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "output_check_read_rate_limited",
        limit_reason:
          "Output check/read requests are temporarily rate limited.",
        limit_resets_at: "2999-01-01T00:00:00.000Z",
        used_units: 121,
        limit_units: 120
      },
      log: undefined
    }
  });
  assert.equal(query.calls.length, 1);
});

test("quota statement builders scope rows to account metric and window", () => {
  assert.deepEqual(
    activeLimitBlockStatement(identity, "output_file_download").values,
    [
      identity.accountId,
      "output_file_download",
      true,
      "authenticated_caller_api_requests_per_calendar_month"
    ]
  );
  assert.deepEqual(activeLimitBlockStatement(identity, "output_ack").values, [
    identity.accountId,
    "output_ack",
    false,
    "authenticated_caller_api_requests_per_calendar_month"
  ]);
  assert.deepEqual(
    activeLimitBlockStatement(identity, "input_submission").values,
    [
      identity.accountId,
      "input_submission",
      true,
      "authenticated_caller_api_requests_per_calendar_month"
    ]
  );
  assert.deepEqual(
    incrementQuotaWindowStatement({
      identity,
      limitName: "authenticated_caller_api_requests_per_calendar_month",
      windowKind: "calendar_month",
      windowStartUtc: "2026-06-01T00:00:00.000Z"
    }).values,
    [
      identity.accountId,
      "authenticated_caller_api_requests_per_calendar_month",
      "calendar_month",
      "2026-06-01T00:00:00.000Z"
    ]
  );
  const concurrency = concurrencySlotStatement({
    identity,
    limitName: "concurrent_write_requests_per_account",
    limitUnits: 20
  });
  assert.match(concurrency.sql, /md5\(\$1 \|\| ':' \|\| \$3/);
  assert.deepEqual(concurrency.values, [
    identity.accountId,
    20,
    "concurrent_write_requests_per_account"
  ]);
});

test("quota windows follow UTC minute, day, and calendar month boundaries", () => {
  /**
   * @param {"minute" | "day" | "calendar_month"} windowKind
   * @param {string} at
   */
  const windowAt = (windowKind, at) =>
    quotaWindow(
      /** @type {Parameters<typeof quotaWindow>[0]} */ ({ windowKind }),
      new Date(at)
    );

  assert.deepEqual(windowAt("minute", "2026-06-30T12:34:56.789Z"), {
    windowKind: "minute",
    windowStartUtc: "2026-06-30T12:34:00.000Z",
    windowEndUtc: "2026-06-30T12:35:00.000Z"
  });
  assert.deepEqual(windowAt("minute", "2026-12-31T23:59:59.999Z"), {
    windowKind: "minute",
    windowStartUtc: "2026-12-31T23:59:00.000Z",
    windowEndUtc: "2027-01-01T00:00:00.000Z"
  });
  assert.deepEqual(windowAt("day", "2026-06-30T23:59:59.999Z"), {
    windowKind: "day",
    windowStartUtc: "2026-06-30T00:00:00.000Z",
    windowEndUtc: "2026-07-01T00:00:00.000Z"
  });
  assert.deepEqual(windowAt("calendar_month", "2026-01-31T12:00:00.000Z"), {
    windowKind: "calendar_month",
    windowStartUtc: "2026-01-01T00:00:00.000Z",
    windowEndUtc: "2026-02-01T00:00:00.000Z"
  });
  assert.deepEqual(windowAt("calendar_month", "2028-02-29T23:59:59.999Z"), {
    windowKind: "calendar_month",
    windowStartUtc: "2028-02-01T00:00:00.000Z",
    windowEndUtc: "2028-03-01T00:00:00.000Z"
  });
  assert.deepEqual(windowAt("calendar_month", "2026-12-31T23:59:59.999Z"), {
    windowKind: "calendar_month",
    windowStartUtc: "2026-12-01T00:00:00.000Z",
    windowEndUtc: "2027-01-01T00:00:00.000Z"
  });
});
