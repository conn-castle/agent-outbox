import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { handleAccountStatusRequest } from "../../../../src/server/status";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = apiRequestContext(request, "/api/account/status");
  const result = await handleAccountStatusRequest(request, context);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
