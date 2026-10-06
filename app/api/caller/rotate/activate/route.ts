import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleRotateActivateRequest } from "../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/activate",
    (context, body) => handleRotateActivateRequest(request, context, body)
  );
}
