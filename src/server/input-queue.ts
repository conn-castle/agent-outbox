import { auditEventInsertStatement } from "./accounting.ts";
import {
  apiNotFound,
  apiTemporaryUnavailable,
  apiTransactionFailure,
  apiValidationFailed,
  type ApiErrorInput,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  runAuthenticatedCallerTransaction,
  type CallerIdentity
} from "./caller-api-auth.ts";
import {
  accountLimitProfileForAccount,
  accountWriteLockStatement,
  enforceAcceptedInputSubmissionLimits,
  enforceAccountRequestLimits,
  type CallerLimitGuardResult
} from "./caller-api-limits.ts";
import type {
  ProductTransactionQuery,
  TransactionContextStatement
} from "./database.ts";
import {
  parseInputDeleteBody,
  parseInputSubmission,
  sha256Hex,
  type NormalizedInputAction,
  type NormalizedInputSubmission,
  type NormalizedPopupOption
} from "./input-schema.ts";

const INPUT_NOT_FOUND_MESSAGE = "Input item was not found for this caller.";

export type InputQueueOperation = "send" | "replace" | "delete";

export type InputQueueSuccess =
  | {
      operation: "send";
      caller_item_id: string;
      status: "pending";
      revision: number;
      created: boolean;
      duplicate: boolean;
    }
  | {
      operation: "replace";
      caller_item_id: string;
      status: "pending";
      revision: number;
      replaced: boolean;
      changed: boolean;
    }
  | {
      operation: "delete";
      caller_item_id: string;
      deleted: true;
    };

export type InputQueueResult =
  { ok: true; data: InputQueueSuccess } | { ok: false; error: ApiErrorInput };

type ExistingInputRow = {
  input_item_id: string;
  status: "pending" | "answered";
  current_revision: number;
  normalized_content_fingerprint: string | null;
  non_file_payload_bytes: string | number;
  has_live_output: boolean;
};

type AuditContextRow = {
  account_audit_id: string;
  caller_audit_id: string;
};

class CallerItemIdStorageError extends Error {
  constructor(cause: Error) {
    super("Caller item id cannot fit its uniqueness index.", { cause });
    this.name = "CallerItemIdStorageError";
  }
}

function isCallerItemIdIndexWidthError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const postgresError = error as Error & {
    code?: string;
    routine?: string;
    schema?: string;
    table?: string;
    constraint?: string;
    column?: string;
  };
  if (postgresError.code !== "54000") return false;

  if (postgresError.routine === "_bt_check_third_page") {
    return (
      postgresError.schema === "public" &&
      postgresError.table === "agent_outbox_input_items" &&
      postgresError.constraint ===
        "agent_outbox_input_items_caller_id_caller_item_id_key" &&
      postgresError.column == null
    );
  }

  // PostgreSQL's larger tuple-width failure has no object metadata. This
  // predicate is used only around the root input INSERT: its sole unbounded
  // indexed value is caller_item_id. Other program-limit errors must escape.
  return (
    (postgresError.routine === "index_form_tuple_context" ||
      postgresError.routine === "index_form_tuple") &&
    postgresError.schema == null &&
    postgresError.table == null &&
    postgresError.constraint == null &&
    postgresError.column == null
  );
}

export async function handleInputQueueRequest(
  request: Request,
  context: ApiRequestContext,
  operation: InputQueueOperation,
  jsonBody: unknown
): Promise<InputQueueResult> {
  if (operation === "delete") {
    const parsed = parseInputDeleteBody(jsonBody);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(
      "Caller API database configuration is unavailable."
    );
  }

  let identity: CallerIdentity | undefined;
  try {
    const transaction = await runAuthenticatedCallerTransaction(
      request,
      context,
      connectionString,
      async (query, auth) => {
        identity = auth;
        return handleInputQueueRequestInTransaction(
          query,
          context,
          auth,
          operation,
          jsonBody
        );
      }
    );
    if (!transaction.authenticated) {
      return { ok: false, error: transaction.failure.clientError };
    }
    return transaction.data;
  } catch (error) {
    // This marker escapes the exact INSERT and is returned only after the
    // transaction helper has rolled back. Failed rollback/cleanup replaces or
    // wraps it, so those uncertain outcomes keep the normal 503/reporting path.
    if (error instanceof CallerItemIdStorageError) {
      return apiValidationFailed("Input submission failed validation.", [
        {
          path: "caller_item_id",
          code: "invalid_string",
          message:
            "caller_item_id cannot fit the item uniqueness index. Use a shorter ID."
        }
      ]);
    }
    return apiTransactionFailure(error, context, {
      operation: `input_${operation}`,
      accountId: identity?.accountId,
      callerId: identity?.callerId,
      message: "Input queue operation failed unexpectedly.",
      unavailableMessage: "Input queue operation is temporarily unavailable."
    });
  }
}

export async function handleInputQueueRequestInTransaction(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  auth: CallerIdentity,
  operation: InputQueueOperation,
  jsonBody: unknown
): Promise<InputQueueResult> {
  if (operation !== "delete") {
    // Lock the account before reading its tier so a concurrent downgrade
    // cannot leave validation and limits on a stale profile. This also keeps
    // send/replace in account-before-input lock order, matching human answers.
    await query(accountWriteLockStatement(auth));
  }
  const profile = await accountLimitProfileForAccount(query, auth.accountId);
  if (!profile) {
    return apiTemporaryUnavailable(
      "Input queue operation is temporarily unavailable."
    );
  }

  if (operation === "delete") {
    const parsed = parseInputDeleteBody(jsonBody);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const requestLimit = await enforceAccountRequestLimits(
      query,
      auth,
      profile,
      "input_delete"
    );
    const requestLimitResult = inputResultFromLimitGuard(requestLimit);
    if (requestLimitResult) {
      return requestLimitResult;
    }
    return deleteInputItem(query, context, auth, parsed.callerItemId);
  }

  const parsed = parseInputSubmission(jsonBody, {
    limitProfile: profile
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const requestLimit = await enforceAccountRequestLimits(
    query,
    auth,
    profile,
    "input_send_replace"
  );
  const requestLimitResult = inputResultFromLimitGuard(requestLimit);
  if (requestLimitResult) {
    return requestLimitResult;
  }

  if (operation === "send") {
    return sendInputItem(query, context, auth, parsed.submission, {
      beforeCreate: async () => {
        return inputResultFromLimitGuard(
          await enforceAcceptedInputSubmissionLimits(query, auth, profile, {
            queuedItemDelta: 1,
            nonFilePayloadByteDelta: parsed.submission.nonFilePayloadBytes
          })
        );
      }
    });
  }

  return replaceInputItem(query, context, auth, parsed.submission, {
    beforeChange: async (existing) => {
      return inputResultFromLimitGuard(
        await enforceAcceptedInputSubmissionLimits(query, auth, profile, {
          queuedItemDelta: 0,
          nonFilePayloadByteDelta: Math.max(
            0,
            parsed.submission.nonFilePayloadBytes -
              databaseNonNegativeInteger(existing.non_file_payload_bytes)
          )
        })
      );
    }
  });
}

export async function sendInputItem(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  identity: CallerIdentity,
  submission: NormalizedInputSubmission,
  options: {
    beforeCreate?: () => Promise<InputQueueResult | null>;
  } = {}
): Promise<InputQueueResult> {
  if (options.beforeCreate) {
    await query(serializedSendInputItemStatement(identity, submission));
  }

  const existing = await existingInput(
    query,
    identity,
    submission.callerItemId
  );
  if (existing) {
    return sendResultForExisting(existing, submission);
  }

  if (options.beforeCreate) {
    const concurrentExisting = await existingInput(
      query,
      identity,
      submission.callerItemId
    );
    if (concurrentExisting) {
      return sendResultForExisting(concurrentExisting, submission);
    }

    const limitResult = await options.beforeCreate();
    if (limitResult) {
      return limitResult;
    }
  }

  const inserted = await query<{
    input_item_id: string;
    current_revision: number;
  }>(insertInputItemStatement(identity, submission)).catch((error: unknown) => {
    if (isCallerItemIdIndexWidthError(error)) {
      throw new CallerItemIdStorageError(error);
    }
    throw error;
  });
  const insertedRow = inserted.rows[0];

  if (!insertedRow) {
    const raced = await existingInput(query, identity, submission.callerItemId);
    if (raced) {
      return sendResultForExisting(raced, submission);
    }
    return internalQueueError(context.correlationId);
  }

  await insertChildRows(query, insertedRow.input_item_id, submission);
  await query(
    auditEventInsertStatement({
      eventType: "input_submitted",
      ...(await auditContext(query, identity)),
      inputItemId: insertedRow.input_item_id,
      itemStatus: "pending",
      nonFileBytes: submission.nonFilePayloadBytes,
      requestId: context.requestId,
      correlationId: context.correlationId,
      callerItemIdHash: submission.callerItemIdHash,
      metadata: { revision: insertedRow.current_revision }
    })
  );

  return {
    ok: true,
    data: {
      operation: "send",
      caller_item_id: submission.callerItemId,
      status: "pending",
      revision: insertedRow.current_revision,
      created: true,
      duplicate: false
    }
  };
}

export async function replaceInputItem(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  identity: CallerIdentity,
  submission: NormalizedInputSubmission,
  options: {
    beforeChange?: (
      existing: ExistingInputRow
    ) => Promise<InputQueueResult | null>;
  } = {}
): Promise<InputQueueResult> {
  const existing = await existingInput(
    query,
    identity,
    submission.callerItemId
  );
  if (!existing) {
    return apiNotFound(INPUT_NOT_FOUND_MESSAGE);
  }
  if (existing.status !== "pending") {
    return existing.has_live_output
      ? answeredUnacknowledgedError()
      : inputNotPendingError();
  }
  if (
    existing.normalized_content_fingerprint ===
    submission.normalizedContentFingerprint
  ) {
    return {
      ok: true,
      data: {
        operation: "replace",
        caller_item_id: submission.callerItemId,
        status: "pending",
        revision: existing.current_revision,
        replaced: false,
        changed: false
      }
    };
  }

  const limitResult = await options.beforeChange?.(existing);
  if (limitResult) {
    return limitResult;
  }

  const updated = await query<{ current_revision: number }>(
    updateInputItemStatement(existing.input_item_id, submission)
  );
  const revision = updated.rows[0]?.current_revision;
  if (!revision) {
    return internalQueueError(context.correlationId);
  }

  await query(deleteLinkButtonsStatement(existing.input_item_id));
  await query(deleteActionsStatement(existing.input_item_id));
  await insertChildRows(query, existing.input_item_id, submission);
  await query(
    auditEventInsertStatement({
      eventType: "input_replaced",
      ...(await auditContext(query, identity)),
      inputItemId: existing.input_item_id,
      itemStatus: "pending",
      nonFileBytes: submission.nonFilePayloadBytes,
      requestId: context.requestId,
      correlationId: context.correlationId,
      callerItemIdHash: submission.callerItemIdHash,
      metadata: { revision }
    })
  );

  return {
    ok: true,
    data: {
      operation: "replace",
      caller_item_id: submission.callerItemId,
      status: "pending",
      revision,
      replaced: true,
      changed: true
    }
  };
}

export async function deleteInputItem(
  query: ProductTransactionQuery,
  context: ApiRequestContext,
  identity: CallerIdentity,
  callerItemId: string
): Promise<InputQueueResult> {
  const existing = await existingInput(query, identity, callerItemId);
  if (!existing) {
    return apiNotFound(INPUT_NOT_FOUND_MESSAGE);
  }
  if (existing.status !== "pending") {
    return inputNotPendingError();
  }

  await query(deleteInputItemStatement(existing.input_item_id));
  await query(
    auditEventInsertStatement({
      eventType: "input_deleted",
      ...(await auditContext(query, identity)),
      inputItemId: existing.input_item_id,
      itemStatus: "pending",
      nonFileBytes: databaseNonNegativeInteger(existing.non_file_payload_bytes),
      deletionReason: "caller_delete",
      requestId: context.requestId,
      correlationId: context.correlationId,
      callerItemIdHash: sha256Hex(callerItemId),
      metadata: {}
    })
  );

  return {
    ok: true,
    data: {
      operation: "delete",
      caller_item_id: callerItemId,
      deleted: true
    }
  };
}

export function existingInputStatement(
  identity: CallerIdentity,
  callerItemId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        i.input_item_id,
        i.status,
        i.current_revision,
        i.normalized_content_fingerprint,
        i.non_file_payload_bytes,
        exists (
          select 1
          from public.agent_outbox_output_results o
          where o.input_item_id = i.input_item_id
        ) as has_live_output
      from public.agent_outbox_input_items i
      where i.account_id = $1
        and i.caller_id = $2
        and i.caller_item_id = $3
      for update
    `,
    values: [identity.accountId, identity.callerId, callerItemId]
  };
}

export function serializedSendInputItemStatement(
  identity: CallerIdentity,
  submission: NormalizedInputSubmission
): TransactionContextStatement {
  return {
    sql: `
      select pg_advisory_xact_lock(
        ('x' || substr(md5($1 || ':' || $2 || ':' || $3), 1, 16))::bit(64)::bigint
      ) as acquired
    `,
    values: [identity.accountId, identity.callerId, submission.callerItemId]
  };
}

export function insertInputItemStatement(
  identity: CallerIdentity,
  submission: NormalizedInputSubmission
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_input_items (
        account_id,
        caller_id,
        caller_item_id,
        caller_item_id_hash,
        status,
        priority,
        current_revision,
        row_type_display,
        row_type_icon,
        row_accent_color,
        title_html,
        subtitle_html,
        corner_html,
        summary_html,
        details_html,
        card_visual_kind,
        card_visual_payload,
        skip_disabled,
        normalized_content_fingerprint,
        non_file_payload_bytes,
        card_time
      )
      values (
        $1, $2, $3, $4, 'pending', $5, 1, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19
      )
      on conflict (caller_id, caller_item_id) do nothing
      returning input_item_id, current_revision
    `,
    values: inputItemValues(identity, submission)
  };
}

export function updateInputItemStatement(
  inputItemId: string,
  submission: NormalizedInputSubmission
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_input_items
      set
        priority = $2,
        current_revision = current_revision + 1,
        row_type_display = $3,
        row_type_icon = $4,
        row_accent_color = $5,
        title_html = $6,
        subtitle_html = $7,
        corner_html = $8,
        summary_html = $9,
        details_html = $10,
        card_visual_kind = $11,
        card_visual_payload = $12::jsonb,
        skip_disabled = $13,
        normalized_content_fingerprint = $14,
        non_file_payload_bytes = $15,
        card_time = $16,
        updated_at = now()
      where input_item_id = $1
      returning current_revision
    `,
    values: [
      inputItemId,
      submission.priority,
      submission.rowType.display,
      submission.rowType.icon,
      submission.rowAccentColor,
      submission.titleHtml,
      submission.subtitleHtml,
      submission.cornerHtml,
      submission.summaryHtml,
      submission.detailsHtml,
      submission.cardVisual?.kind ?? null,
      JSON.stringify(submission.cardVisual?.payload ?? {}),
      submission.skipDisabled,
      submission.normalizedContentFingerprint,
      submission.nonFilePayloadBytes,
      submission.cardTime
    ]
  };
}

export function insertLinkButtonStatement(
  inputItemId: string,
  button: NormalizedInputSubmission["linkButtons"][number]
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_input_link_buttons (
        input_item_id,
        display_order,
        display,
        icon,
        url
      )
      values ($1, $2, $3, $4, $5)
    `,
    values: [
      inputItemId,
      button.displayOrder,
      button.display,
      button.icon,
      button.url
    ]
  };
}

export function insertActionStatement(
  inputItemId: string,
  action: NormalizedInputAction
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_input_actions (
        input_item_id,
        display_order,
        display,
        icon,
        action_value,
        overflow,
        action_tone,
        action_style,
        popup_kind,
        popup_payload
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      returning input_action_id
    `,
    values: [
      inputItemId,
      action.displayOrder,
      action.display,
      action.icon,
      action.value,
      action.overflow,
      action.tone,
      action.style,
      action.popupKind,
      JSON.stringify(action.popupPayload)
    ]
  };
}

export function insertPopupOptionStatement(
  inputActionId: string,
  option: NormalizedPopupOption
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_input_action_popup_options (
        input_action_id,
        display_order,
        display,
        option_value,
        icon
      )
      values ($1, $2, $3, $4, $5)
    `,
    values: [
      inputActionId,
      option.displayOrder,
      option.display,
      option.value,
      option.icon
    ]
  };
}

export function deleteLinkButtonsStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: "delete from public.agent_outbox_input_link_buttons where input_item_id = $1",
    values: [inputItemId]
  };
}

export function deleteActionsStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: "delete from public.agent_outbox_input_actions where input_item_id = $1",
    values: [inputItemId]
  };
}

export function deleteInputItemStatement(
  inputItemId: string
): TransactionContextStatement {
  return {
    sql: "delete from public.agent_outbox_input_items where input_item_id = $1",
    values: [inputItemId]
  };
}

function sendResultForExisting(
  existing: ExistingInputRow,
  submission: NormalizedInputSubmission
): InputQueueResult {
  if (existing.status === "answered") {
    return answeredUnacknowledgedError();
  }
  if (
    existing.normalized_content_fingerprint ===
    submission.normalizedContentFingerprint
  ) {
    return {
      ok: true,
      data: {
        operation: "send",
        caller_item_id: submission.callerItemId,
        status: "pending",
        revision: existing.current_revision,
        created: false,
        duplicate: true
      }
    };
  }

  return {
    ok: false,
    error: {
      status: 409,
      code: "pending_content_conflict",
      message:
        "A pending input item with this caller_item_id already has different content."
    }
  };
}

async function existingInput(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  callerItemId: string
) {
  const result = await query<ExistingInputRow>(
    existingInputStatement(identity, callerItemId)
  );
  return result.rows[0] ?? null;
}

async function insertChildRows(
  query: ProductTransactionQuery,
  inputItemId: string,
  submission: NormalizedInputSubmission
) {
  for (const button of submission.linkButtons) {
    await query(insertLinkButtonStatement(inputItemId, button));
  }

  for (const action of submission.actions) {
    const actionResult = await query<{ input_action_id: string }>(
      insertActionStatement(inputItemId, action)
    );
    const inputActionId = actionResult.rows[0]?.input_action_id;
    if (!inputActionId) {
      throw new Error("Input action insert did not return input_action_id");
    }
    for (const option of action.options) {
      await query(insertPopupOptionStatement(inputActionId, option));
    }
  }
}

function inputResultFromLimitGuard(
  result: CallerLimitGuardResult
): InputQueueResult | null {
  return result.ok ? null : { ok: false, error: result.error };
}

function databaseNonNegativeInteger(value: string | number) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RangeError("database byte counts must be non-negative integers");
  }
  return numeric;
}

async function auditContext(
  query: ProductTransactionQuery,
  identity: CallerIdentity
) {
  const result = await query<AuditContextRow>({
    sql: `
      select a.account_audit_id, c.caller_audit_id
      from public.agent_outbox_accounts a
      join public.agent_outbox_callers c
        on c.account_id = a.account_id
      where a.account_id = $1
        and c.caller_id = $2
    `,
    values: [identity.accountId, identity.callerId]
  });
  const row = result.rows[0];
  if (!row) {
    throw new Error("Input queue audit context was not found");
  }
  return {
    accountAuditId: row.account_audit_id,
    callerAuditId: row.caller_audit_id
  };
}

function inputItemValues(
  identity: CallerIdentity,
  submission: NormalizedInputSubmission
) {
  return [
    identity.accountId,
    identity.callerId,
    submission.callerItemId,
    submission.callerItemIdHash,
    submission.priority,
    submission.rowType.display,
    submission.rowType.icon,
    submission.rowAccentColor,
    submission.titleHtml,
    submission.subtitleHtml,
    submission.cornerHtml,
    submission.summaryHtml,
    submission.detailsHtml,
    submission.cardVisual?.kind ?? null,
    JSON.stringify(submission.cardVisual?.payload ?? {}),
    submission.skipDisabled,
    submission.normalizedContentFingerprint,
    submission.nonFilePayloadBytes,
    submission.cardTime
  ];
}

function answeredUnacknowledgedError(): InputQueueResult {
  return {
    ok: false,
    error: {
      status: 409,
      code: "answered_unacknowledged",
      message:
        "An answered output result for this caller_item_id is still unacknowledged."
    }
  };
}

function inputNotPendingError(): InputQueueResult {
  return {
    ok: false,
    error: {
      status: 409,
      code: "input_not_pending",
      message: "Input replace/delete is allowed only while the item is pending."
    }
  };
}

function internalQueueError(errorId: string): InputQueueResult {
  return {
    ok: false,
    error: {
      status: 500,
      code: "internal_error",
      message: "Input queue operation could not be completed.",
      errorId
    }
  };
}
