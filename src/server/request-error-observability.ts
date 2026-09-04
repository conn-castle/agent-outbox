export const NEXT_REQUEST_ERROR_OPERATION = "next_request_error";
export const NEXT_REQUEST_ERROR_MESSAGE = "Next.js request error captured.";

export type PathShape = "contains_dot" | "extensionless";
export type MultipartBoundaryState =
  | "not_multipart"
  | "absent"
  | "empty"
  | "quoted"
  | "unquoted"
  | "malformed"
  | "multiple"
  | "unknown";
export type ContentLengthState =
  "absent" | "zero" | "positive" | "invalid" | "unknown";

export type NextRequestErrorRequest = {
  path?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

export type NextRequestErrorContext = {
  routePath?: string;
};

export type NextRequestErrorClassification = {
  route: string;
  method: string;
  path_shape: PathShape;
  multipart_boundary: MultipartBoundaryState;
  content_length_state: ContentLengthState;
};

const SAFE_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS"
]);
type BoundaryParameterState = "empty" | "quoted" | "unquoted" | "malformed";
const RFC2045_TOKEN_PATTERN = /^[^\x00-\x20()<>@,;:\\"/[\]?=]+$/;
const FALLBACK_CLASSIFICATION: NextRequestErrorClassification = {
  route: "unknown",
  method: "other",
  path_shape: "extensionless",
  multipart_boundary: "unknown",
  content_length_state: "unknown"
};

// Classify only the metadata Next.js already passes to onRequestError. Never
// read a request body, and never return the raw path, header, or boundary
// values used during classification.
export function classifyNextRequestError(
  request: NextRequestErrorRequest | null | undefined,
  errorContext: NextRequestErrorContext | null | undefined
): NextRequestErrorClassification {
  try {
    return {
      route: canonicalRoute(errorContext?.routePath),
      method: classifyMethod(request?.method),
      path_shape: classifyPathShape(request?.path),
      multipart_boundary: classifyMultipartBoundary(request?.headers),
      content_length_state: classifyContentLengthState(request?.headers)
    };
  } catch {
    return { ...FALLBACK_CLASSIFICATION };
  }
}

function canonicalRoute(routePath: unknown) {
  if (typeof routePath !== "string") {
    return "unknown";
  }

  const trimmed = routePath.trim();
  if (
    trimmed.startsWith("/") &&
    trimmed.length <= 200 &&
    !/[?#\s]/.test(trimmed) &&
    /^[\x21-\x7E]+$/.test(trimmed)
  ) {
    return trimmed;
  }

  return "unknown";
}

function classifyMethod(method: unknown) {
  if (typeof method !== "string") {
    return "other";
  }

  const normalized = method.trim().toUpperCase();
  if (SAFE_HTTP_METHODS.has(normalized)) {
    return normalized;
  }

  return "other";
}

function classifyPathShape(path: unknown): PathShape {
  return originalPathname(path).includes(".")
    ? "contains_dot"
    : "extensionless";
}

function originalPathname(path: unknown) {
  if (typeof path !== "string") {
    return "";
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(trimmed, "https://agent-outbox.invalid");
    return url.pathname;
  } catch {
    const cutoff = trimmed.search(/[?#]/);
    return cutoff === -1 ? trimmed : trimmed.slice(0, cutoff);
  }
}

function classifyMultipartBoundary(
  headers: NextRequestErrorRequest["headers"]
): MultipartBoundaryState {
  if (!headers || typeof headers !== "object") {
    return "unknown";
  }

  const values = headerValues(headers, "content-type");
  if (values.length === 0) {
    return "not_multipart";
  }
  if (values.length > 1) {
    return values.some(isMultipartFormDataHeader)
      ? "malformed"
      : "not_multipart";
  }

  const contentType = values[0] ?? "";
  const separator = contentType.indexOf(";");
  const mediaType = (
    separator === -1 ? contentType : contentType.slice(0, separator)
  )
    .trim()
    .toLowerCase();
  if (mediaType !== "multipart/form-data") {
    return "not_multipart";
  }

  const parameterSource =
    separator === -1 ? "" : contentType.slice(separator + 1);
  const parameters = splitHeaderParameters(parameterSource);
  if (parameters === null) {
    return "malformed";
  }

  const boundaries: BoundaryParameterState[] = [];
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (trimmed === "") {
      continue;
    }

    const eq = trimmed.indexOf("=");
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq))
      .trim()
      .toLowerCase();
    if (name !== "boundary") {
      continue;
    }
    if (eq === -1) {
      boundaries.push("malformed");
      continue;
    }

    boundaries.push(classifyBoundaryValue(trimmed.slice(eq + 1)));
  }

  if (boundaries.length === 0) {
    return "absent";
  }
  if (boundaries.length > 1) {
    return "multiple";
  }

  return boundaries[0] ?? "malformed";
}

function classifyBoundaryValue(rawValue: string): BoundaryParameterState {
  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return "empty";
  }
  if (trimmed.startsWith('"')) {
    const parsed = parseQuotedString(trimmed);
    if (!parsed || parsed.rest.trim() !== "") {
      return "malformed";
    }
    return parsed.value === "" ? "empty" : "quoted";
  }

  return RFC2045_TOKEN_PATTERN.test(trimmed) ? "unquoted" : "malformed";
}

function classifyContentLengthState(
  headers: NextRequestErrorRequest["headers"]
): ContentLengthState {
  if (!headers || typeof headers !== "object") {
    return "unknown";
  }

  const values = headerValues(headers, "content-length");
  if (values.length === 0) {
    return "absent";
  }
  if (values.length > 1) {
    return "invalid";
  }

  const trimmed = values[0]?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) {
    return "invalid";
  }

  return /^0+$/.test(trimmed) ? "zero" : "positive";
}

function headerValues(
  headers: NextRequestErrorRequest["headers"],
  name: string
) {
  if (!headers || typeof headers !== "object") {
    return [];
  }

  const needle = name.toLowerCase();
  const values: string[] = [];

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          values.push(entry);
        }
      }
      continue;
    }
    if (typeof value === "string") {
      values.push(value);
    }
  }

  return values;
}

function isMultipartFormDataHeader(value: string) {
  const separator = value.indexOf(";");
  const mediaType = (separator === -1 ? value : value.slice(0, separator))
    .trim()
    .toLowerCase();
  return mediaType === "multipart/form-data";
}

function splitHeaderParameters(parameterSource: string) {
  const parameters: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of parameterSource) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ";" && !inQuotes) {
      parameters.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (inQuotes || escaped) {
    return null;
  }

  parameters.push(current);
  return parameters;
}

function parseQuotedString(input: string) {
  if (!input.startsWith('"')) {
    return null;
  }

  let value = "";
  let escaped = false;

  for (let index = 1; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return {
        value,
        rest: input.slice(index + 1)
      };
    }
    value += char;
  }

  return null;
}
