import { createCorrelationId } from "../../../../src/server/correlation";
import { smokeBearerFailureResponse } from "../../../../src/server/http";
import { emitRuntimeLog } from "../../../../src/server/logging";
import {
  captureCanaryException,
  isRuntimeSmokeRequest
} from "../../../../src/server/sentry";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const errorId = createCorrelationId("err");
  const error = new Error("runtime structured error canary");
  captureCanaryException(error, errorId, isRuntimeSmokeRequest(request));
  emitRuntimeLog({
    level: "error",
    error_id: errorId,
    environment: process.env.APP_ENV ?? null,
    release: process.env.CF_VERSION_METADATA ?? null,
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
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
