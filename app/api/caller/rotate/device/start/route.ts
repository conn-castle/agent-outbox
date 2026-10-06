import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRotateDeviceStartRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/device/start",
    (context, body) => handleRotateDeviceStartRequest(request, context, body)
  );
}
