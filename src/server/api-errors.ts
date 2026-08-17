import { createCorrelationId } from "./correlation.ts";
import type { ActiveLimitBlockMetadata } from "./accounting.ts";
import { durationSinceMs, emitRuntimeLog } from "./logging.ts";
import type { LimitErrorMetadata } from "./limits.ts";
import { captureRuntimeException } from "./sentry.ts";
import type { ApiErrorCode } from "../shared/api-error-contract.ts";

export type { ApiErrorCode } from "../shared/api-error-contract.ts";

export type ApiFieldError = {
  path: string;
  code: string;
  message: string;
};

export type ApiLimitMetadata = {
  limit_name: string;
  limit_reason_code: string;
  limit_reason: string;
  limit_resets_at: string | null;
};

export type ApiUpgradeMetadata = {
  message: string;
  url: string;
};

export type ApiRequestContext = {
  requestId: string;
  correlationId: string;
  route?: string;
  method?: string;
  startedAtMs?: number;
};

export type ApiErrorInput = {
  status: number;
  code: ApiErrorCode;
  message: string;
  fields?: readonly ApiFieldError[];
  limit?:
    LimitErrorMetadata | ActiveLimitBlockMetadata | ApiLimitMetadata | null;
  retryAfterSeconds?: number | null;
  upgrade?: ApiUpgradeMetadata | null;
  log?: {
    callerId?: string | null;
  };
  errorId?: string | null;
  reported?: boolean;
};

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function apiRequestContext(
  request: Request,
  route?: string
): ApiRequestContext {
  const suppliedRequestId = request.headers.get("x-request-id")?.trim();

  return {
    requestId:
      suppliedRequestId && SAFE_REQUEST_ID_PATTERN.test(suppliedRequestId)
        ? suppliedRequestId
        : createCorrelationId("req"),
    correlationId: createCorrelationId("corr"),
    route,
    method: request.method,
    startedAtMs: Date.now()
  };
}

export function apiSuccessResponse<TData>(
  context: ApiRequestContext,
  data: TData,
  init?: ResponseInit
) {
  return Response.json(
    {
      ok: true,
      request_id: context.requestId,
      correlation_id: context.correlationId,
      data
    },
    {
      ...init,
      headers: apiResponseHeaders(context, init?.headers)
    }
  );
}

export function apiErrorResponse(
  context: ApiRequestContext,
  error: ApiErrorInput
) {
  const retryAfterSeconds =
    error.retryAfterSeconds ??
    retryAfterSecondsFromLimit(error.limit ?? null, new Date());
  const headers = apiResponseHeaders(context);

  if (retryAfterSeconds != null) {
    headers.set("Retry-After", String(retryAfterSeconds));
  }
  if (!error.reported) {
    const errorId = error.errorId ?? context.correlationId;
    const sentryCaptured =
      error.status === 500
        ? captureRuntimeException(new Error("API request failed"), {
            errorId,
            operation: `api_error.${error.code}`,
            route: context.route
          })
        : undefined;
    emitOperatorActionableFailure({
      status: error.status,
      limit: error.limit,
      error_id: errorId,
      request_id: context.requestId,
      sentry_captured: sentryCaptured,
      surface: "api",
      route: context.route,
      method: context.method,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation: `api_error.${error.code}`,
      caller_id: error.log?.callerId ?? undefined,
      message: "api request failed"
    });
  }

  return Response.json(
    {
      ok: false,
      request_id: context.requestId,
      correlation_id: context.correlationId,
      error: omitNullish({
        code: error.code,
        message: error.message,
        fields: error.fields,
        retry_after_seconds: retryAfterSeconds,
        limit: apiLimitMetadata(error.limit ?? null),
        upgrade: error.upgrade,
        error_id: error.errorId
      })
    },
    {
      status: error.status,
      headers
    }
  );
}

export function apiResponseHeaders(
  context: ApiRequestContext,
  initHeaders?: HeadersInit
) {
  const headers = new Headers(initHeaders);

  headers.set("X-Request-ID", context.requestId);
  headers.set("X-Correlation-ID", context.correlationId);

  return headers;
}

export function apiLimitMetadata(
  limit: LimitErrorMetadata | ActiveLimitBlockMetadata | ApiLimitMetadata | null
): ApiLimitMetadata | null {
  if (!limit) {
    return null;
  }

  if ("limitName" in limit) {
    return {
      limit_name: limit.limitName,
      limit_reason_code: limit.limitReasonCode,
      limit_reason: limit.limitReason,
      limit_resets_at: limit.limitResetsAt
    };
  }

  if ("limit_name" in limit) {
    return {
      limit_name: limit.limit_name,
      limit_reason_code: limit.limit_reason_code,
      limit_reason: limit.limit_reason,
      limit_resets_at: limit.limit_resets_at
    };
  }

  return limit;
}

export function retryAfterSecondsFromLimit(
  limit:
    LimitErrorMetadata | ActiveLimitBlockMetadata | ApiLimitMetadata | null,
  now: Date
) {
  const metadata = apiLimitMetadata(limit);
  if (!metadata?.limit_resets_at) {
    return null;
  }

  const resetMs = new Date(metadata.limit_resets_at).getTime();
  const nowMs = now.getTime();

  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return null;
  }

  return Math.ceil((resetMs - nowMs) / 1000);
}

function omitNullish<TObject extends Record<string, unknown>>(value: TObject) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue != null)
  );
}

type OperatorActionableFailureInput = {
  status: number;
  limit?: ApiErrorInput["limit"];
  error_id: string;
  request_id: string;
  sentry_captured?: boolean;
  surface: "app" | "api";
  route?: string;
  method?: string;
  duration_ms?: number;
  operation: string;
  operation_kind?: string;
  account_id?: string;
  caller_id?: string;
  message: string;
};

export function emitOperatorActionableFailure(
  input: OperatorActionableFailureInput
) {
  const limit = apiLimitMetadata(input.limit ?? null);
  if (input.status < 500 && !limit) {
    return;
  }

  const activeLimit =
    input.limit && "account_id" in input.limit ? input.limit : null;

  emitRuntimeLog({
    level: input.status >= 500 ? "error" : "warn",
    error_id: input.error_id,
    request_id: input.request_id,
    // Every 5xx failure log must state its Sentry outcome explicitly so
    // operators can alert on sentry_captured=false without blind spots.
    // Callers that captured (or attempted capture) pass the real outcome.
    sentry_captured:
      input.sentry_captured ?? (input.status >= 500 ? false : undefined),
    surface: input.surface,
    route: input.route,
    method: input.method,
    status_code: input.status,
    duration_ms: input.duration_ms,
    operation: input.operation,
    operation_kind: input.operation_kind ?? activeLimit?.operation_kind,
    account_id: input.account_id ?? activeLimit?.account_id,
    caller_id: input.caller_id,
    limit_name: limit?.limit_name,
    limit_reason_code: limit?.limit_reason_code,
    limit_resets_at: limit?.limit_resets_at,
    used_units: limitNumericValue(input.limit, "usedUnits", "used_units"),
    limit_units: limitNumericValue(input.limit, "limitUnits", "limit_units"),
    message: input.message
  });
}

function limitNumericValue(
  limit: ApiErrorInput["limit"],
  camelKey: "usedUnits" | "limitUnits",
  snakeKey: "used_units" | "limit_units"
) {
  if (!limit) {
    return undefined;
  }

  const limitRecord = limit as Record<string, unknown>;
  const value = limitRecord[camelKey] ?? limitRecord[snakeKey];
  return typeof value === "number" ? value : undefined;
}
