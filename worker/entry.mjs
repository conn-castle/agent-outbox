import openNextWorker from "../.open-next/worker.js";
import {
  runtimeDatabaseConnectionString,
  runtimeDatabaseEnv
} from "./hyperdrive.mjs";
import {
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary,
  runScheduledCleanup
} from "../src/server/scheduled.ts";
import {
  reportFetchRuntimeFailure,
  runWithScheduledSentry
} from "../src/server/sentry.ts";
import { createCorrelationId } from "../src/server/correlation.ts";
import { humanMutationTransportFailureResponse } from "../src/server/human-mutation-response.ts";
import {
  boundedRequestBody,
  HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT
} from "../src/server/request-body.ts";

export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache
} from "../.open-next/worker.js";

export default {
  async fetch(request, env, context) {
    if (!isHumanMutationPost(request)) {
      return openNextWorker.fetch(request, runtimeDatabaseEnv(env), context);
    }

    // OpenNext's external middleware converter buffers arrayBuffer() before
    // application auth/route parsing. Bound that first read without a body copy.
    const requestId = createCorrelationId("human_mutation_req");
    const startedAt = Date.now();
    let bounded;
    try {
      bounded = boundedRequestBody(
        request,
        HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT
      );
      if (!bounded.ok) {
        return humanMutationTransportFailureResponse("request_too_large");
      }
      const forwarded = new Request(request, {
        body: bounded.body,
        duplex: "half"
      });
      return await openNextWorker.fetch(
        forwarded,
        runtimeDatabaseEnv(env),
        context
      );
    } catch (error) {
      const failure = bounded?.ok ? bounded.failure() : null;
      if (failure?.reason === "too_large") {
        return humanMutationTransportFailureResponse("request_too_large");
      }
      const reporting = reportFetchRuntimeFailure(
        failure ? failure.error : error,
        {
          errorId: requestId,
          request_id: requestId,
          surface: "app",
          route: "/human/mutations",
          method: "POST",
          status_code: 503,
          duration_ms: Math.max(0, Date.now() - startedAt),
          operation: "human_mutation",
          message: "Human mutation failed unexpectedly."
        }
      );
      if (typeof context?.waitUntil === "function") {
        context.waitUntil(reporting);
      } else {
        await reporting;
      }
      return humanMutationTransportFailureResponse("temporary_unavailable");
    }
  },

  async scheduled(controller, env, context) {
    runScheduledCanary({
      trigger: "cron",
      cron: controller.cron || RUNTIME_CRON_SCHEDULE,
      scheduledTime: controller.scheduledTime
    });
    const cleanup = runWithScheduledSentry(() =>
      runScheduledCleanup({
        connectionString: runtimeDatabaseConnectionString(env),
        now:
          typeof controller.scheduledTime === "number" &&
          Number.isFinite(controller.scheduledTime)
            ? new Date(controller.scheduledTime)
            : undefined
      })
    );

    if (typeof context?.waitUntil === "function") {
      context.waitUntil(cleanup);
      return;
    }

    await cleanup;
  }
};

/**
 * Selects POSTs with canonical, trailing-slash or decoded mutation paths for
 * resource protection. Does not rewrite URLs or authorize actions; selecting an
 * encoded spelling does not establish that the router accepts it.
 * @param {Request} request
 */
function isHumanMutationPost(request) {
  if (request.method !== "POST") return false;
  // OpenNext also matches decoded paths; include the optional trailing slash
  // without rewriting the request that its middleware receives.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
  return pathname === "/human/mutations" || pathname === "/human/mutations/";
}
