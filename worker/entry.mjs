import openNextWorker from "../.open-next/worker.js";
import {
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary
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

  async scheduled(controller) {
    runScheduledCanary({
      trigger: "cron",
      cron: controller.cron || RUNTIME_CRON_SCHEDULE,
      scheduledTime: controller.scheduledTime
    });
  }
};
