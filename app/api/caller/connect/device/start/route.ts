import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleConnectDeviceStartRequest } from "../../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/device/start",
    (context, body) => handleConnectDeviceStartRequest(request, context, body)
  );
}
