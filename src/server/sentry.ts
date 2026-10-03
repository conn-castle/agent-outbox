import * as Sentry from "@sentry/nextjs";
import type { Breadcrumb, Event } from "@sentry/nextjs";

import {
  emitRuntimeLog,
  safeErrorCode,
  safeErrorName,
  type RuntimeLogEvent
} from "./logging.ts";
import { runtimeRelease } from "./observability.ts";

const RUNTIME_SMOKE_SENTRY_SUPPRESS_HEADER = "x-agent-outbox-runtime-smoke";
const SANITIZED_EXCEPTION_MESSAGE = "Agent Outbox runtime failure";

export function sentryCaptureEnabled() {
  return (
    process.env.APP_ENV === "production" &&
    Boolean(process.env.SENTRY_DSN) &&
    Boolean(runtimeRelease()) &&
    process.env.CI !== "true" &&
    process.env.NODE_ENV !== "test"
  );
}

export function sentryCaptureConfigured() {
  return sentryCaptureEnabled();
}

export function isRuntimeSmokeRequest(request: Request) {
  return request.headers.get(RUNTIME_SMOKE_SENTRY_SUPPRESS_HEADER) === "1";
}

export function captureRuntimeException(
  error: Error,
  input: {
    errorId: string;
    suppressCapture?: boolean;
    operation?: string;
    route?: string;
  }
) {
  if (input.suppressCapture || !sentryCaptureEnabled()) {
    return false;
  }

  const release = runtimeRelease();
  try {
    const errorCode = safeErrorCode(error);
    Sentry.withScope((scope) => {
      scope.setTag("error_id", input.errorId);
      if (errorCode) {
        scope.setTag("error_code", errorCode);
      }
      if (input.operation) {
        scope.setTag("operation", input.operation);
      }
      if (input.route) {
        scope.setTag("route", input.route);
      }
      if (release) {
        scope.setTag("release", release);
      }
      scope.setContext("agent_outbox", {
        error_id: input.errorId,
        ...(errorCode ? { error_code: errorCode } : {}),
        operation: input.operation ?? null,
        route: input.route ?? null,
        release
      });
      // The sanitized exception carries a fixed redacted message, so Sentry's
      // default stack/message grouping would merge every unrelated failure
      // reported through this helper into a single issue. Pin an explicit
      // fingerprint built from the safe discriminators (error name, operation,
      // route) so grouping stays deterministic and triage-able without
      // reintroducing any sensitive text.
      scope.setFingerprint([
        "agent-outbox-runtime-failure",
        safeErrorName(error),
        input.operation ?? "unknown",
        input.route ?? "unknown"
      ]);
      Sentry.captureException(sanitizedSentryException(error));
    });
  } catch {
    return false;
  }

  return true;
}

export type RuntimeFailureReportInput = Omit<
  RuntimeLogEvent,
  "level" | "error_id" | "error_name" | "error_code" | "sentry_captured"
> & {
  errorId: string;
  suppressCapture?: boolean;
};

export function reportRuntimeFailure(
  error: unknown,
  { errorId, suppressCapture, ...event }: RuntimeFailureReportInput
) {
  const exception = runtimeExceptionFromUnknown(error);
  const sentryCaptured = captureRuntimeException(exception, {
    errorId,
    suppressCapture,
    operation: event.operation,
    route: event.route
  });
  const log = emitRuntimeLog({
    ...event,
    level: "error",
    error_id: errorId,
    error_name: safeErrorName(exception),
    error_code: safeErrorCode(exception),
    sentry_captured: sentryCaptured
  });

  return {
    error_id: errorId,
    sentry_captured: sentryCaptured,
    log
  };
}

export function sentryRuntimeInitOptions() {
  const release = runtimeRelease();

  return {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV,
    ...(release ? { release } : {}),
    tracesSampleRate: 0.05,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent
  };
}

// SDK integrations (Next.js onRequestError and spans, request data, console,
// fetch) attach raw headers, cookies, queries, thrown values, and exception
// text. Strip them from every outgoing event so only the safe tags and context
// set here are sent.
function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.data;
    // Raw pathnames can contain caller identifiers. Keep the Next.js route
    // template in contexts.nextjs.router_path instead, when available.
    delete event.request.url;
  }
  // Thrown non-Error values are serialized here in full.
  delete event.extra;
  if (event.contexts?.nextjs) {
    delete event.contexts.nextjs.request_path;
  }
  if (event.contexts?.trace?.data) {
    scrubAttributes(event.contexts.trace.data);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = SANITIZED_EXCEPTION_MESSAGE;
    }
  }
  for (const span of event.spans ?? []) {
    scrubAttributes(span.data);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((breadcrumb) => breadcrumb.category !== "console")
      .map(scrubBreadcrumb);
  }
  return event;
}

function scrubBreadcrumb(breadcrumb: Breadcrumb) {
  if (breadcrumb.data) {
    scrubAttributes(breadcrumb.data);
  }
  return breadcrumb;
}

function scrubAttributes(data: Record<string, unknown>) {
  for (const key of Object.keys(data)) {
    if (
      key === "http.query" ||
      key === "http.fragment" ||
      key === "url.query" ||
      key === "url.fragment" ||
      key.startsWith("http.request.header.") ||
      key.startsWith("http.response.header.")
    ) {
      delete data[key];
    }
  }
  for (const key of ["url", "http.url", "url.full", "http.target"]) {
    const value = data[key];
    if (typeof value === "string") {
      data[key] = withoutQuery(value);
    }
  }
}

function withoutQuery(url: string) {
  return url.replace(/[?#].*$/s, "");
}

function runtimeExceptionFromUnknown(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  return new Error("Unknown runtime failure");
}

function sanitizedSentryException(error: Error) {
  const sanitized = new Error(SANITIZED_EXCEPTION_MESSAGE);
  sanitized.name = safeErrorName(error);
  return sanitized;
}
