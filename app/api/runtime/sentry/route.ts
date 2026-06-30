import { createCorrelationId } from "../../../../src/server/correlation";
import {
  missingConfigurationResponse,
  smokeBearerFailureResponse
} from "../../../../src/server/http";
import { emitRuntimeLog } from "../../../../src/server/logging";
import {
  captureCanaryException,
  isRuntimeSmokeRequest
} from "../../../../src/server/sentry";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const suppressCapture = isRuntimeSmokeRequest(request);
  if (
    process.env.APP_ENV === "production" &&
    !process.env.SENTRY_DSN &&
    !suppressCapture
  ) {
    return missingConfigurationResponse(["SENTRY_DSN"]);
  }

  const errorId = createCorrelationId("sentry");
  const captured = captureCanaryException(
    new Error("runtime sentry canary"),
    errorId,
    suppressCapture
  );
  emitRuntimeLog({
    level: "error",
    error_id: errorId,
    environment: process.env.APP_ENV ?? null,
    release: process.env.CF_VERSION_METADATA ?? null,
    surface: "api",
    route: "/api/runtime/sentry",
    method: "POST",
    status_code: 200,
    operation: "runtime.sentry.canary",
    message: captured
      ? "sentry correlation canary captured"
      : "sentry correlation canary skipped"
  });

  return NextResponse.json({
    ok: true,
    error_id: errorId,
    sentry_capture_enabled: captured,
    sentry_capture_suppressed: suppressCapture
  });
}
