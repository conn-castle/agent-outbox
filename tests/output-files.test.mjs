import assert from "node:assert/strict";
import test from "node:test";

import { consumesMonthlyCallerApiRequestQuota } from "../src/server/accounting.ts";
import {
  outputFileDownloadAuditStatement,
  outputFileDownloadHeaders,
  outputFileDownloadInTransaction,
  outputFileDownloadStatement,
  safeAttachmentFilename,
  safeContentType
} from "../src/server/output-files.ts";

/**
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 */

const context = {
  requestId: "req-file-test",
  correlationId: "corr-file-test"
};

const identity = {
  accountId: "00000000-0000-4000-8000-000000000001",
  callerId: "00000000-0000-4000-8000-000000000002"
};

const path = {
  outputResultId: "00000000-0000-4000-8000-000000000003",
  fileId: "00000000-0000-4000-8000-000000000004"
};

/**
 * @param {Partial<import("../src/server/output-files.ts").OutputFileDownloadAuditRow & { filename: string, mime_type: string | null, file_bytes: Buffer }>} overrides
 * @returns {import("../src/server/output-files.ts").OutputFileDownloadAuditRow & { filename: string, mime_type: string | null, file_bytes: Buffer }}
 */
function fileRow(overrides = {}) {
  return {
    output_file_id: path.fileId,
    output_result_id: path.outputResultId,
    input_item_id: "00000000-0000-4000-8000-000000000005",
    account_audit_id: "00000000-0000-4000-8000-0000000000a1",
    caller_audit_id: "00000000-0000-4000-8000-0000000000c1",
    caller_item_id_hash: "e".repeat(64),
    response_kind: /** @type {"file_upload"} */ ("file_upload"),
    filename: "receipt.pdf",
    mime_type: "application/pdf",
    size_bytes: 7,
    file_bytes: Buffer.from("payload"),
    ...overrides
  };
}

/**
 * @param {QueryResultRow[][]} rowsByCall
 * @returns {ProductTransactionQuery & { calls: TransactionContextStatement[] }}
 */
function fakeQuery(rowsByCall) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   */
  const query = async (statement) => {
    calls.push(statement);
    const rows = rowsByCall[calls.length - 1] ?? [];
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed =
    /** @type {ProductTransactionQuery & { calls: TransactionContextStatement[] }} */ (
      /** @type {unknown} */ (query)
    );
  typed.calls = calls;
  return typed;
}

test("output file download lookup scopes by account caller output and file ids", () => {
  const statement = outputFileDownloadStatement(identity, path);

  assert.deepEqual(statement.values, [
    identity.accountId,
    identity.callerId,
    path.outputResultId,
    path.fileId
  ]);
  assert.match(statement.sql, /from public\.agent_outbox_output_files f/);
  assert.match(statement.sql, /join public\.agent_outbox_output_results o/);
  assert.match(statement.sql, /f\.account_id = \$1/);
  assert.match(statement.sql, /f\.caller_id = \$2/);
  // Cast id columns to text so a non-UUID path segment yields zero rows (404)
  // instead of a Postgres 22P02 uuid cast error swallowed into a 503.
  assert.match(statement.sql, /f\.output_result_id::text = \$3/);
  assert.match(statement.sql, /f\.output_file_id::text = \$4/);
  assert.match(statement.sql, /for update of f, o/i);
});

test("output file download returns raw bytes and writes content-safe byte audit", async () => {
  const query = fakeQuery([[fileRow()]]);
  const result = await outputFileDownloadInTransaction(
    query,
    context,
    identity,
    path
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.bytes.toString("utf8") : "", "payload");
  assert.equal(
    result.ok ? result.headers.get("Content-Type") : "",
    "application/pdf"
  );
  assert.equal(result.ok ? result.headers.get("Content-Length") : "", "7");

  assert.equal(query.calls.length, 2);
  assert.match(query.calls[1].sql, /agent_outbox_audit_events/);
  assert.deepEqual(query.calls[1].values, [
    "file_downloaded",
    "00000000-0000-4000-8000-0000000000a1",
    "00000000-0000-4000-8000-0000000000c1",
    "00000000-0000-4000-8000-000000000005",
    path.outputResultId,
    path.fileId,
    "answered",
    "file_upload",
    7,
    "req-file-test",
    "corr-file-test",
    "e".repeat(64),
    "{}"
  ]);
  assert.doesNotMatch(JSON.stringify(query.calls[1]), /payload|receipt\.pdf/);
});

test("output file download reports not found without audit when ids do not match", async () => {
  const query = fakeQuery([[]]);
  const result = await outputFileDownloadInTransaction(
    query,
    context,
    identity,
    path
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message: "Output file was not found."
    }
  });
  assert.equal(query.calls.length, 1);
});

test("file download headers force attachment nosniff and safe content metadata", () => {
  const headers = outputFileDownloadHeaders(context, {
    filename: '../résumé "Q2".html',
    mimeType: "text/html",
    sizeBytes: "123"
  });

  assert.equal(headers.get("X-Request-ID"), "req-file-test");
  assert.equal(headers.get("X-Correlation-ID"), "corr-file-test");
  assert.equal(headers.get("Content-Type"), "application/octet-stream");
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("Content-Length"), "123");
  assert.equal(
    headers.get("Content-Disposition"),
    'attachment; filename=".._re_sume_ _Q2_.html"'
  );
});

test("file download MIME and filename sanitizers reject active content and header breaks", () => {
  assert.equal(safeContentType("application/pdf"), "application/pdf");
  assert.equal(safeContentType("IMAGE/PNG"), "image/png");
  assert.equal(safeContentType("text/html"), "application/octet-stream");
  assert.equal(safeContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(
    safeContentType("text/plain; charset=utf-8"),
    "application/octet-stream"
  );
  assert.equal(safeContentType(null), "application/octet-stream");

  assert.equal(safeAttachmentFilename(""), "download");
  assert.equal(
    safeAttachmentFilename("..\nsecret/path.txt"),
    ".._secret_path.txt"
  );
});

test("output file download counts as a monthly caller API request operation by classifier", () => {
  assert.equal(
    consumesMonthlyCallerApiRequestQuota("output_file_download"),
    true
  );
});

test("audit statement records byte count only, never raw file content", () => {
  const statement = outputFileDownloadAuditStatement(
    fileRow({
      filename: "secret-name.txt",
      file_bytes: Buffer.from("secret bytes")
    }),
    context
  );

  assert.equal(statement.values?.[0], "file_downloaded");
  assert.equal(statement.values?.[8], 7);
  assert.doesNotMatch(JSON.stringify(statement), /secret-name|secret bytes/);
});
