import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../src/server/api-errors";
import { readJsonBodyWithLimit } from "../../../../src/server/input-schema";
import { handleOutputReadAllRequest } from "../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request);
  const body = await readJsonBodyWithLimit(request);
  if (!body.ok) {
    return apiErrorResponse(context, body.error);
  }

  const result = await handleOutputReadAllRequest(request, context, body.value);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data, {
    headers: { "Cache-Control": "no-store" }
  });
}
