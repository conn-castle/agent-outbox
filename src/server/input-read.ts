import {
  apiTimestamp,
  apiValidationFailed,
  isJsonRecord,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  runGuardedCallerTransaction,
  type CallerIdentity
} from "./caller-api-auth.ts";
import {
  CanonicalInputIntegrityError,
  canonicalInputLinkButtonsStatement,
  canonicalInputActionsStatement,
  canonicalInputOptionsStatement,
  reconstructCanonicalInput,
  type CanonicalActionRow,
  type CanonicalInput,
  type CanonicalInputRootRow,
  type CanonicalLinkButtonRow,
  type CanonicalOptionRow
} from "./canonical-input.ts";
import type {
  ProductTransactionQuery,
  TransactionContextStatement
} from "./database.ts";
import {
  callerIdNotAllowedError,
  isStorableString,
  unstorableStringError
} from "./input-schema.ts";
import {
  encodePageCursor,
  pageFromRows,
  parsePageRequest,
  type PageRequest
} from "./pagination.ts";
import {
  InputReadRequestSchema,
  publicInputReadShapeMatches,
  publicSchemaFieldErrors
} from "../shared/public-api-contract.ts";

export const INPUT_READ_LIMIT_OPERATION_KIND = "output_check_read";
export const INPUT_LIST_OPERATION = "input_list";
export const INPUT_READ_OPERATION = "input_read";

export type InputReadQueueResult =
  | { ok: true; data: InputListPage | InputReadResult }
  | { ok: false; error: ApiErrorInput };

export type InputListItem = {
  caller_item_id: string;
  status: "pending" | "answered";
  revision: number;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
};

export type InputListPage = {
  items: InputListItem[];
  has_more: boolean;
  next_cursor: string | null;
  returned_count: number;
  page_limit: number;
};

export type InputReadResult = InputListItem & {
  raw_input: Record<string, unknown>;
};

type InputCursor = {
  inputItemId: string;
};

type InputListRow = {
  input_item_id: string;
  caller_item_id: string;
  status: "pending" | "answered";
  current_revision: number;
  created_at: string | Date;
  updated_at: string | Date;
  answered_at: string | Date | null;
};

const INPUT_VALIDATION_MESSAGE = "Input read request failed validation.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleInputListRequest(
  request: Request,
  context: ApiRequestContext
): Promise<InputReadQueueResult> {
  const parsed = parseInputPageQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return parsed;
  }

  return runGuardedCallerTransaction(
    request,
    context,
    {
      rateLimitKind: INPUT_READ_LIMIT_OPERATION_KIND,
      loggedOperation: INPUT_LIST_OPERATION,
      unavailableMessage: "Input list operation is temporarily unavailable.",
      unexpectedFailureMessage: "Input list operation failed unexpectedly."
    },
    (query, identity) =>
      listInputsInTransaction(query, identity, parsed.limit, parsed.cursor)
  );
}

export async function handleInputReadRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown
): Promise<InputReadQueueResult> {
  const parsed = parseInputReadBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  return runGuardedCallerTransaction(
    request,
    context,
    {
      rateLimitKind: INPUT_READ_LIMIT_OPERATION_KIND,
      loggedOperation: INPUT_READ_OPERATION,
      unavailableMessage: "Input read operation is temporarily unavailable.",
      unexpectedFailureMessage: "Input read operation failed unexpectedly."
    },
    (query, identity) =>
      readInputInTransaction(query, identity, parsed.callerItemId)
  );
}

export async function listInputsInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  limit: number,
  cursor: InputCursor | null
): Promise<InputReadQueueResult> {
  const pageRows = await query<InputListRow>(
    inputListPageStatement(identity, limit, cursor)
  );
  const { page, hasMore, nextCursor } = pageFromRows(
    pageRows.rows,
    limit,
    cursorFromInputRow
  );

  return {
    ok: true,
    data: {
      items: page.map(inputListItemFromRow),
      has_more: hasMore,
      next_cursor: nextCursor,
      returned_count: page.length,
      page_limit: limit
    }
  };
}

export async function readInputInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  callerItemId: string
): Promise<InputReadQueueResult> {
  const existing = await query<CanonicalInputRootRow>(
    liveInputForReadStatement(identity, callerItemId)
  );
  const root = existing.rows[0];
  if (!root) {
    return notFoundError();
  }

  const links = await query<CanonicalLinkButtonRow>(
    canonicalInputLinkButtonsStatement(identity, [root.input_item_id])
  );
  const actions = await query<CanonicalActionRow>(
    canonicalInputActionsStatement(identity, [root.input_item_id])
  );
  const options = await query<CanonicalOptionRow>(
    canonicalInputOptionsStatement(identity, [root.input_item_id])
  );

  const reconstructed = reconstructCanonicalInput({
    root,
    linkButtons: links.rows,
    actions: actions.rows,
    options: options.rows
  });
  if (!reconstructed.ok) {
    throw new CanonicalInputIntegrityError({
      inputItemId: root.input_item_id,
      accountId: identity.accountId,
      callerId: identity.callerId
    });
  }

  return { ok: true, data: publicInputReadResult(reconstructed.input) };
}

export function parseInputPageQuery(
  searchParams: URLSearchParams
): PageRequest<InputCursor> {
  return parsePageRequest(
    { limit: searchParams.get("limit"), cursor: searchParams.get("cursor") },
    inputCursorFromPayload,
    INPUT_VALIDATION_MESSAGE
  );
}

export function parseInputReadBody(
  body: unknown
): { ok: true; callerItemId: string } | { ok: false; error: ApiErrorInput } {
  if (!isJsonRecord(body)) {
    return validationFailed([
      {
        path: "",
        code: "invalid_request",
        message: "Request body must be an object."
      }
    ]);
  }

  if ("caller_id" in body) {
    return validationFailed([callerIdNotAllowedError()]);
  }

  if (
    typeof body.caller_item_id !== "string" ||
    body.caller_item_id.length < 1
  ) {
    return validationFailed([
      {
        path: "caller_item_id",
        code: "invalid_string",
        message: "caller_item_id must be a non-empty string."
      }
    ]);
  }

  if (!isStorableString(body.caller_item_id)) {
    return validationFailed([unstorableStringError("caller_item_id")]);
  }

  if (publicInputReadShapeMatches(body)) {
    return { ok: true, callerItemId: body.caller_item_id };
  }

  return validationFailed(
    publicSchemaFieldErrors(
      InputReadRequestSchema,
      body,
      "Request does not match the public input-read contract."
    )
  );
}

export function inputListPageStatement(
  identity: CallerIdentity,
  limit: number,
  cursor: InputCursor | null
): TransactionContextStatement {
  const values: (string | number)[] = [identity.accountId, identity.callerId];
  const cursorClause = cursor ? "and i.input_item_id > $3::uuid" : "";

  if (cursor) {
    values.push(cursor.inputItemId);
  }

  values.push(limit + 1);

  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        i.caller_item_id,
        i.status,
        i.current_revision,
        i.created_at,
        i.updated_at,
        i.answered_at
      from public.agent_outbox_input_items i
      where i.account_id = $1
        and i.caller_id = $2
        ${cursorClause}
      order by i.input_item_id
      limit $${values.length}
    `,
    values
  };
}

export function liveInputForReadStatement(
  identity: CallerIdentity,
  callerItemId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        i.input_item_id::text as input_item_id,
        i.caller_item_id,
        i.status,
        i.current_revision,
        i.priority,
        i.row_type_display,
        i.row_type_icon,
        i.row_accent_color,
        i.title_html,
        i.subtitle_html,
        i.corner_html,
        i.card_time,
        i.summary_html,
        i.details_html,
        i.card_visual_kind,
        i.card_visual_payload,
        i.skip_disabled,
        i.normalized_content_fingerprint,
        i.created_at,
        i.updated_at,
        i.answered_at
      from public.agent_outbox_input_items i
      where i.account_id = $1
        and i.caller_id = $2
        and i.caller_item_id = $3
      for update
    `,
    values: [identity.accountId, identity.callerId, callerItemId]
  };
}

export function cursorFromInputRow(row: { input_item_id: string }) {
  return encodePageCursor({ input_item_id: row.input_item_id });
}

function inputCursorFromPayload(
  payload: Record<string, unknown>
): InputCursor | null {
  return typeof payload.input_item_id === "string" &&
    UUID_PATTERN.test(payload.input_item_id)
    ? { inputItemId: payload.input_item_id }
    : null;
}

function publicInputReadResult(input: CanonicalInput): InputReadResult {
  return {
    caller_item_id: input.caller_item_id,
    status: input.status,
    revision: input.revision,
    created_at: input.created_at,
    updated_at: input.updated_at,
    answered_at: input.answered_at,
    raw_input: input.raw_input
  };
}

function inputListItemFromRow(row: InputListRow): InputListItem {
  return {
    caller_item_id: row.caller_item_id,
    status: row.status,
    revision: row.current_revision,
    created_at: apiTimestamp(row.created_at),
    updated_at: apiTimestamp(row.updated_at),
    answered_at: row.answered_at == null ? null : apiTimestamp(row.answered_at)
  };
}

function validationFailed(fields: ApiErrorInput["fields"]): {
  ok: false;
  error: ApiErrorInput;
} {
  return apiValidationFailed(INPUT_VALIDATION_MESSAGE, fields);
}

function notFoundError(): InputReadQueueResult {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message: "Input item was not found for this caller."
    }
  };
}
