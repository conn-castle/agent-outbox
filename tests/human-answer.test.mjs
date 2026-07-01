import assert from "node:assert/strict";
import pg from "pg";
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

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {{ inputRows?: QueryResultRow[], actionRows?: QueryResultRow[], optionRows?: QueryResultRow[], outputRows?: QueryResultRow[], preReadRows?: QueryResultRow[], undoRows?: QueryResultRow[] }} HumanAnswerMockRows
 * @typedef {{ accountId: string, userId: string, callerId: string, inputItemId: string, actionId: string }} HumanAnswerDatabaseIds
 */

const { Client } = pg;

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
        display_timezone: "Not/AZone"
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
          message: "Date-picker responses require an IANA timezone name."
        }
      ]
    }
  );

  const oversizedText = validatedResponsePayload(
    { popupKind: "free_text", popupPayload: {}, optionValues: [] },
    { kind: "free_text", text: "x".repeat(HUMAN_ANSWER_RESPONSE_BYTE_LIMIT) }
  );
  assert.equal(oversizedText.ok, false);
  assert.equal(oversizedText.code, "request_too_large");
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

test("human answer service creates one output and audit rows without raw answer content", async () => {
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
    baseAnswerInput
  );

  assert.deepEqual(result, {
    ok: true,
    outputResultId: "output-1",
    inputItemId: baseAnswerInput.inputItemId,
    callerItemId: "caller-item-1",
    actionValue: "approve",
    responseKind: "free_text",
    responsePayload: { text: "Use the revised answer." },
    responsePayloadBytes: 34,
    answeredAt: "2026-06-30T12:00:00.000Z",
    expiresAt: "2026-07-14T12:00:00.000Z"
  });

  const outputInsert = calls.find((call) =>
    call.sql.includes("insert into public.agent_outbox_output_results")
  );
  assert.ok(outputInsert);
  assert.ok(outputInsert.values);
  assert.deepEqual(outputInsert.values.slice(0, 11), [
    baseAnswerInput.accountId,
    baseAnswerInput.callerId,
    baseAnswerInput.inputItemId,
    "caller-item-1",
    "approve",
    "free_text",
    '{"text":"Use the revised answer."}',
    34,
    "2026-06-30T12:00:00.000Z",
    baseAnswerInput.humanUserId,
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
  "phase 4 local database human answer service creates and restores unread output",
  { skip: databaseTestsEnabled ? false : "database tests are opt-in" },
  async () => {
    assert.ok(databaseUrl);

    const client = new Client({ connectionString: databaseUrl });
    const ids = {
      accountId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      callerId: crypto.randomUUID(),
      inputItemId: crypto.randomUUID(),
      actionId: crypto.randomUUID()
    };

    await client.connect();
    try {
      await seedDatabaseRows(client, ids);
      await client.query("set role agent_outbox_app");
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

      const answeredRows = await client.query(
        `
          select i.status, i.answered_at, o.expires_at
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
          select status, current_revision
          from public.agent_outbox_input_items
          where input_item_id = $1
        `,
        [ids.inputItemId]
      );
      assert.deepEqual(restoredRows.rows[0], {
        status: "pending",
        current_revision: 2
      });
    } finally {
      await resetRoleAndRollback(client);
      await cleanupDatabaseRows(client, ids);
      await client.end();
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
      statement.sql.includes("insert into public.agent_outbox_output_results")
    ) {
      return queryResult(rowsByKind.outputRows ?? []);
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
  await client.query("reset role");
  await client.query("begin");
  try {
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.audit_break_glass",
      "on"
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
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * @param {import("pg").Client} client
 */
async function resetRoleAndRollback(client) {
  for (const sql of ["rollback", "reset role"]) {
    try {
      await client.query(sql);
    } catch {
      // Best-effort cleanup after a failed database assertion.
    }
  }
}
