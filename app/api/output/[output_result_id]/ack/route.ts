import { respondToApiRequest } from "../../../../../src/server/api-route";
import { handleOutputAckRequest } from "../../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ output_result_id: string }> }
) {
  return respondToApiRequest(
    request,
    "/api/output/[output_result_id]/ack",
    async (context) => {
      const { output_result_id: outputResultId } = await params;
      return handleOutputAckRequest(request, context, outputResultId);
    },
    { noStore: true }
  );
}
