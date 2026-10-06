import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRevokeDevicePollRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/revoke/device/poll",
    (context, body) => handleRevokeDevicePollRequest(request, context, body)
  );
}
