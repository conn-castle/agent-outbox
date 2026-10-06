import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse,
  type ApiRequestContext,
  type ApiResult
} from "./api-errors.ts";
import { readJsonBodyWithLimit } from "./request-body.ts";

type ApiRouteOptions = { noStore?: boolean };

export async function respondToApiRequest<TData>(
  request: Request,
  route: string,
  handle: (context: ApiRequestContext) => Promise<ApiResult<TData>>,
  options: ApiRouteOptions = {}
): Promise<Response> {
  const context = apiRequestContext(request, route);
  const result = await handle(context);
  if (!result.ok) {
    return apiErrorResponse(context, result.error);
  }

  return apiSuccessResponse(
    context,
    result.data,
    options.noStore ? { headers: { "Cache-Control": "no-store" } } : undefined
  );
}

export function respondToJsonApiRequest<TData>(
  request: Request,
  route: string,
  handle: (
    context: ApiRequestContext,
    body: unknown
  ) => Promise<ApiResult<TData>>,
  options?: ApiRouteOptions
): Promise<Response> {
  return respondToApiRequest(
    request,
    route,
    async (context) => {
      const body = await readJsonBodyWithLimit(request);
      if (!body.ok) {
        return body;
      }

      return handle(context, body.value);
    },
    options
  );
}
