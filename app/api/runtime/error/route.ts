import { createCorrelationId } from "../../../../src/server/correlation";
import { smokeBearerFailureResponse } from "../../../../src/server/http";
import { durationSinceMs } from "../../../../src/server/logging";
import {
  isRuntimeSmokeRequest,
  reportRuntimeFailure
} from "../../../../src/server/sentry";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const requestId = createCorrelationId("req");
  const errorId = createCorrelationId("err");
  const error = new Error("runtime structured error canary");
  reportRuntimeFailure(error, {
    errorId,
    request_id: requestId,
    suppressCapture: isRuntimeSmokeRequest(request),
    environment: process.env.APP_ENV ?? null,
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
    duration_ms: durationSinceMs(startedAtMs),
    operation: "runtime.structured_error.canary",
    message: "structured error canary executed"
  });

  return NextResponse.json(
    {
      ok: false,
      error_id: errorId,
      code: "structured_error_canary"
    },
    { status: 500 }
  );
}
