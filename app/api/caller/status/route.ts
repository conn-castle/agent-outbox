import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { handleCallerStatusRequest } from "../../../../src/server/status";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = apiRequestContext(request);
  const result = await handleCallerStatusRequest(request, context);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
