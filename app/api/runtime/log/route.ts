import { createCorrelationId } from "../../../../src/server/correlation";
import { smokeBearerFailureResponse } from "../../../../src/server/http";
import {
  durationSinceMs,
  emitRuntimeLog
} from "../../../../src/server/logging";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const errorId = createCorrelationId("log");
  const log = emitRuntimeLog({
    level: "info",
    error_id: errorId,
    environment: process.env.APP_ENV ?? null,
    surface: "api",
    route: "/api/runtime/log",
    method: "GET",
    status_code: 200,
    duration_ms: durationSinceMs(startedAtMs),
    operation: "runtime.structured_log.canary",
    message: "structured log canary executed"
  });

  return NextResponse.json({
    ok: true,
    code: "structured_log_ok",
    error_id: errorId,
    log
  });
}
