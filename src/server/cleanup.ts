import type { TransactionContextStatement } from "./database.ts";
import type { LimitWindowKind } from "./limits.ts";
import { fixedWindowLimitNames, getLimitDefinition } from "./limits.ts";

const CALLER_SETUP_REQUEST_RETENTION_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const TERMINAL_OUTPUT_DELETION_REASONS = [
  "acknowledgement",
  "output_timeout",
  "downgrade_grace_file_output",
  "downgrade_grace_non_file_payload_limit"
] as const;

export type TerminalOutputDeletionReason =
  (typeof TERMINAL_OUTPUT_DELETION_REASONS)[number];

export function duplicateAcknowledgementLookupStatement(
  outputResultId: string
): TransactionContextStatement {
  return {
    sql: "select public.agent_outbox_output_ack_already_recorded($1) as already_recorded",
    values: [outputResultId]
  };
}

export function terminalOutputDeletionStatement(
  outputResultId: string,
  deletionReason: TerminalOutputDeletionReason,
  requestId: string | null = null
): TransactionContextStatement {
  return {
    sql: "select * from public.agent_outbox_delete_output_result($1, $2, $3)",
    values: [outputResultId, deletionReason, requestId]
  };
}

export function preReadUndoStatement(
  outputResultId: string,
  requestId: string | null = null
): TransactionContextStatement {
  return {
    sql: "select * from public.agent_outbox_restore_unread_output($1, $2)",
    values: [outputResultId, requestId]
  };
}

export function pendingInputRetentionStatement(
  retentionBefore: Date,
  requestId: string | null = null
): TransactionContextStatement {
  return {
    sql: "select public.agent_outbox_delete_retained_pending_inputs($1, $2) as deleted_count",
    values: [timestampValue(retentionBefore), requestId]
  };
}

export function downgradeGraceExpiryStatement(
  nonFilePayloadLimitBytes: number,
  now: Date
): TransactionContextStatement {
  if (
    !Number.isSafeInteger(nonFilePayloadLimitBytes) ||
    nonFilePayloadLimitBytes < 0
  ) {
    throw new RangeError(
      "nonFilePayloadLimitBytes must be a non-negative safe integer"
    );
  }

  return {
    sql: "select * from public.agent_outbox_cleanup_downgrade_grace_expiry($1, $2)",
    values: [nonFilePayloadLimitBytes, timestampValue(now)]
  };
}

export function quotaWindowPruningStatement(
  before: Date
): TransactionContextStatement {
  return {
    sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
    values: [timestampValue(before)]
  };
}

export function quotaWindowMaintenanceStatements(
  now: Date
): TransactionContextStatement[] {
  const before = quotaWindowPruningCutoff(now);
  // IP quota windows only ever store minute-window counters (every IP-scoped
  // control-plane limit is per-minute), so a row is dead at the next minute
  // boundary. Reusing the account cutoff would anchor pruning to the oldest
  // live calendar-month window and retain per-IP minute rows for up to a month,
  // and unlike the account table (bounded by account count) the IP table grows
  // per attacker IP. Prune it with a minute-anchored cutoff instead.
  const ipBefore = quotaWindowPruningCutoff(now, ["minute"]);
  const callerSetupBefore = new Date(
    now.getTime() - CALLER_SETUP_REQUEST_RETENTION_DAYS * ONE_DAY_MS
  );

  return [
    quotaWindowPruningStatement(before),
    {
      sql: "select public.agent_outbox_prune_ip_quota_windows($1) as deleted_count",
      values: [timestampValue(ipBefore)]
    },
    {
      sql: "select public.agent_outbox_prune_caller_setup_requests($1) as deleted_count",
      values: [timestampValue(callerSetupBefore)]
    }
  ];
}

export function quotaWindowPruningCutoff(
  now: Date,
  windowKinds?: readonly LimitWindowKind[]
) {
  const allowed = windowKinds ? new Set(windowKinds) : null;
  const oldestLiveWindowStart = Math.min(
    ...fixedWindowLimitNames()
      .filter(
        (limitName) =>
          allowed === null ||
          allowed.has(getLimitDefinition(limitName).windowKind!)
      )
      .map((limitName) => {
        const start = new Date(now.getTime());
        const windowKind = getLimitDefinition(limitName).windowKind!;
        start.setUTCSeconds(0, 0);
        if (windowKind === "day" || windowKind === "calendar_month") {
          start.setUTCHours(0, 0, 0, 0);
        }
        if (windowKind === "calendar_month") {
          start.setUTCDate(1);
        }
        return start.getTime();
      })
  );

  return new Date(oldestLiveWindowStart);
}

export function activeLimitMaintenanceStatement(
  now: Date
): TransactionContextStatement {
  return {
    sql: "select public.agent_outbox_prune_expired_limit_blocks($1) as deleted_count",
    values: [timestampValue(now)]
  };
}

function timestampValue(value: Date) {
  return value.toISOString();
}
