import { Buffer } from "node:buffer";

import {
  auditSafeLifecycleEvent,
  type AuditSafeLifecycleEvent
} from "./accounting.ts";
import { preReadUndoStatement } from "./cleanup.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import type { ApiErrorCode, ApiFieldError } from "./api-errors.ts";
import { isIanaTimeZone } from "./input-schema.ts";

export const HUMAN_ANSWER_RESPONSE_BYTE_LIMIT = 128_000;
export const UNACKNOWLEDGED_OUTPUT_TIMEOUT_DAYS = 14;

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
  display_timezone: string;
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
  file: UploadedFileResponse;
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
  popup_kind: OutputResponseKind;
  popup_payload: unknown;
};

type PopupOptionRow = {
  option_value: string;
};

type OutputInsertRow = {
  output_result_id: string;
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
};

type PopupActionForValidation = {
  popupKind: OutputResponseKind;
  popupPayload: unknown;
  optionValues?: readonly string[];
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function createHumanAnswer(
  connectionString: string,
  input: CreateHumanAnswerInput
): Promise<HumanAnswerResult> {
  return runProductTransaction(
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
}

export async function createHumanAnswerInTransaction(
  query: ProductTransactionQuery,
  input: CreateHumanAnswerInput
): Promise<HumanAnswerResult> {
  const contextFailure = validateHumanAnswerInput(input);
  if (contextFailure) {
    return contextFailure;
  }

  const answeredAt = input.answeredAt ?? new Date();
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
  const payloadResult = validatedResponsePayload(
    {
      popupKind: action.popup_kind,
      popupPayload: action.popup_payload,
      optionValues: optionResult.rows.map((row) => row.option_value)
    },
    input.response
  );

  if (!payloadResult.ok) {
    return payloadResult;
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

  await query(markInputAnsweredStatement(input.inputItemId, answeredAt));

  const expiresAt = outputExpiresAt(answeredAt);
  const auditEvents = [
    auditSafeLifecycleEvent({
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
    auditSafeLifecycleEvent({
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

  for (const event of auditEvents) {
    await query(insertAuditEventStatement(event));
  }

  return {
    ok: true,
    outputResultId,
    inputItemId: targetInput.input_item_id,
    callerItemId: targetInput.caller_item_id,
    actionValue: input.actionValue,
    responseKind: payloadResult.responseKind,
    responsePayload: payloadResult.responsePayload,
    responsePayloadBytes: payloadResult.responsePayloadBytes,
    answeredAt: timestampValue(answeredAt),
    expiresAt: timestampValue(expiresAt)
  };
}

export async function undoHumanAnswerBeforeRead(
  connectionString: string,
  input: PreReadUndoInput
): Promise<PreReadUndoResult> {
  return runProductTransaction(
    connectionString,
    {
      requestId: input.requestId,
      authSurface: "human",
      accountId: input.accountId,
      callerId: input.callerId,
      userId: input.humanUserId
    },
    (query) => undoHumanAnswerBeforeReadInTransaction(query, input)
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
      return invalidActionResponse(
        "response.kind",
        "File upload answers require the dedicated file workflow."
      );
  }
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
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
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

function insertAuditEventStatement(
  event: AuditSafeLifecycleEvent
): TransactionContextStatement {
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
        non_file_bytes,
        file_bytes,
        quota_metric,
        limit_name,
        deletion_reason,
        request_id,
        correlation_id,
        caller_item_id_hash,
        metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb
      )
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
      event.non_file_bytes ?? null,
      event.file_bytes ?? null,
      event.quota_metric ?? null,
      event.limit_name ?? null,
      event.deletion_reason ?? null,
      event.request_id ?? null,
      event.correlation_id ?? null,
      event.caller_item_id_hash ?? null,
      JSON.stringify(event.metadata)
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
  popupPayload: unknown,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (typeof response.text !== "string") {
    return invalidActionResponse(
      "response.text",
      "Free-text responses require text."
    );
  }

  const minLength = numberField(popupPayload, "min_length");
  const maxLength = numberField(popupPayload, "max_length");
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
  action: PopupActionForValidation,
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

  const minSelected = numberField(action.popupPayload, "min_selected") ?? 0;
  const maxSelected =
    numberField(action.popupPayload, "max_selected") ?? optionValues.size;
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
  popupPayload: unknown,
  response: Record<string, unknown>
): StoredPayload | HumanAnswerFailure {
  if (response.mode !== "date" && response.mode !== "datetime") {
    return invalidActionResponse(
      "response.mode",
      "Date-picker responses require a supported mode."
    );
  }

  const configuredMode = stringField(popupPayload, "mode");
  if (configuredMode !== response.mode) {
    return invalidActionResponse(
      "response.mode",
      "Date-picker response mode must match the selected action."
    );
  }

  if (typeof response.display_timezone !== "string") {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker responses require the displayed timezone."
    );
  }
  if (!isIanaTimeZone(response.display_timezone)) {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker responses require an IANA timezone name."
    );
  }

  const configuredTimezone = stringField(popupPayload, "display_timezone");
  if (configuredTimezone && response.display_timezone !== configuredTimezone) {
    return invalidActionResponse(
      "response.display_timezone",
      "Date-picker timezone must match the selected action."
    );
  }

  if (response.mode === "date") {
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
      stringField(popupPayload, "min_value"),
      stringField(popupPayload, "max_value")
    );
    if (rangeFailure) {
      return rangeFailure;
    }

    return storedPayload("date_picker", {
      mode: "date",
      value_date: response.value_date,
      display_timezone: response.display_timezone
    });
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
    stringField(popupPayload, "min_value"),
    stringField(popupPayload, "max_value")
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

function validateDateRange(
  value: string,
  minValue: string | null,
  maxValue: string | null
): HumanAnswerFailure | null {
  if (minValue && (!validDateOnly(minValue) || value < minValue)) {
    return invalidActionResponse(
      "response.value_date",
      "Date-picker date response is before the selected action minimum."
    );
  }
  if (maxValue && (!validDateOnly(maxValue) || value > maxValue)) {
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
  const valueMs = new Date(value).getTime();
  if (minValue) {
    const minMs = new Date(minValue).getTime();
    if (!validUtcDateTime(minValue) || valueMs < minMs) {
      return invalidActionResponse(
        "response.value_utc",
        "Date-picker datetime response is before the selected action minimum."
      );
    }
  }
  if (maxValue) {
    const maxMs = new Date(maxValue).getTime();
    if (!validUtcDateTime(maxValue) || valueMs > maxMs) {
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
  responsePayload: JsonValue
): StoredPayload | HumanAnswerFailure {
  const serialized = JSON.stringify(responsePayload);

  const responsePayloadBytes = Buffer.byteLength(serialized, "utf8");
  if (responsePayloadBytes > HUMAN_ANSWER_RESPONSE_BYTE_LIMIT) {
    return failure(
      "request_too_large",
      "Human answer response payload exceeds the 128000-byte cap."
    );
  }

  return {
    ok: true,
    responseKind,
    responsePayload,
    responsePayloadBytes
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

function numberField(source: unknown, key: string): number | null {
  if (!isRecord(source)) {
    return null;
  }

  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(source: unknown, key: string): string | null {
  if (!isRecord(source)) {
    return null;
  }

  const value = source[key];
  return typeof value === "string" ? value : null;
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
  return value.endsWith("Z") && !Number.isNaN(new Date(value).getTime());
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
