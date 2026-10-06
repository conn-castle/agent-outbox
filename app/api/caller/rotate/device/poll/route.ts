import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRotateDevicePollRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/device/poll",
    (context, body) => handleRotateDevicePollRequest(request, context, body)
  );
}
