import { respondToApiRequest } from "../../../../src/server/api-route";
import { handleCallerStatusRequest } from "../../../../src/server/status";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return respondToApiRequest(request, "/api/caller/status", (context) =>
    handleCallerStatusRequest(request, context)
  );
}
