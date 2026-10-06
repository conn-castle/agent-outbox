import { respondToApiRequest } from "../../../../src/server/api-route";
import { handleOutputCheckRequest } from "../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return respondToApiRequest(
    request,
    "/api/output/check",
    (context) => handleOutputCheckRequest(request, context),
    { noStore: true }
  );
}
