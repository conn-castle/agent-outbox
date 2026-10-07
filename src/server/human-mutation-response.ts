import type { HumanMutationResult } from "../shared/human-mutation.ts";
import { HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT } from "./request-body.ts";

export function humanMutationResponse(
  result: HumanMutationResult,
  status: number
): Response {
  return Response.json(result, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export function humanMutationFailureResponse(
  code: string,
  message: string,
  status: number
): Response {
  return humanMutationResponse(
    { ok: false, operation: "answer", code, message, inputItemIds: [] },
    status
  );
}

/** The shared transport failures for the Worker entry and application route. */
export function humanMutationTransportFailureResponse(
  code: "request_too_large" | "temporary_unavailable"
) {
  return humanMutationFailureResponse(
    code,
    code === "request_too_large"
      ? `Action failed: request exceeds the ${HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte limit.`
      : "Action is temporarily unavailable.",
    code === "request_too_large" ? 413 : 503
  );
}
