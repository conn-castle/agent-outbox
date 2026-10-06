import { respondToJsonApiRequest } from "../../../../../src/server/api-route";
import { handleRevokeConfirmRequest } from "../../../../../src/server/caller-credential-operations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/caller/revoke/confirm",
    (context, body) => handleRevokeConfirmRequest(request, context, body)
  );
}
