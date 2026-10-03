import * as Sentry from "@sentry/nextjs";

import {
  emitRuntimeLog,
  safeErrorCode,
  safeErrorName,
  type RuntimeLogEvent
} from "./logging.ts";
import { createCorrelationId } from "./correlation.ts";
import { runtimeRelease } from "./observability.ts";

const RUNTIME_SMOKE_SENTRY_SUPPRESS_HEADER = "x-agent-outbox-runtime-smoke";
const SCHEDULED_SENTRY_FLUSH_TIMEOUT_MS = 2_000;
const SANITIZED_RUNTIME_FAILURE_MESSAGE = "Agent Outbox runtime failure";
const SANITIZED_DATABASE_OPERATION = "db.query";

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
  if (input.suppressCapture || !sentryCaptureEnabled() || !Sentry.getClient()) {
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
    // Stop SDK breadcrumbs at the source; also drop direct scope breadcrumbs.
    maxBreadcrumbs: 0,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    integrations: [runtimeContentSafetyIntegration]
  };
}

const runtimeContentSafetyIntegration: ReturnType<
  typeof Sentry.getDefaultIntegrations
>[number] = {
  name: "AgentOutboxRuntimeContentSafety",
  setup(client) {
    // Internal SDK exceptions skip event processors and beforeSend. This hook
    // runs for their envelopes too, immediately before transport.send.
    client.on("beforeEnvelope", ([header, items]) => {
      for (const [itemHeader, payload] of items) {
        if (
          (itemHeader.type === "event" || itemHeader.type === "transaction") &&
          payload &&
          typeof payload === "object"
        ) {
          const event = payload as Sentry.Event;
          const trace = event.contexts?.trace;
          const databaseEvent = isDatabaseSpan(trace?.op, trace?.data);
          scrubSentryEvent(event);
          // Event processing metadata has already moved into this header.
          const samplingContext = header.trace;
          if (
            samplingContext &&
            typeof samplingContext === "object" &&
            "transaction" in samplingContext &&
            typeof samplingContext.transaction === "string"
          ) {
            samplingContext.transaction = databaseEvent
              ? SANITIZED_DATABASE_OPERATION
              : withoutUrlSuffix(samplingContext.transaction);
          }
        }
      }
    });
  }
};

function scrubSentryEvent<TEvent extends Sentry.Event>(event: TEvent): TEvent {
  if (Array.isArray(event.exception?.values)) {
    for (const exception of event.exception.values) {
      if (!exception || typeof exception !== "object") {
        continue;
      }
      exception.value = SANITIZED_RUNTIME_FAILURE_MESSAGE;
      if (Array.isArray(exception.stacktrace?.frames)) {
        for (const frame of exception.stacktrace.frames) {
          if (frame && typeof frame === "object") {
            delete frame.vars;
          }
        }
      }
    }
  }
  delete event.message;
  delete event.logentry;
  delete event.extra;
  delete event.breadcrumbs;
  if (typeof event.request?.method === "string") {
    event.request = { method: event.request.method };
  } else {
    delete event.request;
  }
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs === "object") {
    delete nextjs.request_path;
  }
  const trace = event.contexts?.trace;
  const databaseTransaction = isDatabaseSpan(trace?.op, trace?.data);
  scrubSpanData(trace?.data);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      if (span && typeof span === "object") {
        const databaseSpan = isDatabaseSpan(span.op, span.data);
        scrubSpanData(span.data);
        if (databaseSpan) {
          span.description = SANITIZED_DATABASE_OPERATION;
        } else if (typeof span.description === "string") {
          span.description = withoutUrlSuffix(span.description);
        }
      }
    }
  }
  if (typeof event.transaction === "string") {
    event.transaction = databaseTransaction
      ? SANITIZED_DATABASE_OPERATION
      : withoutUrlSuffix(event.transaction);
  }
  // The sampling context becomes the envelope trace header.
  const samplingContext = event.sdkProcessingMetadata?.dynamicSamplingContext;
  if (typeof samplingContext?.transaction === "string") {
    samplingContext.transaction = databaseTransaction
      ? SANITIZED_DATABASE_OPERATION
      : withoutUrlSuffix(samplingContext.transaction);
  }
  return event;
}

function withoutUrlSuffix(value: string) {
  return value.split(/[?#]/, 1)[0];
}

function isDatabaseSpan(op: unknown, data: unknown) {
  return (
    (typeof op === "string" && (op === "db" || op.startsWith("db."))) ||
    (data !== null &&
      typeof data === "object" &&
      ("db.system" in data ||
        "db.system.name" in data ||
        "db.statement" in data ||
        "db.query.text" in data))
  );
}

const SENSITIVE_SPAN_DATA_KEYS = new Set([
  "db.statement",
  "db.query.text",
  "db.connection_string",
  "http.request.body.data",
  "url.full",
  "url.path",
  "url.query",
  "url.fragment",
  "http.url",
  "http.target",
  "http.query",
  "http.fragment",
  "url"
]);

function scrubSpanData(data: unknown) {
  if (!data || typeof data !== "object") {
    return;
  }
  for (const key of Object.keys(data)) {
    if (
      key.startsWith("http.request.header.") ||
      key.startsWith("http.response.header.") ||
      SENSITIVE_SPAN_DATA_KEYS.has(key)
    ) {
      delete (data as Record<string, unknown>)[key];
    }
  }
}

// Cron invocations bypass OpenNext, so Next.js instrumentation never
// initializes Sentry and the SDK's end-of-request flush never runs. Initialize
// the client when this isolate has none, and flush before the task settles so
// Cloudflare keeps the isolate alive until captured events are sent.
export async function runWithScheduledSentry<TResult>(
  task: () => Promise<TResult>
): Promise<TResult> {
  if (sentryCaptureEnabled() && !Sentry.getClient()) {
    try {
      Sentry.init(sentryRuntimeInitOptions());
    } catch (error) {
      reportRuntimeFailure(error, {
        errorId: createCorrelationId("sentry"),
        environment: process.env.APP_ENV ?? null,
        surface: "scheduled",
        operation: "runtime.scheduled.sentry_init",
        message: "scheduled Sentry initialization failed"
      });
    }
  }

  try {
    return await task();
  } finally {
    if (Sentry.getClient()) {
      // Flush failures must not replace the task's own outcome.
      const flushed = await Sentry.flush(
        SCHEDULED_SENTRY_FLUSH_TIMEOUT_MS
      ).catch(() => false);
      if (!flushed) {
        emitRuntimeLog({
          level: "warn",
          environment: process.env.APP_ENV ?? null,
          surface: "scheduled",
          operation: "runtime.scheduled.sentry_flush",
          message: "scheduled Sentry flush did not complete"
        });
      }
    }
  }
}

function runtimeExceptionFromUnknown(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  return new Error("Unknown runtime failure");
}

function sanitizedSentryException(error: Error) {
  const sanitized = new Error(SANITIZED_RUNTIME_FAILURE_MESSAGE);
  sanitized.name = safeErrorName(error);
  return sanitized;
}
