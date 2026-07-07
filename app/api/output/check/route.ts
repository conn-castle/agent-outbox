import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { handleOutputCheckRequest } from "../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = apiRequestContext(request, "/api/output/check");
  const result = await handleOutputCheckRequest(request, context);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data, {
    headers: { "Cache-Control": "no-store" }
  });
}
