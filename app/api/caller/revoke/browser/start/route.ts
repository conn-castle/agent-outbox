import { respondToJsonApiRequest } from "../../../../../../src/server/api-route";
import { handleRevokeBrowserStartRequest } from "../../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/revoke/browser/start",
    (context, body) => handleRevokeBrowserStartRequest(request, context, body)
  );
}
