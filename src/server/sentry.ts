import * as Sentry from "@sentry/nextjs";

const RUNTIME_SMOKE_SENTRY_SUPPRESS_HEADER = "x-agent-outbox-runtime-smoke";

export function sentryCaptureEnabled() {
  return (
    process.env.APP_ENV === "production" &&
    Boolean(process.env.SENTRY_DSN) &&
    process.env.CI !== "true" &&
    process.env.NODE_ENV !== "test"
  );
}

export function isRuntimeSmokeRequest(request: Request) {
  return request.headers.get(RUNTIME_SMOKE_SENTRY_SUPPRESS_HEADER) === "1";
}

export function captureCanaryException(
  error: Error,
  errorId: string,
  suppressCapture: boolean
) {
  if (suppressCapture || !sentryCaptureEnabled()) {
    return false;
  }

  Sentry.withScope((scope) => {
    scope.setTag("error_id", errorId);
    scope.setContext("agent_outbox", {
      error_id: errorId,
      canary: "runtime"
    });
    Sentry.captureException(error);
  });

  return true;
}
