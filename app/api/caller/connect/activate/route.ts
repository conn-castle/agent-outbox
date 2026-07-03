import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../../src/server/api-errors";
import { handleConnectActivateRequest } from "../../../../../src/server/caller-connect";
import { readJsonBodyWithLimit } from "../../../../../src/server/input-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request);
  const body = await readJsonBodyWithLimit(request);
  if (!body.ok) {
    return apiErrorResponse(context, body.error);
  }

  const result = await handleConnectActivateRequest(
    request,
    context,
    body.value
  );
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
