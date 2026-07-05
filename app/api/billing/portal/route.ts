import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { createBillingPortalSessionForAccount } from "../../../../src/server/billing";
import { billingHumanSession } from "../../../../src/server/billing-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request);
  const sessionResult = await billingHumanSession(context.requestId);
  if (!sessionResult.ok) {
    return apiErrorResponse(context, sessionResult.error);
  }

  const result = await createBillingPortalSessionForAccount({
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
