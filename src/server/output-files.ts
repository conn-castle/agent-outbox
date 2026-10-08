import { Buffer } from "node:buffer";

import type { PopupKind } from "../shared/input-schema-rules.ts";
import { auditEventInsertStatement } from "./accounting.ts";
import {
  apiResponseHeaders,
  apiTemporaryUnavailable,
  apiValidationFailed,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import {
  runGuardedCallerTransaction,
  type CallerIdentity
} from "./caller-api-auth.ts";
import { isStorableString, unstorableStringError } from "./input-schema.ts";

export type OutputFileDownloadSuccess = {
  ok: true;
  bytes: Buffer;
  headers: Headers;
};

export type OutputFileDownloadResult =
  OutputFileDownloadSuccess | { ok: false; error: ApiErrorInput };

export type OutputFileDownloadPath = {
  outputResultId: string;
  fileId: string;
};

type OutputFileDownloadRow = {
  output_file_id: string;
  output_result_id: string;
  input_item_id: string;
  account_audit_id: string;
  caller_audit_id: string;
  caller_item_id_hash: string;
  response_kind: PopupKind;
  filename: string;
  mime_type: string | null;
  size_bytes: string | number;
  file_bytes: Buffer | Uint8Array;
};

export type OutputFileDownloadAuditRow = Pick<
  OutputFileDownloadRow,
  | "account_audit_id"
  | "caller_audit_id"
  | "input_item_id"
  | "output_result_id"
  | "output_file_id"
  | "caller_item_id_hash"
  | "response_kind"
  | "size_bytes"
>;

/**
 * Checks that both path ids are present and storable, then authenticates the
 * caller and enforces download limits. Canonical UUID checks happen later in
 * the transaction reader, not before authentication.
 */
export async function handleOutputFileDownloadRequest(
  request: Request,
  context: ApiRequestContext,
  path: OutputFileDownloadPath
): Promise<OutputFileDownloadResult> {
  const pathError = validateOutputFileDownloadPath(path);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  return runGuardedCallerTransaction(
    request,
    context,
    {
      rateLimitKind: "output_file_download",
      loggedOperation: "output_file_download",
      unavailableMessage: "Output file download is temporarily unavailable.",
      unexpectedFailureMessage: "Output file download failed unexpectedly."
    },
    /**
     * Delegates the transaction, context, authenticated identity, and path to
     * the file reader after authentication and download limits.
     */
    (query, identity) =>
      outputFileDownloadInTransaction(query, context, identity, path)
  );
}

/**
 * Reads one output file in a transaction the caller has already authenticated
 * and limited. Repeats the present-and-storable path check, then treats a
 * non-canonical output id as not found before locking that output row. A
 * non-canonical file id is not found only after that lock. The file row is
 * locked next. A byte length that disagrees with the stored size is
 * temporarily unavailable; a match is audited and returned with download
 * headers.
 */
export async function outputFileDownloadInTransaction(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  identity: CallerIdentity,
  path: OutputFileDownloadPath
): Promise<OutputFileDownloadResult> {
  const pathError = validateOutputFileDownloadPath(path);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  const notFound: OutputFileDownloadResult = {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message: "Output file was not found."
    }
  };
  if (!CANONICAL_UUID_PATTERN.test(path.outputResultId)) {
    return notFound;
  }
  // Lock the output row before its file row, matching acknowledgement,
  // pre-read undo, and cleanup, whose output deletion cascades to file rows.
  const output = await query(
    callerOutputLockStatement(identity, path.outputResultId)
  );
  if (output.rows.length === 0) {
    return notFound;
  }
  if (!CANONICAL_UUID_PATTERN.test(path.fileId)) {
    return notFound;
  }

  const result = await query<OutputFileDownloadRow>(
    outputFileDownloadStatement(identity, path)
  );
  const row = result.rows[0];
  if (!row) {
    return notFound;
  }

  const bytes = normalizeFileBytes(row.file_bytes);
  const sizeBytes = byteCount(row.size_bytes);
  if (bytes.byteLength !== sizeBytes) {
    return apiTemporaryUnavailable(
      "Output file metadata is temporarily unavailable."
    );
  }

  await query(
    outputFileDownloadAuditStatement({ ...row, size_bytes: sizeBytes }, context)
  );

  return {
    ok: true,
    bytes,
    headers: outputFileDownloadHeaders(context, {
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes
    })
  };
}

// Only canonical lowercase UUIDs can match a stored output or file id. Callers
// check ids against this before the uuid casts below so a malformed path id
// cannot abort the caller's transaction.
export const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function callerOutputLockStatement(
  identity: CallerIdentity,
  outputResultId: string
): TransactionContextStatement {
  return {
    sql: `
      select output_result_id::text as output_result_id
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        and output_result_id = $3::uuid
      for update
    `,
    values: [identity.accountId, identity.callerId, outputResultId]
  };
}

export function outputFileDownloadStatement(
  identity: CallerIdentity,
  path: OutputFileDownloadPath
): TransactionContextStatement {
  return {
    sql: `
      select
        f.output_file_id,
        f.output_result_id,
        o.input_item_id,
        a.account_audit_id,
        c.caller_audit_id,
        i.caller_item_id_hash,
        o.response_kind,
        f.filename,
        f.mime_type,
        f.size_bytes,
        f.file_bytes
      from public.agent_outbox_output_files f
      join public.agent_outbox_output_results o
        on o.account_id = f.account_id
       and o.caller_id = f.caller_id
       and o.output_result_id = f.output_result_id
      join public.agent_outbox_input_items i
        on i.account_id = o.account_id
       and i.caller_id = o.caller_id
       and i.input_item_id = o.input_item_id
      join public.agent_outbox_accounts a
        on a.account_id = f.account_id
      join public.agent_outbox_callers c
        on c.account_id = f.account_id
       and c.caller_id = f.caller_id
      where f.account_id = $1
        and f.caller_id = $2
        and f.output_result_id = $3::uuid
        and f.output_file_id = $4::uuid
      limit 1
      for update of f
    `,
    values: [
      identity.accountId,
      identity.callerId,
      path.outputResultId,
      path.fileId
    ]
  };
}

export function outputFileDownloadAuditStatement(
  row: OutputFileDownloadAuditRow,
  context: ApiRequestContext
): TransactionContextStatement {
  return auditEventInsertStatement({
    eventType: "file_downloaded",
    accountAuditId: row.account_audit_id,
    callerAuditId: row.caller_audit_id,
    inputItemId: row.input_item_id,
    outputResultId: row.output_result_id,
    outputFileId: row.output_file_id,
    itemStatus: "answered",
    responseKind: row.response_kind,
    fileBytes: byteCount(row.size_bytes),
    requestId: context.requestId,
    correlationId: context.correlationId,
    callerItemIdHash: row.caller_item_id_hash,
    metadata: {}
  });
}

export function outputFileDownloadHeaders(
  context: ApiRequestContext,
  input: {
    filename: string;
    mimeType: string | null;
    sizeBytes: string | number;
  }
) {
  const headers = apiResponseHeaders(context);

  headers.set("Content-Type", safeContentType(input.mimeType));
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${safeAttachmentFilename(input.filename)}"`
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(byteCount(input.sizeBytes)));

  return headers;
}

export function safeContentType(mimeType: string | null | undefined) {
  const normalized = mimeType?.trim().toLowerCase();
  if (
    !normalized ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
  ) {
    return "application/octet-stream";
  }

  if (
    normalized === "text/html" ||
    normalized === "application/xhtml+xml" ||
    normalized === "image/svg+xml" ||
    normalized === "text/xml" ||
    normalized === "application/xml"
  ) {
    return "application/octet-stream";
  }

  return normalized;
}

export function safeAttachmentFilename(filename: string) {
  const safe = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\/:*?<>|;\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  if (!safe || safe === "." || safe === "..") {
    return "download";
  }

  return safe;
}

function normalizeFileBytes(fileBytes: Buffer | Uint8Array) {
  return Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
}

function validateOutputFileDownloadPath(path: OutputFileDownloadPath) {
  if (!path.outputResultId || !path.fileId) {
    return {
      status: 400,
      code: "invalid_request",
      message: "output_result_id and file_id are required."
    } satisfies ApiErrorInput;
  }

  const fields = [
    ...(isStorableString(path.outputResultId)
      ? []
      : [unstorableStringError("output_result_id")]),
    ...(isStorableString(path.fileId) ? [] : [unstorableStringError("file_id")])
  ];
  if (fields.length > 0) {
    return apiValidationFailed(
      "Output file download request failed validation.",
      fields
    ).error;
  }

  return null;
}

function byteCount(value: string | number) {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("size_bytes must be a non-negative safe integer");
  }

  return count;
}
