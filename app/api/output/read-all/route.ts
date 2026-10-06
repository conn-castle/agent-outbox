import { respondToJsonApiRequest } from "../../../../src/server/api-route";
import { handleOutputReadAllRequest } from "../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/output/read-all",
    (context, body) => handleOutputReadAllRequest(request, context, body),
    { noStore: true }
  );
}
