import openNextWorker from "../.open-next/worker.js";
import {
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary,
  runScheduledCleanup
} from "../src/server/scheduled.ts";

export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache
} from "../.open-next/worker.js";

export default {
  async fetch(request, env, context) {
    return openNextWorker.fetch(request, env, context);
  },

  async scheduled(controller, env, context) {
    runScheduledCanary({
      trigger: "cron",
      cron: controller.cron || RUNTIME_CRON_SCHEDULE,
      scheduledTime: controller.scheduledTime
    });
    const cleanup = runScheduledCleanup({
      connectionString: env?.DATABASE_APP_ROLE_URL,
      now:
        typeof controller.scheduledTime === "number" &&
        Number.isFinite(controller.scheduledTime)
          ? new Date(controller.scheduledTime)
          : undefined
    });

    if (typeof context?.waitUntil === "function") {
      context.waitUntil(cleanup);
      return;
    }

    await cleanup;
  }
};
