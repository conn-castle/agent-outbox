import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRevokeDeviceStartRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/revoke/device/start",
    (context, body) => handleRevokeDeviceStartRequest(request, context, body)
  );
}
