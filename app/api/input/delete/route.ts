import { respondToJsonApiRequest } from "../../../../src/server/api-route";
import { handleInputQueueRequest } from "../../../../src/server/input-queue";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return respondToJsonApiRequest(
    request,
    "/api/input/delete",
    async (context, body) => {
      const result = await handleInputQueueRequest(
        request,
        context,
        "delete",
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
