import type { TransactionContextStatement } from "./database.ts";

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
