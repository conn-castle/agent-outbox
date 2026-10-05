import { HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT } from "./request-body.ts";

/** The shared transport failures for the Worker entry and application route. */
export function humanMutationTransportFailureResponse(
  code: "request_too_large" | "temporary_unavailable"
) {
  return Response.json(
    {
      ok: false,
      operation: "answer",
      code,
      message:
        code === "request_too_large"
          ? `Action failed: request exceeds the ${HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte limit.`
          : "Action is temporarily unavailable.",
      inputItemIds: []
    },
    {
      status: code === "request_too_large" ? 413 : 503,
      headers: { "Cache-Control": "no-store" }
    }
  );
}
