import { auth } from "@clerk/nextjs/server";

import {
  executeBulkHumanAnswersMutation,
  executeHumanAnswerMutation,
  executeUndoHumanAnswerMutation
} from "../actions";
import type {
  HumanMutationOperation,
  HumanMutationResult
} from "../../../src/shared/human-mutation";
import { createCorrelationId } from "../../../src/server/correlation";
import { humanBrowserFixtureEnabled } from "../../../src/server/human-review-fixture-gate";
import { reportRuntimeFailure } from "../../../src/server/sentry";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return mutationResponse(
      {
        ok: false,
        operation: "answer",
        code: "invalid_request",
        message: "Refresh the page and try again.",
        inputItemIds: []
      },
      403
    );
  }

  const requestId = createCorrelationId("human_mutation_req");
  const startedAt = Date.now();
  try {
    if (!humanBrowserFixtureEnabled()) {
      const session = await auth();
      if (!session.userId) {
        return mutationResponse(
          {
            ok: false,
            operation: "answer",
            code: "authentication_required",
            message:
              "Your session expired. Sign in again, then retry the action.",
            inputItemIds: []
          },
          401
        );
      }
    }
    const formData = await request.formData();
    const operation = formData.get("_operation");
    if (!isHumanMutationOperation(operation)) {
      return mutationResponse(
        {
          ok: false,
          operation: "answer",
          code: "invalid_request",
          message: "Action failed: invalid request.",
          inputItemIds: []
        },
        400
      );
    }

    const result = await executeMutation(operation, formData);
    return mutationResponse(
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
    return mutationResponse(
      {
        ok: false,
        operation: "answer",
        code: "temporary_unavailable",
        message: "Action is temporarily unavailable.",
        inputItemIds: []
      },
      503
    );
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

function isHumanMutationOperation(
  value: FormDataEntryValue | null
): value is HumanMutationOperation {
  return value === "answer" || value === "bulk-answer" || value === "undo";
}

function failureStatus(code: string) {
  if (code === "invalid_request") return 400;
  if (code === "temporary_unavailable" || code.includes("configuration")) {
    return 503;
  }
  return 409;
}

function mutationResponse(result: HumanMutationResult, status: number) {
  return Response.json(result, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
