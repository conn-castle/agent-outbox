import { runtimeRelease } from "./observability.ts";

export type LogLevel = "info" | "warn" | "error";

export type RuntimeLogEvent = {
  level: LogLevel;
  error_id?: string;
  error_name?: string;
  error_code?: string;
  sentry_captured?: boolean;
  sentry_scope_attached?: boolean;
  sentry_capture_rate_limited?: boolean;
  request_id?: string;
  environment?: string | null;
  release?: string | null;
  surface: "app" | "api" | "scheduled";
  route?: string;
  method?: string;
  status_code?: number;
  duration_ms?: number;
  operation: string;
  path_shape?: string;
  multipart_boundary?: string;
  content_length_state?: string;
  operation_kind?: string;
  account_id?: string;
  caller_id?: string;
  input_item_id?: string;
  limit_name?: string;
  limit_reason_code?: string;
  limit_resets_at?: string | null;
  used_units?: number | null;
  limit_units?: number | null;
  client_event_name?: string;
  client_event_category?: string;
  drop_reason?: string;
  stripe_event_type?: string;
  event_count?: number;
  message: string;
};

const SAFE_LOG_KEYS = new Set([
  "level",
  "error_id",
  "error_name",
  "error_code",
  "sentry_captured",
  "sentry_scope_attached",
  "sentry_capture_rate_limited",
  "request_id",
  "environment",
  "release",
  "surface",
  "route",
  "method",
  "status_code",
  "duration_ms",
  "operation",
  "path_shape",
  "multipart_boundary",
  "content_length_state",
  "operation_kind",
  "account_id",
  "caller_id",
  "input_item_id",
  "limit_name",
  "limit_reason_code",
  "limit_resets_at",
  "used_units",
  "limit_units",
  "client_event_name",
  "client_event_category",
  "drop_reason",
  "stripe_event_type",
  "event_count",
  "message"
]);
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const SAFE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "QUERY_READ_TIMEOUT",
  "CONNECTION_TIMEOUT",
  "CONNECTION_TERMINATED"
]);

export function safeLogEvent(event: RuntimeLogEvent) {
  const safeEntries = Object.entries(event)
    .filter(([key, value]) => {
      return (
        SAFE_LOG_KEYS.has(key) &&
        value !== undefined &&
        (key !== "error_code" || safeErrorCodeValue(value) !== undefined)
      );
    })
    .map(([key, value]) => {
      return [
        key,
        key === "error_name" ? safeErrorNameValue(value, "Error") : value
      ];
    });

  return Object.fromEntries(safeEntries);
}

export function safeErrorName(error: unknown) {
  if (isErrorObject(error)) {
    return safeErrorNameValue(error.name, "Error");
  }

  return "UnknownError";
}

export function safeErrorCode(error: unknown): string | undefined {
  try {
    // Transaction cleanup can fail after the original operation. Preserve the
    // original diagnostic carried as the aggregate's cause, with bounded depth.
    for (let depth = 0; depth < 5; depth++) {
      if (!isErrorObject(error)) {
        return undefined;
      }
      const code = safeErrorCodeValue(error.code);
      if (code) {
        return code;
      }
      // node-postgres emits these fixed messages without a machine-readable
      // code. Classify only exact matches; never forward exception text.
      switch (error.message) {
        case "Query read timeout":
          return "QUERY_READ_TIMEOUT";
        case "timeout expired":
          return "CONNECTION_TIMEOUT";
        case "Connection terminated unexpectedly":
          return "CONNECTION_TERMINATED";
      }
      if (!(error instanceof AggregateError)) {
        return undefined;
      }
      error = error.cause;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function emitRuntimeLog(event: RuntimeLogEvent) {
  // Observability must never take down the request/error path: a failure while
  // building or writing the log line is swallowed so it can never escape into a
  // caller's request or error handler. Callers still receive a safe payload.
  try {
    const payload = safeLogEvent({
      environment: process.env.APP_ENV ?? null,
      release: runtimeRelease(),
      ...event
    });
    const line = JSON.stringify(payload);

    if (event.level === "error") {
      console.error(line);
    } else if (event.level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    return payload;
  } catch {
    return {};
  }
}

export function durationSinceMs(startedAtMs: number | undefined) {
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }

  return Math.max(0, Date.now() - Number(startedAtMs));
}

function safeErrorNameValue(value: unknown, fallback: string) {
  if (typeof value === "string" && SAFE_ERROR_NAME_PATTERN.test(value)) {
    return value;
  }

  return fallback;
}

function safeErrorCodeValue(value: unknown) {
  return typeof value === "string" &&
    (SQLSTATE_PATTERN.test(value) || SAFE_ERROR_CODES.has(value))
    ? value
    : undefined;
}

function isErrorObject(
  error: unknown
): error is { name?: unknown; code?: unknown; message?: unknown } {
  return (
    error instanceof Error ||
    Object.prototype.toString.call(error) === "[object Error]"
  );
}
