import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { handleStripeWebhookRequest } from "../../../../src/server/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request);
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiErrorResponse(context, {
      status: 503,
      code: "temporary_unavailable",
      message: "Billing database configuration is unavailable."
    });
  }

  const result = await handleStripeWebhookRequest(request, context, {
    connectionString
  });
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
