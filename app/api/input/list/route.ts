import { respondToApiRequest } from "../../../../src/server/api-route";
import { handleInputListRequest } from "../../../../src/server/input-read";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return respondToApiRequest(
    request,
    "/api/input/list",
    (context) => handleInputListRequest(request, context),
    { noStore: true }
  );
}
