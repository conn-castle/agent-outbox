import { auth } from "@clerk/nextjs/server";

import {
  type ApiErrorInput,
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { createCheckoutSessionForAccount } from "../../../../src/server/billing";
import {
  requiredHumanSessionConfiguration,
  resolveHumanAccountSession
} from "../../../../src/server/human-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request);
  const sessionResult = await billingHumanSession(context.requestId);
  if (!sessionResult.ok) {
    return apiErrorResponse(context, sessionResult.error);
  }

  const result = await createCheckoutSessionForAccount({
    connectionString: sessionResult.data.connectionString,
    accountId: sessionResult.data.accountId,
    userId: sessionResult.data.userId,
    requestId: context.requestId
  });

  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}

async function billingHumanSession(requestId: string) {
  const missing = requiredHumanSessionConfiguration();
  if (missing.length > 0) {
    return {
      ok: false as const,
      error: {
        status: 503,
        code: "temporary_unavailable" as const,
        message: `Billing route configuration is missing required variable names: ${missing.join(", ")}.`
      }
    };
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const humanSession = await resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId
  });
  if (!humanSession.ok) {
    return {
      ok: false as const,
      error: {
        status: humanSession.status,
        code: billingSessionErrorCode(humanSession.status),
        message: humanSession.message
      }
    };
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return {
      ok: false as const,
      error: {
        status: 503,
        code: "temporary_unavailable" as const,
        message: "Billing database configuration is unavailable."
      }
    };
  }

  return {
    ok: true as const,
    data: {
      connectionString,
      accountId: humanSession.accountId,
      userId: humanSession.userId
    }
  };
}

function billingSessionErrorCode(
  status: 401 | 403 | 503
): ApiErrorInput["code"] {
  if (status === 401) {
    return "authentication_required";
  }
  if (status === 403) {
    return "authorization_failed";
  }
  return "temporary_unavailable";
}
