import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeOutputInTransaction,
  checkOutputPageInTransaction,
  outputFileMetadataStatement,
  outputPageStatement,
  outputResultByIdStatement,
  parseOutputPageQuery,
  parseOutputReadAllBody,
  readAllOutputPageInTransaction,
  readOutputResultInTransaction
} from "../src/server/output-queue.ts";

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

const context = {
  requestId: "req-output-test",
  correlationId: "corr-output-test"
};

const outputOneId = "00000000-0000-4000-8000-000000000101";
const outputTwoId = "00000000-0000-4000-8000-000000000102";

/**
 * @param {Partial<QueryResultRow>} overrides
 * @returns {QueryResultRow}
 */
function outputRow(overrides = {}) {
  return {
    output_result_id: outputOneId,
    caller_id: identity.callerId,
    caller_item_id: "email:thread_123",
    action_value: "send",
    response_kind: "free_text",
    response_payload: { text: "Approved response." },
    answered_at: "2026-06-30T12:00:00.000Z",
    answered_by_user_id: "00000000-0000-4000-8000-0000000000ab",
    ...overrides
  };
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
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

test("output check returns cursor-paginated readiness metadata only", async () => {
  const query = fakeQuery([
    [{ ready_count: 3 }],
    [
      outputRow(),
      outputRow({
        output_result_id: outputTwoId,
        caller_item_id: "email:thread_456",
        action_value: "archive",
        response_payload: { text: "Hidden from check." },
        answered_at: "2026-06-30T12:01:00.000Z"
      })
    ]
  ]);

  const result = await checkOutputPageInTransaction(query, identity, 1, null);

  assert.equal(result.ok, true);
  if (!result.ok || !("ready_count" in result.data)) {
    assert.fail("expected output check page");
  }
  assert.deepEqual(result.data.items, [
    {
      output_result_id: outputOneId,
      caller_item_id: "email:thread_123",
      answered_at: "2026-06-30T12:00:00.000Z"
    }
  ]);
  assert.equal(result.data.ready_count, 3);
  assert.equal(result.data.has_more, true);
  assert.deepEqual(decodeCursor(result.data.next_cursor), {
    answered_at: "2026-06-30T12:00:00.000Z",
    output_result_id: outputOneId
  });
  assert.equal(result.data.returned_count, 1);
  assert.equal(result.data.page_limit, 1);
  assert.doesNotMatch(JSON.stringify(result), /action_value|response|files/);
  assert.equal(
    query.calls.some((call) => call.sql.includes("first_read_at")),
    false
  );
});

test("read one returns payload and file metadata only, then marks the result read", async () => {
  const query = fakeQuery([
    [
      outputRow({
        response_kind: "file_upload",
        response_payload: {}
      })
    ],
    [
      {
        output_result_id: outputOneId,
        file_id: "00000000-0000-4000-8000-000000000201",
        filename: "receipt.pdf",
        mime_type: "text/html",
        size_bytes: "123",
        sha256: "a".repeat(64),
        file_bytes: Buffer.from("must not appear")
      }
    ],
    []
  ]);

  const result = await readOutputResultInTransaction(
    query,
    identity,
    outputOneId
  );

  assert.deepEqual(result, {
    ok: true,
    data: {
      output_result_id: outputOneId,
      caller_id: identity.callerId,
      caller_item_id: "email:thread_123",
      action_value: "send",
      response: {
        kind: "file_upload",
        file: {
          file_id: "00000000-0000-4000-8000-000000000201",
          filename: "receipt.pdf",
          mime_type: "application/octet-stream",
          size_bytes: 123,
          sha256: "a".repeat(64)
        }
      },
      answered_at: "2026-06-30T12:00:00.000Z",
      answered_by: "00000000-0000-4000-8000-0000000000ab"
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /must not appear/);
  assert.match(query.calls[2].sql, /first_read_at = coalesce/);
});

test("read all marks only returned output rows and exposes pagination", async () => {
  const query = fakeQuery([
    [
      outputRow(),
      outputRow({
        output_result_id: outputTwoId,
        caller_item_id: "email:thread_456",
        response_payload: { text: "Second page." },
        answered_at: "2026-06-30T12:01:00.000Z"
      })
    ],
    [],
    []
  ]);

  const result = await readAllOutputPageInTransaction(query, identity, 1, null);

  assert.equal(result.ok, true);
  if (!result.ok || !("items" in result.data)) {
    assert.fail("expected output read page");
  }
  assert.deepEqual(
    result.data.items.map((item) => item.output_result_id),
    [outputOneId]
  );
  assert.equal(result.data.has_more, true);
  assert.equal(query.calls[2].values?.length, 1);
  assert.deepEqual(query.calls[2].values, [outputOneId]);
});

test("ack deletes live output and recognizes duplicate acknowledgements", async () => {
  const liveQuery = fakeQuery([
    [{ output_result_id: outputOneId }],
    [{ output_deleted: true, input_deleted: true, files_deleted: 0 }]
  ]);
  const duplicateQuery = fakeQuery([[], [{ already_recorded: true }]]);

  const live = await acknowledgeOutputInTransaction(
    liveQuery,
    identity,
    context,
    outputOneId
  );
  const duplicate = await acknowledgeOutputInTransaction(
    duplicateQuery,
    identity,
    context,
    outputOneId
  );

  assert.deepEqual(live, {
    ok: true,
    data: {
      output_result_id: outputOneId,
      acknowledged: true,
      already_acknowledged: false
    }
  });
  assert.match(liveQuery.calls[1].sql, /agent_outbox_delete_output_result/);
  assert.deepEqual(duplicate, {
    ok: true,
    data: {
      output_result_id: outputOneId,
      acknowledged: true,
      already_acknowledged: true
    }
  });
  assert.match(
    duplicateQuery.calls[1].sql,
    /agent_outbox_output_ack_already_recorded/
  );
});

test("output pagination parsing fails loudly on invalid limits and cursors", () => {
  assert.deepEqual(parseOutputPageQuery(new URLSearchParams()), {
    ok: true,
    limit: 25,
    cursor: null
  });
  assert.deepEqual(parseOutputReadAllBody({ limit: 101, cursor: null }), {
    ok: false,
    error: {
      status: 422,
      code: "validation_failed",
      message: "Output queue request failed validation.",
      fields: [
        {
          path: "limit",
          code: "invalid_limit",
          message: "limit must be an integer from 1 through 100."
        }
      ]
    }
  });
  assert.equal(
    parseOutputReadAllBody({ limit: 25, cursor: "not-a-cursor" }).ok,
    false
  );
});

test("output query builders scope by authenticated caller and metadata-only file reads", () => {
  assert.deepEqual(outputResultByIdStatement(identity, outputOneId).values, [
    identity.accountId,
    identity.callerId,
    outputOneId
  ]);
  assert.match(outputPageStatement(identity, 25, null).sql, /caller_id = \$2/);

  const fileMetadata = outputFileMetadataStatement([outputOneId]);
  assert.match(fileMetadata.sql, /filename/);
  assert.match(fileMetadata.sql, /size_bytes/);
  assert.doesNotMatch(fileMetadata.sql, /file_bytes/);
});

/**
 * @param {string | null} cursor
 */
function decodeCursor(cursor) {
  assert.ok(cursor);
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}
