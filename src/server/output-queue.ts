import {
  apiTemporaryUnavailable,
  apiTimestamp,
  apiValidationFailed,
  isJsonRecord,
  parseBoundedPageLimit,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";
import {
  duplicateAcknowledgementLookupStatement,
  terminalOutputDeletionStatement
} from "./cleanup.ts";
import {
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import type { JsonValue, OutputResponseKind } from "./human-answer.ts";
import { isValidUtcDateTime } from "./input-schema.ts";
import {
  runGuardedCallerTransaction,
  type CallerIdentity
} from "./caller-api-auth.ts";
import { safeContentType } from "./output-files.ts";
import {
  CanonicalInputIntegrityError,
  materializeCanonicalInputsByItemId
} from "./canonical-input.ts";
import {
  OutputReadAllRequestSchema,
  publicOutputReadAllShapeMatches,
  publicSchemaFieldErrors
} from "../shared/public-api-contract.ts";

export const OUTPUT_PAGE_DEFAULT_LIMIT = SYSTEM_CONTRACT.outputPageDefaultLimit;
export const OUTPUT_PAGE_MAX_LIMIT = SYSTEM_CONTRACT.outputPageMaxLimit;

const outputCheckReadOperation = {
  rateLimitKind: "output_check_read",
  loggedOperation: "output_check_read",
  unavailableMessage: "Output queue operation is temporarily unavailable.",
  unexpectedFailureMessage: "Output queue operation failed unexpectedly."
} as const;

export type OutputQueueResult =
  { ok: true; data: OutputQueueSuccess } | { ok: false; error: ApiErrorInput };

export type OutputQueueSuccess =
  OutputCheckPage | AgentOutboxOutputResult | OutputReadPage | OutputAckResult;

export type OutputCheckItem = {
  output_result_id: string;
  caller_item_id: string;
  answered_at: string;
};

export type OutputCheckPage = {
  items: OutputCheckItem[];
  ready_count: number;
  has_more: boolean;
  next_cursor: string | null;
  returned_count: number;
  page_limit: number;
};

export type AgentOutboxOutputResult = {
  output_result_id: string;
  caller_id: string;
  caller_item_id: string;
  action_value: string;
  response: JsonValue;
  answered_at: string;
  answered_by: string | null;
  raw_input: Record<string, unknown>;
};

export type OutputReadPage = {
  items: AgentOutboxOutputResult[];
  unavailable_outputs: OutputUnavailableItem[];
  unavailable_count: number;
  has_more: boolean;
  next_cursor: string | null;
  returned_count: number;
  page_limit: number;
};

export type OutputUnavailableItem = {
  output_result_id: string;
  code: "temporary_unavailable";
  message: "Output file metadata is temporarily unavailable.";
};

export type OutputAckResult = {
  output_result_id: string;
  acknowledged: true;
  already_acknowledged: boolean;
};

type ParsedPageRequest =
  | {
      ok: true;
      limit: number;
      cursor: OutputCursor | null;
    }
  | {
      ok: false;
      error: ApiErrorInput;
    };

type OutputCursor = {
  answeredAt: string;
  outputResultId: string;
};

type OutputRow = {
  output_result_id: string;
  caller_id: string;
  caller_item_id: string;
  input_item_id: string;
  action_value: string;
  response_kind: OutputResponseKind;
  response_payload: unknown;
  answered_at: string | Date;
  answered_by_user_id: string | null;
};

type OutputPageCursorRow = {
  output_result_id: string;
  answered_at: string | Date;
  answered_at_cursor: string;
};

type OutputCheckPageRow = OutputPageCursorRow & {
  caller_item_id: string;
};

// Rows returned by paginated output statements carry a full-precision string rendering
// of answered_at so the keyset cursor matches the raw timestamptz column exactly
// (node-postgres truncates timestamptz to millisecond-precision Date objects).
type OutputPageRow = OutputRow & OutputPageCursorRow;

type OutputFileMetadataRow = {
  output_result_id: string;
  file_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: string | number;
  sha256: string;
};

type ReadyCountRow = {
  ready_count: string | number;
};

type TerminalDeletionRow = {
  output_deleted: boolean;
  input_deleted: boolean;
  files_deleted: string | number;
};

type DuplicateAckRow = {
  already_recorded: boolean;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleOutputCheckRequest(
  request: Request,
  context: ApiRequestContext
): Promise<OutputQueueResult> {
  const parsed = parseOutputPageQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return parsed;
  }

  return runGuardedCallerTransaction(
    request,
    context,
    outputCheckReadOperation,
    (query, identity) =>
      checkOutputPageInTransaction(query, identity, parsed.limit, parsed.cursor)
  );
}

export async function handleOutputReadRequest(
  request: Request,
  context: ApiRequestContext,
  outputResultId: string
): Promise<OutputQueueResult> {
  if (!outputResultId) {
    return outputResultIdRequiredError();
  }

  return runGuardedCallerTransaction(
    request,
    context,
    outputCheckReadOperation,
    (query, identity) =>
      readOutputResultInTransaction(query, identity, outputResultId)
  );
}

export async function handleOutputReadAllRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown
): Promise<OutputQueueResult> {
  const parsed = parseOutputReadAllBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  return runGuardedCallerTransaction(
    request,
    context,
    outputCheckReadOperation,
    (query, identity) =>
      readAllOutputPageInTransaction(
        query,
        identity,
        parsed.limit,
        parsed.cursor
      )
  );
}

export async function handleOutputAckRequest(
  request: Request,
  context: ApiRequestContext,
  outputResultId: string
): Promise<OutputQueueResult> {
  if (!outputResultId) {
    return outputResultIdRequiredError();
  }

  return runGuardedCallerTransaction(
    request,
    context,
    {
      rateLimitKind: "output_ack",
      loggedOperation: "output_ack",
      unavailableMessage: "Output queue operation is temporarily unavailable.",
      unexpectedFailureMessage: "Output queue operation failed unexpectedly."
    },
    (query, identity) =>
      acknowledgeOutputInTransaction(query, identity, context, outputResultId)
  );
}

export async function checkOutputPageInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  limit: number,
  cursor: OutputCursor | null
): Promise<OutputQueueResult> {
  const readyCount = await query<ReadyCountRow>(
    outputReadyCountStatement(identity)
  );
  const pageRows = await query<OutputCheckPageRow>(
    outputCheckPageStatement(identity, limit, cursor)
  );
  const page = pageRows.rows.slice(0, limit);
  const hasMore = pageRows.rows.length > limit;

  return {
    ok: true,
    data: {
      items: page.map(outputCheckItemFromRow),
      ready_count: Number(readyCount.rows[0].ready_count),
      has_more: hasMore,
      next_cursor: hasMore ? cursorFromOutputRow(page[page.length - 1]) : null,
      returned_count: page.length,
      page_limit: limit
    }
  };
}

export async function readOutputResultInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  outputResultId: string
): Promise<OutputQueueResult> {
  const result = await query<OutputRow>(
    outputResultByIdStatement(identity, outputResultId)
  );
  const row = result.rows[0];
  if (!row) {
    return notFoundError();
  }

  const filesByOutputId = await outputFileMetadataByResultId(query, identity, [
    row.output_result_id
  ]);
  const output = outputResultFromRow(row, filesByOutputId);
  if (!output.ok) {
    return output;
  }

  const rawInputs = await canonicalRawInputsForOutputRows(query, identity, [
    row
  ]);
  const rawInput = requiredRawInput(rawInputs, row.input_item_id, identity);

  await query(markOutputResultsReadStatement(identity, [row.output_result_id]));
  return {
    ok: true,
    data: {
      ...output.data,
      raw_input: rawInput
    }
  };
}

export async function readAllOutputPageInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  limit: number,
  cursor: OutputCursor | null
): Promise<OutputQueueResult> {
  const pageRows = await query<OutputPageRow>(
    outputPageStatement(identity, limit, cursor, { lockRows: true })
  );
  const page = pageRows.rows.slice(0, limit);
  const hasMore = pageRows.rows.length > limit;
  const outputResultIds = page.map((row) => row.output_result_id);
  const filesByOutputId = await outputFileMetadataByResultId(
    query,
    identity,
    outputResultIds
  );
  const eligible: {
    row: OutputPageRow;
    data: Omit<AgentOutboxOutputResult, "raw_input">;
  }[] = [];
  const unavailableOutputs: OutputUnavailableItem[] = [];

  for (const row of page) {
    const output = outputResultFromRow(row, filesByOutputId);
    if (!output.ok) {
      if (row.response_kind !== "file_upload") {
        return output;
      }
      unavailableOutputs.push({
        output_result_id: row.output_result_id,
        code: "temporary_unavailable",
        message: "Output file metadata is temporarily unavailable."
      });
      continue;
    }
    eligible.push({ row, data: output.data });
  }

  const rawInputs = await canonicalRawInputsForOutputRows(
    query,
    identity,
    eligible.map(({ row }) => row)
  );
  const items: AgentOutboxOutputResult[] = eligible.map(({ row, data }) => ({
    ...data,
    raw_input: requiredRawInput(rawInputs, row.input_item_id, identity)
  }));

  const returnedOutputResultIds = items.map((item) => item.output_result_id);
  if (returnedOutputResultIds.length > 0) {
    await query(
      markOutputResultsReadStatement(identity, returnedOutputResultIds)
    );
  }

  return {
    ok: true,
    data: {
      items,
      unavailable_outputs: unavailableOutputs,
      unavailable_count: unavailableOutputs.length,
      has_more: hasMore,
      next_cursor: hasMore ? cursorFromOutputRow(page[page.length - 1]) : null,
      returned_count: items.length,
      page_limit: limit
    }
  };
}

export async function acknowledgeOutputInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  context: ApiRequestContext,
  outputResultId: string
): Promise<OutputQueueResult> {
  const liveResult = await query<{ output_result_id: string }>(
    outputIdForAcknowledgementStatement(identity, outputResultId)
  );
  const liveOutputResultId = liveResult.rows[0]?.output_result_id;

  if (liveOutputResultId) {
    const deletion = await query<TerminalDeletionRow>(
      terminalOutputDeletionStatement(
        liveOutputResultId,
        "acknowledgement",
        context.requestId
      )
    );
    if (deletion.rows[0]?.output_deleted) {
      return {
        ok: true,
        data: {
          output_result_id: outputResultId,
          acknowledged: true,
          already_acknowledged: false
        }
      };
    }
  }

  if (UUID_PATTERN.test(outputResultId)) {
    const duplicate = await query<DuplicateAckRow>(
      duplicateAcknowledgementLookupStatement(identity, outputResultId)
    );
    if (duplicate.rows[0]?.already_recorded) {
      return {
        ok: true,
        data: {
          output_result_id: outputResultId,
          acknowledged: true,
          already_acknowledged: true
        }
      };
    }
  }

  return notFoundError();
}

export function parseOutputPageQuery(
  searchParams: URLSearchParams
): ParsedPageRequest {
  return parseOutputPageParameters({
    limit: searchParams.get("limit"),
    cursor: searchParams.get("cursor")
  });
}

export function parseOutputReadAllBody(body: unknown): ParsedPageRequest {
  if (!isJsonRecord(body)) {
    return validationFailed([
      {
        path: "",
        code: "invalid_request",
        message: "Request body must be an object."
      }
    ]);
  }

  if (
    body.limit !== undefined &&
    body.limit !== null &&
    typeof body.limit !== "number"
  ) {
    return validationFailed([
      {
        path: "limit",
        code: "invalid_limit",
        message: `limit must be an integer from 1 through ${OUTPUT_PAGE_MAX_LIMIT}.`
      }
    ]);
  }

  const parsed = parseOutputPageParameters({
    limit: body.limit,
    cursor: body.cursor
  });
  if (!parsed.ok) return parsed;
  if (publicOutputReadAllShapeMatches(body)) return parsed;

  return validationFailed(
    publicSchemaFieldErrors(
      OutputReadAllRequestSchema,
      body,
      "Request does not match the public read-all contract."
    )
  );
}

export function outputReadyCountStatement(
  identity: CallerIdentity
): TransactionContextStatement {
  return {
    sql: `
      select count(*)::integer as ready_count
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
    `,
    values: [identity.accountId, identity.callerId]
  };
}

export function outputPageStatement(
  identity: CallerIdentity,
  limit: number,
  cursor: OutputCursor | null,
  options: { lockRows?: boolean } = {}
): TransactionContextStatement {
  const values: (string | number)[] = [identity.accountId, identity.callerId];
  const cursorClause = cursor
    ? "and (answered_at, output_result_id) > ($3::timestamptz, $4::uuid)"
    : "";

  if (cursor) {
    values.push(cursor.answeredAt, cursor.outputResultId);
  }

  values.push(limit + 1);

  // read-all locks the page rows FOR UPDATE (like the single-read path) so a
  // concurrent undo/ack/cleanup cannot delete or restore a row between the
  // select and the mark-read update; the non-mutating check path never locks.
  const lockClause = options.lockRows ? "\n      for update" : "";

  return {
    sql: `
      select
        output_result_id::text as output_result_id,
        caller_id::text as caller_id,
        caller_item_id,
        input_item_id::text as input_item_id,
        action_value,
        response_kind,
        response_payload,
        answered_at,
        to_char(answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as answered_at_cursor,
        answered_by_user_id::text as answered_by_user_id
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        ${cursorClause}
      order by answered_at, output_result_id
      limit $${values.length}${lockClause}
    `,
    values
  };
}

export function outputCheckPageStatement(
  identity: CallerIdentity,
  limit: number,
  cursor: OutputCursor | null
): TransactionContextStatement {
  const values: (string | number)[] = [identity.accountId, identity.callerId];
  const cursorClause = cursor
    ? "and (answered_at, output_result_id) > ($3::timestamptz, $4::uuid)"
    : "";

  if (cursor) {
    values.push(cursor.answeredAt, cursor.outputResultId);
  }

  values.push(limit + 1);

  return {
    sql: `
      select
        output_result_id::text as output_result_id,
        caller_item_id,
        answered_at,
        to_char(answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as answered_at_cursor
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        ${cursorClause}
      order by answered_at, output_result_id
      limit $${values.length}
    `,
    values
  };
}

export function outputResultByIdStatement(
  identity: CallerIdentity,
  outputResultId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        output_result_id::text as output_result_id,
        caller_id::text as caller_id,
        caller_item_id,
        input_item_id::text as input_item_id,
        action_value,
        response_kind,
        response_payload,
        answered_at,
        answered_by_user_id::text as answered_by_user_id
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        and output_result_id::text = $3
      for update
    `,
    values: [identity.accountId, identity.callerId, outputResultId]
  };
}

export function outputFileMetadataStatement(
  identity: CallerIdentity,
  outputResultIds: readonly string[]
): TransactionContextStatement {
  const placeholders = outputResultIds.map((_, index) => `$${index + 3}`);

  return {
    sql: `
      select
        output_result_id::text as output_result_id,
        output_file_id::text as file_id,
        filename,
        mime_type,
        size_bytes,
        sha256
      from public.agent_outbox_output_files
      where account_id = $1
        and caller_id = $2
        and output_result_id in (${placeholders.join(", ")})
      order by output_result_id, display_order, output_file_id
    `,
    values: [identity.accountId, identity.callerId, ...outputResultIds]
  };
}

export function markOutputResultsReadStatement(
  identity: CallerIdentity,
  outputResultIds: readonly string[]
): TransactionContextStatement {
  const placeholders = outputResultIds.map((_, index) => `$${index + 3}`);

  return {
    sql: `
      update public.agent_outbox_output_results
      set
        first_read_at = coalesce(first_read_at, now()),
        read_count = read_count + 1
      where account_id = $1
        and caller_id = $2
        and output_result_id in (${placeholders.join(", ")})
    `,
    values: [identity.accountId, identity.callerId, ...outputResultIds]
  };
}

export function outputIdForAcknowledgementStatement(
  identity: CallerIdentity,
  outputResultId: string
): TransactionContextStatement {
  return {
    sql: `
      select output_result_id::text as output_result_id
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        and output_result_id::text = $3
      for update
    `,
    values: [identity.accountId, identity.callerId, outputResultId]
  };
}

async function outputFileMetadataByResultId(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  outputResultIds: readonly string[]
) {
  const filesByOutputId = new Map<string, OutputFileMetadataRow[]>();
  if (outputResultIds.length === 0) {
    return filesByOutputId;
  }

  const result = await query<OutputFileMetadataRow>(
    outputFileMetadataStatement(identity, outputResultIds)
  );
  for (const row of result.rows) {
    const rows = filesByOutputId.get(row.output_result_id) ?? [];
    rows.push(row);
    filesByOutputId.set(row.output_result_id, rows);
  }
  return filesByOutputId;
}

async function canonicalRawInputsForOutputRows(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  rows: readonly OutputRow[]
): Promise<Map<string, Record<string, unknown>>> {
  const materialized = await materializeCanonicalInputsByItemId(
    query,
    identity,
    rows.map((row) => row.input_item_id)
  );
  const byInputItemId = new Map<string, Record<string, unknown>>();
  for (const [inputItemId, input] of materialized) {
    byInputItemId.set(inputItemId, input.raw_input);
  }
  return byInputItemId;
}

function requiredRawInput(
  rawInputs: Map<string, Record<string, unknown>>,
  inputItemId: string,
  identity: CallerIdentity
) {
  const rawInput = rawInputs.get(inputItemId);
  if (!rawInput) {
    throw new CanonicalInputIntegrityError({
      inputItemId,
      accountId: identity.accountId,
      callerId: identity.callerId
    });
  }
  return rawInput;
}

function outputResultFromRow(
  row: OutputRow,
  filesByOutputId: ReadonlyMap<string, OutputFileMetadataRow[]>
):
  | { ok: true; data: Omit<AgentOutboxOutputResult, "raw_input"> }
  | { ok: false; error: ApiErrorInput } {
  const response = outputResponse(
    row,
    filesByOutputId.get(row.output_result_id) ?? []
  );
  if (!response.ok) {
    return response;
  }

  return {
    ok: true,
    data: {
      output_result_id: row.output_result_id,
      caller_id: row.caller_id,
      caller_item_id: row.caller_item_id,
      action_value: row.action_value,
      response: response.data,
      answered_at: apiTimestamp(row.answered_at),
      answered_by: row.answered_by_user_id
    }
  };
}

function outputResponse(
  row: OutputRow,
  files: readonly OutputFileMetadataRow[]
): { ok: true; data: JsonValue } | { ok: false; error: ApiErrorInput } {
  if (row.response_kind === "none") {
    return { ok: true, data: { kind: "none" } };
  }

  if (row.response_kind === "file_upload") {
    const file = files[0];
    if (!file) {
      return temporaryUnavailableError(
        "Output file metadata is temporarily unavailable."
      );
    }
    const sizeBytes =
      typeof file.size_bytes === "number"
        ? file.size_bytes
        : Number(file.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return temporaryUnavailableError(
        "Output file metadata is temporarily unavailable."
      );
    }

    return {
      ok: true,
      data: {
        kind: "file_upload",
        file: {
          file_id: file.file_id,
          filename: file.filename,
          mime_type: safeContentType(file.mime_type),
          size_bytes: sizeBytes,
          sha256: file.sha256
        }
      }
    };
  }

  if (!isJsonRecord(row.response_payload)) {
    return temporaryUnavailableError(
      "Output response payload is temporarily unavailable."
    );
  }

  return {
    ok: true,
    data: {
      ...row.response_payload,
      kind: row.response_kind
    } as JsonValue
  };
}

function outputCheckItemFromRow(row: OutputCheckPageRow): OutputCheckItem {
  return {
    output_result_id: row.output_result_id,
    caller_item_id: row.caller_item_id,
    answered_at: apiTimestamp(row.answered_at)
  };
}

function parseOutputPageParameters(input: {
  limit: unknown;
  cursor: unknown;
}): ParsedPageRequest {
  const limit = parseBoundedPageLimit(
    input.limit,
    OUTPUT_PAGE_DEFAULT_LIMIT,
    OUTPUT_PAGE_MAX_LIMIT
  );
  const cursor = parseCursor(input.cursor);
  const fields = [
    ...(limit.ok ? [] : limit.fields),
    ...(cursor.ok ? [] : cursor.fields)
  ];

  if (!limit.ok || !cursor.ok) {
    return validationFailed(fields);
  }

  return {
    ok: true,
    limit: limit.value,
    cursor: cursor.value
  };
}

function parseCursor(value: unknown) {
  if (value == null || value === "") {
    return { ok: true as const, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false as const,
      fields: [
        {
          path: "cursor",
          code: "invalid_cursor",
          message: "cursor must be an opaque string or null."
        }
      ]
    };
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      isJsonRecord(parsed) &&
      typeof parsed.answered_at === "string" &&
      typeof parsed.output_result_id === "string" &&
      isValidUtcDateTime(parsed.answered_at) &&
      UUID_PATTERN.test(parsed.output_result_id)
    ) {
      return {
        ok: true as const,
        value: {
          answeredAt: parsed.answered_at,
          outputResultId: parsed.output_result_id
        }
      };
    }
  } catch {
    // Return the safe validation error below.
  }

  return {
    ok: false as const,
    fields: [
      {
        path: "cursor",
        code: "invalid_cursor",
        message: "cursor is invalid or expired."
      }
    ]
  };
}

export function cursorFromOutputRow(row: OutputPageCursorRow) {
  return Buffer.from(
    JSON.stringify({
      answered_at: row.answered_at_cursor,
      output_result_id: row.output_result_id
    }),
    "utf8"
  ).toString("base64url");
}

function validationFailed(fields: ApiErrorInput["fields"]): {
  ok: false;
  error: ApiErrorInput;
} {
  return apiValidationFailed("Output queue request failed validation.", fields);
}

function notFoundError(): OutputQueueResult {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message: "Output result was not found for this caller."
    }
  };
}

function outputResultIdRequiredError(): OutputQueueResult {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message: "output_result_id is required."
    }
  };
}

function temporaryUnavailableError(
  message: string,
  options?: { errorId?: string; reported?: boolean }
): { ok: false; error: ApiErrorInput } {
  return apiTemporaryUnavailable(message, options);
}
