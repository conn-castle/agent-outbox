import { createHash } from "node:crypto";

import type {
  ApiErrorCode,
  ApiErrorInput,
  ApiFieldError
} from "./api-errors.ts";
import {
  fileUploadEnabled,
  limitErrorMetadata,
  type LimitProfileSelector
} from "./limits.ts";
import {
  isSafeColor,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "../shared/input-schema-rules.ts";

export const INPUT_REQUEST_BODY_BYTE_LIMIT = 128_000;

export type QueuePriority = "low" | "normal" | "high" | "urgent";
export type PopupKind =
  | "none"
  | "free_text"
  | "single_select"
  | "multi_select"
  | "date_picker"
  | "file_upload";

export type NormalizedInputSubmission = {
  callerItemId: string;
  callerItemIdHash: string;
  priority: QueuePriority;
  rowType: {
    display: string;
    icon: string;
  };
  rowAccentColor: string | null;
  titleHtml: string;
  subtitleHtml: string;
  cornerHtml: string | null;
  summaryHtml: string;
  detailsHtml: string | null;
  linkButtons: NormalizedInputLinkButton[];
  cardVisual: NormalizedCardVisual | null;
  skipDisabled: boolean;
  actions: NormalizedInputAction[];
  normalizedContentFingerprint: string;
  nonFilePayloadBytes: number;
  containsFileUploadAction: boolean;
  normalizedContent: Record<string, unknown>;
};

export type NormalizedInputLinkButton = {
  displayOrder: number;
  display: string;
  icon: string;
  url: string;
};

export type NormalizedCardVisual =
  | {
      kind: "numeric_bar";
      payload: {
        label: string;
        value: number;
        display: string;
        unit: string | null;
        min_value: number;
        max_value: number;
      };
    }
  | {
      kind: "pill";
      payload: {
        text: string;
        icon: string | null;
        color: string;
      };
    }
  | {
      kind: "progress_ring";
      payload: {
        label: string;
        value: number;
        display: string;
        unit: string | null;
        min_value: number;
        max_value: number;
        color: string | null;
      };
    };

export type NormalizedInputAction = {
  displayOrder: number;
  display: string;
  icon: string;
  value: string;
  overflow: boolean;
  popupKind: PopupKind;
  popupPayload: Record<string, unknown>;
  options: NormalizedPopupOption[];
};

export type NormalizedPopupOption = {
  displayOrder: number;
  display: string;
  value: string;
  icon: string | null;
};

export type JsonBodyParseResult =
  | { ok: true; bytes: number; value: unknown }
  | { ok: false; error: ApiErrorInput };

export type InputSubmissionParseResult =
  | { ok: true; submission: NormalizedInputSubmission }
  | { ok: false; error: ApiErrorInput };

export type InputDeleteParseResult =
  { ok: true; callerItemId: string } | { ok: false; error: ApiErrorInput };

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CARD_VISUAL_KINDS = new Set(["numeric_bar", "pill", "progress_ring"]);
const POPUP_KINDS = new Set([
  "none",
  "free_text",
  "single_select",
  "multi_select",
  "date_picker",
  "file_upload"
]);
const MAX_LINK_BUTTONS = 32;
const MAX_ACTIONS = 32;
const MAX_SELECT_OPTIONS = 64;
const PROTOCOL_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/(?:[A-Za-z0-9!#$&^_.+-]+|\*)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
export { isSafeColor, SUPPORTED_LUCIDE_ICON_NAMES };

const SUPPORTED_LUCIDE_ICONS = new Set<string>(SUPPORTED_LUCIDE_ICON_NAMES);

const ALLOWED_HTML_ELEMENTS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
  "a"
]);

export async function readJsonBodyWithLimit(
  request: Request
): Promise<JsonBodyParseResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > INPUT_REQUEST_BODY_BYTE_LIMIT
  ) {
    return {
      ok: false,
      error: requestTooLargeError()
    };
  }

  const body = await request.arrayBuffer();
  const bytes = body.byteLength;

  if (bytes > INPUT_REQUEST_BODY_BYTE_LIMIT) {
    return {
      ok: false,
      error: requestTooLargeError()
    };
  }

  try {
    return {
      ok: true,
      bytes,
      value: JSON.parse(Buffer.from(body).toString("utf8"))
    };
  } catch {
    return {
      ok: false,
      error: {
        status: 400,
        code: "invalid_json",
        message: "Request body must be valid JSON."
      }
    };
  }
}

export function parseInputDeleteBody(value: unknown): InputDeleteParseResult {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      error: validationError([
        fieldError("", "invalid_request", "Request body must be an object.")
      ])
    };
  }

  const callerItemId = requiredString(
    value,
    "caller_item_id",
    fields,
    "caller_item_id"
  );

  if (fields.length > 0) {
    return { ok: false, error: validationError(fields) };
  }

  return { ok: true, callerItemId };
}

export function parseInputSubmission(
  value: unknown,
  options: { limitProfile?: LimitProfileSelector } = {}
): InputSubmissionParseResult {
  const fields: ApiFieldError[] = [];

  if (!isPlainRecord(value)) {
    return {
      ok: false,
      error: validationError([
        fieldError("", "invalid_request", "Request body must be an object.")
      ])
    };
  }

  if ("caller_id" in value) {
    fields.push(
      fieldError(
        "caller_id",
        "caller_id_not_allowed",
        "Caller identity is derived from bearer authentication."
      )
    );
  }

  const callerItemId = requiredString(
    value,
    "caller_item_id",
    fields,
    "caller_item_id"
  );
  const priority = optionalEnum(
    value,
    "priority",
    "normal",
    PRIORITIES,
    fields,
    "priority"
  ) as QueuePriority;
  const rowType = parseRowType(value.row_type, fields, "row_type");
  const rowAccentColor = optionalColor(
    value.row_accent_color,
    fields,
    "row_accent_color"
  );
  const titleHtml = requiredHtml(value, "title", fields, "title");
  const subtitleHtml = requiredHtml(value, "subtitle", fields, "subtitle");
  const cornerHtml = optionalHtml(value.corner, fields, "corner");
  const summaryHtml = requiredHtml(value, "summary", fields, "summary");
  const detailsHtml = optionalHtml(value.details, fields, "details");
  const linkButtons = parseLinkButtons(value.link_buttons, fields);
  const cardVisual = parseCardVisual(value.card_visual, fields, "card_visual");
  const skipDisabled = optionalBoolean(
    value,
    "skip_disabled",
    false,
    fields,
    "skip_disabled"
  );
  const actions = parseActions(value.actions, fields);
  const containsFileUploadAction = actions.some(
    (action) => action.popupKind === "file_upload"
  );

  if (fields.length > 0) {
    return { ok: false, error: validationError(fields) };
  }

  if (
    containsFileUploadAction &&
    options.limitProfile &&
    !fileUploadEnabled(options.limitProfile)
  ) {
    return {
      ok: false,
      error: {
        status: 402,
        code: "upgrade_required",
        message: "File upload actions require a paid hosted account.",
        limit: limitErrorMetadata(options.limitProfile, "file_upload_enabled"),
        upgrade: {
          message: "File upload actions require a paid hosted account.",
          url: "https://app.agent-outbox.dev/upgrade"
        }
      }
    };
  }
  if (containsFileUploadAction) {
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message:
          "File upload actions require the paid file upload workflow, which is not available in this API phase."
      }
    };
  }

  const normalizedContent = {
    caller_item_id: callerItemId,
    priority,
    row_type: rowType,
    row_accent_color: rowAccentColor,
    title: titleHtml,
    subtitle: subtitleHtml,
    corner: cornerHtml,
    summary: summaryHtml,
    details: detailsHtml,
    link_buttons: linkButtons.map(({ displayOrder: _order, ...button }) => ({
      display: button.display,
      icon: button.icon,
      url: button.url
    })),
    card_visual: cardVisual
      ? { kind: cardVisual.kind, ...cardVisual.payload }
      : null,
    skip_disabled: skipDisabled,
    actions: actions.map((action) => ({
      display: action.display,
      icon: action.icon,
      value: action.value,
      overflow: action.overflow,
      popup: {
        kind: action.popupKind,
        ...action.popupPayload,
        ...(action.options.length > 0 ? { options: action.options } : {})
      }
    }))
  };
  const canonical = stableStringify(normalizedContent);

  return {
    ok: true,
    submission: {
      callerItemId,
      callerItemIdHash: sha256Hex(callerItemId),
      priority,
      rowType,
      rowAccentColor,
      titleHtml,
      subtitleHtml,
      cornerHtml,
      summaryHtml,
      detailsHtml,
      linkButtons,
      cardVisual,
      skipDisabled,
      actions,
      normalizedContentFingerprint: sha256Hex(canonical),
      nonFilePayloadBytes: Buffer.byteLength(canonical, "utf8"),
      containsFileUploadAction,
      normalizedContent
    }
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function requestTooLargeError(): ApiErrorInput {
  return {
    status: 413,
    code: "request_too_large",
    message: "Input request body exceeds the 128,000 byte limit.",
    limit: {
      limit_name: "input_request_body_bytes_excluding_files",
      limit_reason_code: "input_request_too_large",
      limit_reason: "Input request body exceeds the accepted byte ceiling.",
      limit_resets_at: null
    }
  };
}

function parseRowType(value: unknown, fields: ApiFieldError[], path: string) {
  if (!isPlainRecord(value)) {
    fields.push(
      fieldError(path, "invalid_type", "row_type must be an object.")
    );
    return { display: "", icon: "" };
  }

  return {
    display: requiredString(value, "display", fields, `${path}.display`),
    icon: requiredIcon(value, "icon", fields, `${path}.icon`)
  };
}

function parseLinkButtons(value: unknown, fields: ApiFieldError[]) {
  if (!Array.isArray(value)) {
    fields.push(
      fieldError(
        "link_buttons",
        "invalid_type",
        "link_buttons must be an array."
      )
    );
    return [];
  }
  if (value.length > MAX_LINK_BUTTONS) {
    fields.push(
      fieldError(
        "link_buttons",
        "too_many_items",
        "link_buttons may contain at most 32 entries."
      )
    );
    return [];
  }

  return value.map((entry, index): NormalizedInputLinkButton => {
    const path = `link_buttons[${index}]`;
    if (!isPlainRecord(entry)) {
      fields.push(
        fieldError(path, "invalid_type", "Link button must be an object.")
      );
      return { displayOrder: index, display: "", icon: "", url: "" };
    }

    return {
      displayOrder: index,
      display: requiredString(entry, "display", fields, `${path}.display`),
      icon: requiredIcon(entry, "icon", fields, `${path}.icon`),
      url: requiredHttpUrl(entry, "url", fields, `${path}.url`)
    };
  });
}

function parseActions(value: unknown, fields: ApiFieldError[]) {
  if (!Array.isArray(value)) {
    fields.push(
      fieldError("actions", "invalid_type", "actions must be an array.")
    );
    return [];
  }
  if (value.length < 1 || value.length > MAX_ACTIONS) {
    fields.push(
      fieldError(
        "actions",
        "invalid_length",
        "actions must contain 1 to 32 entries."
      )
    );
    return [];
  }

  const seenActionValues = new Set<string>();
  return value.map((entry, index): NormalizedInputAction => {
    const path = `actions[${index}]`;
    if (!isPlainRecord(entry)) {
      fields.push(
        fieldError(path, "invalid_type", "Action must be an object.")
      );
      return placeholderAction(index);
    }

    const actionValue = requiredProtocolValue(
      entry,
      "value",
      fields,
      `${path}.value`
    );
    if (actionValue && seenActionValues.has(actionValue)) {
      fields.push(
        fieldError(
          `${path}.value`,
          "duplicate_action_value",
          "Action values must be unique within one input item."
        )
      );
    }
    seenActionValues.add(actionValue);

    const popup = parsePopup(entry.popup, fields, `${path}.popup`);

    return {
      displayOrder: index,
      display: requiredString(entry, "display", fields, `${path}.display`),
      icon: requiredIcon(entry, "icon", fields, `${path}.icon`),
      value: actionValue,
      overflow: requiredBoolean(entry, "overflow", fields, `${path}.overflow`),
      popupKind: popup.kind,
      popupPayload: popup.payload,
      options: popup.options
    };
  });
}

function parsePopup(value: unknown, fields: ApiFieldError[], path: string) {
  if (!isPlainRecord(value)) {
    fields.push(fieldError(path, "invalid_type", "popup must be an object."));
    return { kind: "none" as const, payload: {}, options: [] };
  }

  const kind = requiredEnum(value, "kind", POPUP_KINDS, fields, `${path}.kind`);
  switch (kind) {
    case "none":
      return { kind, payload: {}, options: [] };
    case "free_text":
      return parseFreeTextPopup(value, fields, path);
    case "single_select":
      return parseSelectPopup(value, fields, path, false);
    case "multi_select":
      return parseSelectPopup(value, fields, path, true);
    case "date_picker":
      return parseDatePickerPopup(value, fields, path);
    case "file_upload":
      return parseFileUploadPopup(value, fields, path);
    default:
      return { kind: "none" as const, payload: {}, options: [] };
  }
}

function parseFreeTextPopup(
  value: Record<string, unknown>,
  fields: ApiFieldError[],
  path: string
) {
  const minLength = optionalInteger(
    value.min_length,
    fields,
    `${path}.min_length`
  );
  const maxLength = optionalInteger(
    value.max_length,
    fields,
    `${path}.max_length`
  );

  if (minLength != null && minLength < 0) {
    fields.push(
      fieldError(
        `${path}.min_length`,
        "invalid_bound",
        "min_length must be non-negative."
      )
    );
  }
  if (maxLength != null && maxLength <= 0) {
    fields.push(
      fieldError(
        `${path}.max_length`,
        "invalid_bound",
        "max_length must be positive."
      )
    );
  }
  if (minLength != null && maxLength != null && minLength > maxLength) {
    fields.push(
      fieldError(
        `${path}.max_length`,
        "invalid_bound",
        "min_length must be less than or equal to max_length."
      )
    );
  }

  return {
    kind: "free_text" as const,
    payload: {
      label: requiredString(value, "label", fields, `${path}.label`),
      placeholder: optionalString(
        value.placeholder,
        fields,
        `${path}.placeholder`
      ),
      default_value: optionalString(
        value.default_value,
        fields,
        `${path}.default_value`
      ),
      multiline: requiredBoolean(
        value,
        "multiline",
        fields,
        `${path}.multiline`
      ),
      min_length: minLength,
      max_length: maxLength
    },
    options: []
  };
}

function parseSelectPopup(
  value: Record<string, unknown>,
  fields: ApiFieldError[],
  path: string,
  multi: boolean
) {
  const options = parsePopupOptions(value.options, fields, `${path}.options`);
  const minSelected = multi
    ? (optionalInteger(value.min_selected, fields, `${path}.min_selected`) ?? 0)
    : null;
  const maxSelected = multi
    ? (optionalInteger(value.max_selected, fields, `${path}.max_selected`) ??
      options.length)
    : null;

  if (
    multi &&
    (minSelected == null ||
      maxSelected == null ||
      minSelected < 0 ||
      minSelected > maxSelected ||
      maxSelected > options.length)
  ) {
    fields.push(
      fieldError(
        `${path}.max_selected`,
        "invalid_bound",
        "multi_select bounds must satisfy 0 <= min_selected <= max_selected <= options.length."
      )
    );
  }

  return {
    kind: multi ? ("multi_select" as const) : ("single_select" as const),
    payload: multi
      ? {
          label: requiredString(value, "label", fields, `${path}.label`),
          min_selected: minSelected,
          max_selected: maxSelected
        }
      : {
          label: requiredString(value, "label", fields, `${path}.label`)
        },
    options
  };
}

function parsePopupOptions(
  value: unknown,
  fields: ApiFieldError[],
  path: string
) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_SELECT_OPTIONS
  ) {
    fields.push(
      fieldError(
        path,
        "invalid_length",
        "Select options must contain 1 to 64 entries."
      )
    );
    return [];
  }

  const seenValues = new Set<string>();
  return value.map((entry, index): NormalizedPopupOption => {
    const optionPath = `${path}[${index}]`;
    if (!isPlainRecord(entry)) {
      fields.push(
        fieldError(optionPath, "invalid_type", "Option must be an object.")
      );
      return { displayOrder: index, display: "", value: "", icon: null };
    }

    const optionValue = requiredProtocolValue(
      entry,
      "value",
      fields,
      `${optionPath}.value`
    );
    if (optionValue && seenValues.has(optionValue)) {
      fields.push(
        fieldError(
          `${optionPath}.value`,
          "duplicate_option_value",
          "Option values must be unique within one popup."
        )
      );
    }
    seenValues.add(optionValue);

    return {
      displayOrder: index,
      display: requiredString(
        entry,
        "display",
        fields,
        `${optionPath}.display`
      ),
      value: optionValue,
      icon: optionalIcon(entry.icon, fields, `${optionPath}.icon`)
    };
  });
}

function parseDatePickerPopup(
  value: Record<string, unknown>,
  fields: ApiFieldError[],
  path: string
) {
  const mode = requiredEnum(
    value,
    "mode",
    new Set(["date", "datetime"]),
    fields,
    `${path}.mode`
  ) as "date" | "datetime";
  const displayTimezone = optionalString(
    value.display_timezone,
    fields,
    `${path}.display_timezone`
  );
  const minValue = optionalDatePickerValue(
    value.min_value,
    mode,
    fields,
    `${path}.min_value`
  );
  const maxValue = optionalDatePickerValue(
    value.max_value,
    mode,
    fields,
    `${path}.max_value`
  );

  if (displayTimezone && !isIanaTimeZone(displayTimezone)) {
    fields.push(
      fieldError(
        `${path}.display_timezone`,
        "invalid_timezone",
        "display_timezone must be an IANA timezone name."
      )
    );
  }
  if (
    minValue &&
    maxValue &&
    compareDatePickerValues(minValue, maxValue, mode) > 0
  ) {
    fields.push(
      fieldError(
        `${path}.max_value`,
        "invalid_range",
        "date_picker min_value must be less than or equal to max_value."
      )
    );
  }

  return {
    kind: "date_picker" as const,
    payload: {
      label: requiredString(value, "label", fields, `${path}.label`),
      mode,
      placeholder: optionalString(
        value.placeholder,
        fields,
        `${path}.placeholder`
      ),
      display_timezone: displayTimezone,
      min_value: minValue,
      max_value: maxValue
    },
    options: []
  };
}

function parseFileUploadPopup(
  value: Record<string, unknown>,
  fields: ApiFieldError[],
  path: string
) {
  const acceptMimeTypes =
    value.accept_mime_types == null
      ? null
      : parseAcceptMimeTypes(
          value.accept_mime_types,
          fields,
          `${path}.accept_mime_types`
        );

  return {
    kind: "file_upload" as const,
    payload: {
      label: requiredString(value, "label", fields, `${path}.label`),
      accept_mime_types: acceptMimeTypes
    },
    options: []
  };
}

function parseAcceptMimeTypes(
  value: unknown,
  fields: ApiFieldError[],
  path: string
) {
  if (!Array.isArray(value) || value.length < 1) {
    fields.push(
      fieldError(
        path,
        "invalid_mime_types",
        "accept_mime_types must be null, omitted, or a non-empty array."
      )
    );
    return [];
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || !MIME_PATTERN.test(entry)) {
      fields.push(
        fieldError(
          `${path}[${index}]`,
          "invalid_mime_type",
          "accept_mime_types entries must be valid MIME type patterns."
        )
      );
      return "";
    }
    return entry.toLowerCase();
  });
}

function parseCardVisual(
  value: unknown,
  fields: ApiFieldError[],
  path: string
): NormalizedCardVisual | null {
  if (value == null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    fields.push(
      fieldError(path, "invalid_type", "card_visual must be an object or null.")
    );
    return null;
  }

  const kind = requiredEnum(
    value,
    "kind",
    CARD_VISUAL_KINDS,
    fields,
    `${path}.kind`
  );
  if (kind === "numeric_bar" || kind === "progress_ring") {
    const numeric = parseBoundedNumericVisual(value, fields, path);
    if (kind === "numeric_bar") {
      return { kind, payload: numeric };
    }
    return {
      kind,
      payload: {
        ...numeric,
        color: optionalColor(value.color, fields, `${path}.color`)
      }
    };
  }
  if (kind === "pill") {
    return {
      kind,
      payload: {
        text: requiredString(value, "text", fields, `${path}.text`),
        icon: optionalIcon(value.icon, fields, `${path}.icon`),
        color: requiredColor(value, "color", fields, `${path}.color`)
      }
    };
  }

  return null;
}

function parseBoundedNumericVisual(
  value: Record<string, unknown>,
  fields: ApiFieldError[],
  path: string
) {
  const numericValue = requiredFiniteNumber(
    value,
    "value",
    fields,
    `${path}.value`
  );
  const minValue = requiredFiniteNumber(
    value,
    "min_value",
    fields,
    `${path}.min_value`
  );
  const maxValue = requiredFiniteNumber(
    value,
    "max_value",
    fields,
    `${path}.max_value`
  );

  if (
    Number.isFinite(minValue) &&
    Number.isFinite(maxValue) &&
    minValue >= maxValue
  ) {
    fields.push(
      fieldError(
        `${path}.max_value`,
        "invalid_range",
        "min_value must be less than max_value."
      )
    );
  } else if (
    Number.isFinite(numericValue) &&
    Number.isFinite(minValue) &&
    Number.isFinite(maxValue) &&
    (numericValue < minValue || numericValue > maxValue)
  ) {
    fields.push(
      fieldError(
        `${path}.value`,
        "out_of_range",
        "value must be within min_value and max_value."
      )
    );
  }

  return {
    label: requiredString(value, "label", fields, `${path}.label`),
    value: numericValue,
    display: requiredString(value, "display", fields, `${path}.display`),
    unit: optionalString(value.unit, fields, `${path}.unit`),
    min_value: minValue,
    max_value: maxValue
  };
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "string" || value.length < 1) {
    fields.push(
      fieldError(path, "invalid_string", `${path} must be a non-empty string.`)
    );
    return "";
  }
  return value;
}

function optionalString(value: unknown, fields: ApiFieldError[], path: string) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    fields.push(
      fieldError(path, "invalid_string", `${path} must be a string or null.`)
    );
    return null;
  }
  return value;
}

function requiredBoolean(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "boolean") {
    fields.push(
      fieldError(path, "invalid_boolean", `${path} must be a boolean.`)
    );
    return false;
  }
  return value;
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  fields: ApiFieldError[],
  path: string
) {
  if (!(key in source) || source[key] == null) {
    return fallback;
  }
  return requiredBoolean(source, key, fields, path);
}

function requiredEnum(
  source: Record<string, unknown>,
  key: string,
  values: Set<string>,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "string" || !values.has(value)) {
    fields.push(
      fieldError(path, "invalid_enum", `${path} has an unsupported value.`)
    );
    return "";
  }
  return value;
}

function optionalEnum(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  values: Set<string>,
  fields: ApiFieldError[],
  path: string
) {
  if (!(key in source) || source[key] == null) {
    return fallback;
  }
  return requiredEnum(source, key, values, fields, path);
}

function requiredFiniteNumber(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fields.push(
      fieldError(path, "invalid_number", `${path} must be a finite number.`)
    );
    return Number.NaN;
  }
  return value;
}

function optionalInteger(
  value: unknown,
  fields: ApiFieldError[],
  path: string
): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fields.push(
      fieldError(path, "invalid_integer", `${path} must be an integer or null.`)
    );
    return null;
  }
  return value;
}

function requiredProtocolValue(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "string" || !PROTOCOL_VALUE_PATTERN.test(value)) {
    fields.push(
      fieldError(
        path,
        "invalid_protocol_value",
        "Values must match [A-Za-z0-9._:-]+ and be 1 to 128 characters."
      )
    );
    return "";
  }
  return value;
}

function requiredIcon(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  return validateIcon(source[key], fields, path, false) ?? "";
}

function optionalIcon(value: unknown, fields: ApiFieldError[], path: string) {
  return validateIcon(value, fields, path, true);
}

function validateIcon(
  value: unknown,
  fields: ApiFieldError[],
  path: string,
  optional: boolean
) {
  if (value == null && optional) {
    return null;
  }
  if (typeof value !== "string" || !SUPPORTED_LUCIDE_ICONS.has(value)) {
    fields.push(
      fieldError(
        path,
        "unsupported_icon",
        "Icon names must be supported Lucide icon keys."
      )
    );
    return optional ? null : "";
  }
  return value;
}

function requiredHttpUrl(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "string") {
    fields.push(
      fieldError(path, "invalid_url", `${path} must be an http or https URL.`)
    );
    return "";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("unsupported protocol");
    }
    return url.toString();
  } catch {
    fields.push(
      fieldError(path, "invalid_url", `${path} must be an http or https URL.`)
    );
    return "";
  }
}

function requiredHtml(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = requiredString(source, key, fields, path);
  if (value) {
    validateSafeHtml(value, fields, path);
  }
  return value;
}

function optionalHtml(value: unknown, fields: ApiFieldError[], path: string) {
  const html = optionalString(value, fields, path);
  if (html) {
    validateSafeHtml(html, fields, path);
  }
  return html;
}

function validateSafeHtml(html: string, fields: ApiFieldError[], path: string) {
  if (/<!--|<!doctype|<\?|<!\[CDATA\[/i.test(html)) {
    fields.push(
      fieldError(
        path,
        "unsafe_html",
        "HTML comments and document nodes are not allowed."
      )
    );
    return;
  }

  const stripped = html.replace(/<[^>]*>/g, (tag) => {
    validateHtmlTag(tag, fields, path);
    return "";
  });
  if (stripped.includes("<") || stripped.includes(">")) {
    fields.push(
      fieldError(
        path,
        "unsafe_html",
        "HTML must use allowed text-formatting tags only."
      )
    );
  }
}

function validateHtmlTag(
  rawTag: string,
  fields: ApiFieldError[],
  path: string
) {
  const match = rawTag.match(/^<\/?\s*([A-Za-z0-9:-]+)([\s\S]*?)\/?\s*>$/);
  if (!match) {
    fields.push(
      fieldError(path, "unsafe_html", "HTML tag syntax is not allowed.")
    );
    return;
  }

  const [, rawName, rawAttrs] = match;
  const name = rawName.toLowerCase();
  if (!ALLOWED_HTML_ELEMENTS.has(name) || name.includes(":")) {
    fields.push(
      fieldError(path, "unsafe_html", `HTML element <${name}> is not allowed.`)
    );
    return;
  }

  if (rawTag.startsWith("</")) {
    if (rawAttrs.trim()) {
      fields.push(
        fieldError(
          path,
          "unsafe_html",
          "Closing HTML tags cannot have attributes."
        )
      );
    }
    return;
  }

  validateHtmlAttributes(name, rawAttrs, fields, path);
}

function validateHtmlAttributes(
  tagName: string,
  rawAttrs: string,
  fields: ApiFieldError[],
  path: string
) {
  let remaining = rawAttrs.trim().replace(/\/$/, "").trim();
  while (remaining) {
    const match = remaining.match(
      /^([A-Za-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')\s*/
    );
    if (!match) {
      fields.push(
        fieldError(
          path,
          "unsafe_html",
          "HTML attributes must be quoted and allowed."
        )
      );
      return;
    }

    const attr = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? "";
    if (!htmlAttributeAllowed(tagName, attr, value)) {
      fields.push(
        fieldError(
          path,
          "unsafe_html",
          `HTML attribute ${attr} is not allowed.`
        )
      );
      return;
    }
    remaining = remaining.slice(match[0].length).trim();
  }
}

function htmlAttributeAllowed(tagName: string, attr: string, value: string) {
  if (
    attr.startsWith("on") ||
    attr === "style" ||
    attr === "class" ||
    attr === "id" ||
    attr.includes(":") ||
    /[<>]/.test(value)
  ) {
    return false;
  }

  if (tagName === "a") {
    if (attr === "title") {
      return true;
    }
    if (attr !== "href") {
      return false;
    }
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol);
    } catch {
      return false;
    }
  }

  if (
    (tagName === "td" || tagName === "th") &&
    (attr === "colspan" || attr === "rowspan")
  ) {
    return /^[1-9][0-9]?$/.test(value);
  }

  return false;
}

function requiredColor(
  source: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  path: string
) {
  const value = source[key];
  if (typeof value !== "string" || !isSafeColor(value)) {
    fields.push(
      fieldError(path, "unsafe_color", `${path} must be a safe CSS color.`)
    );
    return "";
  }
  return value;
}

function optionalColor(value: unknown, fields: ApiFieldError[], path: string) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || !isSafeColor(value)) {
    fields.push(
      fieldError(
        path,
        "unsafe_color",
        `${path} must be a safe CSS color or null.`
      )
    );
    return null;
  }
  return value;
}

function optionalDatePickerValue(
  value: unknown,
  mode: "date" | "datetime",
  fields: ApiFieldError[],
  path: string
) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    fields.push(
      fieldError(path, "invalid_date", `${path} must be a string or null.`)
    );
    return null;
  }
  if (mode === "date" && !isValidCivilDate(value)) {
    fields.push(
      fieldError(path, "invalid_date", `${path} must be YYYY-MM-DD.`)
    );
    return null;
  }
  if (mode === "datetime" && !isValidUtcDateTime(value)) {
    fields.push(
      fieldError(
        path,
        "invalid_datetime",
        `${path} must be an ISO-8601 UTC datetime.`
      )
    );
    return null;
  }
  return value;
}

function isValidCivilDate(value: string) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function isValidUtcDateTime(value: string) {
  return utcDateTimeSortKey(value) != null;
}

export function compareUtcDateTimeValues(left: string, right: string) {
  const leftKey = utcDateTimeSortKey(left);
  const rightKey = utcDateTimeSortKey(right);
  if (leftKey == null || rightKey == null) {
    throw new Error("UTC datetime values must be validated before compare");
  }
  return leftKey.localeCompare(rightKey);
}

function compareDatePickerValues(
  left: string,
  right: string,
  mode: "date" | "datetime"
) {
  if (mode === "date") {
    return left.localeCompare(right);
  }
  return compareUtcDateTimeValues(left, right);
}

function utcDateTimeSortKey(value: string) {
  const match = value.match(UTC_DATETIME_PATTERN);
  if (!match) {
    return null;
  }

  const [, date, hours, minutes, seconds, fraction = ""] = match;
  if (
    !isValidCivilDate(date) ||
    Number(hours) > 23 ||
    Number(minutes) > 59 ||
    Number(seconds) > 59
  ) {
    return null;
  }

  return `${date}T${hours}:${minutes}:${seconds}.${fraction.padEnd(9, "0")}Z`;
}

export function isIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function placeholderAction(index: number): NormalizedInputAction {
  return {
    displayOrder: index,
    display: "",
    icon: "",
    value: "",
    overflow: false,
    popupKind: "none",
    popupPayload: {},
    options: []
  };
}

function validationError(fields: readonly ApiFieldError[]): ApiErrorInput {
  return {
    status: 422,
    code: topLevelValidationCode(fields),
    message: "Input submission failed validation.",
    fields
  };
}

function topLevelValidationCode(
  fields: readonly ApiFieldError[]
): ApiErrorCode {
  if (fields.some((field) => field.code === "unsafe_html")) {
    return "unsafe_html";
  }
  if (fields.some((field) => field.code === "unsafe_color")) {
    return "unsafe_color";
  }
  if (fields.some((field) => field.code === "unsupported_icon")) {
    return "unsupported_icon";
  }
  return "validation_failed";
}

function fieldError(
  path: string,
  code: string,
  message: string
): ApiFieldError {
  return { path, code, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
