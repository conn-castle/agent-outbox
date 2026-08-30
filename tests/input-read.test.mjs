import assert from "node:assert/strict";
import test from "node:test";

import { enforceCallerOperationLimits } from "../src/server/caller-api-auth.ts";
import {
  CanonicalInputIntegrityError,
  canonicalInputActionsStatement,
  canonicalInputLinkButtonsStatement,
  canonicalInputOptionsStatement,
  canonicalInputRootsStatement,
  isCanonicalInputIntegrityError,
  materializeCanonicalInputsByItemId,
  reconstructCanonicalInput,
  reportCanonicalInputIntegrityFailure
} from "../src/server/canonical-input.ts";
import {
  INPUT_READ_LIMIT_OPERATION_KIND,
  cursorFromInputRow,
  handleInputListRequest,
  handleInputReadRequest,
  inputListPageStatement,
  listInputsInTransaction,
  liveInputForReadStatement,
  parseInputPageQuery,
  parseInputReadBody,
  readInputInTransaction
} from "../src/server/input-read.ts";
import { sha256Hex, stableStringify } from "../src/server/input-schema.ts";
import {
  PUBLIC_API_EXAMPLES,
  publicCanonicalRawInputShapeMatches,
  publicInputSubmissionShapeMatches,
  publicSchemaMatches
} from "../src/shared/public-api-contract.ts";
import {
  CANONICAL_INPUT_ONE_ID as inputOneId,
  CANONICAL_INPUT_TWO_ID as inputTwoId,
  CANONICAL_TEST_IDENTITY as identity,
  canonicalFormsFromSubmission,
  parseValidSubmission,
  richPublicInput,
  storedRowsFromSubmission
} from "./helpers/canonical-input.mjs";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

const context = {
  requestId: "req-input-read-test",
  correlationId: "corr-input-read-test"
};

function parseValid(input = richPublicInput()) {
  return parseValidSubmission(input);
}

/**
 * @param {QueryResultRow[][]} rowsByCall
 * @param {{ roots?: QueryResultRow[]; links?: QueryResultRow[]; actions?: QueryResultRow[]; options?: QueryResultRow[] }} canonical
 * @returns {MockProductTransactionQuery}
 */
function fakeQuery(rowsByCall, canonical = {}) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /** @param {TransactionContextStatement} statement */
  const query = async (statement) => {
    calls.push(statement);
    if (
      statement.sql.includes("normalized_content_fingerprint") &&
      !/for update/i.test(statement.sql)
    ) {
      return queryResult(canonical.roots ?? []);
    }
    if (statement.sql.includes("agent_outbox_input_link_buttons")) {
      return queryResult(canonical.links ?? []);
    }
    if (statement.sql.includes("agent_outbox_input_action_popup_options")) {
      return queryResult(canonical.options ?? []);
    }
    if (
      statement.sql.includes("agent_outbox_input_actions") &&
      statement.sql.includes("join public.agent_outbox_input_items")
    ) {
      return queryResult(canonical.actions ?? []);
    }
    const sequential = calls.filter(
      (call) =>
        !(
          call.sql.includes("normalized_content_fingerprint") &&
          !/for update/i.test(call.sql)
        ) &&
        !call.sql.includes("agent_outbox_input_link_buttons") &&
        !call.sql.includes("agent_outbox_input_action_popup_options") &&
        !(
          call.sql.includes("agent_outbox_input_actions") &&
          call.sql.includes("join public.agent_outbox_input_items")
        )
    );
    return queryResult(rowsByCall[sequential.length - 1] ?? []);
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

/**
 * @param {QueryResultRow[]} rows
 */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

function listRow(overrides = {}) {
  return {
    input_item_id: inputOneId,
    caller_item_id: "workflow:nested",
    status: "pending",
    current_revision: 1,
    created_at: "2026-06-30T12:00:00.000Z",
    updated_at: "2026-06-30T12:05:00.000Z",
    answered_at: null,
    ...overrides
  };
}

/** @param {string} cursor */
function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

test("canonical reconstruction restores nested variants, defaults, and public shape", () => {
  const submission = parseValid(
    richPublicInput({ extra_unknown_property: "must not be retained" })
  );
  const stored = storedRowsFromSubmission(inputOneId, submission);
  const result = reconstructCanonicalInput({
    root: stored.root,
    linkButtons: stored.links,
    actions: stored.actions,
    options: stored.options
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected reconstructed canonical input");
  }
  assert.equal(result.input.caller_item_id, "workflow:nested");
  assert.equal(result.input.status, "pending");
  assert.equal(result.input.revision, 1);
  assert.equal(result.input.answered_at, null);
  assert.equal(publicInputSubmissionShapeMatches(result.input.raw_input), true);
  assert.equal(
    publicCanonicalRawInputShapeMatches(result.input.raw_input),
    true
  );
  assert.equal("extra_unknown_property" in result.input.raw_input, false);
  assert.equal(result.input.raw_input.priority, "normal");
  assert.equal(result.input.raw_input.skip_disabled, false);
  assert.equal(result.input.raw_input.corner, null);
  assert.equal(result.input.raw_input.details, null);
  assert.equal(result.input.raw_input.row_accent_color, null);
  assert.deepEqual(result.input.raw_input.card_visual, {
    kind: "progress_ring",
    label: "Progress",
    value: 4,
    display: "4/10",
    unit: "%",
    min_value: 0,
    max_value: 10,
    color: "blue"
  });

  const actions = /** @type {Array<Record<string, any>>} */ (
    result.input.raw_input.actions
  );
  assert.equal(actions[0].tone, "success");
  assert.equal(actions[0].style, "solid");
  assert.equal("tone" in actions[1], false);
  assert.equal("style" in actions[1], false);
  assert.deepEqual(actions[1].popup, {
    kind: "free_text",
    label: "Notes",
    placeholder: null,
    default_value: null,
    multiline: true,
    min_length: null,
    max_length: 200
  });
  assert.deepEqual(actions[2].popup.options, [
    { display: "A", value: "a", icon: "check" },
    { display: "B", value: "b", icon: null }
  ]);
  assert.equal(
    actions[2].popup.options.some(
      (/** @type {Record<string, unknown>} */ option) =>
        "displayOrder" in option
    ),
    false
  );
  assert.equal(actions[3].popup.min_selected, 0);
  assert.equal(actions[3].popup.max_selected, 2);
  assert.equal(actions[4].popup.mode, "date");
  assert.equal(actions[5].popup.accept_mime_types, null);
  assert.deepEqual(
    result.input.raw_input.link_buttons,
    submission.normalizedContent.link_buttons
  );

  const { fingerprintForm } = canonicalFormsFromSubmission(submission);
  assert.equal(
    sha256Hex(stableStringify(fingerprintForm)),
    submission.normalizedContentFingerprint
  );
  const fingerprintActions = /** @type {Array<Record<string, any>>} */ (
    fingerprintForm.actions
  );
  assert.equal(fingerprintActions[2].popup.options[0].displayOrder, 0);
});

test("canonical reconstruction restores pill and numeric bar visuals", () => {
  const pill = parseValid(
    richPublicInput({
      card_visual: {
        kind: "pill",
        text: "Needs review",
        icon: "check",
        color: "orange"
      },
      actions: [
        {
          display: "Ack",
          icon: "check",
          value: "ack",
          overflow: false,
          popup: { kind: "none" }
        }
      ]
    })
  );
  const numeric = parseValid(
    richPublicInput({
      card_visual: {
        kind: "numeric_bar",
        label: "Score",
        value: 8,
        display: "8/10",
        unit: null,
        min_value: 0,
        max_value: 10
      },
      actions: [
        {
          display: "Ack",
          icon: "check",
          value: "ack",
          overflow: false,
          popup: { kind: "none" }
        }
      ]
    })
  );

  const pillStored = storedRowsFromSubmission(inputOneId, pill);
  const numericStored = storedRowsFromSubmission(inputTwoId, numeric);
  const pillResult = reconstructCanonicalInput({
    root: pillStored.root,
    linkButtons: pillStored.links,
    actions: pillStored.actions,
    options: pillStored.options
  });
  const numericResult = reconstructCanonicalInput({
    root: numericStored.root,
    linkButtons: numericStored.links,
    actions: numericStored.actions,
    options: numericStored.options
  });

  assert.equal(pillResult.ok, true);
  assert.equal(numericResult.ok, true);
  if (!pillResult.ok || !numericResult.ok) {
    assert.fail("expected visual reconstructions");
  }
  assert.deepEqual(pillResult.input.raw_input.card_visual, {
    kind: "pill",
    text: "Needs review",
    icon: "check",
    color: "orange"
  });
  assert.deepEqual(numericResult.input.raw_input.card_visual, {
    kind: "numeric_bar",
    label: "Score",
    value: 8,
    display: "8/10",
    unit: null,
    min_value: 0,
    max_value: 10
  });
});

test("fingerprint mismatch and public-schema failure are temporary_unavailable", () => {
  const submission = parseValid();
  const stored = storedRowsFromSubmission(inputOneId, submission, {
    normalized_content_fingerprint: "0".repeat(64)
  });
  const mismatch = reconstructCanonicalInput({
    root: stored.root,
    linkButtons: stored.links,
    actions: stored.actions,
    options: stored.options
  });
  assert.deepEqual(mismatch, {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Canonical input is temporarily unavailable."
    }
  });
  assert.equal(JSON.stringify(mismatch).includes("Canonical title"), false);

  const emptyActionsFingerprint = sha256Hex(
    stableStringify(
      canonicalFormsFromSubmission({ ...submission, actions: [] })
        .fingerprintForm
    )
  );
  const schemaFailure = reconstructCanonicalInput({
    root: {
      ...stored.root,
      normalized_content_fingerprint: emptyActionsFingerprint
    },
    linkButtons: stored.links,
    actions: [],
    options: []
  });
  assert.equal(schemaFailure.ok, false);
  if (schemaFailure.ok) {
    assert.fail("expected public schema failure");
  }
  assert.equal(schemaFailure.error.code, "temporary_unavailable");
  assert.equal(schemaFailure.error.status, 503);
});

test("input list returns caller-scoped metadata in stable indexed keyset order", async () => {
  const query = fakeQuery([
    [
      listRow(),
      listRow({
        input_item_id: inputTwoId,
        caller_item_id: "workflow:later",
        status: "answered",
        current_revision: 2,
        created_at: "2026-06-30T12:01:00.000Z",
        answered_at: "2026-06-30T12:02:00.000Z"
      })
    ]
  ]);

  const result = await listInputsInTransaction(query, identity, 1, null);

  assert.equal(result.ok, true);
  if (!result.ok || !("items" in result.data)) {
    assert.fail("expected input list page");
  }
  assert.deepEqual(result.data.items, [
    {
      caller_item_id: "workflow:nested",
      status: "pending",
      revision: 1,
      created_at: "2026-06-30T12:00:00.000Z",
      updated_at: "2026-06-30T12:05:00.000Z",
      answered_at: null
    }
  ]);
  assert.equal(result.data.has_more, true);
  assert.equal(result.data.returned_count, 1);
  assert.equal(result.data.page_limit, 1);
  assert.ok(result.data.next_cursor);
  assert.deepEqual(decodeCursor(result.data.next_cursor), {
    input_item_id: inputOneId
  });
  assert.equal("input_item_id" in result.data.items[0], false);
  assert.equal("raw_input" in result.data.items[0], false);
  assert.doesNotMatch(query.calls[0].sql, /for update/i);
  assert.deepEqual(query.calls[0].values, [
    identity.accountId,
    identity.callerId,
    2
  ]);
});

test("input list cursor uses the indexed internal UUID without exposing it", () => {
  const cursor = cursorFromInputRow({
    input_item_id: inputOneId
  });
  const parsed = parseInputPageQuery(
    new URLSearchParams({ limit: "10", cursor })
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.cursor) {
    assert.fail("expected parsed input cursor");
  }
  const nextPage = inputListPageStatement(identity, 10, parsed.cursor);
  assert.match(nextPage.sql, /i\.input_item_id > \$3::uuid/);
  assert.ok(nextPage.values);
  assert.equal(nextPage.values[2], inputOneId);
  assert.equal(nextPage.values[3], 11);
});

test("input read returns canonical raw_input for the authenticated caller only", async () => {
  const submission = parseValid();
  const stored = storedRowsFromSubmission(inputOneId, submission, {
    status: "answered",
    answered_at: "2026-06-30T12:02:00.000Z"
  });
  const query = fakeQuery([[stored.root]], {
    links: stored.links,
    actions: stored.actions,
    options: stored.options
  });

  const result = await readInputInTransaction(
    query,
    identity,
    submission.callerItemId
  );

  assert.equal(result.ok, true);
  if (!result.ok || !("raw_input" in result.data)) {
    assert.fail("expected input read result");
  }
  assert.equal(result.data.caller_item_id, submission.callerItemId);
  assert.equal(result.data.status, "answered");
  assert.equal(result.data.answered_at, "2026-06-30T12:02:00.000Z");
  assert.equal(publicInputSubmissionShapeMatches(result.data.raw_input), true);
  assert.equal(
    publicCanonicalRawInputShapeMatches(result.data.raw_input),
    true
  );
  assert.equal(JSON.stringify(result.data).includes(inputOneId), false);
  assert.match(query.calls[0].sql, /for update/i);
  assert.deepEqual(query.calls[0].values, [
    identity.accountId,
    identity.callerId,
    submission.callerItemId
  ]);
  assert.equal(
    query.calls.some((call) => call.sql.includes("first_read_at")),
    false
  );
});

test("input read returns not_found for a missing live item", async () => {
  const query = fakeQuery([[]]);
  const result = await readInputInTransaction(query, identity, "missing:item");
  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message: "Input item was not found for this caller."
    }
  });
  assert.equal(query.calls.length, 1);
});

test("child-table reads join through caller-owned input rows", () => {
  for (const statement of [
    canonicalInputLinkButtonsStatement(identity, [inputOneId]),
    canonicalInputActionsStatement(identity, [inputOneId]),
    canonicalInputOptionsStatement(identity, [inputOneId])
  ]) {
    assert.ok(statement.values);
    assert.deepEqual(statement.values.slice(0, 2), [
      identity.accountId,
      identity.callerId
    ]);
    assert.match(statement.sql, /join public\.agent_outbox_input_items i/);
  }

  const roots = canonicalInputRootsStatement(identity, [inputOneId]);
  assert.ok(roots.values);
  assert.deepEqual(roots.values.slice(0, 2), [
    identity.accountId,
    identity.callerId
  ]);
  assert.match(
    liveInputForReadStatement(identity, "workflow:nested").sql,
    /for update/i
  );
});

test("input page parsing fails loudly on invalid limits and cursors", () => {
  assert.deepEqual(parseInputPageQuery(new URLSearchParams()), {
    ok: true,
    limit: 25,
    cursor: null
  });
  assert.equal(parseInputPageQuery(new URLSearchParams("limit=101")).ok, false);
  assert.equal(
    parseInputPageQuery(new URLSearchParams("cursor=not-a-cursor")).ok,
    false
  );
  assert.equal(parseInputReadBody({ caller_item_id: "" }).ok, false);
  assert.equal(parseInputReadBody(null).ok, false);
  assert.equal(parseInputReadBody("email:thread_123").ok, false);
  assert.equal(parseInputReadBody(["email:thread_123"]).ok, false);
  assert.deepEqual(parseInputReadBody({ caller_item_id: "email:thread_123" }), {
    ok: true,
    callerItemId: "email:thread_123"
  });
});

test("input read wrappers surface the caller-transaction config guard", async () => {
  const previous = process.env.DATABASE_APP_ROLE_URL;
  delete process.env.DATABASE_APP_ROLE_URL;
  try {
    const expected = {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Caller API database configuration is unavailable."
      }
    };
    assert.deepEqual(
      await handleInputListRequest(
        new Request("https://api.test/api/input/list"),
        context
      ),
      expected
    );
    assert.deepEqual(
      await handleInputReadRequest(
        new Request("https://api.test/api/input/read", { method: "POST" }),
        context,
        { caller_item_id: "email:thread_123" }
      ),
      expected
    );
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previous;
    }
  }
});

test("input read locks the caller-scoped root and treats a concurrent miss as not_found", async () => {
  const submission = parseValid();
  const stored = storedRowsFromSubmission(inputOneId, submission);
  const query = fakeQuery([[stored.root]], {
    links: stored.links,
    actions: stored.actions,
    options: stored.options
  });

  const result = await readInputInTransaction(
    query,
    identity,
    submission.callerItemId
  );

  assert.equal(result.ok, true);
  assert.match(query.calls[0].sql, /for update/i);
  assert.deepEqual(query.calls[0].values, [
    identity.accountId,
    identity.callerId,
    submission.callerItemId
  ]);
  assert.equal(
    query.calls.filter((call) => /for update/i.test(call.sql)).length,
    1
  );

  const missing = await readInputInTransaction(
    fakeQuery([[]]),
    identity,
    submission.callerItemId
  );
  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected not_found after the root lock misses");
  }
  assert.equal(missing.error.code, "not_found");
});

test("malformed locked input throws a content-free integrity error", async () => {
  const submission = parseValid();
  const stored = storedRowsFromSubmission(inputOneId, submission, {
    normalized_content_fingerprint: "0".repeat(64)
  });
  const query = fakeQuery([[stored.root]], {
    links: stored.links,
    actions: stored.actions,
    options: stored.options
  });

  await assert.rejects(
    () => readInputInTransaction(query, identity, submission.callerItemId),
    (error) => {
      assert.equal(isCanonicalInputIntegrityError(error), true);
      const integrity = /** @type {CanonicalInputIntegrityError} */ (error);
      assert.equal(integrity.inputItemId, inputOneId);
      assert.equal(integrity.accountId, identity.accountId);
      assert.equal(integrity.callerId, identity.callerId);
      assert.equal(
        integrity.message,
        "Canonical input integrity check failed."
      );
      assert.equal(
        JSON.stringify(integrity).includes("Canonical title"),
        false
      );
      return true;
    }
  );
});

test("canonical integrity reporting uses a distinct operation and safe identifiers", () => {
  const error = new CanonicalInputIntegrityError({
    inputItemId: inputOneId,
    accountId: identity.accountId,
    callerId: identity.callerId
  });
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const originalError = console.error;
  console.error = (line) => {
    logs.push(JSON.parse(String(line)));
  };
  try {
    reportCanonicalInputIntegrityFailure(error, {
      ...context,
      route: "/api/input/read",
      method: "POST"
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  assert.equal(logs[0].operation, "canonical_input_integrity");
  assert.equal(logs[0].input_item_id, inputOneId);
  assert.equal(logs[0].account_id, identity.accountId);
  assert.equal(logs[0].caller_id, identity.callerId);
  assert.equal(logs[0].message, "Canonical input integrity check failed.");
  assert.equal(JSON.stringify(logs).includes("Canonical title"), false);
  assert.equal(logs[0].error_name, "CanonicalInputIntegrityError");
});

test("input list and read share output_check_read limits under distinct operations", async () => {
  const query = fakeQuery([
    [{ tier: "hosted_free" }],
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
  const result = await enforceCallerOperationLimits(
    query,
    identity,
    INPUT_READ_LIMIT_OPERATION_KIND,
    "Input read operation is temporarily unavailable."
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected output_check_read throttle");
  }
  assert.equal(result.error.code, "rate_limit_exceeded");
  assert.equal(
    result.error.limit && "limit_name" in result.error.limit
      ? result.error.limit.limit_name
      : null,
    "output_check_read_requests_per_account_per_minute"
  );
});

test("canonical raw_input examples are default-expanded and stricter than requests", () => {
  assert.equal(
    publicSchemaMatches("InputSubmission", PUBLIC_API_EXAMPLES.inputSubmission),
    true
  );
  assert.equal(
    publicSchemaMatches(
      "CanonicalRawInput",
      PUBLIC_API_EXAMPLES.inputSubmission
    ),
    false
  );
  assert.equal(
    publicSchemaMatches(
      "CanonicalRawInput",
      PUBLIC_API_EXAMPLES.canonicalRawInput
    ),
    true
  );
  assert.equal(
    publicSchemaMatches(
      "InputSubmission",
      PUBLIC_API_EXAMPLES.canonicalRawInput
    ),
    true
  );
  assert.deepEqual(
    PUBLIC_API_EXAMPLES.readSuccess.data.raw_input,
    PUBLIC_API_EXAMPLES.canonicalRawInput
  );
  assert.deepEqual(
    PUBLIC_API_EXAMPLES.readInputSuccess.data.raw_input,
    PUBLIC_API_EXAMPLES.canonicalRawInput
  );
  assert.equal(PUBLIC_API_EXAMPLES.canonicalRawInput.skip_disabled, false);
  assert.equal(PUBLIC_API_EXAMPLES.canonicalRawInput.card_visual, null);
  assert.equal(PUBLIC_API_EXAMPLES.canonicalRawInput.corner, null);
});

test("batch materialize throws integrity errors without leaking review content", async () => {
  const submission = parseValid();
  const stored = storedRowsFromSubmission(inputOneId, submission, {
    normalized_content_fingerprint: "0".repeat(64)
  });
  const query = fakeQuery([], {
    roots: [stored.root],
    links: stored.links,
    actions: stored.actions,
    options: stored.options
  });

  await assert.rejects(
    () => materializeCanonicalInputsByItemId(query, identity, [inputOneId]),
    (error) => {
      assert.equal(isCanonicalInputIntegrityError(error), true);
      assert.equal(JSON.stringify(error).includes("Canonical title"), false);
      return true;
    }
  );
});
