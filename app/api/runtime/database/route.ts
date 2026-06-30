import { createCorrelationId } from "../../../../src/server/correlation";
import { runTransactionContextCanary } from "../../../../src/server/database";
import {
  missingConfigurationResponse,
  smokeBearerFailureResponse
} from "../../../../src/server/http";
import { emitRuntimeLog } from "../../../../src/server/logging";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return missingConfigurationResponse(["DATABASE_APP_ROLE_URL"]);
  }

  try {
    const canary = await runTransactionContextCanary(connectionString);
    const ok = canary.transactionContextMatched && canary.restrictedRoleMatched;
    return NextResponse.json(
      {
        ok,
        code: ok
          ? "database_canary_ok"
          : canary.restrictedRoleMatched
            ? "database_transaction_context_mismatch"
            : "database_restricted_role_mismatch",
        transaction_context_matched: canary.transactionContextMatched,
        restricted_role_matched: canary.restrictedRoleMatched
      },
      { status: ok ? 200 : 502 }
    );
  } catch (error) {
    const errorId = createCorrelationId("db");
    emitRuntimeLog({
      level: "error",
      error_id: errorId,
      error_name: error instanceof Error ? error.name : "UnknownError",
      environment: process.env.APP_ENV ?? null,
      release: process.env.CF_VERSION_METADATA ?? null,
      surface: "api",
      route: "/api/runtime/database",
      method: "GET",
      status_code: 502,
      operation: "runtime.database.canary",
      message: "database canary failed"
    });

    return NextResponse.json(
      {
        ok: false,
        error_id: errorId,
        code: "database_canary_failed"
      },
      { status: 502 }
    );
  }
}
