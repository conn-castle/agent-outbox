import assert from "node:assert/strict";
import test from "node:test";

import {
  createHumanAnswerInTransaction,
  HUMAN_ANSWER_RESPONSE_BYTE_LIMIT,
  inputActionForAnswerStatement,
  outputForPreReadUndoStatement,
  targetInputForAnswerStatement,
  undoHumanAnswerBeforeReadInTransaction,
  validatedResponsePayload
} from "../src/server/human-answer.ts";
import { humanReviewPageInTransaction } from "../src/server/human-review.ts";
import { handleInputQueueRequestInTransaction } from "../src/server/input-queue.ts";
import { runScheduledCleanup } from "../src/server/scheduled.ts";
import {
  assertMigrationOwnerCanSetAppRole,
  connectedDatabaseClient,
  preserveBodyErrorDuringTeardown,
  teardownAttempt
} from "./helpers/database.mjs";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {{ inputRows?: QueryResultRow[], actionRows?: QueryResultRow[], optionRows?: QueryResultRow[], accountTierRows?: QueryResultRow[], advisoryLockRows?: QueryResultRow[], accountStockUsageRows?: QueryResultRow[], outputRows?: QueryResultRow[], outputFileRows?: QueryResultRow[], preReadRows?: QueryResultRow[], undoRows?: QueryResultRow[] }} HumanAnswerMockRows
 * @typedef {{ accountId: string, userId: string, callerId: string, inputItemId: string, actionId: string }} HumanAnswerDatabaseIds
 */

const databaseTestsEnabled =
  process.env.AGENT_OUTBOX_ENABLE_DATABASE_TESTS === "1";
const databaseUrl = databaseTestsEnabled
  ? process.env.DATABASE_MIGRATION_URL
  : undefined;

/** @type {import("../src/server/human-answer.ts").CreateHumanAnswerInput} */
const baseAnswerInput = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002",
  humanUserId: "00000000-0000-4000-8000-000000000003",
  requestId: "req-test",
  correlationId: "corr-test",
  inputItemId: "00000000-0000-4000-8000-000000000004",
  expectedRevision: 3,
  actionValue: "approve",
  response: { kind: "free_text", text: "Use the revised answer." },
  answeredAt: new Date("2026-06-30T12:00:00.000Z")
};

test("feedback accompanies every response kind without replacing or bypassing the answer", () => {
  /** @type {Array<[Parameters<typeof validatedResponsePayload>[0], import("../src/server/human-answer.ts").HumanActionResponse]>} */
  const cases = [
    [{ popupKind: "none", popupPayload: {} }, { kind: "none" }],
    [
      { popupKind: "free_text", popupPayload: {} },
      { kind: "free_text", text: "Answer" }
    ],
    [
      { popupKind: "single_select", popupPayload: {}, optionValues: ["yes"] },
      { kind: "single_select", value: "yes" }
    ],
    [
      { popupKind: "multi_select", popupPayload: {}, optionValues: ["yes"] },
      { kind: "multi_select", values: ["yes"] }
    ],
    [
      { popupKind: "date_picker", popupPayload: { mode: "date" } },
      {
        kind: "date_picker",
        mode: "date",
        value_date: "2026-09-14",
        display_timezone: null
      }
    ],
    [
      { popupKind: "date_picker", popupPayload: { mode: "datetime" } },
      {
        kind: "date_picker",
        mode: "datetime",
        value_utc: "2026-09-14T12:00:00Z",
        display_timezone: "UTC"
      }
    ],
    [
      { popupKind: "file_upload", popupPayload: {} },
      {
        kind: "file_upload",
        file: new File(["file"], "note.txt", { type: "text/plain" })
      }
    ]
  ];
  for (const [action, response] of cases) {
    const result = validatedResponsePayload(
      action,
      response,
      "A qualification."
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      JSON.parse(JSON.stringify(result.responsePayload)).feedback,
      "A qualification."
    );
    assert.equal(result.responseKind, response.kind);
    assert.equal(
      result.responsePayloadBytes,
      Buffer.byteLength(JSON.stringify(result.responsePayload))
    );
  }
  /** @type {Parameters<typeof validatedResponsePayload>[0]} */
  const action = { popupKind: "none", popupPayload: {} };
  assert.deepEqual(
    validatedResponsePayload(action, { kind: "none" }, " \n "),
    validatedResponsePayload(action, { kind: "none" })
  );
  assert.equal(
    validatedResponsePayload(action, { kind: "none" }, 123).ok,
    false
  );
  assert.equal(
    validatedResponsePayload(
      action,
      { kind: "free_text", text: "Wrong kind" },
      "Feedback"
    ).ok,
    false
  );
  const oversized = validatedResponsePayload(
    action,
    { kind: "none" },
    "😀".repeat(HUMAN_ANSWER_RESPONSE_BYTE_LIMIT / 4)
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, "request_too_large");
});

test("human answer statement builders scope by explicit account caller and input context", () => {
  assert.deepEqual(
    targetInputForAnswerStatement({
      accountId: "account-123",
      callerId: "caller-123",
      inputItemId: "input-123"
    }).values,
    ["account-123", "caller-123", "input-123"]
  );
  assert.match(
    targetInputForAnswerStatement({
      accountId: "account-123",
      callerId: "caller-123",
      inputItemId: "input-123"
    }).sql,
    /for update of i/
  );

  assert.deepEqual(inputActionForAnswerStatement("input-123", "send"), {
    sql: `
      select
        input_action_id,
        popup_kind,
        popup_payload
      from public.agent_outbox_input_actions
      where input_item_id = $1
        and action_value = $2
    `,
    values: ["input-123", "send"]
  });

  assert.deepEqual(
    outputForPreReadUndoStatement({
      accountId: "account-123",
      callerId: "caller-123",
      outputResultId: "output-123"
    }).values,
    ["account-123", "caller-123", "output-123"]
  );
});

test("human answer response validation enforces selected popup options and bounds", () => {
  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "single_select",
        popupPayload: {},
        optionValues: ["approve", "reject"]
      },
      { kind: "single_select", value: "archive" }
    ),
    {
      ok: false,
      code: "invalid_action_response",
      message: "Action response does not match the selected action.",
      fields: [
        {
          path: "response.value",
          code: "invalid_action_response",
          message:
            "Single-select response must use one of the selected action options."
        }
      ]
    }
  );

  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "multi_select",
        popupPayload: { min_selected: 1, max_selected: 2 },
        optionValues: ["a", "b", "c"]
      },
      { kind: "multi_select", values: ["a", "c"] }
    ),
    {
      ok: true,
      responseKind: "multi_select",
      responsePayload: { values: ["a", "c"] },
      responsePayloadBytes: 20
    }
  );
  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "date_picker",
        popupPayload: { mode: "date", display_timezone: null },
        optionValues: []
      },
      {
        kind: "date_picker",
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: "America/New_York"
      }
    ),
    {
      ok: false,
      code: "invalid_action_response",
      message: "Action response does not match the selected action.",
      fields: [
        {
          path: "response.display_timezone",
          code: "invalid_action_response",
          message: "Date-picker timezone must match the selected action."
        }
      ]
    }
  );
  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "date_picker",
        popupPayload: { mode: "date", display_timezone: "America/New_York" },
        optionValues: []
      },
      {
        kind: "date_picker",
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: "America/New_York"
      }
    ),
    {
      ok: true,
      responseKind: "date_picker",
      responsePayload: {
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: "America/New_York"
      },
      responsePayloadBytes: 79
    }
  );
  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "date_picker",
        popupPayload: { mode: "datetime", display_timezone: null },
        optionValues: []
      },
      {
        kind: "date_picker",
        mode: "datetime",
        value_utc: "2026-06-30T12:00:00Z",
        display_timezone: null
      }
    ),
    {
      ok: false,
      code: "invalid_action_response",
      message: "Action response does not match the selected action.",
      fields: [
        {
          path: "response.display_timezone",
          code: "invalid_action_response",
          message:
            "Date-picker datetime responses require the displayed timezone."
        }
      ]
    }
  );
  assert.deepEqual(
    validatedResponsePayload(
      {
        popupKind: "date_picker",
        popupPayload: { mode: "date", display_timezone: null },
        optionValues: []
      },
      {
        kind: "date_picker",
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: null
      }
    ),
    {
      ok: true,
      responseKind: "date_picker",
      responsePayload: {
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: null
      },
      responsePayloadBytes: 65
    }
  );
  /** @type {Array<[Record<string, unknown>, import("../src/server/human-answer.ts").HumanActionResponse, string]>} */
  const timezoneMismatches = [
    [
      { mode: "date", display_timezone: "America/New_York" },
      {
        kind: "date_picker",
        mode: "date",
        value_date: "2026-06-30",
        display_timezone: null
      },
      "Date-picker timezone must match the selected action."
    ],
    [
      { mode: "datetime", display_timezone: null },
      {
        kind: "date_picker",
        mode: "datetime",
        value_utc: "2026-06-30T12:00:00Z",
        display_timezone: "Not/AZone"
      },
      "Date-picker responses require an IANA timezone name."
    ],
    [
      { mode: "datetime", display_timezone: "America/New_York" },
      {
        kind: "date_picker",
        mode: "datetime",
        value_utc: "2026-06-30T12:00:00Z",
        display_timezone: "UTC"
      },
      "Date-picker timezone must match the selected action."
    ]
  ];
  for (const [popupPayload, response, message] of timezoneMismatches) {
    const result = validatedResponsePayload(
      { popupKind: "date_picker", popupPayload, optionValues: [] },
      response
    );
    assert.deepEqual(
      result.ok ? null : result.fields,
      [
        {
          path: "response.display_timezone",
          code: "invalid_action_response",
          message
        }
      ],
      JSON.stringify(response)
    );
  }

  assert.deepEqual(
    validatedResponsePayload(
      { popupKind: "free_text", popupPayload: {}, optionValues: [] },
      { kind: "free_text", text: "   " }
    ),
    {
      ok: true,
      responseKind: "free_text",
      responsePayload: { text: "   " },
      responsePayloadBytes: 14
    }
  );

  const oversizedText = validatedResponsePayload(
    { popupKind: "free_text", popupPayload: {}, optionValues: [] },
    { kind: "free_text", text: "x".repeat(HUMAN_ANSWER_RESPONSE_BYTE_LIMIT) }
  );
  assert.equal(oversizedText.ok, false);
  assert.equal(oversizedText.code, "request_too_large");
});

test("human answer response validation accepts one matching uploaded file", () => {
  const file = new File(["file bytes"], "receipt.pdf", {
    type: "application/pdf"
  });
  const result = validatedResponsePayload(
    {
      popupKind: "file_upload",
      popupPayload: {
        accept_mime_types: ["application/*"]
      },
      optionValues: []
    },
    { kind: "file_upload", file }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.responseKind : null, "file_upload");
  assert.equal(result.ok ? result.responsePayloadBytes : null, 2);

  const rejected = validatedResponsePayload(
    {
      popupKind: "file_upload",
      popupPayload: {
        accept_mime_types: ["image/png"]
      },
      optionValues: []
    },
    { kind: "file_upload", file }
  );
  assert.equal(rejected.ok, false);
  assert.equal(
    rejected.ok ? null : rejected.fields?.[0]?.path,
    "response.file"
  );
});

test("human answer response validation fails closed for malformed file upload MIME policy", () => {
  const file = new File(["file bytes"], "receipt.pdf", {
    type: "application/pdf"
  });
  const result = validatedResponsePayload(
    {
      popupKind: "file_upload",
      popupPayload: {
        accept_mime_types: ["not-a-mime-pattern"]
      },
      optionValues: []
    },
    { kind: "file_upload", file }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "temporary_unavailable");
});

test("human answer response validation rejects impossible and sub-millisecond datetime responses", () => {
  const action = {
    popupKind: /** @type {"date_picker"} */ ("date_picker"),
    popupPayload: {
      mode: "datetime",
      min_value: "2026-01-01T00:00:00.000000001Z",
      max_value: "2026-01-01T00:00:00.000000010Z"
    },
    optionValues: []
  };

  const invalidCalendarDate = validatedResponsePayload(action, {
    kind: "date_picker",
    mode: "datetime",
    value_utc: "2026-02-30T00:00:00Z",
    display_timezone: "UTC"
  });
  const belowMinimum = validatedResponsePayload(action, {
    kind: "date_picker",
    mode: "datetime",
    value_utc: "2026-01-01T00:00:00.000000000Z",
    display_timezone: "UTC"
  });
  const invalidMonth = validatedResponsePayload(action, {
    kind: "date_picker",
    mode: "datetime",
    value_utc: "2026-13-01T00:00:00Z",
    display_timezone: "UTC"
  });

  assert.equal(invalidCalendarDate.ok, false);
  assert.equal(
    invalidCalendarDate.ok ? null : invalidCalendarDate.fields?.[0]?.path,
    "response.value_utc"
  );
  assert.equal(belowMinimum.ok, false);
  assert.equal(
    belowMinimum.ok ? null : belowMinimum.fields?.[0]?.message,
    "Date-picker datetime response is before the selected action minimum."
  );
  assert.equal(invalidMonth.ok, false);
  assert.equal(
    invalidMonth.ok ? null : invalidMonth.fields?.[0]?.path,
    "response.value_utc"
  );
});

test("human answer service rejects stale revisions before creating output", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  const result = await createHumanAnswerInTransaction(
    mockQuery(calls, {
      inputRows: [
        {
          input_item_id: baseAnswerInput.inputItemId,
          caller_item_id: "caller-item-1",
          caller_item_id_hash: "hash-1",
          status: "pending",
          current_revision: 4,
          non_file_payload_bytes: 100,
          updated_at: new Date("2026-06-29T09:00:00.000Z"),
          account_audit_id: "audit-account-1",
          caller_audit_id: "audit-caller-1"
        }
      ]
    }),
    baseAnswerInput
  );

  assert.deepEqual(result, {
    ok: false,
    code: "stale_input_revision",
    message: "Input item revision changed before the answer was submitted."
  });
  assert.equal(
    calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_output_results")
    ),
    false
  );
});

test("human answer service creates one output with feedback and content-safe audit rows", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  const result = await createHumanAnswerInTransaction(
    mockQuery(calls, {
      inputRows: [
        {
          input_item_id: baseAnswerInput.inputItemId,
          caller_item_id: "caller-item-1",
          caller_item_id_hash: "hash-1",
          status: "pending",
          current_revision: 3,
          non_file_payload_bytes: "100",
          updated_at: new Date("2026-06-29T09:00:00.000Z"),
          account_audit_id: "audit-account-1",
          caller_audit_id: "audit-caller-1"
        }
      ],
      actionRows: [
        {
          input_action_id: "action-1",
          popup_kind: "free_text",
          popup_payload: { min_length: 1, max_length: 200 }
        }
      ],
      outputRows: [{ output_result_id: "output-1" }]
    }),
    { ...baseAnswerInput, feedback: "Please rename this." }
  );

  assert.deepEqual(result, {
    ok: true,
    outputResultId: "output-1",
    inputItemId: baseAnswerInput.inputItemId,
    callerItemId: "caller-item-1",
    actionValue: "approve",
    responseKind: "free_text",
    responsePayload: {
      text: "Use the revised answer.",
      feedback: "Please rename this."
    },
    responsePayloadBytes: 67,
    answeredAt: "2026-06-30T12:00:00.000Z",
    expiresAt: "2026-07-14T12:00:00.000Z"
  });

  const outputInsert = calls.find((call) =>
    call.sql.includes("insert into public.agent_outbox_output_results")
  );
  assert.ok(outputInsert);
  assert.ok(outputInsert.values);
  assert.deepEqual(outputInsert.values.slice(0, 12), [
    baseAnswerInput.accountId,
    baseAnswerInput.callerId,
    baseAnswerInput.inputItemId,
    "caller-item-1",
    "approve",
    "free_text",
    '{"text":"Use the revised answer.","feedback":"Please rename this."}',
    67,
    "2026-06-30T12:00:00.000Z",
    baseAnswerInput.humanUserId,
    "2026-06-29T09:00:00.000Z",
    "2026-07-14T12:00:00.000Z"
  ]);

  const auditCalls = calls.filter((call) =>
    call.sql.includes("insert into public.agent_outbox_audit_events")
  );
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(
    auditCalls.map((call) => call.values?.[0]),
    ["input_answered", "output_created"]
  );
  assert.doesNotMatch(JSON.stringify(auditCalls), /Use the revised answer/);
  assert.doesNotMatch(JSON.stringify(auditCalls), /Please rename this/);
  assert.deepEqual(
    auditCalls.map((call) => {
      const metadata = call.values?.[16];
      if (typeof metadata !== "string") {
        assert.fail("expected audit metadata JSON string");
      }
      return JSON.parse(metadata);
    }),
    [{ revision: 3 }, { revision: 3 }]
  );
});

test("human answer service stores uploaded bytes in one output file row and content-safe audits", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  const file = new File(["uploaded bytes"], "invoice:Q3.html", {
    type: "text/html"
  });
  const result = await createHumanAnswerInTransaction(
    mockQuery(calls, {
      inputRows: [
        {
          input_item_id: baseAnswerInput.inputItemId,
          caller_item_id: "caller-item-1",
          caller_item_id_hash: "hash-1",
          status: "pending",
          current_revision: 3,
          non_file_payload_bytes: "100",
          updated_at: new Date("2026-06-29T09:00:00.000Z"),
          account_audit_id: "audit-account-1",
          caller_audit_id: "audit-caller-1"
        }
      ],
      actionRows: [
        {
          input_action_id: "action-1",
          popup_kind: "file_upload",
          popup_payload: { accept_mime_types: ["text/*"] }
        }
      ],
      accountTierRows: [{ tier: "hosted_paid" }],
      advisoryLockRows: [{ acquired: true }],
      accountStockUsageRows: [
        {
          queued_input_items: "1",
          non_file_stored_bytes: "100",
          overall_stored_bytes: "100"
        }
      ],
      outputRows: [{ output_result_id: "output-1" }],
      outputFileRows: [{ output_file_id: "file-1" }]
    }),
    {
      ...baseAnswerInput,
      response: { kind: "file_upload", file }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.responseKind : null, "file_upload");
  assert.deepEqual(result.ok ? result.responsePayload : null, {
    kind: "file_upload",
    file: {
      file_id: "file-1",
      filename: "invoice_Q3.html",
      mime_type: "application/octet-stream",
      size_bytes: 14,
      sha256: "b467a58745eb669cb9b2ac392cdc6871edb391065b2c3d652ffe8593500dca5b"
    }
  });

  const fileInsert = calls.find((call) =>
    call.sql.includes("insert into public.agent_outbox_output_files")
  );
  assert.ok(fileInsert);
  assert.equal(fileInsert.values?.[3], "invoice_Q3.html");
  assert.equal(fileInsert.values?.[4], "application/octet-stream");
  assert.equal(fileInsert.values?.[5], 14);
  assert.ok(Buffer.isBuffer(fileInsert.values?.[7]));

  const auditCalls = calls.filter((call) =>
    call.sql.includes("insert into public.agent_outbox_audit_events")
  );
  assert.deepEqual(
    auditCalls.map((call) => call.values?.[0]),
    ["input_answered", "output_created", "file_uploaded"]
  );
  assert.doesNotMatch(JSON.stringify(auditCalls), /invoice|uploaded bytes/);
  assert.equal(auditCalls[2].values?.[9], 14);
});

test("human answer service rejects oversized uploaded files before reading bytes", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  let readAttempted = false;

  class OversizedFile extends File {
    get size() {
      return 32_000_001;
    }

    async arrayBuffer() {
      readAttempted = true;
      return new ArrayBuffer(0);
    }
  }

  const file = new OversizedFile(["x"], "oversized.txt", {
    type: "text/plain"
  });
  const result = await createHumanAnswerInTransaction(
    mockQuery(calls, {
      inputRows: [
        {
          input_item_id: baseAnswerInput.inputItemId,
          caller_item_id: "caller-item-1",
          caller_item_id_hash: "hash-1",
          status: "pending",
          current_revision: 3,
          non_file_payload_bytes: "100",
          updated_at: new Date("2026-06-29T09:00:00.000Z"),
          account_audit_id: "audit-account-1",
          caller_audit_id: "audit-caller-1"
        }
      ],
      actionRows: [
        {
          input_action_id: "action-1",
          popup_kind: "file_upload",
          popup_payload: { accept_mime_types: ["text/plain"] }
        }
      ],
      accountTierRows: [{ tier: "hosted_paid" }]
    }),
    {
      ...baseAnswerInput,
      response: { kind: "file_upload", file }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "request_too_large");
  assert.equal(readAttempted, false);
  assert.equal(
    calls.some((call) =>
      call.sql.includes("insert into public.agent_outbox_output_results")
    ),
    false
  );
});

test("pre-read undo reports output_already_read without calling restore", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  const result = await undoHumanAnswerBeforeReadInTransaction(
    mockQuery(calls, {
      preReadRows: [
        {
          output_result_id: "output-1",
          first_read_at: "2026-06-30T12:05:00.000Z"
        }
      ]
    }),
    {
      accountId: baseAnswerInput.accountId,
      callerId: baseAnswerInput.callerId,
      humanUserId: baseAnswerInput.humanUserId,
      requestId: "req-test",
      correlationId: "corr-test",
      outputResultId: "output-1"
    }
  );

  assert.deepEqual(result, {
    ok: false,
    code: "output_already_read",
    message: "Output result has already been read by the caller."
  });
  assert.equal(
    calls.some((call) =>
      call.sql.includes("agent_outbox_restore_unread_output")
    ),
    false
  );
});

test("pre-read undo delegates unread restoration to the existing database function", async () => {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  const result = await undoHumanAnswerBeforeReadInTransaction(
    mockQuery(calls, {
      preReadRows: [{ output_result_id: "output-1", first_read_at: null }],
      undoRows: [
        { output_deleted: true, input_restored: true, files_deleted: 2 }
      ]
    }),
    {
      accountId: baseAnswerInput.accountId,
      callerId: baseAnswerInput.callerId,
      humanUserId: baseAnswerInput.humanUserId,
      requestId: "req-test",
      correlationId: "corr-test",
      outputResultId: "output-1"
    }
  );

  assert.deepEqual(result, {
    ok: true,
    outputResultId: "output-1",
    outputDeleted: true,
    inputRestored: true,
    filesDeleted: 2
  });
  const restoreCall = calls.find((call) =>
    call.sql.includes("agent_outbox_restore_unread_output")
  );
  assert.ok(restoreCall);
  assert.deepEqual(restoreCall.values, ["output-1", "req-test"]);
});

test(
  "database queue and history preserve other items across answer, undo, and re-answer",
  { skip: databaseTestsEnabled ? false : "database tests are opt-in" },
  async () => {
    assert.ok(databaseUrl);

    const client = await connectedDatabaseClient(databaseUrl);
    const ids = {
      accountId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      callerId: crypto.randomUUID(),
      inputItemId: crypto.randomUUID(),
      actionId: crypto.randomUUID()
    };
    const otherItemId = crypto.randomUUID();
    const untouchedItemId = crypto.randomUUID();
    /** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
    const reviewContext = {
      surface: "human",
      accountId: ids.accountId,
      userId: ids.userId,
      role: "owner"
    };
    /** @type {ProductTransactionQuery} */
    const query = (statement) => client.query(statement.sql, statement.values);
    /** @param {string[]} pendingIds @param {string[]} answeredIds */
    async function assertQueues(pendingIds, answeredIds) {
      for (const [
        status,
        expected
      ] of /** @type {Array<["pending" | "answered", string[]]>} */ ([
        ["pending", pendingIds],
        ["answered", answeredIds]
      ])) {
        const page = await humanReviewPageInTransaction(query, reviewContext, {
          status
        });
        assert.equal(page.totalCount, expected.length);
        assert.deepEqual(
          page.rows.map((row) => row.inputItemId).sort(),
          [...expected].sort()
        );
      }
    }
    /** @type {unknown} */
    let bodyError;

    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query("set role agent_outbox_app");
      await client.query("begin");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountId
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userId
      ]);
      await seedDatabaseRows(client, ids);
      for (const itemId of [otherItemId, untouchedItemId]) {
        await client.query(
          `
          insert into public.agent_outbox_input_items(
            input_item_id, account_id, caller_id, caller_item_id, caller_item_id_hash,
            row_type_display, row_type_icon, title_html, subtitle_html, summary_html, non_file_payload_bytes
          ) values ($1::uuid, $2, $3, $1::uuid::text, $1::uuid::text, 'Review', 'inbox', 'Other review', 'Subtitle', 'Summary', 25)
        `,
          [itemId, ids.accountId, ids.callerId]
        );
        await client.query(
          `
          insert into public.agent_outbox_input_actions(input_action_id, input_item_id, display_order, display, icon, action_value, popup_kind)
          values ($1, $2, 0, 'Approve', 'check', 'approve', 'none')
        `,
          [crypto.randomUUID(), itemId]
        );
      }
      await client.query("commit");
      await client.query("begin");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.request_id",
        "req-db-test"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountId
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userId
      ]);

      const originalInput = await client.query(
        `select updated_at from public.agent_outbox_input_items where input_item_id = $1`,
        [ids.inputItemId]
      );
      const originalUpdatedAt = originalInput.rows[0].updated_at.toISOString();
      await assertQueues([ids.inputItemId, otherItemId, untouchedItemId], []);
      const otherAnswer = await createHumanAnswerInTransaction(query, {
        accountId: ids.accountId,
        callerId: ids.callerId,
        humanUserId: ids.userId,
        requestId: "req-db-other",
        correlationId: "corr-db-other",
        inputItemId: otherItemId,
        expectedRevision: 1,
        actionValue: "approve",
        response: { kind: "none" }
      });
      assert.equal(otherAnswer.ok, true);

      const answer = await createHumanAnswerInTransaction(
        (statement) => client.query(statement.sql, statement.values),
        {
          accountId: ids.accountId,
          callerId: ids.callerId,
          humanUserId: ids.userId,
          requestId: "req-db-test",
          correlationId: "corr-db-test",
          inputItemId: ids.inputItemId,
          expectedRevision: 1,
          actionValue: "approve",
          response: { kind: "none" },
          answeredAt: new Date("2026-06-30T12:00:00.000Z")
        }
      );

      assert.equal(answer.ok, true);
      assert.equal(answer.responseKind, "none");
      await assertQueues([untouchedItemId], [ids.inputItemId, otherItemId]);

      const answeredRows = await client.query(
        `
          select i.status, i.answered_at, o.expires_at, o.previous_input_updated_at
          from public.agent_outbox_input_items i
          join public.agent_outbox_output_results o
            on o.input_item_id = i.input_item_id
          where i.input_item_id = $1
        `,
        [ids.inputItemId]
      );
      assert.equal(answeredRows.rows[0].status, "answered");
      assert.equal(
        answeredRows.rows[0].expires_at.toISOString(),
        "2026-07-14T12:00:00.000Z"
      );
      assert.equal(
        answeredRows.rows[0].previous_input_updated_at.toISOString(),
        originalUpdatedAt
      );

      const undo = await undoHumanAnswerBeforeReadInTransaction(
        (statement) => client.query(statement.sql, statement.values),
        {
          accountId: ids.accountId,
          callerId: ids.callerId,
          humanUserId: ids.userId,
          requestId: "req-db-test",
          correlationId: "corr-db-test",
          outputResultId: answer.outputResultId
        }
      );

      assert.deepEqual(undo, {
        ok: true,
        outputResultId: answer.outputResultId,
        outputDeleted: true,
        inputRestored: true,
        filesDeleted: 0
      });

      const restoredRows = await client.query(
        `
          select status, current_revision, updated_at
          from public.agent_outbox_input_items
          where input_item_id = $1
        `,
        [ids.inputItemId]
      );
      assert.equal(restoredRows.rows[0].status, "pending");
      assert.equal(restoredRows.rows[0].current_revision, 2);
      await assertQueues([ids.inputItemId, untouchedItemId], [otherItemId]);
      assert.equal(
        restoredRows.rows[0].updated_at.toISOString(),
        originalUpdatedAt
      );

      const legacyAnswer = await createHumanAnswerInTransaction(
        (statement) => client.query(statement.sql, statement.values),
        {
          accountId: ids.accountId,
          callerId: ids.callerId,
          humanUserId: ids.userId,
          requestId: "req-db-test-legacy",
          correlationId: "corr-db-test-legacy",
          inputItemId: ids.inputItemId,
          expectedRevision: 2,
          actionValue: "approve",
          response: { kind: "none" },
          answeredAt: new Date("2026-06-30T13:00:00.000Z")
        }
      );
      assert.equal(legacyAnswer.ok, true);
      await assertQueues([untouchedItemId], [ids.inputItemId, otherItemId]);
      if (!legacyAnswer.ok) assert.fail("expected legacy fallback answer");
      await client.query(
        `update public.agent_outbox_output_results set previous_input_updated_at = null where output_result_id = $1`,
        [legacyAnswer.outputResultId]
      );
      const fallbackNow = await client.query("select now() as now");
      const fallbackStartedAt = fallbackNow.rows[0].now;
      const legacyUndo = await undoHumanAnswerBeforeReadInTransaction(
        (statement) => client.query(statement.sql, statement.values),
        {
          accountId: ids.accountId,
          callerId: ids.callerId,
          humanUserId: ids.userId,
          requestId: "req-db-test-legacy",
          correlationId: "corr-db-test-legacy",
          outputResultId: legacyAnswer.outputResultId
        }
      );
      assert.equal(legacyUndo.ok, true);
      await assertQueues([ids.inputItemId, untouchedItemId], [otherItemId]);
      const legacyRestored = await client.query(
        `select updated_at from public.agent_outbox_input_items where input_item_id = $1`,
        [ids.inputItemId]
      );
      assert.equal(
        legacyRestored.rows[0].updated_at.toISOString(),
        fallbackStartedAt.toISOString(),
        "legacy outputs without a captured timestamp must fall back to the transaction now()"
      );
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        () => cleanupHumanAnswerDatabaseTest(client, ids),
        "Human answer database test and teardown both failed."
      );
    }
  }
);

test(
  "concurrent replacement and human answers finish without deadlocking or answering a stale revision",
  { skip: databaseTestsEnabled ? false : "database tests are opt-in" },
  async (t) => {
    assert.ok(databaseUrl);
    const scenarios = [
      {
        tier: "hosted_free",
        kind: "none",
        pauseAt: "account",
        answerWins: false
      },
      {
        tier: "hosted_paid",
        kind: "none",
        pauseAt: "input",
        answerWins: false
      },
      {
        tier: "hosted_paid",
        kind: "file_upload",
        pauseAt: "upload",
        answerWins: true
      }
    ];
    for (const { tier, kind, pauseAt, answerWins } of scenarios) {
      await t.test(`${tier}: pause after ${pauseAt}`, async () => {
        const owner = await connectedDatabaseClient(databaseUrl);
        const human = await connectedDatabaseClient(databaseUrl);
        const caller = await connectedDatabaseClient(databaseUrl);
        const ids = {
          accountId: crypto.randomUUID(),
          userId: crypto.randomUUID(),
          callerId: crypto.randomUUID(),
          inputItemId: crypto.randomUUID(),
          actionId: crypto.randomUUID()
        };
        /** @type {PromiseWithResolvers<void>} */
        const accountLocked = Promise.withResolvers();
        /** @type {PromiseWithResolvers<void>} */
        const resumeReplacement = Promise.withResolvers();
        /** @type {Promise<unknown>[]} */
        const operations = [];
        /** @type {unknown} */
        let bodyError;
        try {
          await assertMigrationOwnerCanSetAppRole(owner);
          await owner.query("begin");
          await seedDatabaseRows(owner, ids);
          await owner.query(
            "update public.agent_outbox_accounts set tier = $2 where account_id = $1",
            [ids.accountId, tier]
          );
          await owner.query(
            "update public.agent_outbox_input_actions set popup_kind = $2 where input_action_id = $1",
            [ids.actionId, kind]
          );
          await owner.query("commit");
          const humanPid = (await human.query("select pg_backend_pid() as pid"))
            .rows[0].pid;
          const callerPid = (
            await caller.query("select pg_backend_pid() as pid")
          ).rows[0].pid;
          /**
           * @template TResult
           * @param {import("pg").Client} client
           * @param {string} surface
           * @param {(query: ProductTransactionQuery) => Promise<TResult>} callback
           */
          async function transaction(client, surface, callback) {
            return runHumanAnswerDatabaseTransaction(
              client,
              ids,
              surface,
              callback
            );
          }
          const submission = {
            caller_item_id: "caller-item-db",
            row_type: { display: "Review", icon: "inbox" },
            title: "Replaced title",
            subtitle: "Subtitle",
            summary: "Summary",
            link_buttons: [],
            actions: [
              {
                display: "Approve",
                icon: "check",
                value: "approve",
                overflow: false,
                popup:
                  kind === "file_upload"
                    ? { kind, label: "Upload answer" }
                    : { kind }
              }
            ]
          };
          if (pauseAt === "input") {
            // Seed the minute quota through the real API path. A later quota
            // upsert need not acquire a foreign-key lock on the account.
            const warmup = await transaction(caller, "caller", (query) =>
              handleInputQueueRequestInTransaction(
                query,
                { requestId: "req-warmup", correlationId: "corr-warmup" },
                ids,
                "replace",
                { ...submission, caller_item_id: "missing-warmup" }
              )
            );
            assert.equal(warmup.ok, false);
            if (warmup.ok) assert.fail("warmup input must be missing");
            assert.equal(warmup.error.code, "not_found");
          }
          let paused = false;
          /** @param {ProductTransactionQuery} query @param {(statement: TransactionContextStatement) => boolean} matches */
          function pauseAfter(query, matches) {
            return /** @type {ProductTransactionQuery} */ (
              async (statement) => {
                const result = await query(statement);
                if (!paused && matches(statement)) {
                  paused = true;
                  accountLocked.resolve();
                  await resumeReplacement.promise;
                }
                return result;
              }
            );
          }
          const startReplacement = () =>
            transaction(caller, "caller", (query) =>
              handleInputQueueRequestInTransaction(
                answerWins
                  ? query
                  : pauseAfter(
                      query,
                      (statement) =>
                        statement.sql.includes("for update") &&
                        statement.sql.includes(
                          pauseAt === "account"
                            ? "from public.agent_outbox_accounts"
                            : "from public.agent_outbox_input_items"
                        )
                    ),
                {
                  requestId: "req-concurrent-caller",
                  correlationId: "corr-concurrent-caller"
                },
                ids,
                "replace",
                submission
              )
            );
          const startAnswer = () =>
            transaction(human, "human", (query) =>
              createHumanAnswerInTransaction(
                answerWins
                  ? pauseAfter(query, (statement) =>
                      statement.sql.includes(
                        "insert into public.agent_outbox_output_files"
                      )
                    )
                  : query,
                {
                  accountId: ids.accountId,
                  callerId: ids.callerId,
                  humanUserId: ids.userId,
                  inputItemId: ids.inputItemId,
                  requestId: "req-concurrent-human",
                  correlationId: "corr-concurrent-human",
                  expectedRevision: 1,
                  actionValue: "approve",
                  response:
                    kind === "file_upload"
                      ? {
                          kind: "file_upload",
                          file: new File(["answer"], "answer.txt", {
                            type: "text/plain"
                          })
                        }
                      : { kind: "none" }
                }
              )
            );
          const first = answerWins ? startAnswer() : startReplacement();
          operations.push(first);
          await Promise.race([accountLocked.promise, first]);
          assert.equal(
            paused,
            true,
            "first operation must reach the pause point"
          );
          const second = answerWins ? startReplacement() : startAnswer();
          operations.push(second);
          const settledOperations = Promise.allSettled([first, second]);
          await waitForDatabaseBlock(
            owner,
            answerWins ? callerPid : humanPid,
            answerWins ? humanPid : callerPid
          );
          resumeReplacement.resolve();
          const results = await settledOperations;
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
          }
          const replaced =
            /** @type {Awaited<ReturnType<typeof handleInputQueueRequestInTransaction>>} */ (
              await (answerWins ? second : first)
            );
          const answered =
            /** @type {Awaited<ReturnType<typeof createHumanAnswerInTransaction>>} */ (
              await (answerWins ? first : second)
            );
          assert.equal(replaced.ok, !answerWins, JSON.stringify(replaced));
          assert.equal(answered.ok, answerWins, JSON.stringify(answered));
          if (answerWins) {
            if (replaced.ok || !answered.ok) assert.fail("answer must win");
            assert.equal(replaced.error.code, "answered_unacknowledged");
            const uploaded = await owner.query(
              "select file_bytes from public.agent_outbox_output_files where output_result_id = $1",
              [answered.outputResultId]
            );
            assert.equal(uploaded.rowCount, 1);
            assert.equal(uploaded.rows[0].file_bytes.toString(), "answer");
          } else {
            if (answered.ok) assert.fail("the old revision cannot be answered");
            assert.equal(answered.code, "stale_input_revision");
          }
          const state = await owner.query(
            `select status, current_revision,
              (select count(*)::int from public.agent_outbox_output_results where input_item_id = $1) as outputs
             from public.agent_outbox_input_items where input_item_id = $1`,
            [ids.inputItemId]
          );
          assert.deepEqual(state.rows, [
            answerWins
              ? { status: "answered", current_revision: 1, outputs: 1 }
              : { status: "pending", current_revision: 2, outputs: 0 }
          ]);
        } catch (error) {
          bodyError = error;
        } finally {
          resumeReplacement.resolve();
          await Promise.allSettled(operations);
          await preserveBodyErrorDuringTeardown(
            bodyError,
            async () => {
              await human.end();
              await caller.end();
              await cleanupHumanAnswerDatabaseTest(owner, ids);
            },
            "Concurrent replacement test and teardown both failed."
          );
        }
      });
    }
  }
);

test(
  "expired paid-account cleanup and a stale human answer complete without deadlocking",
  { skip: databaseTestsEnabled ? false : "database tests are opt-in" },
  async () => {
    assert.ok(databaseUrl);
    const owner = await connectedDatabaseClient(databaseUrl);
    const human = await connectedDatabaseClient(databaseUrl);
    const cleanupClient = await connectedDatabaseClient(databaseUrl);
    const ids = {
      accountId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      callerId: crypto.randomUUID(),
      inputItemId: crypto.randomUUID(),
      actionId: crypto.randomUUID()
    };
    /** @type {PromiseWithResolvers<void>} */
    const itemDeleted = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const resumeCleanup = Promise.withResolvers();
    /** @type {Promise<unknown>[]} */
    const operations = [];
    /** @type {unknown} */
    let bodyError;
    try {
      await assertMigrationOwnerCanSetAppRole(owner);
      await owner.query("begin");
      await seedDatabaseRows(owner, ids);
      await owner.query("commit");
      const input = {
        accountId: ids.accountId,
        callerId: ids.callerId,
        humanUserId: ids.userId,
        inputItemId: ids.inputItemId,
        requestId: "req-cleanup-race-human",
        correlationId: "corr-cleanup-race-human",
        expectedRevision: 1,
        actionValue: "approve",
        response: /** @type {const} */ ({ kind: "none" })
      };
      const seededAnswer = await runHumanAnswerDatabaseTransaction(
        human,
        ids,
        "human",
        (query) =>
          createHumanAnswerInTransaction(query, {
            ...input,
            answeredAt: new Date("2026-09-01T00:00:00.000Z")
          })
      );
      assert.equal(seededAnswer.ok, true, JSON.stringify(seededAnswer));
      await owner.query(
        "update public.agent_outbox_accounts set tier = 'hosted_paid', billing_status = 'grace', billing_grace_ends_at = '2026-09-30T00:00:00Z' where account_id = $1",
        [ids.accountId]
      );
      const humanPid = (await human.query("select pg_backend_pid() as pid"))
        .rows[0].pid;
      const cleanupPid = (
        await cleanupClient.query("select pg_backend_pid() as pid")
      ).rows[0].pid;
      const cleanup = runScheduledCleanup({
        connectionString: databaseUrl,
        now: new Date("2026-10-01T00:00:00.000Z"),
        requestId: "req-cleanup-race",
        runTransaction(_connectionString, context, callback) {
          return runHumanAnswerDatabaseTransaction(
            cleanupClient,
            ids,
            "cleanup",
            (query) =>
              callback(
                /** @type {ProductTransactionQuery} */ (
                  async (statement) => {
                    const result = await query(statement);
                    if (
                      statement.sql.includes(
                        "agent_outbox_cleanup_account_targets"
                      )
                    ) {
                      // Keep this shared test database's other accounts out of the run.
                      const rows = result.rows.filter(
                        (row) => row.account_id === ids.accountId
                      );
                      return { ...result, rows, rowCount: rows.length };
                    }
                    if (
                      context.accountId === ids.accountId &&
                      statement.sql.includes(
                        "agent_outbox_delete_expired_outputs"
                      )
                    ) {
                      assert.equal(Number(result.rows[0].deleted_count), 1);
                      itemDeleted.resolve();
                      await resumeCleanup.promise;
                    }
                    return result;
                  }
                )
              )
          );
        }
      });
      operations.push(cleanup);
      await Promise.race([itemDeleted.promise, cleanup]);
      const answer = runHumanAnswerDatabaseTransaction(
        human,
        ids,
        "human",
        (query) => createHumanAnswerInTransaction(query, input)
      );
      operations.push(answer);
      const settled = Promise.allSettled([cleanup, answer]);
      await waitForDatabaseBlock(owner, humanPid, cleanupPid);
      resumeCleanup.resolve();
      for (const result of await settled) {
        if (result.status === "rejected") throw result.reason;
      }
      assert.equal((await cleanup).accounts_cleaned, 1);
      const answered = await answer;
      assert.equal(answered.ok, false, JSON.stringify(answered));
      if (answered.ok) assert.fail("deleted input cannot be answered");
      assert.equal(answered.code, "not_found");
      const state = await owner.query(
        `select tier,
          (select count(*)::int from public.agent_outbox_input_items where account_id = $1) as inputs,
          (select count(*)::int from public.agent_outbox_output_results where account_id = $1) as outputs
         from public.agent_outbox_accounts where account_id = $1`,
        [ids.accountId]
      );
      assert.deepEqual(state.rows, [
        { tier: "hosted_free", inputs: 0, outputs: 0 }
      ]);
    } catch (error) {
      bodyError = error;
    } finally {
      resumeCleanup.resolve();
      await Promise.allSettled(operations);
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          await human.end();
          await cleanupClient.end();
          await cleanupHumanAnswerDatabaseTest(owner, ids);
        },
        "Cleanup concurrency test and teardown both failed."
      );
    }
  }
);

test(
  "phase 4 local database human review pagination and search run the production statement",
  { skip: databaseTestsEnabled ? false : "database tests are opt-in" },
  async () => {
    assert.ok(databaseUrl);

    const client = await connectedDatabaseClient(databaseUrl);
    const ids = {
      accountId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      callerId: crypto.randomUUID(),
      inputItemId: crypto.randomUUID(),
      actionId: crypto.randomUUID()
    };
    // 105 extra items plus the seeded item make 106 rows, so page one must
    // contain exactly 100 rows and the second page exactly 6.
    const extraItemIds = Array.from({ length: 105 }, () => crypto.randomUUID());
    const markerItemId = extraItemIds[0];
    const decoyItemId = extraItemIds[1];
    // Every row is inserted in one transaction, so all rows share the same
    // default updated_at and the list order is fully determined by the
    // input_item_id tiebreaker (uuid comparison matches sorting the
    // lowercase canonical strings).
    const sortedItemIds = [ids.inputItemId, ...extraItemIds].sort();
    /** @type {import("../src/server/authorization.ts").AuthorizedHumanAccountContext} */
    const reviewContext = {
      surface: "human",
      accountId: ids.accountId,
      userId: ids.userId,
      role: "owner"
    };
    /**
     * @param {TransactionContextStatement} statement
     * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
     */
    const rawQuery = (statement) =>
      client.query(statement.sql, statement.values);
    const query = /** @type {ProductTransactionQuery} */ (
      /** @type {unknown} */ (rawQuery)
    );
    /** @type {unknown} */
    let bodyError;

    try {
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query("set role agent_outbox_app");
      await client.query("begin");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountId
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userId
      ]);
      await seedDatabaseRows(client, ids);
      for (const [index, extraItemId] of extraItemIds.entries()) {
        // The marker title exercises both LIKE-metacharacter escaping (the
        // literal "50%_off!") and visible-text search. The phrase crosses the
        // </strong> boundary, a newline/space run, U+00A0, and U+FEFF.
        // JavaScript `\s` collapses the last two; POSIX `[[:space:]]` does not.
        // The decoy only matches "50%_off!" when % and _ are wrongly treated
        // as wildcards.
        const titleHtml =
          extraItemId === markerItemId
            ? "<strong>Tail</strong>\n  literal\u00A0\uFEFFphrase 50%_off! marker"
            : extraItemId === decoyItemId
              ? "50 percent off! wildcard decoy"
              : `Bulk review item ${index}`;
        await client.query(
          `
            insert into public.agent_outbox_input_items(
              input_item_id,
              account_id,
              caller_id,
              caller_item_id,
              caller_item_id_hash,
              row_type_display,
              row_type_icon,
              title_html,
              subtitle_html,
              summary_html,
              non_file_payload_bytes
            )
            values ($1, $2, $3, $4, $5, 'Review', 'inbox', $6, 'Subtitle', 'Summary', 25)
          `,
          [
            extraItemId,
            ids.accountId,
            ids.callerId,
            `caller-item-page-${index}`,
            `hash-page-${index}`,
            titleHtml
          ]
        );
      }
      await client.query("commit");
      await client.query("begin");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.request_id",
        "req-db-page-test"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountId
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userId
      ]);

      const firstPage = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { offset: 0 }
      );
      assert.equal(firstPage.hasNext, true);
      assert.equal(firstPage.totalCount, sortedItemIds.length);
      assert.deepEqual(
        firstPage.rows.map((row) => row.inputItemId),
        sortedItemIds.slice(0, 100)
      );

      const secondPage = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { offset: 100 }
      );
      assert.equal(secondPage.hasNext, false);
      assert.equal(secondPage.totalCount, sortedItemIds.length);
      assert.deepEqual(
        secondPage.rows.map((row) => row.inputItemId),
        sortedItemIds.slice(100)
      );

      // The literal search only matches when %, _ and ! are escaped; broken
      // escaping either drops the marker (its visible text has no "off%")
      // or pulls in the wildcard decoy.
      const literalSearch = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { search: "50%_off!" }
      );
      assert.equal(literalSearch.totalCount, 1);
      assert.deepEqual(
        literalSearch.rows.map((row) => row.inputItemId),
        [markerItemId]
      );

      // The marker's visible title reads "Tail literal ..." once the tag
      // becomes a space and the whitespace run collapses, as the client
      // search mirror renders it. The raw HTML column never contains this
      // phrase, so the match proves the statement searches visible text.
      const strippedSearch = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { search: "Tail literal" }
      );
      assert.deepEqual(
        strippedSearch.rows.map((row) => row.inputItemId),
        [markerItemId]
      );

      // U+00A0 and U+FEFF sit between "literal" and "phrase". The search
      // matches only when the SQL whitespace class collapses both the way
      // JavaScript `\s` does.
      const bomSeparatedSearch = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { search: "literal phrase" }
      );
      assert.deepEqual(
        bomSeparatedSearch.rows.map((row) => row.inputItemId),
        [markerItemId]
      );

      // Markup must not be searchable: no seeded row has "strong" in its
      // visible text, so the marker's <strong> tag must not match.
      const markupSearch = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { search: "strong" }
      );
      assert.deepEqual(markupSearch.rows, []);
      assert.equal(markupSearch.totalCount, 0);
      const emptyPage = await humanReviewPageInTransaction(
        query,
        reviewContext,
        { offset: 1000 }
      );
      assert.deepEqual(emptyPage.rows, []);
      assert.equal(emptyPage.totalCount, sortedItemIds.length);
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        () => cleanupHumanAnswerDatabaseTest(client, ids),
        "Human answer database test and teardown both failed."
      );
    }
  }
);

/**
 * @param {TransactionContextStatement[]} calls
 * @param {HumanAnswerMockRows} rowsByKind
 * @returns {ProductTransactionQuery}
 */
function mockQuery(calls, rowsByKind) {
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);

    if (statement.sql.includes("from public.agent_outbox_input_items")) {
      return queryResult(rowsByKind.inputRows ?? []);
    }
    if (statement.sql.includes("from public.agent_outbox_input_actions")) {
      return queryResult(rowsByKind.actionRows ?? []);
    }
    if (
      statement.sql.includes(
        "from public.agent_outbox_input_action_popup_options"
      )
    ) {
      return queryResult(rowsByKind.optionRows ?? []);
    }
    if (
      statement.sql.includes("select tier from public.agent_outbox_accounts")
    ) {
      return queryResult(rowsByKind.accountTierRows ?? []);
    }
    if (statement.sql.includes("agent_outbox_account_limit_blocks")) {
      return queryResult([]);
    }
    if (statement.sql.includes("pg_try_advisory_xact_lock")) {
      return queryResult(rowsByKind.advisoryLockRows ?? []);
    }
    if (
      statement.sql.includes(
        "select account_id::text from public.agent_outbox_accounts"
      )
    ) {
      return queryResult([]);
    }
    if (statement.sql.includes("agent_outbox_account_stock_usage")) {
      return queryResult(rowsByKind.accountStockUsageRows ?? []);
    }
    if (
      statement.sql.includes("insert into public.agent_outbox_output_results")
    ) {
      return queryResult(rowsByKind.outputRows ?? []);
    }
    if (
      statement.sql.includes("insert into public.agent_outbox_output_files")
    ) {
      return queryResult(rowsByKind.outputFileRows ?? []);
    }
    if (statement.sql.includes("from public.agent_outbox_output_results")) {
      return queryResult(rowsByKind.preReadRows ?? []);
    }
    if (statement.sql.includes("agent_outbox_restore_unread_output")) {
      return queryResult(rowsByKind.undoRows ?? []);
    }

    return queryResult([]);
  };

  return /** @type {ProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
}

/**
 * @param {QueryResultRow[]} rows
 * @returns {import("pg").QueryResult<QueryResultRow>}
 */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

/**
 * @template TResult
 * @param {import("pg").Client} client
 * @param {HumanAnswerDatabaseIds} ids
 * @param {string} surface
 * @param {(query: ProductTransactionQuery) => Promise<TResult>} callback
 */
async function runHumanAnswerDatabaseTransaction(
  client,
  ids,
  surface,
  callback
) {
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = '5s'");
    await client.query("set local role agent_outbox_app");
    for (const [key, value] of Object.entries({
      auth_surface: surface,
      account_id: ids.accountId,
      caller_id: ids.callerId,
      user_id: ids.userId,
      request_id: `req-concurrent-${surface}`
    })) {
      await client.query("select set_config($1, $2, true)", [
        `agent_outbox.${key}`,
        value
      ]);
    }
    const result = await callback((statement) =>
      client.query(statement.sql, statement.values)
    );
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** @param {import("pg").Client} owner @param {number} waitingPid @param {number} blockingPid */
async function waitForDatabaseBlock(owner, waitingPid, blockingPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const wait = await owner.query(
      "select $2::int = any(pg_blocking_pids($1::int)) as blocked",
      [waitingPid, blockingPid]
    );
    if (wait.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("concurrent operation did not enter the expected database wait");
}

/**
 * @param {import("pg").Client} client
 * @param {HumanAnswerDatabaseIds} ids
 */
async function seedDatabaseRows(client, ids) {
  await client.query(
    `
      insert into public.agent_outbox_accounts(account_id, label)
      values ($1, 'Human answer test account')
    `,
    [ids.accountId]
  );
  await client.query(
    `
      insert into public.agent_outbox_users(user_id, clerk_user_id)
      values ($1, $2)
    `,
    [ids.userId, `clerk-${ids.userId}`]
  );
  await client.query(
    `
      insert into public.agent_outbox_account_members(account_id, user_id, role)
      values ($1, $2, 'owner')
    `,
    [ids.accountId, ids.userId]
  );
  await client.query(
    `
      insert into public.agent_outbox_callers(caller_id, account_id, display_name)
      values ($1, $2, 'Human answer test caller')
    `,
    [ids.callerId, ids.accountId]
  );
  await client.query(
    `
      insert into public.agent_outbox_input_items(
        input_item_id,
        account_id,
        caller_id,
        caller_item_id,
        caller_item_id_hash,
        row_type_display,
        row_type_icon,
        title_html,
        subtitle_html,
        summary_html,
        non_file_payload_bytes
      )
      values ($1, $2, $3, 'caller-item-db', 'hash-db', 'Review', 'inbox', 'Title', 'Subtitle', 'Summary', 25)
    `,
    [ids.inputItemId, ids.accountId, ids.callerId]
  );
  await client.query(
    `
      insert into public.agent_outbox_input_actions(
        input_action_id,
        input_item_id,
        display_order,
        display,
        icon,
        action_value,
        popup_kind
      )
      values ($1, $2, 0, 'Approve', 'check', 'approve', 'none')
    `,
    [ids.actionId, ids.inputItemId]
  );
}

/**
 * @param {import("pg").Client} client
 * @param {HumanAnswerDatabaseIds} ids
 */
async function cleanupDatabaseRows(client, ids) {
  const cleanupRole = await client.query(
    `select rolsuper or rolbypassrls as bypasses_rls from pg_catalog.pg_roles where rolname = current_user`
  );
  const bypassesRls = cleanupRole.rows[0]?.bypasses_rls === true;
  if (!bypassesRls) {
    await client.query("set role agent_outbox_app");
  }
  await client.query("begin");
  try {
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.audit_break_glass",
      "on"
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.auth_surface",
      "cleanup"
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.account_id",
      ids.accountId
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.user_id",
      ids.userId
    ]);
    await client.query(
      `
        delete from public.agent_outbox_audit_events
        where input_item_id = $1
      `,
      [ids.inputItemId]
    );
    await client.query(
      `
        delete from public.agent_outbox_accounts
        where account_id = $1
      `,
      [ids.accountId]
    );
    await client.query(
      `
        delete from public.agent_outbox_users
        where user_id = $1
      `,
      [ids.userId]
    );
    await client.query("commit");
    if (!bypassesRls) {
      await client.query("reset role");
    }
  } catch (error) {
    await client.query("rollback");
    if (!bypassesRls) {
      await client.query("reset role");
    }
    throw error;
  }
}

/**
 * @param {import("pg").Client} client
 * @param {HumanAnswerDatabaseIds} ids
 */
async function cleanupHumanAnswerDatabaseTest(client, ids) {
  /** @type {Error[]} */
  const errors = [];
  const attempt = teardownAttempt(
    errors,
    "Human answer database teardown failed"
  );

  await attempt("transaction rollback", () => client.query("rollback"));
  await attempt("role reset", () => client.query("reset role"));
  await attempt("test row cleanup", () => cleanupDatabaseRows(client, ids));
  await attempt("client close", () => client.end());

  if (errors.length > 0) {
    throw new AggregateError(errors, "Human answer database teardown failed.");
  }
}
