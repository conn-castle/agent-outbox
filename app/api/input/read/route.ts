import { respondToJsonApiRequest } from "../../../../src/server/api-route";
import { handleInputReadRequest } from "../../../../src/server/input-read";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/input/read",
    (context, body) => handleInputReadRequest(request, context, body),
    { noStore: true }
  );
}
