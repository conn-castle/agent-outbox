import { auth } from "@clerk/nextjs/server";

import {
  executeBulkHumanAnswersMutation,
  executeHumanAnswerMutation,
  executeUndoHumanAnswerMutation
} from "../actions";
import {
  isHumanMutationOperation,
  type HumanMutationOperation
} from "../../../src/shared/human-mutation";
import { createCorrelationId } from "../../../src/server/correlation";
import { humanBrowserFixtureEnabled } from "../../../src/server/human-review-fixture-gate";
import {
  humanMutationFailureResponse,
  humanMutationResponse,
  humanMutationTransportFailureResponse
} from "../../../src/server/human-mutation-response";
import {
  HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT,
  readFormDataWithLimit
} from "../../../src/server/request-body";
import { reportRuntimeFailure } from "../../../src/server/sentry";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return humanMutationFailureResponse(
      "invalid_request",
      "Refresh the page and try again.",
      403
    );
  }

  const requestId = createCorrelationId("human_mutation_req");
  const startedAt = Date.now();
  try {
    if (!humanBrowserFixtureEnabled()) {
      const session = await auth();
      if (!session.userId) {
        return humanMutationFailureResponse(
          "authentication_required",
          "Your session expired. Sign in again, then retry the action.",
          401
        );
      }
    }
    const body = await readFormDataWithLimit(
      request,
      HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT
    );
    if (!body.ok) {
      return body.reason === "too_large"
        ? humanMutationTransportFailureResponse("request_too_large")
        : invalidRequestResponse();
    }
    const formData = body.formData;
    const operation = formData.get("_operation");
    if (!isHumanMutationOperation(operation)) return invalidRequestResponse();

    const result = await executeMutation(operation, formData);
    return humanMutationResponse(
      result,
      result.ok ? 200 : failureStatus(result.code)
    );
  } catch (error) {
    reportRuntimeFailure(error, {
      errorId: requestId,
      request_id: requestId,
      surface: "app",
      route: "/human/mutations",
      method: "POST",
      status_code: 503,
      duration_ms: Math.max(0, Date.now() - startedAt),
      operation: "human_mutation",
      message: "Human mutation failed unexpectedly."
    });
    return humanMutationTransportFailureResponse("temporary_unavailable");
  }
}

function requestIsSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const requestUrl = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    requestUrl.host;
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    requestUrl.protocol.replace(":", "");
  return origin === requestUrl.origin || origin === `${protocol}://${host}`;
}

function executeMutation(
  operation: HumanMutationOperation,
  formData: FormData
) {
  switch (operation) {
    case "answer":
      return executeHumanAnswerMutation(formData);
    case "bulk-answer":
      return executeBulkHumanAnswersMutation(formData);
    case "undo":
      return executeUndoHumanAnswerMutation(formData);
  }
}

function failureStatus(code: string) {
  if (code === "invalid_request") return 400;
  if (code === "temporary_unavailable" || code.includes("configuration")) {
    return 503;
  }
  return 409;
}

function invalidRequestResponse() {
  return humanMutationFailureResponse(
    "invalid_request",
    "Action failed: invalid request.",
    400
  );
}
