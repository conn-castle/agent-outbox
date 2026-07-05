import assert from "node:assert/strict";
import test from "node:test";

import {
  accountLimitProfile,
  deleteInputItem,
  handleInputQueueRequestInTransaction,
  insertInputItemStatement,
  replaceInputItem,
  serializedSendInputItemStatement,
  sendInputItem
} from "../src/server/input-queue.ts";
import { callerCredentialLastUsedStatement } from "../src/server/caller-api-auth.ts";
import {
  INPUT_REQUEST_BODY_BYTE_LIMIT,
  parseInputSubmission,
  readJsonBodyWithLimit
} from "../src/server/input-schema.ts";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

const context = {
  requestId: "req-input-test",
  correlationId: "corr-input-test"
};

const identity = {
  accountId: "00000000-0000-0000-0000-000000000001",
  callerId: "00000000-0000-0000-0000-000000000002"
};

function baseInput(overrides = {}) {
  return {
    caller_item_id: "email:thread_123",
    row_type: {
      display: "Email Draft",
      icon: "mail"
    },
    row_accent_color: "#2563eb",
    title: "<strong>Reply to Acme</strong>",
    subtitle: "Draft response prepared by Steward",
    corner: "2 min ago",
    summary: "<p>Approve or edit the proposed response.</p>",
    details:
      '<p>See <a href="https://example.com/source" title="Source">source</a>.</p>',
    link_buttons: [
      {
        display: "Open Source",
        icon: "external-link",
        url: "https://example.com/source"
      }
    ],
    card_visual: {
      kind: "numeric_bar",
      label: "Confidence",
      value: 8,
      display: "8/10",
      unit: null,
      min_value: 0,
      max_value: 10
    },
    actions: [
      {
        display: "Send",
        icon: "send",
        value: "send",
        overflow: false,
        popup: {
          kind: "none"
        }
      }
    ],
    ...overrides
  };
}

function parseValidInput(input = baseInput()) {
  const result = parseInputSubmission(input, { limitProfile: "hosted-paid" });
  assert.equal(result.ok, true);
  return result.submission;
}

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
    return queryResult(rows);
  };
  const typedQuery = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typedQuery.calls = calls;
  return typedQuery;
}

/**
 * @param {QueryResultRow[]} rows
 * @returns {import("pg").QueryResult<QueryResultRow>}
 */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

function pendingInputRow() {
  return {
    input_item_id: "input-1",
    status: "pending",
    current_revision: 2,
    normalized_content_fingerprint: "fingerprint",
    non_file_payload_bytes: 4096,
    has_live_output: false
  };
}

/**
 * @typedef {{
 *   tier?: string,
 *   quotaWindowRowsByLimit?: Record<string, QueryResultRow[]>,
 *   defaultQuotaWindowRows?: QueryResultRow[],
 *   advisoryLockRows?: QueryResultRow[],
 *   inputRows?: QueryResultRow[],
 *   accountStockUsageRows?: QueryResultRow[],
 *   insertedInputRows?: QueryResultRow[],
 *   insertedActionRows?: QueryResultRow[],
 *   auditRows?: QueryResultRow[]
 * }} InputQueueThrottleQueryOptions
 */

/**
 * @param {InputQueueThrottleQueryOptions} options
 * @returns {MockProductTransactionQuery}
 */
function inputQueueThrottleQuery({
  tier = "hosted_free",
  quotaWindowRowsByLimit = {},
  defaultQuotaWindowRows = [],
  advisoryLockRows = [],
  inputRows = [],
  accountStockUsageRows = [],
  insertedInputRows = [],
  insertedActionRows = [],
  auditRows = [
    {
      account_audit_id: "00000000-0000-0000-0000-0000000000a1",
      caller_audit_id: "00000000-0000-0000-0000-0000000000c1"
    }
  ]
} = {}) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);
    if (/select tier from public\.agent_outbox_accounts/.test(statement.sql)) {
      return queryResult([{ tier }]);
    }
    if (/agent_outbox_account_limit_blocks/.test(statement.sql)) {
      return queryResult([]);
    }
    if (/agent_outbox_account_quota_windows/.test(statement.sql)) {
      const limitName =
        typeof statement.values?.[1] === "string" ? statement.values[1] : "";
      return queryResult(
        quotaWindowRowsByLimit[limitName] ?? defaultQuotaWindowRows
      );
    }
    if (/pg_(try_)?advisory_xact_lock/.test(statement.sql)) {
      return queryResult(advisoryLockRows);
    }
    if (/from public\.agent_outbox_input_items i/.test(statement.sql)) {
      return queryResult(inputRows);
    }
    if (/agent_outbox_account_stock_usage/.test(statement.sql)) {
      return queryResult(accountStockUsageRows);
    }
    if (/insert into public\.agent_outbox_input_items/.test(statement.sql)) {
      return queryResult(insertedInputRows);
    }
    if (/insert into public\.agent_outbox_input_actions/.test(statement.sql)) {
      return queryResult(insertedActionRows);
    }
    if (/select a\.account_audit_id/.test(statement.sql)) {
      return queryResult(auditRows);
    }
    return queryResult([]);
  };
  const typedQuery = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typedQuery.calls = calls;
  return typedQuery;
}

test("input parser normalizes safe submissions and computes stable fingerprints", () => {
  const first = parseInputSubmission(baseInput(), {
    limitProfile: "hosted-paid"
  });
  const second = parseInputSubmission(
    {
      actions: baseInput().actions,
      link_buttons: baseInput().link_buttons,
      summary: baseInput().summary,
      title: baseInput().title,
      subtitle: baseInput().subtitle,
      row_type: baseInput().row_type,
      caller_item_id: baseInput().caller_item_id,
      corner: baseInput().corner,
      details: baseInput().details,
      row_accent_color: baseInput().row_accent_color,
      card_visual: baseInput().card_visual
    },
    { limitProfile: "hosted-paid" }
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.submission.priority, "normal");
  assert.equal(first.submission.skipDisabled, false);
  assert.equal(
    first.submission.normalizedContentFingerprint,
    second.submission.normalizedContentFingerprint
  );
  assert.equal(
    first.submission.linkButtons[0].url,
    "https://example.com/source"
  );
  assert.equal(first.submission.actions[0].popupKind, "none");
});

test("input parser rejects caller identity, unsafe HTML, unsafe colors, and invalid URLs", () => {
  const result = parseInputSubmission(
    baseInput({
      caller_id: "caller-from-body",
      title: '<span onclick="steal()">Bad</span>',
      row_accent_color: "url(https://example.com/color)",
      link_buttons: [
        {
          display: "Bad Link",
          icon: "external-link",
          url: "javascript:alert(1)"
        }
      ]
    }),
    { limitProfile: "hosted-paid" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsafe_html");
  assert.deepEqual(result.error.fields?.map((field) => field.path).sort(), [
    "caller_id",
    "link_buttons[0].url",
    "row_accent_color",
    "title"
  ]);
});

test("input parser rejects embedded active content and caller component attempts", () => {
  const cases = [
    {
      name: "script",
      input: baseInput({ details: "<script>fixtureUnsafeScript()</script>" }),
      path: "details",
      code: "unsafe_html"
    },
    {
      name: "arbitrary svg",
      input: baseInput({ summary: "<svg><circle /></svg>" }),
      path: "summary",
      code: "unsafe_html"
    },
    {
      name: "media",
      input: baseInput({ details: '<video src="https://example.com/x.mp4">' }),
      path: "details",
      code: "unsafe_html"
    },
    {
      name: "form",
      input: baseInput({ title: '<form action="/x"><input name="x"></form>' }),
      path: "title",
      code: "unsafe_html"
    },
    {
      name: "unsafe visual color",
      input: baseInput({
        card_visual: {
          kind: "pill",
          text: "Needs review",
          icon: "check",
          color: "var(--caller-color)"
        }
      }),
      path: "card_visual.color",
      code: "unsafe_color"
    },
    {
      name: "caller component",
      input: baseInput({
        card_visual: {
          kind: "caller_component",
          component: "CallerInjectedWidget",
          props: { src: "https://example.com/widget.js" }
        }
      }),
      path: "card_visual.kind",
      code: "invalid_enum"
    }
  ];

  for (const { name, input, path, code } of cases) {
    const result = parseInputSubmission(input, { limitProfile: "hosted-paid" });
    assert.equal(result.ok, false, name);
    assert.equal(
      result.error.fields?.some((field) => field.path === path),
      true
    );
    assert.equal(
      result.error.fields?.some((field) => field.code === code),
      true
    );
  }
});

test("input parser accepts anchor href with multi-parameter query strings", () => {
  // Query strings with more than one parameter (?a=1&b=2) are ordinary URLs and
  // pass the http/https/mailto protocol allow-list; the ampersand must not be
  // rejected on its own or the allowed <a href> feature is unusable.
  const result = parseInputSubmission(
    baseInput({
      details:
        '<p>See <a href="https://example.com/search?a=1&b=2">results</a>.</p>'
    }),
    { limitProfile: "hosted-paid" }
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected multi-parameter href to be accepted");
  }
  assert.match(result.submission.detailsHtml ?? "", /a=1&b=2/);
});

test("input parser rejects impossible and inverted datetime picker bounds", () => {
  const invalidCalendarDate = parseInputSubmission(
    baseInput({
      actions: [
        {
          display: "Schedule",
          icon: "calendar",
          value: "schedule",
          overflow: false,
          popup: {
            kind: "date_picker",
            label: "Send at",
            mode: "datetime",
            min_value: "2026-02-30T00:00:00Z"
          }
        }
      ]
    }),
    { limitProfile: "hosted-paid" }
  );
  const invertedSubMillisecondBounds = parseInputSubmission(
    baseInput({
      actions: [
        {
          display: "Schedule",
          icon: "calendar",
          value: "schedule",
          overflow: false,
          popup: {
            kind: "date_picker",
            label: "Send at",
            mode: "datetime",
            min_value: "2026-01-01T00:00:00.000000001Z",
            max_value: "2026-01-01T00:00:00.000000000Z"
          }
        }
      ]
    }),
    { limitProfile: "hosted-paid" }
  );

  assert.equal(invalidCalendarDate.ok, false);
  assert.equal(
    invalidCalendarDate.ok ? null : invalidCalendarDate.error.fields?.[0]?.code,
    "invalid_datetime"
  );
  assert.equal(invertedSubMillisecondBounds.ok, false);
  assert.equal(
    invertedSubMillisecondBounds.ok
      ? null
      : invertedSubMillisecondBounds.error.fields?.[0]?.code,
    "invalid_range"
  );
});

test("input parser rejects safe-shaped but unsupported icon names", () => {
  const result = parseInputSubmission(
    baseInput({
      row_type: {
        display: "Email Draft",
        icon: "not-a-real-icon"
      }
    }),
    { limitProfile: "hosted-paid" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_icon");
});

test("file upload actions fail loudly before the paid upload workflow exists", () => {
  const input = baseInput({
    actions: [
      {
        display: "Upload",
        icon: "upload",
        value: "upload",
        overflow: false,
        popup: {
          kind: "file_upload",
          label: "Attach file",
          accept_mime_types: ["application/pdf"]
        }
      }
    ]
  });
  const result = parseInputSubmission(input, { limitProfile: "hosted-free" });
  const paidResult = parseInputSubmission(input, {
    limitProfile: "hosted-paid"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.status, 402);
  assert.equal(result.error.code, "upgrade_required");
  assert.equal(
    result.error.limit && "limitReasonCode" in result.error.limit
      ? result.error.limit.limitReasonCode
      : null,
    "file_upload_upgrade_required"
  );
  assert.equal(paidResult.ok, false);
  assert.deepEqual(paidResult.error, {
    status: 503,
    code: "temporary_unavailable",
    message:
      "File upload actions require the paid file upload workflow, which is not available in this API phase."
  });
});

test("input request body parser rejects non-file JSON bodies over 128000 bytes", async () => {
  const response = await readJsonBodyWithLimit(
    new Request("https://app.agent-outbox.dev/api/input/send", {
      method: "POST",
      body: JSON.stringify({ body: "x".repeat(128_001) })
    })
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.status, 413);
  assert.equal(response.error.code, "request_too_large");
  assert.equal(
    response.error.limit && "limit_reason_code" in response.error.limit
      ? response.error.limit.limit_reason_code
      : null,
    "input_request_too_large"
  );
});

test("input request body parser stops reading unknown-length bodies past the byte limit", async () => {
  let pullCount = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      controller.enqueue(new Uint8Array(INPUT_REQUEST_BODY_BYTE_LIMIT + 1));
    },
    cancel() {
      canceled = true;
    }
  });
  const requestInit = /** @type {RequestInit} */ (
    /** @type {unknown} */ ({
      method: "POST",
      body,
      duplex: "half"
    })
  );
  const response = await readJsonBodyWithLimit(
    new Request("https://app.agent-outbox.dev/api/input/send", requestInit)
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.status, 413);
  assert.equal(response.error.code, "request_too_large");
  assert.equal(pullCount, 1);
  assert.equal(canceled, true);
});

test("send creates a pending item and stores normalized child rows", async () => {
  const submission = parseValidInput();
  const query = fakeQuery([
    [],
    [{ input_item_id: "input-1", current_revision: 1 }],
    [],
    [{ input_action_id: "action-1" }],
    [
      {
        account_audit_id: "00000000-0000-0000-0000-0000000000a1",
        caller_audit_id: "00000000-0000-0000-0000-0000000000c1"
      }
    ],
    []
  ]);

  const result = await sendInputItem(query, context, identity, submission);

  assert.deepEqual(result, {
    ok: true,
    data: {
      operation: "send",
      caller_item_id: "email:thread_123",
      status: "pending",
      revision: 1,
      created: true,
      duplicate: false
    }
  });
  assert.match(
    query.calls[1].sql,
    /insert into public\.agent_outbox_input_items/
  );
  assert.match(query.calls[2].sql, /agent_outbox_input_link_buttons/);
  assert.match(query.calls[3].sql, /agent_outbox_input_actions/);
  assert.match(query.calls[5].sql, /agent_outbox_audit_events/);
});

test("send no-ops only for equivalent pending content and conflicts on changed content", async () => {
  const submission = parseValidInput();
  const duplicateQuery = fakeQuery([
    [
      {
        input_item_id: "input-1",
        status: "pending",
        current_revision: 3,
        normalized_content_fingerprint: submission.normalizedContentFingerprint,
        has_live_output: false
      }
    ]
  ]);
  const conflictQuery = fakeQuery([
    [
      {
        input_item_id: "input-1",
        status: "pending",
        current_revision: 3,
        normalized_content_fingerprint: "different",
        has_live_output: false
      }
    ]
  ]);

  const duplicate = await sendInputItem(
    duplicateQuery,
    context,
    identity,
    submission
  );
  const conflict = await sendInputItem(
    conflictQuery,
    context,
    identity,
    submission
  );

  if (!duplicate.ok || duplicate.data.operation !== "send") {
    assert.fail("expected duplicate send success");
  }
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(conflict.ok, false);
  assert.equal(
    conflict.ok ? null : conflict.error.code,
    "pending_content_conflict"
  );
});

test("duplicate send does not run accepted-submission limit guard", async () => {
  const submission = parseValidInput();
  const query = fakeQuery([
    [{ acquired: true }],
    [
      {
        input_item_id: "input-1",
        status: "pending",
        current_revision: 7,
        normalized_content_fingerprint: submission.normalizedContentFingerprint,
        non_file_payload_bytes: submission.nonFilePayloadBytes,
        has_live_output: false
      }
    ]
  ]);
  let guardCalled = false;

  const result = await sendInputItem(query, context, identity, submission, {
    beforeCreate: async () => {
      guardCalled = true;
      return {
        ok: false,
        error: {
          status: 429,
          code: "quota_limit_exceeded",
          message: "Should not be returned for duplicate send."
        }
      };
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.data.operation !== "send") {
    assert.fail("expected duplicate send success");
  }
  assert.equal(result.data.duplicate, true);
  assert.equal(result.data.revision, 7);
  assert.equal(guardCalled, false);
  assert.match(query.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(query.calls[1].sql, /agent_outbox_input_items/);
});

test("raced duplicate send does not run accepted-submission limit guard", async () => {
  const submission = parseValidInput();
  const query = fakeQuery([
    [{ acquired: true }],
    [],
    [
      {
        input_item_id: "input-1",
        status: "pending",
        current_revision: 8,
        normalized_content_fingerprint: submission.normalizedContentFingerprint,
        non_file_payload_bytes: submission.nonFilePayloadBytes,
        has_live_output: false
      }
    ]
  ]);
  let guardCalled = false;

  const result = await sendInputItem(query, context, identity, submission, {
    beforeCreate: async () => {
      guardCalled = true;
      return {
        ok: false,
        error: {
          status: 429,
          code: "quota_limit_exceeded",
          message: "Should not be returned for raced duplicate send."
        }
      };
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.data.operation !== "send") {
    assert.fail("expected raced duplicate send success");
  }
  assert.equal(result.data.duplicate, true);
  assert.equal(result.data.revision, 8);
  assert.equal(guardCalled, false);
  assert.equal(query.calls.length, 3);
  assert.match(query.calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(query.calls[1].sql, /agent_outbox_input_items/);
  assert.match(query.calls[2].sql, /agent_outbox_input_items/);
});

test("send and replace reject answered items while output is unacknowledged", async () => {
  const submission = parseValidInput();
  const rows = [
    [
      {
        input_item_id: "input-1",
        status: "answered",
        current_revision: 1,
        normalized_content_fingerprint: submission.normalizedContentFingerprint,
        has_live_output: true
      }
    ]
  ];

  const send = await sendInputItem(
    fakeQuery(rows),
    context,
    identity,
    submission
  );
  const replace = await replaceInputItem(
    fakeQuery(rows),
    context,
    identity,
    submission
  );

  assert.equal(send.ok, false);
  assert.equal(send.ok ? null : send.error.code, "answered_unacknowledged");
  assert.equal(replace.ok, false);
  assert.equal(
    replace.ok ? null : replace.error.code,
    "answered_unacknowledged"
  );
});

test("replace increments revision only when pending content changes", async () => {
  const submission = parseValidInput();
  const sameContent = await replaceInputItem(
    fakeQuery([
      [
        {
          input_item_id: "input-1",
          status: "pending",
          current_revision: 5,
          normalized_content_fingerprint:
            submission.normalizedContentFingerprint,
          has_live_output: false
        }
      ]
    ]),
    context,
    identity,
    submission
  );
  const changedQuery = fakeQuery([
    [
      {
        input_item_id: "input-1",
        status: "pending",
        current_revision: 5,
        normalized_content_fingerprint: "old",
        has_live_output: false
      }
    ],
    [{ current_revision: 6 }],
    [],
    [],
    [],
    [{ input_action_id: "action-1" }],
    [
      {
        account_audit_id: "00000000-0000-0000-0000-0000000000a1",
        caller_audit_id: "00000000-0000-0000-0000-0000000000c1"
      }
    ],
    []
  ]);

  const changed = await replaceInputItem(
    changedQuery,
    context,
    identity,
    submission
  );

  assert.equal(sameContent.ok, true);
  assert.deepEqual(sameContent.ok ? sameContent.data : null, {
    operation: "replace",
    caller_item_id: "email:thread_123",
    status: "pending",
    revision: 5,
    replaced: false,
    changed: false
  });
  if (!changed.ok || changed.data.operation !== "replace") {
    assert.fail("expected changed replace success");
  }
  assert.equal(changed.data.revision, 6);
  assert.match(
    changedQuery.calls[1].sql,
    /current_revision = current_revision \+ 1/
  );
  assert.match(changedQuery.calls[2].sql, /agent_outbox_input_link_buttons/);
  assert.match(changedQuery.calls[3].sql, /agent_outbox_input_actions/);
});

test("delete removes only pending input items", async () => {
  const deleteQuery = fakeQuery([
    [pendingInputRow()],
    [],
    [
      {
        account_audit_id: "00000000-0000-0000-0000-0000000000a1",
        caller_audit_id: "00000000-0000-0000-0000-0000000000c1"
      }
    ],
    []
  ]);

  const deleted = await deleteInputItem(
    deleteQuery,
    context,
    identity,
    "email:thread_123"
  );
  const answered = await deleteInputItem(
    fakeQuery([
      [
        {
          input_item_id: "input-1",
          status: "answered",
          current_revision: 2,
          normalized_content_fingerprint: "fingerprint",
          has_live_output: true
        }
      ]
    ]),
    context,
    identity,
    "email:thread_123"
  );

  assert.deepEqual(deleted, {
    ok: true,
    data: {
      operation: "delete",
      caller_item_id: "email:thread_123",
      deleted: true
    }
  });
  assert.match(
    deleteQuery.calls[1].sql,
    /delete from public\.agent_outbox_input_items/
  );
  // The input_deleted audit event must record the freed non-file byte count
  // from the existing row, matching input_submitted/input_replaced.
  assert.match(deleteQuery.calls[3].sql, /agent_outbox_audit_events/);
  assert.equal(deleteQuery.calls[3].values?.[0], "input_deleted");
  assert.equal(deleteQuery.calls[3].values?.[5], 4096);
  assert.equal(answered.ok, false);
  assert.equal(answered.ok ? null : answered.error.code, "input_not_pending");
});

test("input delete transaction blocks on the per-minute request throttle before deletion", async () => {
  const query = inputQueueThrottleQuery({
    quotaWindowRowsByLimit: {
      input_delete_requests_per_account_per_minute: [{ used_units: "601" }]
    },
    inputRows: [pendingInputRow()]
  });

  const result = await handleInputQueueRequestInTransaction(
    query,
    context,
    identity,
    "delete",
    { caller_item_id: "email:thread_123" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.ok || !result.error.limit || !("limit_name" in result.error.limit)
      ? null
      : result.error.limit.limit_name,
    "input_delete_requests_per_account_per_minute"
  );
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("delete from public.agent_outbox_input_items")
    ),
    false
  );
});

test("input send and replace transactions block on the send/replace request throttle", async () => {
  for (const operation of /** @type {const} */ (["send", "replace"])) {
    const query = inputQueueThrottleQuery({
      quotaWindowRowsByLimit: {
        authenticated_caller_api_requests_per_calendar_month: [
          { used_units: "1" }
        ],
        input_send_replace_requests_per_account_per_minute: [
          { used_units: "600" }
        ]
      }
    });

    const result = await handleInputQueueRequestInTransaction(
      query,
      context,
      identity,
      operation,
      baseInput()
    );

    assert.equal(result.ok, false, operation);
    assert.equal(
      result.ok ? null : result.error.code,
      "rate_limit_exceeded",
      operation
    );
    assert.equal(
      result.ok || !result.error.limit || !("limit_name" in result.error.limit)
        ? null
        : result.error.limit.limit_name,
      "input_send_replace_requests_per_account_per_minute",
      operation
    );
    assert.equal(
      query.calls.some((call) =>
        call.sql.includes("insert into public.agent_outbox_input_items")
      ),
      false,
      operation
    );
  }
});

test("input delete transaction stays monthly-exempt while enforcing the minute throttle", async () => {
  const query = inputQueueThrottleQuery({
    quotaWindowRowsByLimit: {
      input_delete_requests_per_account_per_minute: [{ used_units: "1" }]
    },
    inputRows: [pendingInputRow()]
  });

  const result = await handleInputQueueRequestInTransaction(
    query,
    context,
    identity,
    "delete",
    { caller_item_id: "email:thread_123" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.operation : null, "delete");
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

test("allowed input send still reaches accepted-submission checks before insertion", async () => {
  const query = inputQueueThrottleQuery({
    defaultQuotaWindowRows: [{ used_units: "1" }],
    advisoryLockRows: [{ acquired: true }],
    accountStockUsageRows: [
      {
        queued_input_items: "0",
        non_file_stored_bytes: "0",
        overall_stored_bytes: "0"
      }
    ],
    insertedInputRows: [{ input_item_id: "input-1", current_revision: 1 }],
    insertedActionRows: [{ input_action_id: "action-1" }]
  });

  const result = await handleInputQueueRequestInTransaction(
    query,
    context,
    identity,
    "send",
    baseInput({ caller_item_id: "email:accepted_check" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.operation : null, "send");
  assert.equal(
    query.calls.some((call) =>
      call.sql.includes("public.agent_outbox_account_stock_usage")
    ),
    true
  );
  assert.equal(
    query.calls.some((call) =>
      call.values?.includes("burst_input_submissions_per_account_per_minute")
    ),
    true
  );
});

test("insert statement never accepts caller identity from request bodies", () => {
  const submission = parseValidInput();
  const statement = insertInputItemStatement(identity, submission);

  assert.deepEqual(statement.values?.slice(0, 3), [
    identity.accountId,
    identity.callerId,
    "email:thread_123"
  ]);
});

test("send serialization lock scopes duplicate detection to the authenticated caller item", () => {
  const submission = parseValidInput();
  const statement = serializedSendInputItemStatement(identity, submission);

  assert.match(statement.sql, /pg_advisory_xact_lock/);
  assert.match(statement.sql, /md5/);
  assert.deepEqual(statement.values, [
    identity.accountId,
    identity.callerId,
    submission.callerItemId
  ]);
});

test("caller credential last-used update is scoped to authenticated account caller and key", () => {
  const statement = callerCredentialLastUsedStatement({
    accountId: identity.accountId,
    callerId: identity.callerId,
    keyId: "key_123"
  });

  assert.deepEqual(statement, {
    sql: `
      update public.agent_outbox_caller_credentials
      set last_used_at = now()
      where account_id = $1
        and caller_id = $2
        and key_id = $3
        and (
          last_used_at is null
          or last_used_at < now() - interval '15 minutes'
        )
    `,
    values: [identity.accountId, identity.callerId, "key_123"]
  });
  assert.match(statement.sql, /account_id = \$1/);
  assert.match(statement.sql, /caller_id = \$2/);
  assert.match(statement.sql, /key_id = \$3/);
  assert.match(statement.sql, /last_used_at is null/);
  assert.match(statement.sql, /last_used_at < now\(\) - interval '15 minutes'/);
});

test("account limit profile fails loud when the authenticated account row is missing", async () => {
  const query = fakeQuery([[]]);

  assert.equal(await accountLimitProfile(query, identity.accountId), null);
  assert.deepEqual(query.calls[0].values, [identity.accountId]);
});
