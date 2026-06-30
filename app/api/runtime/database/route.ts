import { runTransactionContextCanary } from "../../../../src/server/database";
import {
  missingConfigurationResponse,
  smokeBearerFailureResponse
} from "../../../../src/server/http";
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
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "database_canary_failed"
      },
      { status: 502 }
    );
  }
}
