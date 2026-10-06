import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

import { auditEventInsertStatement } from "./accounting.ts";
import {
  accountLimitProfileForAccount,
  accountWriteLockStatement,
  enforceHumanFileUploadLimits
} from "./caller-api-limits.ts";
import { preReadUndoStatement } from "./cleanup.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import {
  emitOperatorActionableFailure,
  type ApiErrorCode,
  type ApiErrorInput,
  type ApiFieldError
} from "./api-errors.ts";
import {
  compareUtcDateTimeValues,
  isIanaTimeZone,
  isValidUtcDateTime,
  type NormalizedFreeTextPopupPayload,
  type NormalizedDatePickerPopupPayload,
  type NormalizedFileUploadPopupPayload
} from "./input-schema.ts";
import { persistedPopup, type PersistedPopup } from "./persisted-payload.ts";
import { durationSinceMs } from "./logging.ts";
import { safeAttachmentFilename, safeContentType } from "./output-files.ts";
import { reportRuntimeFailure } from "./sentry.ts";

export const HUMAN_ANSWER_RESPONSE_BYTE_LIMIT =
  SYSTEM_CONTRACT.humanAnswerResponseBodyBytes;
export const UNACKNOWLEDGED_OUTPUT_TIMEOUT_DAYS =
  SYSTEM_CONTRACT.unacknowledgedOutputTimeoutDays;

export const OUTPUT_RESPONSE_KINDS = [
  "none",
  "free_text",
  "single_select",
  "multi_select",
  "date_picker",
  "file_upload"
] as const;

export type OutputResponseKind = (typeof OUTPUT_RESPONSE_KINDS)[number];

export type NoPopupResponse = {
  kind: "none";
};

export type FreeTextResponse = {
  kind: "free_text";
  text: string;
};

export type SingleSelectResponse = {
  kind: "single_select";
  value: string;
};

export type MultiSelectResponse = {
  kind: "multi_select";
  values: string[];
};

export type DatePickerDateResponse = {
  kind: "date_picker";
  mode: "date";
  value_date: string;
  display_timezone: string | null;
};

export type DatePickerDateTimeResponse = {
  kind: "date_picker";
  mode: "datetime";
  value_utc: string;
  display_timezone: string;
};

export type UploadedFileResponse = {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
};

export type FileUploadResponse = {
  kind: "file_upload";
  file: File;
};

export type HumanActionResponse =
  | NoPopupResponse
  | FreeTextResponse
  | SingleSelectResponse
  | MultiSelectResponse
  | DatePickerDateResponse
  | DatePickerDateTimeResponse
  | FileUploadResponse;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type HumanAnswerFailure = {
  ok: false;
  code: ApiErrorCode;
  message: string;
  fields?: ApiFieldError[];
};

export type HumanAnswerSuccess = {
  ok: true;
  outputResultId: string;
  inputItemId: string;
  callerItemId: string;
  actionValue: string;
  responseKind: OutputResponseKind;
  responsePayload: JsonValue;
  responsePayloadBytes: number;
  answeredAt: string;
  expiresAt: string;
};

export type HumanAnswerResult = HumanAnswerSuccess | HumanAnswerFailure;

export type CreateHumanAnswerInput = HumanAnswerActorContext & {
  inputItemId: string;
  expectedRevision: number;
  actionValue: string;
  response: HumanActionResponse;
  feedback?: string;
  answeredAt?: Date;
};

export type HumanAnswerActorContext = {
  accountId: string;
  callerId: string;
  humanUserId: string;
  requestId: string;
  correlationId: string;
};

export type PreReadUndoInput = HumanAnswerActorContext & {
  outputResultId: string;
};

export type PreReadUndoSuccess = {
  ok: true;
  outputResultId: string;
  outputDeleted: boolean;
  inputRestored: boolean;
  filesDeleted: number;
};

export type PreReadUndoResult = PreReadUndoSuccess | HumanAnswerFailure;

type TargetInputRow = {
  input_item_id: string;
  caller_item_id: string;
  caller_item_id_hash: string;
  status: "pending" | "answered";
  current_revision: number;
  non_file_payload_bytes: string | number;
  account_audit_id: string;
  caller_audit_id: string;
};

type InputActionRow = {
  input_action_id: string;
  popup_kind: unknown;
  popup_payload: unknown;
};

type PopupOptionRow = {
  option_value: string;
};

type OutputInsertRow = {
  output_result_id: string;
};

type OutputFileInsertRow = {
  output_file_id: string;
};

type PreReadUndoCandidateRow = {
  output_result_id: string;
  first_read_at: Date | string | null;
};

type PreReadUndoRow = {
  output_deleted: boolean;
  input_restored: boolean;
  files_deleted: number;
};

type StoredPayload = {
  ok: true;
  responseKind: OutputResponseKind;
  responsePayload: JsonValue;
  responsePayloadBytes: number;
  file?: File;
};

type PopupActionForValidation = PersistedPopup & {
  optionValues?: readonly string[];
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function createHumanAnswer(
  connectionString: string,
  input: CreateHumanAnswerInput
): Promise<HumanAnswerResult> {
  const startedAtMs = Date.now();
  try {
    return await runProductTransaction(
      connectionString,
      {
        requestId: input.requestId,
        authSurface: "human",
        accountId: input.accountId,
        callerId: input.callerId,
        userId: input.humanUserId
      },
      (query) => createHumanAnswerInTransaction(query, input)
    );
  } catch (error) {
    return humanAnswerTransactionFailure(error, input, startedAtMs);
  }
}

export async function createHumanAnswerInTransaction(
  query: ProductTransactionQuery,
  input: CreateHumanAnswerInput
): Promise<HumanAnswerResult> {
  const startedAtMs = Date.now();
  const contextFailure = validateHumanAnswerInput(input);
  if (contextFailure) {
    return contextFailure;
  }

  const answeredAt = input.answeredAt ?? new Date();
  // Caller replacement takes the account quota lock before the input lock.
  // Use the same order here, including the account lock needed by output FKs.
  await query(accountWriteLockStatement(input));
  const targetInputResult = await query<TargetInputRow>(
    targetInputForAnswerStatement(input)
  );
  const targetInput = targetInputResult.rows[0];

  if (!targetInput) {
    return failure("not_found", "Input item was not found.");
  }

  if (targetInput.status !== "pending") {
    return failure(
      "input_not_pending",
      "Human answer creation requires a pending input item."
    );
  }

  if (targetInput.current_revision !== input.expectedRevision) {
    return failure(
      "stale_input_revision",
      "Input item revision changed before the answer was submitted."
    );
  }

  const actionResult = await query<InputActionRow>(
    inputActionForAnswerStatement(input.inputItemId, input.actionValue)
  );
  const action = actionResult.rows[0];

  if (!action) {
    return invalidActionResponse("action_value", "Selected action is invalid.");
  }

  const optionResult = await query<PopupOptionRow>(
    inputActionOptionsStatement(action.input_action_id)
  );
  const optionValues = optionResult.rows.map((row) => row.option_value);
  const popup = answerablePopup(
    action.input_action_id,
    persistedPopup(
      action.input_action_id,
      action.popup_kind,
      action.popup_payload
    ),
    optionValues.length
  );
  const payloadResult = validatedResponsePayload(
    { ...popup, optionValues },
    input.response,
    input.feedback
  );

  if (!payloadResult.ok) {
    return payloadResult;
  }

  const upload = await preparedFileUpload(
    query,
    input,
    payloadResult,
    startedAtMs
  );
  if (!upload.ok) {
    return upload;
  }

  const outputResult = await query<OutputInsertRow>(
    createOutputResultStatement({
      input,
      targetInput,
      payload: payloadResult,
      answeredAt
    })
  );
  const outputResultId = outputResult.rows[0].output_result_id;
  let uploadedFile: {
    outputFileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  } | null = null;
  if (upload.file) {
    const insertedFile = await query<OutputFileInsertRow>(
      createOutputFileStatement({
        input,
        outputResultId,
        file: upload.file
      })
    );
    uploadedFile = {
      outputFileId: insertedFile.rows[0].output_file_id,
      filename: upload.file.filename,
      mimeType: upload.file.mimeType,
      sizeBytes: upload.file.sizeBytes,
      sha256: upload.file.sha256
    };
  }

  await query(markInputAnsweredStatement(input.inputItemId, answeredAt));

  const expiresAt = outputExpiresAt(answeredAt);
  const auditStatements = [
    auditEventInsertStatement({
      eventType: "input_answered",
      accountAuditId: targetInput.account_audit_id,
      callerAuditId: targetInput.caller_audit_id,
      inputItemId: targetInput.input_item_id,
      outputResultId,
      itemStatus: "answered",
      responseKind: payloadResult.responseKind,
      nonFileBytes: byteCount(targetInput.non_file_payload_bytes),
      requestId: input.requestId,
      correlationId: input.correlationId,
      callerItemIdHash: targetInput.caller_item_id_hash,
      metadata: { revision: targetInput.current_revision }
    }),
    auditEventInsertStatement({
      eventType: "output_created",
      accountAuditId: targetInput.account_audit_id,
      callerAuditId: targetInput.caller_audit_id,
      inputItemId: targetInput.input_item_id,
      outputResultId,
      itemStatus: "answered",
      responseKind: payloadResult.responseKind,
      nonFileBytes: payloadResult.responsePayloadBytes,
      requestId: input.requestId,
      correlationId: input.correlationId,
      callerItemIdHash: targetInput.caller_item_id_hash,
      metadata: { revision: targetInput.current_revision }
    })
  ];
  if (uploadedFile) {
    auditStatements.push(
      auditEventInsertStatement({
        eventType: "file_uploaded",
        accountAuditId: targetInput.account_audit_id,
        callerAuditId: targetInput.caller_audit_id,
        inputItemId: targetInput.input_item_id,
        outputResultId,
        outputFileId: uploadedFile.outputFileId,
        itemStatus: "answered",
        responseKind: "file_upload",
        fileBytes: uploadedFile.sizeBytes,
        requestId: input.requestId,
        correlationId: input.correlationId,
        callerItemIdHash: targetInput.caller_item_id_hash,
        metadata: { revision: targetInput.current_revision }
      })
    );
  }

  for (const statement of auditStatements) {
    await query(statement);
  }

  return {
    ok: true,
    outputResultId,
    inputItemId: targetInput.input_item_id,
    callerItemId: targetInput.caller_item_id,
    actionValue: input.actionValue,
    responseKind: payloadResult.responseKind,
    responsePayload: uploadedFile
      ? {
          kind: "file_upload",
          file: {
            file_id: uploadedFile.outputFileId,
            filename: uploadedFile.filename,
            mime_type: uploadedFile.mimeType,
            size_bytes: uploadedFile.sizeBytes,
            sha256: uploadedFile.sha256
          }
        }
      : payloadResult.responsePayload,
    responsePayloadBytes: payloadResult.responsePayloadBytes,
    answeredAt: timestampValue(answeredAt),
    expiresAt: timestampValue(expiresAt)
  };
}

export function humanAnswerTransactionFailure(
  error: unknown,
  input: CreateHumanAnswerInput,
  startedAtMs = Date.now()
): HumanAnswerResult {
  reportRuntimeFailure(error, {
    errorId: input.correlationId,
    request_id: input.requestId,
    surface: "app",
    route: "/human",
    method: "POST",
    status_code: 503,
    duration_ms: durationSinceMs(startedAtMs),
    operation: "human_answer_transaction",
    operation_kind:
      input.response.kind === "file_upload" ? "file_upload" : undefined,
    account_id: input.accountId,
    caller_id: input.callerId,
    message: "Human answer transaction failed unexpectedly."
  });
  return failure(
    "temporary_unavailable",
    "Human answer is temporarily unavailable."
  );
}

export function humanAnswerUndoTransactionFailure(
  error: unknown,
  input: PreReadUndoInput
): PreReadUndoResult {
  const startedAtMs = Date.now();
  reportRuntimeFailure(error, {
    errorId: input.correlationId,
    request_id: input.requestId,
    surface: "app",
    route: "/human",
    method: "POST",
    status_code: 503,
    duration_ms: durationSinceMs(startedAtMs),
    operation: "human_answer_undo_transaction",
    account_id: input.accountId,
    caller_id: input.callerId,
    message: "Human answer undo transaction failed unexpectedly."
  });
  return failure(
    "temporary_unavailable",
    "Human answer undo is temporarily unavailable."
  );
}

export async function undoHumanAnswerBeforeReadInTransaction(
  query: ProductTransactionQuery,
  input: PreReadUndoInput
): Promise<PreReadUndoResult> {
  const contextFailure = validateHumanAnswerContext(input);
  if (contextFailure) {
    return contextFailure;
  }

  if (!input.outputResultId) {
    return failure("invalid_request", "outputResultId is required.");
  }

  const candidateResult = await query<PreReadUndoCandidateRow>(
    outputForPreReadUndoStatement(input)
  );
  const candidate = candidateResult.rows[0];

  if (!candidate) {
    return failure("not_found", "Output result was not found.");
  }

  if (candidate.first_read_at != null) {
    return failure(
      "output_already_read",
      "Output result has already been read by the caller."
    );
  }

  const undoResult = await query<PreReadUndoRow>(
    preReadUndoStatement(input.outputResultId, input.requestId)
  );
  const undo = undoResult.rows[0];

  if (!undo?.output_deleted || !undo.input_restored) {
    return failure("not_found", "Unread output result was not restored.");
  }

  return {
    ok: true,
    outputResultId: input.outputResultId,
    outputDeleted: undo.output_deleted,
    inputRestored: undo.input_restored,
    filesDeleted: Number(undo.files_deleted)
  };
}

export function targetInputForAnswerStatement(
  input: Pick<CreateHumanAnswerInput, "accountId" | "callerId" | "inputItemId">
): TransactionContextStatement {
  return {
    sql: `
      select
        i.input_item_id,
        i.caller_item_id,
        i.caller_item_id_hash,
        i.status,
        i.current_revision,
        i.non_file_payload_bytes,
        a.account_audit_id,
        c.caller_audit_id
      from public.agent_outbox_input_items i
      join public.agent_outbox_accounts a
        on a.account_id = i.account_id
      join public.agent_outbox_callers c
        on c.account_id = i.account_id
       and c.caller_id = i.caller_id
      where i.account_id = $1
        and i.caller_id = $2
        and i.input_item_id = $3
      for update of i
    `,
    values: [input.accountId, input.callerId, input.inputItemId]
  };
}

export function inputActionForAnswerStatement(
  inputItemId: string,
  actionValue: string
): TransactionContextStatement {
  return {
    sql: `
      select
        input_action_id,
        popup_kind,
        popup_payload
      from public.agent_outbox_input_actions
      where input_item_id = $1
        and action_value = $2
    `,
    values: [inputItemId, actionValue]
  };
}

export function inputActionOptionsStatement(
  inputActionId: string
): TransactionContextStatement {
  return {
    sql: `
      select option_value
      from public.agent_outbox_input_action_popup_options
      where input_action_id = $1
      order by display_order, input_action_popup_option_id
    `,
    values: [inputActionId]
  };
}

export function outputForPreReadUndoStatement(
  input: Pick<PreReadUndoInput, "accountId" | "callerId" | "outputResultId">
): TransactionContextStatement {
  return {
    sql: `
      select output_result_id, first_read_at
      from public.agent_outbox_output_results
      where account_id = $1
        and caller_id = $2
        and output_result_id = $3
      for update
    `,
    values: [input.accountId, input.callerId, input.outputResultId]
  };
}

export function validatedResponsePayload(
  action: PopupActionForValidation,
  response: unknown,
  feedback?: unknown
): StoredPayload | HumanAnswerFailure {
  if (feedback !== undefined && typeof feedback !== "string") {
    return invalidActionResponse("feedback", "Feedback must be text.");
  }
  const payload = validatedActionPayload(action, response);
  if (!payload.ok || !feedback?.trim()) return payload;
  return storedPayload(
    payload.responseKind,
    { ...(payload.responsePayload as Record<string, JsonValue>), feedback },
    payload.file
  );
}

function validatedActionPayload(
  action: PopupActionForValidation,
  response: unknown
): StoredPayload | HumanAnswerFailure {
  if (!isRecord(response) || response.kind !== action.popupKind) {
    return invalidActionResponse(
      "response.kind",
      "Response kind must match the selected action popup."
    );
  }

  switch (action.popupKind) {
    case "none":
      if (Object.keys(response).length !== 1) {
        return invalidActionResponse(
          "response",
          "None responses must not include popup-specific data."
        );
      }
      return storedPayload("none", {});

    case "free_text":
      return validateFreeTextResponse(action.popupPayload, response);

    case "single_select":
      return validateSingleSelectResponse(action, response);

    case "multi_select":
      return validateMultiSelectResponse(action, response);

    case "date_picker":
      return validateDatePickerResponse(action.popupPayload, response);

    case "file_upload":
      return validateFileUploadResponse(action.popupPayload, response);
  }
}

async function preparedFileUpload(
  query: ProductTransactionQuery,
  input: CreateHumanAnswerInput,
  payload: StoredPayload,
  startedAtMs: number
): Promise<
  | {
      ok: true;
      file: {
        filename: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
        bytes: Buffer;
      } | null;
    }
  | HumanAnswerFailure
> {
  if (payload.responseKind !== "file_upload") {
    return { ok: true, file: null };
  }
  const file = payload.file as File;

  const profile = await accountLimitProfileForAccount(query, input.accountId);
  if (!profile) {
    emitHumanFileUploadFailure(
      input,
      {
        status: 503,
        code: "temporary_unavailable",
        message: "File upload is temporarily unavailable."
      },
      startedAtMs
    );
    return failure(
      "temporary_unavailable",
      "File upload is temporarily unavailable."
    );
  }
  const limits = await enforceHumanFileUploadLimits(
    query,
    { accountId: input.accountId, callerId: input.callerId },
    profile,
    file.size
  );
  if (!limits.ok) {
    emitHumanFileUploadFailure(input, limits.error, startedAtMs);
    return {
      ok: false,
      code: limits.error.code,
      message: limits.error.message
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch (error) {
    reportRuntimeFailure(error, {
      errorId: input.correlationId,
      request_id: input.requestId,
      surface: "app",
      route: "/human",
      method: "POST",
      status_code: 503,
      duration_ms: durationSinceMs(startedAtMs),
      operation: "human_file_upload",
      operation_kind: "file_upload",
      account_id: input.accountId,
      caller_id: input.callerId,
      message: "Human file upload failed unexpectedly."
    });
    return failure(
      "temporary_unavailable",
      "Uploaded file could not be read safely."
    );
  }
  if (bytes.byteLength !== file.size) {
    emitHumanFileUploadFailure(
      input,
      {
        status: 503,
        code: "temporary_unavailable",
        message: "Uploaded file could not be read safely."
      },
      startedAtMs
    );
    return failure(
      "temporary_unavailable",
      "Uploaded file could not be read safely."
    );
  }

  return {
    ok: true,
    file: {
      filename: safeAttachmentFilename(file.name),
      mimeType: safeContentType(file.type),
      sizeBytes: file.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes
    }
  };
}

function emitHumanFileUploadFailure(
  input: CreateHumanAnswerInput,
  error: Pick<ApiErrorInput, "status" | "code" | "message" | "limit">,
  startedAtMs: number
) {
  emitOperatorActionableFailure({
    status: error.status,
    limit: error.limit,
    error_id: input.correlationId,
    request_id: input.requestId,
    surface: "app",
    route: "/human",
    method: "POST",
    duration_ms: durationSinceMs(startedAtMs),
    operation: "human_file_upload",
    operation_kind: "file_upload",
    account_id: input.accountId,
    caller_id: input.callerId,
    message: "Human file upload failed."
  });
}

function createOutputResultStatement(input: {
  input: CreateHumanAnswerInput;
  targetInput: TargetInputRow;
  payload: StoredPayload;
  answeredAt: Date;
}): TransactionContextStatement {
  const expiresAt = outputExpiresAt(input.answeredAt);

  return {
    sql: `
      insert into public.agent_outbox_output_results(
        account_id,
        caller_id,
        input_item_id,
        caller_item_id,
        action_value,
        response_kind,
        response_payload,
        response_payload_bytes,
        answered_at,
        answered_by_user_id,
        previous_input_updated_at,
        expires_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
        -- Copied in SQL so undo restores the exact microsecond queue position.
        (select updated_at from public.agent_outbox_input_items where input_item_id = $3),
        $11
      )
      returning output_result_id
    `,
    values: [
      input.input.accountId,
      input.input.callerId,
      input.targetInput.input_item_id,
      input.targetInput.caller_item_id,
      input.input.actionValue,
      input.payload.responseKind,
      JSON.stringify(input.payload.responsePayload),
      input.payload.responsePayloadBytes,
      timestampValue(input.answeredAt),
      input.input.humanUserId,
      timestampValue(expiresAt)
    ]
  };
}

function markInputAnsweredStatement(
  inputItemId: string,
  answeredAt: Date
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_input_items
      set
        status = 'answered',
        answered_at = $2,
        updated_at = $2
      where input_item_id = $1
    `,
    values: [inputItemId, timestampValue(answeredAt)]
  };
}

function createOutputFileStatement(input: {
  input: CreateHumanAnswerInput;
  outputResultId: string;
  file: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    bytes: Buffer;
  };
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_output_files(
        output_result_id,
        account_id,
        caller_id,
        display_order,
        filename,
        mime_type,
        size_bytes,
        sha256,
        file_bytes
      )
      values ($1, $2, $3, 0, $4, $5, $6, $7, $8)
      returning output_file_id::text as output_file_id
    `,
    values: [
      input.outputResultId,
      input.input.accountId,
      input.input.callerId,
      input.file.filename,
      input.file.mimeType,
      input.file.sizeBytes,
      input.file.sha256,
      input.file.bytes
    ]
  };
}

function validateHumanAnswerInput(
  input: CreateHumanAnswerInput
): HumanAnswerFailure | null {
  const contextFailure = validateHumanAnswerContext(input);
  if (contextFailure) {
    return contextFailure;
  }

  if (!input.inputItemId) {
    return failure("invalid_request", "inputItemId is required.");
  }

  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision <= 0
  ) {
    return failure(
      "invalid_request",
      "expectedRevision must be a positive integer."
    );
  }

  if (!input.actionValue) {
    return failure("invalid_request", "actionValue is required.");
  }

  if (input.answeredAt && Number.isNaN(input.answeredAt.getTime())) {
    return failure("invalid_request", "answeredAt must be a valid Date.");
  }

  return null;
}

function validateHumanAnswerContext(
  input: HumanAnswerActorContext
): HumanAnswerFailure | null {
  if (!input.accountId) {
    return failure("invalid_request", "accountId is required.");
  }
  if (!input.callerId) {
    return failure("invalid_request", "callerId is required.");
  }
  if (!input.humanUserId) {
    return failure("invalid_request", "humanUserId is required.");
  }
  if (!input.requestId) {
    return failure("invalid_request", "requestId is required.");
  }
  if (!input.correlationId) {
    return failure("invalid_request", "correlationId is required.");
  }

  return null;
}

function validateFreeTextResponse(
  popupPayload: NormalizedFreeTextPopupPayload,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (typeof response.text !== "string") {
    return invalidActionResponse(
      "response.text",
      "Free-text responses require text."
    );
  }

  const minLength = popupPayload.min_length;
  const maxLength = popupPayload.max_length;
  if (minLength != null && response.text.length < minLength) {
    return invalidActionResponse(
      "response.text",
      "Free-text response is shorter than the selected action allows."
    );
  }
  if (maxLength != null && response.text.length > maxLength) {
    return invalidActionResponse(
      "response.text",
      "Free-text response is longer than the selected action allows."
    );
  }

  return storedPayload("free_text", { text: response.text });
}

function validateSingleSelectResponse(
  action: PopupActionForValidation,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (typeof response.value !== "string") {
    return invalidActionResponse(
      "response.value",
      "Single-select responses require one option value."
    );
  }

  if (!new Set(action.optionValues ?? []).has(response.value)) {
    return invalidActionResponse(
      "response.value",
      "Single-select response must use one of the selected action options."
    );
  }

  return storedPayload("single_select", { value: response.value });
}

function validateMultiSelectResponse(
  action: Extract<PopupActionForValidation, { popupKind: "multi_select" }>,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (
    !Array.isArray(response.values) ||
    !response.values.every((value) => typeof value === "string")
  ) {
    return invalidActionResponse(
      "response.values",
      "Multi-select responses require option values."
    );
  }

  const uniqueValues = new Set(response.values);
  if (uniqueValues.size !== response.values.length) {
    return invalidActionResponse(
      "response.values",
      "Multi-select response values must be unique."
    );
  }

  const optionValues = new Set(action.optionValues ?? []);
  if (!response.values.every((value) => optionValues.has(value))) {
    return invalidActionResponse(
      "response.values",
      "Multi-select responses must use selected action options."
    );
  }

  const minSelected = action.popupPayload.min_selected;
  const maxSelected = action.popupPayload.max_selected;
  if (
    response.values.length < minSelected ||
    response.values.length > maxSelected
  ) {
    return invalidActionResponse(
      "response.values",
      "Multi-select response option count is outside the selected action bounds."
    );
  }

  return storedPayload("multi_select", { values: response.values });
}

function validateDatePickerResponse(
  popupPayload: NormalizedDatePickerPopupPayload,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (response.mode !== "date" && response.mode !== "datetime") {
    return invalidActionResponse(
      "response.mode",
      "Date-picker responses require a supported mode."
    );
  }

  const configuredMode = popupPayload.mode;
  if (configuredMode !== response.mode) {
    return invalidActionResponse(
      "response.mode",
      "Date-picker response mode must match the selected action."
    );
  }

  const configuredTimezone = popupPayload.display_timezone;

  if (response.mode === "date") {
    // Civil dates show only the caller-configured timezone, so none is invented.
    if (response.display_timezone !== configuredTimezone) {
      return invalidActionResponse(
        "response.display_timezone",
        "Date-picker timezone must match the selected action."
      );
    }

    if (
      typeof response.value_date !== "string" ||
      !validDateOnly(response.value_date)
    ) {
      return invalidActionResponse(
        "response.value_date",
        "Date-picker date responses require a YYYY-MM-DD date."
      );
    }

    const rangeFailure = validateDateRange(
      response.value_date,
      popupPayload.min_value,
      popupPayload.max_value
    );
    if (rangeFailure) {
      return rangeFailure;
    }

    return storedPayload("date_picker", {
      mode: "date",
      value_date: response.value_date,
      display_timezone: configuredTimezone
    });
  }

  if (typeof response.display_timezone !== "string") {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker datetime responses require the displayed timezone."
    );
  }
  if (!isIanaTimeZone(response.display_timezone)) {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker responses require an IANA timezone name."
    );
  }
  if (configuredTimezone && response.display_timezone !== configuredTimezone) {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker timezone must match the selected action."
    );
  }

  if (
    typeof response.value_utc !== "string" ||
    !validUtcDateTime(response.value_utc)
  ) {
    return invalidActionResponse(
      "response.value_utc",
      "Date-picker datetime responses require a UTC ISO-8601 datetime."
    );
  }

  const rangeFailure = validateDateTimeRange(
    response.value_utc,
    popupPayload.min_value,
    popupPayload.max_value
  );
  if (rangeFailure) {
    return rangeFailure;
  }

  return storedPayload("date_picker", {
    mode: "datetime",
    value_utc: response.value_utc,
    display_timezone: response.display_timezone
  });
}

function validateFileUploadResponse(
  popupPayload: NormalizedFileUploadPopupPayload,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (!(response.file instanceof File)) {
    return invalidActionResponse(
      "response.file",
      "File-upload responses require one uploaded file."
    );
  }
  if (response.file.size <= 0) {
    return invalidActionResponse(
      "response.file",
      "File-upload responses require a non-empty uploaded file."
    );
  }
  if (!Number.isSafeInteger(response.file.size)) {
    return invalidActionResponse(
      "response.file",
      "Uploaded file size is outside the supported range."
    );
  }

  const mimeType = normalizeMimeType(response.file.type);
  const patterns = popupPayload.accept_mime_types;
  if (
    patterns &&
    (!mimeType ||
      !patterns.some((pattern) =>
        pattern.endsWith("/*")
          ? mimeType.startsWith(pattern.slice(0, -1))
          : mimeType === pattern
      ))
  ) {
    return invalidActionResponse(
      "response.file",
      "Uploaded file MIME type is not accepted by the selected action."
    );
  }

  return storedPayload("file_upload", {}, response.file);
}

function validateDateRange(
  value: string,
  minValue: string | null,
  maxValue: string | null
): HumanAnswerFailure | null {
  if (minValue !== null && value < minValue) {
    return invalidActionResponse(
      "response.value_date",
      "Date-picker date response is before the selected action minimum."
    );
  }
  if (maxValue !== null && value > maxValue) {
    return invalidActionResponse(
      "response.value_date",
      "Date-picker date response is after the selected action maximum."
    );
  }

  return null;
}

function validateDateTimeRange(
  value: string,
  minValue: string | null,
  maxValue: string | null
): HumanAnswerFailure | null {
  if (minValue !== null) {
    if (compareUtcDateTimeValues(value, minValue) < 0) {
      return invalidActionResponse(
        "response.value_utc",
        "Date-picker datetime response is before the selected action minimum."
      );
    }
  }
  if (maxValue !== null) {
    if (compareUtcDateTimeValues(value, maxValue) > 0) {
      return invalidActionResponse(
        "response.value_utc",
        "Date-picker datetime response is after the selected action maximum."
      );
    }
  }

  return null;
}

function storedPayload(
  responseKind: OutputResponseKind,
  responsePayload: JsonValue,
  file?: File
): StoredPayload | HumanAnswerFailure {
  const serialized = JSON.stringify(responsePayload);

  const responsePayloadBytes = Buffer.byteLength(serialized, "utf8");
  if (responsePayloadBytes > HUMAN_ANSWER_RESPONSE_BYTE_LIMIT) {
    return failure(
      "request_too_large",
      `Human answer response payload exceeds the ${HUMAN_ANSWER_RESPONSE_BYTE_LIMIT}-byte cap.`
    );
  }

  return {
    ok: true,
    responseKind,
    responsePayload,
    responsePayloadBytes,
    ...(file ? { file } : {})
  };
}

function outputExpiresAt(answeredAt: Date) {
  return new Date(
    answeredAt.getTime() +
      UNACKNOWLEDGED_OUTPUT_TIMEOUT_DAYS * 24 * 60 * 60 * 1000
  );
}

function timestampValue(value: Date) {
  return value.toISOString();
}

function byteCount(value: string | number) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RangeError("byte count must be a non-negative safe integer");
  }

  return numeric;
}

// Checks stored bound, timezone, and MIME values against the input rules
// before the response is inspected, so a malformed configuration fails loudly
// instead of disabling a check or reaching the stored answer.
function answerablePopup(
  inputActionId: string,
  popup: PersistedPopup,
  optionCount: number
): PersistedPopup {
  const source = `popup_payload for input action ${inputActionId}`;
  const malformed = (rule: string) =>
    new Error(`Malformed persisted ${source}: ${rule}.`);
  if (popup.popupKind === "free_text") {
    const { min_length, max_length } = popup.popupPayload;
    if (
      min_length !== null &&
      (!Number.isInteger(min_length) || min_length < 0)
    ) {
      throw malformed("min_length must be a non-negative integer or null");
    }
    if (
      max_length !== null &&
      (!Number.isInteger(max_length) || max_length <= 0)
    ) {
      throw malformed("max_length must be a positive integer or null");
    }
    if (min_length !== null && max_length !== null && min_length > max_length) {
      throw malformed("min_length must not exceed max_length");
    }
  }
  if (popup.popupKind === "multi_select") {
    const { min_selected, max_selected } = popup.popupPayload;
    if (
      !Number.isInteger(min_selected) ||
      !Number.isInteger(max_selected) ||
      min_selected < 0 ||
      min_selected > max_selected ||
      max_selected > optionCount
    ) {
      throw malformed(
        "multi_select bounds must be integers satisfying 0 <= min_selected <= max_selected <= option count"
      );
    }
  }
  if (popup.popupKind === "date_picker") {
    const { mode, display_timezone, min_value, max_value } = popup.popupPayload;
    // Mirrors the input rule, which accepts and stores an empty timezone.
    if (display_timezone && !isIanaTimeZone(display_timezone)) {
      throw malformed("display_timezone must be an IANA timezone name");
    }
    const validBound = mode === "date" ? validDateOnly : validUtcDateTime;
    for (const [key, value] of [
      ["min_value", min_value],
      ["max_value", max_value]
    ] as const) {
      if (value !== null && !validBound(value)) {
        throw malformed(`${key} must be a valid ${mode} bound`);
      }
    }
  }
  if (
    popup.popupKind !== "file_upload" ||
    popup.popupPayload.accept_mime_types === null
  ) {
    return popup;
  }
  const patterns = popup.popupPayload.accept_mime_types.map(
    normalizeMimeTypePattern
  );
  if (patterns.length === 0 || !patterns.every((pattern) => pattern !== null)) {
    throw malformed(
      "accept_mime_types must contain at least one valid MIME type pattern"
    );
  }
  return {
    ...popup,
    popupPayload: { ...popup.popupPayload, accept_mime_types: patterns }
  };
}

function normalizeMimeType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : null;
}

function normalizeMimeTypePattern(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(normalized)
    ? normalized
    : null;
}

function validDateOnly(value: string) {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validUtcDateTime(value: string) {
  return isValidUtcDateTime(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidActionResponse(
  path: string,
  message: string
): HumanAnswerFailure {
  return {
    ok: false,
    code: "invalid_action_response",
    message: "Action response does not match the selected action.",
    fields: [{ path, code: "invalid_action_response", message }]
  };
}

function failure(code: ApiErrorCode, message: string): HumanAnswerFailure {
  return { ok: false, code, message };
}
