import type { ApiErrorInput, ApiRequestContext } from "./api-errors.ts";
import {
  billingAccountStatement,
  billingRuntimeFailure,
  type BillingAccount
} from "./billing.ts";
import {
  type HumanAccountSessionFailure,
  requiredHumanSessionConfiguration,
  runHumanAccountTransaction
} from "./human-session.ts";

export type BillingFlow = "checkout" | "portal";

type BillingHumanSessionData = {
  account: BillingAccount;
};

type BillingHumanSessionResult =
  | { ok: true; data: BillingHumanSessionData }
  | { ok: false; error: ApiErrorInput };

type RunHumanAccountTransaction = typeof runHumanAccountTransaction;

export async function billingHumanSession(
  context: ApiRequestContext,
  flow: BillingFlow
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
    flow,
    clerkUserId: session.userId,
    runHumanTransaction: runHumanAccountTransaction
  });
}

export async function billingHumanSessionFromClerkUser(input: {
  context: ApiRequestContext;
  flow: BillingFlow;
  clerkUserId: string | null | undefined;
  runHumanTransaction: RunHumanAccountTransaction;
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

  let accountId: string | undefined;
  let transaction;
  try {
    transaction = await input.runHumanTransaction(
      {
        clerkUserId: input.clerkUserId,
        requestId: input.context.requestId,
        errorId: input.context.correlationId,
        route: input.context.route,
        method: input.context.method,
        startedAtMs: input.context.startedAtMs
      },
      async (query, session) => {
        accountId = session.accountId;
        const result = await query<BillingAccount>(
          billingAccountStatement(session.accountId)
        );
        return result.rows[0] ?? null;
      }
    );
  } catch (error) {
    const portal = input.flow === "portal";
    return billingRuntimeFailure(error, {
      context: input.context,
      requestId: input.context.requestId,
      accountId,
      operation: portal
        ? "stripe_billing_portal_account_lookup"
        : "stripe_checkout_account_lookup",
      message: portal
        ? "Stripe billing portal account lookup failed unexpectedly."
        : "Stripe checkout account lookup failed unexpectedly.",
      responseMessage: portal
        ? "Billing portal is temporarily unavailable."
        : "Checkout session is temporarily unavailable."
    });
  }

  if (!transaction.ok) {
    return {
      ok: false,
      error: {
        status: transaction.status,
        code: billingSessionErrorCode(transaction.status),
        message: transaction.message,
        ...(transaction.errorId ? { errorId: transaction.errorId } : {}),
        ...(transaction.reported ? { reported: true } : {})
      }
    };
  }

  if (!transaction.data) {
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Billing account is unavailable."
      }
    };
  }

  return {
    ok: true,
    data: {
      account: transaction.data
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
