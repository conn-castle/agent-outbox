import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { handleInputListRequest } from "../../../../src/server/input-read";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = apiRequestContext(request, "/api/input/list");
  const result = await handleInputListRequest(request, context);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data, {
    headers: { "Cache-Control": "no-store" }
  });
}
