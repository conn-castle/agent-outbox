import { respondToJsonApiRequest } from "../../../../src/server/api-route";
import { handleInputQueueRequest } from "../../../../src/server/input-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(request, "/api/input/send", (context, body) =>
    handleInputQueueRequest(request, context, "send", body)
  );
}
