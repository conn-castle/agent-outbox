import type {
  NormalizedDatePickerPopupPayload,
  NormalizedFileUploadPopupPayload,
  NormalizedFreeTextPopupPayload,
  NormalizedMultiSelectPopupPayload,
  NormalizedSelectPopupPayload
} from "./input-schema.ts";

export type PersistedPopup =
  | { popupKind: "none"; popupPayload: Record<string, never> }
  | { popupKind: "free_text"; popupPayload: NormalizedFreeTextPopupPayload }
  | { popupKind: "single_select"; popupPayload: NormalizedSelectPopupPayload }
  | {
      popupKind: "multi_select";
      popupPayload: NormalizedMultiSelectPopupPayload;
    }
  | {
      popupKind: "date_picker";
      popupPayload: NormalizedDatePickerPopupPayload;
    }
  | {
      popupKind: "file_upload";
      popupPayload: NormalizedFileUploadPopupPayload;
    };

export function persistedPopup(
  inputActionId: string,
  popupKind: unknown,
  rawPayload: unknown
): PersistedPopup {
  const payload = persistedPayload(
    `popup_payload for input action ${inputActionId}`,
    rawPayload
  );
  switch (popupKind) {
    case "none":
      return { popupKind: "none", popupPayload: {} };
    case "free_text":
      return {
        popupKind: "free_text",
        popupPayload: {
          label: persistedString(payload, "label"),
          placeholder: persistedNullableString(payload, "placeholder"),
          default_value: persistedNullableString(payload, "default_value"),
          multiline: persistedBoolean(payload, "multiline"),
          min_length: persistedNullableNumber(payload, "min_length"),
          max_length: persistedNullableNumber(payload, "max_length")
        }
      };
    case "single_select":
      return {
        popupKind: "single_select",
        popupPayload: { label: persistedString(payload, "label") }
      };
    case "multi_select":
      return {
        popupKind: "multi_select",
        popupPayload: {
          label: persistedString(payload, "label"),
          min_selected: persistedNumber(payload, "min_selected"),
          max_selected: persistedNumber(payload, "max_selected")
        }
      };
    case "date_picker":
      return {
        popupKind: "date_picker",
        popupPayload: {
          label: persistedString(payload, "label"),
          mode: persistedDatePickerMode(payload),
          placeholder: persistedNullableString(payload, "placeholder"),
          display_timezone: persistedNullableString(
            payload,
            "display_timezone"
          ),
          min_value: persistedNullableString(payload, "min_value"),
          max_value: persistedNullableString(payload, "max_value")
        }
      };
    case "file_upload":
      return {
        popupKind: "file_upload",
        popupPayload: {
          label: persistedString(payload, "label"),
          accept_mime_types: persistedNullableStringArray(
            payload,
            "accept_mime_types"
          )
        }
      };
    default:
      throw new Error(
        `Unsupported persisted popup_kind for input action ${inputActionId}: ${JSON.stringify(popupKind)}`
      );
  }
}

type PersistedPayload = {
  source: string;
  fields: Record<string, unknown>;
};

export function persistedPayload(
  source: string,
  value: unknown
): PersistedPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Malformed persisted ${source}: expected a JSON object.`);
  }
  return { source, fields: value as Record<string, unknown> };
}

function malformedPersistedField(
  payload: PersistedPayload,
  key: string,
  expected: string
) {
  return new Error(
    `Malformed persisted ${payload.source}: ${key} must be ${expected}, got ${persistedValueType(payload.fields[key])}.`
  );
}

// Names only the received type; persisted values can contain review content
// that must not reach logs or Sentry.
function persistedValueType(value: unknown) {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

export function persistedString(payload: PersistedPayload, key: string) {
  const value = payload.fields[key];
  if (typeof value !== "string") {
    throw malformedPersistedField(payload, key, "a string");
  }
  return value;
}

export function persistedNullableString(
  payload: PersistedPayload,
  key: string
) {
  const value = payload.fields[key];
  if (value !== null && typeof value !== "string") {
    throw malformedPersistedField(payload, key, "a string or null");
  }
  return value;
}

export function persistedNumber(payload: PersistedPayload, key: string) {
  const value = payload.fields[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedPersistedField(payload, key, "a finite number");
  }
  return value;
}

function persistedNullableNumber(payload: PersistedPayload, key: string) {
  const value = payload.fields[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedPersistedField(payload, key, "a finite number or null");
  }
  return value;
}

function persistedBoolean(payload: PersistedPayload, key: string) {
  const value = payload.fields[key];
  if (typeof value !== "boolean") {
    throw malformedPersistedField(payload, key, "a boolean");
  }
  return value;
}

function persistedDatePickerMode(payload: PersistedPayload) {
  const value = payload.fields.mode;
  if (value !== "date" && value !== "datetime") {
    throw malformedPersistedField(payload, "mode", '"date" or "datetime"');
  }
  return value;
}

function persistedNullableStringArray(payload: PersistedPayload, key: string) {
  const value = payload.fields[key];
  if (value === null) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw malformedPersistedField(payload, key, "an array of strings or null");
  }
  return value;
}
