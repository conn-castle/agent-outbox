import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleConnectActivateRequest } from "../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/activate",
    (context, body) => handleConnectActivateRequest(request, context, body)
  );
}
