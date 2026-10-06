import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleRotateExchangeRequest } from "../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/rotate/exchange",
    (context, body) => handleRotateExchangeRequest(request, context, body)
  );
}
