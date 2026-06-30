import { createCorrelationId } from "./correlation.ts";
import { emitRuntimeLog } from "./logging.ts";

export const RUNTIME_CRON_SCHEDULE = "17 * * * *";

type ScheduledCanaryTrigger = "cron" | "route";

type ScheduledCanaryInput = {
  trigger: ScheduledCanaryTrigger;
  cron?: string | null;
  scheduledTime?: number | null;
};

export function runScheduledCanary(input: ScheduledCanaryInput) {
  const errorId = createCorrelationId("sched");
  const recordedAt = new Date().toISOString();
  const scheduledTime =
    typeof input.scheduledTime === "number" &&
    Number.isFinite(input.scheduledTime)
      ? new Date(input.scheduledTime).toISOString()
      : null;
  const log = emitRuntimeLog({
    level: "info",
    error_id: errorId,
    environment: process.env.APP_ENV ?? null,
    release: process.env.CF_VERSION_METADATA ?? null,
    surface: "scheduled",
    operation: "runtime.scheduled.canary",
    message: "scheduled runtime canary executed"
  });

  return {
    ok: true,
    code: "scheduled_canary_ok",
    trigger: input.trigger,
    cron: input.cron ?? null,
    configured_cron: RUNTIME_CRON_SCHEDULE,
    error_id: errorId,
    recorded_at: recordedAt,
    scheduled_time: scheduledTime,
    log
  };
}
