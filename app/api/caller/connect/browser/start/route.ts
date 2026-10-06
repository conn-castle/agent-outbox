import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleConnectBrowserStartRequest } from "../../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/browser/start",
    (context, body) => handleConnectBrowserStartRequest(request, context, body)
  );
}
