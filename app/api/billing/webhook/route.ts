import { apiTemporaryUnavailable } from "../../../../src/server/api-errors";
import { respondToApiRequest } from "../../../../src/server/api-route";
import { handleStripeWebhookRequest } from "../../../../src/server/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToApiRequest(
    request,
    "/api/billing/webhook",
    async (context) => {
      const connectionString = process.env.DATABASE_APP_ROLE_URL;
      if (!connectionString) {
        return apiTemporaryUnavailable(
          "Billing database configuration is unavailable."
        );
      }

      return handleStripeWebhookRequest(request, context, { connectionString });
    }
  );
}
