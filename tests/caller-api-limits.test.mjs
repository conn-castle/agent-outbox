import assert from "node:assert/strict";
import test from "node:test";

import {
  activeLimitBlockStatement,
  concurrencySlotStatement,
  enforceAcceptedInputSubmissionLimits,
  enforceCallerRequestLimits,
  incrementQuotaWindowStatement
} from "../src/server/caller-api-limits.ts";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

const identity = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002"
};

/**
 * @param {QueryResultRow[][]} rowsByCall
 * @returns {MockProductTransactionQuery}
 */
function fakeQuery(rowsByCall) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);
    const rows = rowsByCall[calls.length - 1] ?? [];
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

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

  const result = await enforceCallerRequestLimits(
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

test("caller request limits persist an active block when a quota window overflows", async () => {
  const query = fakeQuery([[], [{ used_units: "100001" }], []]);

  const result = await enforceCallerRequestLimits(
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
  assert.match(query.calls[2].sql, /agent_outbox_account_limit_blocks/);
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

  const paidStatus = await enforceCallerRequestLimits(
    paidStatusQuery,
    identity,
    "hosted-paid",
    "status"
  );
  const paidOutput = await enforceCallerRequestLimits(
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
  const query = fakeQuery([[staleBlock], [{ used_units: "1" }]]);

  const result = await enforceCallerRequestLimits(
    query,
    identity,
    "hosted-free",
    "status"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 2);
  assert.match(query.calls[1].sql, /agent_outbox_account_quota_windows/);
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
  const query = fakeQuery([[nullUsageBlock], [{ used_units: "1" }]]);

  const result = await enforceCallerRequestLimits(
    query,
    identity,
    "hosted-free",
    "status"
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(query.calls.length, 2);
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

  const result = await enforceCallerRequestLimits(
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

  const result = await enforceCallerRequestLimits(
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
