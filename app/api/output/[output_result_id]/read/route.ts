import { respondToApiRequest } from "../../../../../src/server/api-route";
import { handleOutputReadRequest } from "../../../../../src/server/output-queue";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ output_result_id: string }> }
) {
  return respondToApiRequest(
    request,
    "/api/output/[output_result_id]/read",
    async (context) => {
      const { output_result_id: outputResultId } = await params;
      return handleOutputReadRequest(request, context, outputResultId);
    },
    { noStore: true }
  );
}
