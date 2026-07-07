import { createCorrelationId } from "../../../../src/server/correlation";
import {
  missingConfigurationResponse,
  smokeBearerFailureResponse
} from "../../../../src/server/http";
import { durationSinceMs } from "../../../../src/server/logging";
import { runtimeRelease } from "../../../../src/server/observability";
import {
  isRuntimeSmokeRequest,
  reportRuntimeFailure,
  sentryCaptureConfigured
} from "../../../../src/server/sentry";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const startedAtMs = Date.now();
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const requestId = createCorrelationId("req");
  const suppressCapture = isRuntimeSmokeRequest(request);
  const captureConfigured = sentryCaptureConfigured();
  if (process.env.APP_ENV === "production") {
    const missing = [
      ...(!process.env.SENTRY_DSN ? ["SENTRY_DSN"] : []),
      ...(!runtimeRelease() ? ["SENTRY_RELEASE"] : [])
    ];
    if (missing.length > 0) {
      return missingConfigurationResponse(missing);
    }
  }

  const errorId = createCorrelationId("sentry");
  const report = reportRuntimeFailure(new Error("runtime sentry canary"), {
    errorId,
    request_id: requestId,
    suppressCapture,
    environment: process.env.APP_ENV ?? null,
    surface: "api",
    route: "/api/runtime/sentry",
    method: "POST",
    status_code: 200,
    duration_ms: durationSinceMs(startedAtMs),
    operation: "runtime.sentry.canary",
    message: "sentry correlation canary executed"
  });

  return NextResponse.json({
    ok: true,
    error_id: errorId,
    sentry_capture_enabled: report.sentry_captured,
    sentry_capture_configured: captureConfigured,
    sentry_capture_suppressed: suppressCapture
  });
}
