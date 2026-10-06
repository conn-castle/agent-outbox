import { respondToApiRequest } from "../../../../src/server/api-route";
import { handleAccountStatusRequest } from "../../../../src/server/status";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return respondToApiRequest(request, "/api/account/status", (context) =>
    handleAccountStatusRequest(request, context)
  );
}
