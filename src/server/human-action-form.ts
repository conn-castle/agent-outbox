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

function utcFromLocalDateTime(
  value: string | null,
  timezone: string
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) {
    return null;
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
  if (!validLocalDateTimeParts(desired)) {
    return null;
  }

  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute
  );
  let instant = desiredUtc;

  try {
    for (let index = 0; index < 3; index += 1) {
      const parts = zonedParts(new Date(instant), timezone);
      const renderedUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute
      );
      instant += desiredUtc - renderedUtc;
    }
    const finalParts = zonedParts(new Date(instant), timezone);
    if (!sameLocalDateTimeParts(desired, finalParts)) {
      return null;
    }
  } catch {
    return null;
  }

  return new Date(instant).toISOString();
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function validLocalDateTimeParts(parts: LocalDateTimeParts) {
  if (
    !Number.isSafeInteger(parts.year) ||
    !Number.isSafeInteger(parts.month) ||
    !Number.isSafeInteger(parts.day) ||
    !Number.isSafeInteger(parts.hour) ||
    !Number.isSafeInteger(parts.minute) ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59
  ) {
    return false;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  );
}

function sameLocalDateTimeParts(
  left: LocalDateTimeParts,
  right: LocalDateTimeParts
) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
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
