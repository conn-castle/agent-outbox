import { Buffer } from "node:buffer";

import {
  auditSafeLifecycleEvent,
  type AuditSafeLifecycleEvent
} from "./accounting.ts";
import {
  apiResponseHeaders,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import {
  accountLimitProfileForAccount,
  enforceCallerRequestLimits
} from "./caller-api-limits.ts";
import {
  authenticateCallerApiRequestWithDatabase,
  type CallerIdentity
} from "./caller-api-auth.ts";
import { emitRuntimeLog } from "./logging.ts";

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
  response_kind: AuditSafeLifecycleEvent["response_kind"];
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

export async function handleOutputFileDownloadRequest(
  request: Request,
  context: ApiRequestContext,
  path: OutputFileDownloadPath
): Promise<OutputFileDownloadResult> {
  const pathError = validateOutputFileDownloadPath(path);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return {
      ok: false,
      error: temporaryUnavailableError(
        "Caller API database configuration is unavailable."
      )
    };
  }

  try {
    const auth = await authenticateCallerApiRequestWithDatabase(
      request,
      context,
      connectionString
    );
    if (!auth.ok) {
      return { ok: false, error: auth.clientError };
    }

    return await runProductTransaction(
      connectionString,
      {
        requestId: context.requestId,
        authSurface: "caller",
        accountId: auth.accountId,
        callerId: auth.callerId
      },
      async (query) => {
        return handleOutputFileDownloadAuthenticatedTransaction(
          query,
          context,
          auth,
          path
        );
      }
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "api",
      operation: "output_file_download",
      message: "Output file download failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: context.requestId
    });
    return {
      ok: false,
      error: temporaryUnavailableError(
        "Output file download is temporarily unavailable."
      )
    };
  }
}

export async function handleOutputFileDownloadAuthenticatedTransaction(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  auth: CallerIdentity,
  path: OutputFileDownloadPath
): Promise<OutputFileDownloadResult> {
  const profile = await accountLimitProfileForAccount(query, auth.accountId);
  if (!profile) {
    return {
      ok: false,
      error: temporaryUnavailableError(
        "Output file download is temporarily unavailable."
      )
    };
  }

  const limit = await enforceCallerRequestLimits(
    query,
    auth,
    profile,
    "output_file_download"
  );
  if (!limit.ok) {
    return { ok: false, error: limit.error };
  }

  return outputFileDownloadInTransaction(query, context, auth, path);
}

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

  const result = await query<OutputFileDownloadRow>(
    outputFileDownloadStatement(identity, path)
  );
  const row = result.rows[0];
  if (!row) {
    return {
      ok: false,
      error: {
        status: 404,
        code: "not_found",
        message: "Output file was not found."
      }
    };
  }

  const bytes = normalizeFileBytes(row.file_bytes);
  const sizeBytes = byteCount(row.size_bytes);
  if (bytes.byteLength !== sizeBytes) {
    return {
      ok: false,
      error: temporaryUnavailableError(
        "Output file metadata is temporarily unavailable."
      )
    };
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
        and f.output_result_id::text = $3
        and f.output_file_id::text = $4
      limit 1
      for update of f, o
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
  const event = auditSafeLifecycleEvent({
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

  return {
    sql: `
      insert into public.agent_outbox_audit_events(
        event_type,
        account_audit_id,
        caller_audit_id,
        input_item_id,
        output_result_id,
        output_file_id,
        item_status,
        response_kind,
        file_bytes,
        request_id,
        correlation_id,
        caller_item_id_hash,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
    `,
    values: [
      event.event_type,
      event.account_audit_id,
      event.caller_audit_id ?? null,
      event.input_item_id ?? null,
      event.output_result_id ?? null,
      event.output_file_id ?? null,
      event.item_status ?? null,
      event.response_kind ?? null,
      event.file_bytes ?? null,
      event.request_id ?? null,
      event.correlation_id ?? null,
      event.caller_item_id_hash ?? null,
      JSON.stringify(event.metadata)
    ]
  };
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

  return null;
}

function byteCount(value: string | number) {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("size_bytes must be a non-negative safe integer");
  }

  return count;
}

function temporaryUnavailableError(message: string): ApiErrorInput {
  return {
    status: 503,
    code: "temporary_unavailable",
    message
  };
}
