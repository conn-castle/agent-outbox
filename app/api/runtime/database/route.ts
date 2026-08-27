import { createCorrelationId } from "../../../../src/server/correlation";
import { runTransactionContextCanary } from "../../../../src/server/database";
import { runHumanReviewQueryCanary } from "../../../../src/server/human-review";
import {
  missingConfigurationResponse,
  smokeBearerFailureResponse
} from "../../../../src/server/http";
import { durationSinceMs } from "../../../../src/server/logging";
import { reportRuntimeFailure } from "../../../../src/server/sentry";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const startedAtMs = Date.now();
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return missingConfigurationResponse(["DATABASE_APP_ROLE_URL"]);
  }

  const requestId = createCorrelationId("req");
  try {
    const canary = await runTransactionContextCanary(connectionString);
    await runHumanReviewQueryCanary(connectionString, requestId);
    const ok = canary.transactionContextMatched && canary.restrictedRoleMatched;
    return NextResponse.json(
      {
        ok,
        code: ok
          ? "database_canary_ok"
          : !canary.restrictedRoleMatched
            ? "database_restricted_role_mismatch"
            : "database_transaction_context_mismatch",
        transaction_context_matched: canary.transactionContextMatched,
        restricted_role_matched: canary.restrictedRoleMatched,
        human_review_query_matched: true
      },
      { status: ok ? 200 : 502 }
    );
  } catch (error) {
    const errorId = createCorrelationId("db");
    reportRuntimeFailure(error, {
      errorId,
      request_id: requestId,
      environment: process.env.APP_ENV ?? null,
      surface: "api",
      route: "/api/runtime/database",
      method: "GET",
      status_code: 502,
      duration_ms: durationSinceMs(startedAtMs),
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
