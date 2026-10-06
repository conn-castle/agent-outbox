import { respondToJsonApiRequest } from "../../../../src/server/api-route";
import { handleInputQueueRequest } from "../../../../src/server/input-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/input/replace",
    async (context, body) => {
      const result = await handleInputQueueRequest(
        request,
        context,
        "replace",
        body
      );
      if (!result.ok) {
        return result;
      }

      const { operation: _operation, ...responseData } = result.data;
      return { ok: true, data: responseData };
    }
  );
}
