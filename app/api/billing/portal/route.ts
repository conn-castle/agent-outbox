import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { createBillingPortalSessionForAccount } from "../../../../src/server/billing";
import { billingHumanSession } from "../../../../src/server/billing-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request, "/api/billing/portal");
  const sessionResult = await billingHumanSession(context, "portal");
  if (!sessionResult.ok) {
    return apiErrorResponse(context, sessionResult.error);
  }

  const result = await createBillingPortalSessionForAccount({
    account: sessionResult.data.account,
    requestId: context.requestId,
    context
  });

  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
