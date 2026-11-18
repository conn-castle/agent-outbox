import type { PopupKind } from "../shared/input-schema-rules.ts";
import type { TransactionContextStatement } from "./database.ts";
import {
  getLimitDefinition,
  limitErrorMetadata,
  MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS,
  type LimitName,
  type LimitOperationKind,
  type LimitProfileSelector
} from "./limits.ts";

export type AuditEventType =
  | "account_created"
  | "user_created"
  | "caller_registered"
  | "caller_key_rotated"
  | "caller_key_revoked"
  | "input_submitted"
  | "input_replaced"
  | "input_answered"
  | "input_deleted"
  | "output_created"
  | "output_acknowledged"
  | "output_deleted"
  | "output_undone"
  | "file_uploaded"
  | "file_downloaded"
  | "file_deleted"
  | "quota_denied";

export type AuditSafeLifecycleInput = {
  eventType: AuditEventType;
  accountAuditId: string;
  callerAuditId?: string | null;
  inputItemId?: string | null;
  outputResultId?: string | null;
  outputFileId?: string | null;
  itemStatus?: "pending" | "answered" | null;
  responseKind?: PopupKind | null;
  nonFileBytes?: number | null;
  fileBytes?: number | null;
  quotaMetric?: string | null;
  limitName?: LimitName | null;
  deletionReason?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  callerItemIdHash?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ActiveLimitBlockInput = {
  selector: LimitProfileSelector;
  accountId: string;
  operationKind: LimitOperationKind;
  limitName: LimitName;
  usedUnits?: number | null;
  limitResetsAt?: Date | null;
};

export type ActiveLimitBlockMetadata = {
  account_id: string;
  operation_kind: LimitOperationKind;
  limit_name: LimitName;
  limit_reason_code: string;
  limit_reason: string;
  limit_resets_at: string | null;
  used_units: number | null;
  limit_units: number | null;
};

const MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KIND_SET =
  new Set<LimitOperationKind>(MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS);

const SAFE_AUDIT_METADATA_KEYS = new Set([
  "attempt",
  "deleted_count",
  "file_count",
  "page_count",
  "request_count",
  "returned_count",
  "revision"
]);

function validByteCount(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }

  return value;
}

/**
 * Builds, but does not execute, a lifecycle audit INSERT.
 * Invalid byte counts throw before a statement is returned, and metadata is
 * filtered to the audit allowlist. Only the listed audit columns are bound, so
 * extra input properties never reach the row. Binds absent optional fields as
 * SQL NULL and serializes filtered metadata as JSON; callers control
 * transaction execution and audit-statement ordering.
 */
export function auditEventInsertStatement(
  input: AuditSafeLifecycleInput
): TransactionContextStatement {
  const metadata = auditSafeMetadata(input.metadata);
  const nonFileBytes =
    input.nonFileBytes == null
      ? null
      : validByteCount(input.nonFileBytes, "nonFileBytes");
  const fileBytes =
    input.fileBytes == null
      ? null
      : validByteCount(input.fileBytes, "fileBytes");

  return {
    sql: `
      insert into public.agent_outbox_audit_events(
        event_type,
        account_audit_id,
        caller_audit_id,
        input_item_id,
        output_result_id,
        output_file_id,
        item_status,
        response_kind,
        non_file_bytes,
        file_bytes,
        quota_metric,
        limit_name,
        deletion_reason,
        request_id,
        correlation_id,
        caller_item_id_hash,
        metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb
      )
    `,
    values: [
      input.eventType,
      input.accountAuditId,
      input.callerAuditId ?? null,
      input.inputItemId ?? null,
      input.outputResultId ?? null,
      input.outputFileId ?? null,
      input.itemStatus ?? null,
      input.responseKind ?? null,
      nonFileBytes,
      fileBytes,
      input.quotaMetric ?? null,
      input.limitName ?? null,
      input.deletionReason ?? null,
      input.requestId ?? null,
      input.correlationId ?? null,
      input.callerItemIdHash ?? null,
      JSON.stringify(metadata)
    ]
  };
}

function auditSafeMetadata(
  metadata: AuditSafeLifecycleInput["metadata"] | undefined
) {
  const safeMetadata: Record<string, number | boolean | null> = {};

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (
      SAFE_AUDIT_METADATA_KEYS.has(key) &&
      (typeof value === "number" ||
        typeof value === "boolean" ||
        value === null)
    ) {
      safeMetadata[key] = value;
    }
  }

  return safeMetadata;
}

export function activeLimitBlockMetadata(
  input: ActiveLimitBlockInput
): ActiveLimitBlockMetadata {
  const definition = getLimitDefinition(input.limitName);
  if (!definition.operationKinds.includes(input.operationKind)) {
    throw new TypeError(
      `${input.limitName} does not apply to ${input.operationKind}`
    );
  }

  const error = limitErrorMetadata(input.selector, input.limitName, {
    usedUnits: input.usedUnits,
    limitResetsAt: input.limitResetsAt
  });

  return {
    account_id: input.accountId,
    operation_kind: input.operationKind,
    limit_name: input.limitName,
    limit_reason_code: error.limitReasonCode,
    limit_reason: error.limitReason,
    limit_resets_at: error.limitResetsAt,
    used_units: error.usedUnits,
    limit_units: error.limitUnits
  };
}

export function consumesMonthlyCallerApiRequestQuota(
  operationKind: LimitOperationKind
) {
  return MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KIND_SET.has(operationKind);
}
