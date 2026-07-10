import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import {
  checkoutIntervalFromRequest,
  createCheckoutSessionForAccount
} from "../../../../src/server/billing";
import { billingHumanSession } from "../../../../src/server/billing-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request, "/api/billing/checkout");
  const sessionResult = await billingHumanSession(context, "checkout");
  if (!sessionResult.ok) {
    return apiErrorResponse(context, sessionResult.error);
  }

  const intervalResult = await checkoutIntervalFromRequest(request);
  if (!intervalResult.ok) {
    return apiErrorResponse(context, intervalResult.error);
  }

  const result = await createCheckoutSessionForAccount({
    account: sessionResult.data.account,
    requestId: context.requestId,
    interval: intervalResult.data,
    context
  });

  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
