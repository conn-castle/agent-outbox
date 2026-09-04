import * as Sentry from "@sentry/nextjs";

import { createCorrelationId } from "./src/server/correlation";
import { emitRuntimeLog, safeErrorName } from "./src/server/logging";
import {
  NEXT_REQUEST_ERROR_MESSAGE,
  NEXT_REQUEST_ERROR_OPERATION,
  classifyNextRequestError
} from "./src/server/request-error-observability";
import { sentryCaptureEnabled } from "./src/server/sentry";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export function onRequestError(
  error: unknown,
  request: Parameters<typeof Sentry.captureRequestError>[1],
  errorContext: Parameters<typeof Sentry.captureRequestError>[2]
) {
  const errorId = createCorrelationId("err");
  const diagnostics = classifyNextRequestError(request, errorContext);
  let delegated = false;
  let captureReturned = false;
  let sentryScopeAttached = false;

  try {
    Sentry.withScope((scope) => {
      scope.setTag("error_id", errorId);
      scope.setTag("operation", NEXT_REQUEST_ERROR_OPERATION);
      scope.setTag("route", diagnostics.route);
      scope.setTag("path_shape", diagnostics.path_shape);
      scope.setTag("multipart_boundary", diagnostics.multipart_boundary);
      scope.setTag("content_length_state", diagnostics.content_length_state);
      scope.setContext("agent_outbox", {
        error_id: errorId,
        operation: NEXT_REQUEST_ERROR_OPERATION,
        route: diagnostics.route,
        path_shape: diagnostics.path_shape,
        multipart_boundary: diagnostics.multipart_boundary,
        content_length_state: diagnostics.content_length_state
      });
      sentryScopeAttached = true;
      // Mark delegation before the call so a thrown delegate is never retried.
      delegated = true;
      Sentry.captureRequestError(error, request, errorContext);
      captureReturned = true;
    });
  } catch {
    // Observability must not escape into Next.js's existing error path.
  }

  if (!delegated) {
    try {
      delegated = true;
      Sentry.captureRequestError(error, request, errorContext);
      captureReturned = true;
    } catch {
      // The structured log below remains the failure signal.
    }
  }

  emitRuntimeLog({
    level: "error",
    error_id: errorId,
    error_name: safeErrorName(error),
    sentry_captured: captureReturned && sentryCaptureEnabled(),
    sentry_scope_attached: sentryScopeAttached,
    surface: diagnostics.route.startsWith("/api/") ? "api" : "app",
    route: diagnostics.route,
    method: diagnostics.method,
    operation: NEXT_REQUEST_ERROR_OPERATION,
    path_shape: diagnostics.path_shape,
    multipart_boundary: diagnostics.multipart_boundary,
    content_length_state: diagnostics.content_length_state,
    message: NEXT_REQUEST_ERROR_MESSAGE
  });
}
