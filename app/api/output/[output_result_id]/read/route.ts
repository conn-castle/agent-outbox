import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../../src/server/api-errors";
import { handleOutputReadRequest } from "../../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ output_result_id: string }> }
) {
  const apiContext = apiRequestContext(request);
  const { output_result_id: outputResultId } = await context.params;
  const result = await handleOutputReadRequest(
    request,
    apiContext,
    outputResultId
  );
  if (!result.ok) {
    return apiErrorResponse(apiContext, result.error);
  }

  return apiSuccessResponse(apiContext, result.data, {
    headers: { "Cache-Control": "no-store" }
  });
}
