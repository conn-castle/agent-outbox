import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleConnectDevicePollRequest } from "../../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/device/poll",
    (context, body) => handleConnectDevicePollRequest(request, context, body)
  );
}
