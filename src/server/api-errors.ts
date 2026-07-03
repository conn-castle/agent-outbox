import { createCorrelationId } from "./correlation.ts";
import type { ActiveLimitBlockMetadata } from "./accounting.ts";
import type { LimitErrorMetadata } from "./limits.ts";

export type ApiErrorCode =
  | "invalid_request"
  | "invalid_json"
  | "request_too_large"
  | "validation_failed"
  | "unsupported_icon"
  | "unsafe_html"
  | "unsafe_color"
  | "invalid_action_response"
  | "upgrade_required"
  | "authentication_required"
  | "invalid_caller_credentials"
  | "authorization_failed"
  | "not_found"
  | "caller_already_exists"
  | "pending_content_conflict"
  | "answered_unacknowledged"
  | "input_not_pending"
  | "stale_input_revision"
  | "output_already_read"
  | "rate_limit_exceeded"
  | "quota_limit_exceeded"
  | "storage_limit_exceeded"
  | "retention_limit_exceeded"
  | "billing_grace_expired"
  | "authorization_pending"
  | "temporary_unavailable"
  | "internal_error";

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
  errorId?: string | null;
};

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function apiRequestContext(request: Request): ApiRequestContext {
  const suppliedRequestId = request.headers.get("x-request-id")?.trim();

  return {
    requestId:
      suppliedRequestId && SAFE_REQUEST_ID_PATTERN.test(suppliedRequestId)
        ? suppliedRequestId
        : createCorrelationId("req"),
    correlationId: createCorrelationId("corr")
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
