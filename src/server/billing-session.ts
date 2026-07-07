import type { ApiErrorInput, ApiRequestContext } from "./api-errors.ts";
import {
  type HumanAccountSessionFailure,
  type HumanAccountSessionResult,
  requiredHumanSessionConfiguration,
  resolveHumanAccountSession
} from "./human-session.ts";

type BillingHumanSessionData = {
  connectionString: string;
  accountId: string;
  userId: string;
};

type BillingHumanSessionResult =
  | { ok: true; data: BillingHumanSessionData }
  | { ok: false; error: ApiErrorInput };

type ResolveHumanAccountSession = typeof resolveHumanAccountSession;

export async function billingHumanSession(
  context: ApiRequestContext
): Promise<BillingHumanSessionResult> {
  const missing = requiredHumanSessionConfiguration();
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: `Billing route configuration is missing required variable names: ${missing.join(", ")}.`
      }
    };
  }

  const { auth } = await import("@clerk/nextjs/server");
  const session = await auth();
  return billingHumanSessionFromClerkUser({
    context,
    clerkUserId: session.userId,
    connectionString: process.env.DATABASE_APP_ROLE_URL,
    resolveSession: resolveHumanAccountSession
  });
}

export async function billingHumanSessionFromClerkUser(input: {
  context: ApiRequestContext;
  clerkUserId: string | null | undefined;
  connectionString: string | undefined;
  resolveSession: ResolveHumanAccountSession;
}): Promise<BillingHumanSessionResult> {
  if (!input.clerkUserId) {
    return {
      ok: false,
      error: {
        status: 401,
        code: "authentication_required",
        message: "Authentication is required to manage billing."
      }
    };
  }

  const humanSession = await input.resolveSession({
    clerkUserId: input.clerkUserId,
    requestId: input.context.requestId,
    errorId: input.context.correlationId,
    route: input.context.route,
    method: input.context.method,
    startedAtMs: input.context.startedAtMs
  });
  if (!humanSession.ok) {
    return {
      ok: false,
      error: {
        status: humanSession.status,
        code: billingSessionErrorCode(humanSession.status),
        message: humanSession.message,
        ...(humanSession.errorId ? { errorId: humanSession.errorId } : {}),
        ...(humanSession.reported ? { reported: true } : {})
      }
    };
  }

  if (!input.connectionString) {
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Billing database configuration is unavailable."
      }
    };
  }

  return {
    ok: true,
    data: {
      connectionString: input.connectionString,
      accountId: humanSession.accountId,
      userId: humanSession.userId
    }
  };
}

function billingSessionErrorCode(
  status: HumanAccountSessionFailure["status"]
): ApiErrorInput["code"] {
  if (status === 401) {
    return "authentication_required";
  }
  if (status === 403) {
    return "authorization_failed";
  }
  return "temporary_unavailable";
}
