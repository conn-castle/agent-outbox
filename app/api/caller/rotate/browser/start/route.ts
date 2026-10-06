import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRotateBrowserStartRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/browser/start",
    (context, body) => handleRotateBrowserStartRequest(request, context, body)
  );
}
