import { utcFromLocalDateTime } from "../shared/local-datetime.ts";
import {
  CANONICAL_UUID_PATTERN,
  VERSIONED_UUID_PATTERN
} from "./api-errors.ts";
import type { HumanActionResponse } from "./human-answer.ts";
import { isStorableString } from "./input-schema.ts";
import {
  isOneOf,
  POPUP_KINDS,
  type PopupKind
} from "../shared/input-schema-rules.ts";

export const MAX_BULK_HUMAN_ANSWER_ITEMS = 100;

export type ParsedHumanAnswerForm =
  | {
      ok: true;
      mutationId: string;
      inputItemId: string;
      callerId: string;
      expectedRevision: number;
      actionValue: string;
      response: HumanActionResponse;
      feedback?: string;
    }
  | { ok: false };

export type ParsedBulkHumanAnswersForm =
  | {
      ok: true;
      mutationId: string;
      actionValue: string;
      items: BulkAnswerItem[];
    }
  | { ok: false };

export type ParsedUndoHumanAnswerForm =
  | {
      ok: true;
      mutationId: string;
      inputItemId: string;
      callerId: string;
      outputResultId: string;
    }
  | { ok: false };

export type BulkAnswerItem = {
  inputItemId: string;
  callerId: string;
  expectedRevision: number;
  feedback?: string;
};

export function parseHumanAnswerForm(
  formData: FormData
): ParsedHumanAnswerForm {
  const inputItemId = uuidField(formData, "inputItemId");
  const callerId = uuidField(formData, "callerId");
  const expectedRevision = integerField(formData, "expectedRevision");
  const actionValue = stringField(formData, "actionValue");
  const popupKind = popupKindField(formData);
  const feedback = feedbackField(formData, "feedback");
  const mutationId = mutationIdField(formData);
  if (
    !mutationId ||
    !inputItemId ||
    !callerId ||
    expectedRevision == null ||
    !actionValue ||
    !popupKind ||
    feedback === null
  ) {
    return { ok: false };
  }

  const response = responseFromForm(formData, popupKind);
  if (!response) {
    return { ok: false };
  }

  return {
    ok: true,
    mutationId,
    inputItemId,
    callerId,
    expectedRevision,
    actionValue,
    response,
    ...(feedback ? { feedback } : {})
  };
}

export function parseBulkHumanAnswersForm(
  formData: FormData
): ParsedBulkHumanAnswersForm {
  const actionValue = stringField(formData, "bulkActionValue");
  const mutationId = mutationIdField(formData);
  if (!actionValue || !mutationId) {
    return { ok: false };
  }

  const rawItems = formData.getAll("bulkItem");
  if (rawItems.length === 0 || rawItems.length > MAX_BULK_HUMAN_ANSWER_ITEMS) {
    return { ok: false };
  }

  const items: BulkAnswerItem[] = [];
  const inputItemIds = new Set<string>();
  for (const rawItem of rawItems) {
    const item = parseBulkItem(rawItem);
    if (!item || inputItemIds.has(item.inputItemId)) {
      return { ok: false };
    }
    inputItemIds.add(item.inputItemId);
    const feedback = feedbackField(formData, `feedback.${item.inputItemId}`);
    if (feedback === null) return { ok: false };
    if (feedback) item.feedback = feedback;
    items.push(item);
  }

  return items.length > 0
    ? { ok: true, mutationId, actionValue, items }
    : { ok: false };
}

export function parseUndoHumanAnswerForm(
  formData: FormData
): ParsedUndoHumanAnswerForm {
  const inputItemId = uuidField(formData, "inputItemId");
  const callerId = uuidField(formData, "callerId");
  const outputResultId = uuidField(formData, "outputResultId");
  const mutationId = mutationIdField(formData);
  if (!mutationId || !inputItemId || !callerId || !outputResultId) {
    return { ok: false };
  }
  return { ok: true, mutationId, inputItemId, callerId, outputResultId };
}

function responseFromForm(
  formData: FormData,
  popupKind: PopupKind
): HumanActionResponse | null {
  switch (popupKind) {
    case "none":
      return { kind: "none" };
    case "free_text": {
      const text = rawStringField(formData, "response.text");
      return text === null
        ? null
        : { kind: "free_text", text: normalizeLineBreaks(text) };
    }
    case "single_select": {
      const value = stringField(formData, "response.value");
      return value ? { kind: "single_select", value } : null;
    }
    case "multi_select": {
      const values = formData.getAll("response.values");
      if (
        values.some(
          (value) => typeof value === "string" && !isStorableString(value)
        )
      ) {
        return null;
      }
      return {
        kind: "multi_select",
        values: values
          .map((value) => (typeof value === "string" ? value : ""))
          .filter(Boolean)
      };
    }
    case "date_picker": {
      const mode = stringField(formData, "response.mode");
      const rawDisplayTimezone = formData.get("response.display_timezone");
      if (
        typeof rawDisplayTimezone === "string" &&
        !isStorableString(rawDisplayTimezone)
      ) {
        return null;
      }
      const displayTimezone = stringField(
        formData,
        "response.display_timezone"
      );
      if (mode === "date") {
        const valueDate = stringField(formData, "response.value_date");
        return valueDate
          ? {
              kind: "date_picker",
              mode,
              value_date: valueDate,
              display_timezone: displayTimezone
            }
          : null;
      }
      if (!displayTimezone) {
        return null;
      }
      if (mode === "datetime") {
        const valueUtc = utcFromLocalDateTime(
          stringField(formData, "response.value_local"),
          displayTimezone
        );
        return valueUtc
          ? {
              kind: "date_picker",
              mode,
              value_utc: valueUtc,
              display_timezone: displayTimezone
            }
          : null;
      }
      return null;
    }
    case "file_upload": {
      const values = formData.getAll("response.file");
      const file = values[0];
      return values.length === 1 && file instanceof File && file.size > 0
        ? { kind: "file_upload", file }
        : null;
    }
  }
}

function popupKindField(formData: FormData): PopupKind | null {
  const value = stringField(formData, "popupKind");
  return isOneOf(POPUP_KINDS, value) ? value : null;
}

function stringField(formData: FormData, key: string) {
  const value = rawStringField(formData, key);
  return value !== null && value.trim() !== "" ? value : null;
}

function rawStringField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && isStorableString(value) ? value : null;
}

function feedbackField(formData: FormData, key: string) {
  const values = formData.getAll(key);
  if (values.length === 0) return undefined;
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    !isStorableString(values[0])
  ) {
    return null;
  }
  return values[0].trim() ? normalizeLineBreaks(values[0]) : undefined;
}

// Multipart form encoding turns every textarea line break into CRLF, while the
// browser measures and displays the text with LF line breaks.
function normalizeLineBreaks(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

// Ids are accepted only as the server issues them, in lowercase, so an id
// from a form always equals the id of the row it names.
function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    VERSIONED_UUID_PATTERN.test(value) &&
    CANONICAL_UUID_PATTERN.test(value)
  );
}

function uuidField(formData: FormData, key: string) {
  const value = stringField(formData, key);
  return isUuid(value) ? value : null;
}

/**
 * The client's id for this mutation, repeated on every retry of it. A form
 * posted without script has none and cannot retry, so it gets a fresh id.
 * Returns null when a supplied id is malformed.
 */
function mutationIdField(formData: FormData) {
  if (!formData.has("mutationId")) return crypto.randomUUID();
  return uuidField(formData, "mutationId");
}

function integerField(formData: FormData, key: string) {
  const value = stringField(formData, key);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBulkItem(value: FormDataEntryValue): BulkAnswerItem | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const item = parsed as Record<string, unknown>;
    if (
      !isUuid(item.inputItemId) ||
      !isUuid(item.callerId) ||
      typeof item.expectedRevision !== "number" ||
      !Number.isSafeInteger(item.expectedRevision)
    ) {
      return null;
    }
    return {
      inputItemId: item.inputItemId,
      callerId: item.callerId,
      expectedRevision: item.expectedRevision
    };
  } catch {
    return null;
  }
}
