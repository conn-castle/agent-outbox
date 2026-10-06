import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleConnectExchangeRequest } from "../../../../../src/server/caller-connect";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/connect/exchange",
    (context, body) => handleConnectExchangeRequest(request, context, body)
  );
}
