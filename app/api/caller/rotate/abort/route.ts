import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleRotateAbortRequest } from "../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/abort",
    (context, body) => handleRotateAbortRequest(request, context, body)
  );
}
