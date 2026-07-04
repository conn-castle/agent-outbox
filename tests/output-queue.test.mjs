import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeOutputInTransaction,
  checkOutputPageInTransaction,
  cursorFromOutputRow,
  handleOutputAckRequest,
  handleOutputCheckRequest,
  handleOutputReadAllRequest,
  handleOutputReadRequest,
  outputCheckPageStatement,
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
    answered_at_cursor: "2026-06-30T12:00:00.000000Z",
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
    answered_at: "2026-06-30T12:00:00.000000Z",
    output_result_id: outputOneId
  });
  assert.equal(result.data.returned_count, 1);
  assert.equal(result.data.page_limit, 1);
  assert.doesNotMatch(JSON.stringify(result), /action_value|response|files/);
  assert.equal(
    query.calls.some((call) => call.sql.includes("first_read_at")),
    false
  );
  assert.doesNotMatch(
    query.calls[1].sql,
    /action_value|response_kind|response_payload|answered_by_user_id/
  );
  // check is non-mutating and must never lock rows, so pages read concurrently
  // stay available to the mutating read/read-all/ack paths.
  assert.doesNotMatch(query.calls[1].sql, /for update/i);
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

test("read one fails loud on invalid file metadata before marking output read", async () => {
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
        mime_type: "application/pdf",
        size_bytes: "-1",
        sha256: "a".repeat(64)
      }
    ]
  ]);

  const result = await readOutputResultInTransaction(
    query,
    identity,
    outputOneId
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Output file metadata is temporarily unavailable."
    }
  });
  assert.equal(query.calls.length, 2);
  assert.equal(
    query.calls.some((call) => call.sql.includes("first_read_at")),
    false
  );
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
  assert.equal(query.calls[2].values?.length, 3);
  assert.deepEqual(query.calls[2].values, [
    identity.accountId,
    identity.callerId,
    outputOneId
  ]);
  assert.match(query.calls[2].sql, /account_id = \$1/);
  assert.match(query.calls[2].sql, /caller_id = \$2/);
  // read-all must lock the page rows FOR UPDATE (like the single-read path) so a
  // concurrent undo/ack/cleanup cannot delete or restore a returned row before
  // the mark-read update runs, which would otherwise hand the caller an
  // undone/deleted output without disabling undo.
  assert.match(query.calls[0].sql, /for update/i);
});

test("read one preserves authoritative response kind over payload keys", async () => {
  const query = fakeQuery([
    [
      outputRow({
        response_kind: "free_text",
        response_payload: { kind: "multi_select", text: "Approved response." }
      })
    ],
    [],
    []
  ]);

  const result = await readOutputResultInTransaction(
    query,
    identity,
    outputOneId
  );

  assert.equal(result.ok, true);
  if (!result.ok || !("response" in result.data)) {
    assert.fail("expected output result");
  }
  assert.deepEqual(result.data.response, {
    kind: "free_text",
    text: "Approved response."
  });
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
  assert.match(duplicateQuery.calls[1].sql, /agent_outbox_audit_events/);
  assert.match(duplicateQuery.calls[1].sql, /agent_outbox_callers/);
  assert.match(
    duplicateQuery.calls[1].sql,
    /event\.output_result_id = \$3::uuid/
  );
  assert.match(duplicateQuery.calls[1].sql, /caller\.account_id = \$1::uuid/);
  assert.match(duplicateQuery.calls[1].sql, /caller\.caller_id = \$2::uuid/);
  assert.match(duplicateQuery.calls[1].sql, /agent_outbox_context_account_id/);
  assert.match(
    duplicateQuery.calls[1].sql,
    /agent_outbox_context_allows_caller/
  );
  assert.deepEqual(duplicateQuery.calls[1].values, [
    identity.accountId,
    identity.callerId,
    outputOneId
  ]);
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
  assert.equal(
    parseOutputReadAllBody({
      limit: 25,
      cursor: Buffer.from(
        JSON.stringify({
          answered_at: "2026-02-30T00:00:00.000000Z",
          output_result_id: outputOneId
        }),
        "utf8"
      ).toString("base64url")
    }).ok,
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
  assert.doesNotMatch(
    outputCheckPageStatement(identity, 25, null).sql,
    /action_value|response_kind|response_payload|answered_by_user_id/
  );
  assert.match(
    outputCheckPageStatement(identity, 25, null).sql,
    /answered_at_cursor/
  );

  const fileMetadata = outputFileMetadataStatement(identity, [outputOneId]);
  assert.match(fileMetadata.sql, /filename/);
  assert.match(fileMetadata.sql, /size_bytes/);
  assert.doesNotMatch(fileMetadata.sql, /file_bytes/);
  assert.match(fileMetadata.sql, /account_id = \$1/);
  assert.match(fileMetadata.sql, /caller_id = \$2/);
  assert.deepEqual(fileMetadata.values, [
    identity.accountId,
    identity.callerId,
    outputOneId
  ]);
});

test("output page cursor preserves microsecond precision across the keyset round-trip", () => {
  // node-postgres parses timestamptz into a millisecond-precision Date, so the
  // page query renders answered_at as a full-precision string that casts back to
  // the exact stored instant. The keyset cursor must carry that string verbatim,
  // otherwise a millisecond cursor stays strictly less than a microsecond column
  // value and pagination repeats the boundary row forever.
  assert.ok(
    outputPageStatement(identity, 25, null).sql.includes(
      `to_char(answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as answered_at_cursor`
    )
  );

  const cursor = cursorFromOutputRow(
    /** @type {any} */ ({
      output_result_id: outputOneId,
      // A Date that only carries millisecond precision; encoding this instead of
      // answered_at_cursor would drop the microseconds below.
      answered_at: new Date("2026-06-30T23:25:51.123Z"),
      answered_at_cursor: "2026-06-30T23:25:51.123456Z"
    })
  );

  assert.deepEqual(decodeCursor(cursor), {
    answered_at: "2026-06-30T23:25:51.123456Z",
    output_result_id: outputOneId
  });

  const parsed = parseOutputReadAllBody({ limit: 10, cursor });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.cursor) {
    assert.fail("expected parsed cursor");
  }
  assert.equal(parsed.cursor.answeredAt, "2026-06-30T23:25:51.123456Z");

  // The exact microsecond string flows through as the $3 keyset parameter so the
  // next page compares against the precise stored instant.
  const nextPage = outputPageStatement(identity, 10, parsed.cursor);
  assert.match(nextPage.sql, /\$3::timestamptz/);
  assert.ok(nextPage.values);
  assert.equal(nextPage.values[2], "2026-06-30T23:25:51.123456Z");
});

test("output request wrappers surface the caller-transaction config guard", async () => {
  // With no app-role connection string configured, withAuthenticatedCallerTransaction
  // must short-circuit before any auth/quota/DB work. Every exported wrapper has to
  // route through it, so removing the guard (or bypassing the wrapper) changes the
  // returned code/message and fails this test.
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
      await handleOutputCheckRequest(
        new Request("https://api.test/api/output/check"),
        context
      ),
      expected
    );
    assert.deepEqual(
      await handleOutputReadRequest(
        new Request("https://api.test/api/output/read", { method: "POST" }),
        context,
        outputOneId
      ),
      expected
    );
    assert.deepEqual(
      await handleOutputReadAllRequest(
        new Request("https://api.test/api/output/read-all", { method: "POST" }),
        context,
        {}
      ),
      expected
    );
    assert.deepEqual(
      await handleOutputAckRequest(
        new Request("https://api.test/api/output/ack", { method: "POST" }),
        context,
        outputOneId
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

test("output request wrappers reject malformed requests before the transaction", async () => {
  // These request-shape guards run ahead of withAuthenticatedCallerTransaction, so a
  // missing DATABASE_APP_ROLE_URL must not change the 400/422 outcome.
  const previous = process.env.DATABASE_APP_ROLE_URL;
  delete process.env.DATABASE_APP_ROLE_URL;
  try {
    const readMissingId = await handleOutputReadRequest(
      new Request("https://api.test/api/output/read", { method: "POST" }),
      context,
      ""
    );
    assert.deepEqual(readMissingId, {
      ok: false,
      error: {
        status: 400,
        code: "invalid_request",
        message: "output_result_id is required."
      }
    });

    const ackMissingId = await handleOutputAckRequest(
      new Request("https://api.test/api/output/ack", { method: "POST" }),
      context,
      ""
    );
    assert.equal(ackMissingId.ok, false);
    assert.equal(ackMissingId.ok ? null : ackMissingId.error.status, 400);

    const readAllBadBody = await handleOutputReadAllRequest(
      new Request("https://api.test/api/output/read-all", { method: "POST" }),
      context,
      "not-an-object"
    );
    assert.equal(readAllBadBody.ok, false);
    assert.equal(readAllBadBody.ok ? null : readAllBadBody.error.status, 422);
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previous;
    }
  }
});

/**
 * @param {string | null} cursor
 */
function decodeCursor(cursor) {
  assert.ok(cursor);
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}
