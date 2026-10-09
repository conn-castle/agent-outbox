import { respondToApiRequest } from "../../../../src/server/api-route";
import { createBillingPortalSessionForAccount } from "../../../../src/server/billing";
import { billingHumanSession } from "../../../../src/server/billing-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToApiRequest(
    request,
    "/api/billing/portal",
    async (context) => {
      const session = await billingHumanSession(context, "portal");
      if (!session.ok) {
        return session;
      }

      return createBillingPortalSessionForAccount({
        account: session.data.account,
        context
      });
    }
  );
}
