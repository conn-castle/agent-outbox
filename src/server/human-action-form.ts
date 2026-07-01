import type { HumanActionResponse } from "./human-answer.ts";
import type { PopupKind } from "./input-schema.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedHumanAnswerForm =
  | {
      ok: true;
      inputItemId: string;
      callerId: string;
      expectedRevision: number;
      actionValue: string;
      response: HumanActionResponse;
    }
  | { ok: false };

export type ParsedBulkHumanAnswersForm =
  | {
      ok: true;
      actionValue: string;
      items: BulkAnswerItem[];
    }
  | { ok: false };

export type ParsedUndoHumanAnswerForm =
  | {
      ok: true;
      inputItemId: string;
      callerId: string;
      outputResultId: string;
    }
  | { ok: false };

export type BulkAnswerItem = {
  inputItemId: string;
  callerId: string;
  expectedRevision: number;
};

export function parseHumanAnswerForm(
  formData: FormData
): ParsedHumanAnswerForm {
  const inputItemId = uuidField(formData, "inputItemId");
  const callerId = uuidField(formData, "callerId");
  const expectedRevision = integerField(formData, "expectedRevision");
  const actionValue = stringField(formData, "actionValue");
  const popupKind = popupKindField(formData);
  if (
    !inputItemId ||
    !callerId ||
    expectedRevision == null ||
    !actionValue ||
    !popupKind
  ) {
    return { ok: false };
  }

  const response = responseFromForm(formData, popupKind);
  if (!response) {
    return { ok: false };
  }

  return {
    ok: true,
    inputItemId,
    callerId,
    expectedRevision,
    actionValue,
    response
  };
}

export function parseBulkHumanAnswersForm(
  formData: FormData
): ParsedBulkHumanAnswersForm {
  const actionValue = stringField(formData, "bulkActionValue");
  if (!actionValue) {
    return { ok: false };
  }

  const rawItems = formData.getAll("bulkItem");
  if (rawItems.length === 0) {
    return { ok: false };
  }

  const items: BulkAnswerItem[] = [];
  for (const rawItem of rawItems) {
    const item = parseBulkItem(rawItem);
    if (!item) {
      return { ok: false };
    }
    items.push(item);
  }

  return items.length > 0 ? { ok: true, actionValue, items } : { ok: false };
}

export function parseUndoHumanAnswerForm(
  formData: FormData
): ParsedUndoHumanAnswerForm {
  const inputItemId = uuidField(formData, "inputItemId");
  const callerId = uuidField(formData, "callerId");
  const outputResultId = uuidField(formData, "outputResultId");
  if (!inputItemId || !callerId || !outputResultId) {
    return { ok: false };
  }
  return { ok: true, inputItemId, callerId, outputResultId };
}

function responseFromForm(
  formData: FormData,
  popupKind: PopupKind
): HumanActionResponse | null {
  switch (popupKind) {
    case "none":
      return { kind: "none" };
    case "free_text": {
      const text = stringField(formData, "response.text");
      return text ? { kind: "free_text", text } : null;
    }
    case "single_select": {
      const value = stringField(formData, "response.value");
      return value ? { kind: "single_select", value } : null;
    }
    case "multi_select":
      return {
        kind: "multi_select",
        values: formData
          .getAll("response.values")
          .map((value) => (typeof value === "string" ? value : ""))
          .filter(Boolean)
      };
    case "date_picker": {
      const mode = stringField(formData, "response.mode");
      const displayTimezone = stringField(
        formData,
        "response.display_timezone"
      );
      if (!displayTimezone) {
        return null;
      }
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
      if (mode === "datetime") {
        const valueUtc = stringField(formData, "response.value_utc");
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
    case "file_upload":
      return null;
  }
}

function popupKindField(formData: FormData): PopupKind | null {
  const value = stringField(formData, "popupKind");
  if (
    value === "none" ||
    value === "free_text" ||
    value === "single_select" ||
    value === "multi_select" ||
    value === "date_picker" ||
    value === "file_upload"
  ) {
    return value;
  }
  return null;
}

function stringField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function uuidField(formData: FormData, key: string) {
  const value = stringField(formData, key);
  return value && UUID_PATTERN.test(value) ? value : null;
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
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.inputItemId !== "string" ||
      !UUID_PATTERN.test(parsed.inputItemId) ||
      typeof parsed.callerId !== "string" ||
      !UUID_PATTERN.test(parsed.callerId) ||
      typeof parsed.expectedRevision !== "number" ||
      !Number.isSafeInteger(parsed.expectedRevision)
    ) {
      return null;
    }
    return {
      inputItemId: parsed.inputItemId,
      callerId: parsed.callerId,
      expectedRevision: parsed.expectedRevision
    };
  } catch {
    return null;
  }
}
