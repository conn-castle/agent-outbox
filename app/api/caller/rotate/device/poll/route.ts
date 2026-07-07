import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../../../../../../src/server/api-errors";
import { handleRotateDevicePollRequest } from "../../../../../../src/server/caller-credential-operations";
import { readJsonBodyWithLimit } from "../../../../../../src/server/input-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = apiRequestContext(request, "/api/caller/rotate/device/poll");
  const body = await readJsonBodyWithLimit(request);
  if (!body.ok) {
    return apiErrorResponse(context, body.error);
  }

  const result = await handleRotateDevicePollRequest(
    request,
    context,
    body.value
  );
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(context, result.data);
}
