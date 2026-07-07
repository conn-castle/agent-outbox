import {
  apiErrorResponse,
  apiRequestContext
} from "../../../../../../src/server/api-errors";
import { handleOutputFileDownloadRequest } from "../../../../../../src/server/output-files";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  routeContext: {
    params: Promise<{ output_result_id: string; file_id: string }>;
  }
) {
  const context = apiRequestContext(
    request,
    "/api/output/[output_result_id]/files/[file_id]"
  );
  const params = await routeContext.params;
  const result = await handleOutputFileDownloadRequest(request, context, {
    outputResultId: params.output_result_id,
    fileId: params.file_id
  });

  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: result.headers
  });
}
