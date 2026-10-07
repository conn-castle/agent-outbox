import { respondToApiRequest } from "../../../../src/server/api-route";
import {
  checkoutIntervalFromRequest,
  createCheckoutSessionForAccount
} from "../../../../src/server/billing";
import { billingHumanSession } from "../../../../src/server/billing-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToApiRequest(
    request,
    "/api/billing/checkout",
    async (context) => {
      const session = await billingHumanSession(context, "checkout");
      if (!session.ok) {
        return session;
      }

      const interval = await checkoutIntervalFromRequest(request);
      if (!interval.ok) {
        return interval;
      }

      return createCheckoutSessionForAccount({
        account: session.data.account,
        requestId: context.requestId,
        interval: interval.data,
        context
      });
    }
  );
}
