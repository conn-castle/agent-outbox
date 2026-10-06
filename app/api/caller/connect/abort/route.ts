import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleConnectAbortRequest } from "../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/abort",
    (context, body) => handleConnectAbortRequest(request, context, body)
  );
}
