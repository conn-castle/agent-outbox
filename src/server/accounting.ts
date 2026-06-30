import {
  getLimitDefinition,
  limitErrorMetadata,
  type LimitName,
  type LimitOperationKind,
  type LimitProfileSelector,
  type LimitWindowKind
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
  responseKind?:
    | "none"
    | "free_text"
    | "single_select"
    | "multi_select"
    | "date_picker"
    | "file_upload"
    | null;
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

export type AuditSafeLifecycleEvent = {
  event_type: AuditEventType;
  account_audit_id: string;
  caller_audit_id?: string;
  input_item_id?: string;
  output_result_id?: string;
  output_file_id?: string;
  item_status?: "pending" | "answered";
  response_kind?: NonNullable<AuditSafeLifecycleInput["responseKind"]>;
  non_file_bytes?: number;
  file_bytes?: number;
  quota_metric?: string;
  limit_name?: LimitName;
  deletion_reason?: string;
  request_id?: string;
  correlation_id?: string;
  caller_item_id_hash?: string;
  metadata: Record<string, string | number | boolean | null>;
};

export type QuotaWindowKey = {
  metric: LimitName;
  windowKind: LimitWindowKind;
  windowStartUtc: string;
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

export type StoredByteAccountingInput = {
  inputPayloadBytes?: number;
  outputPayloadBytes?: number;
  fileBytes?: number;
};

export type StoredByteAccounting = {
  nonFileQueuePayloadBytes: number;
  fileBytes: number;
  overallStoredAccountDataBytes: number;
};

const SAFE_AUDIT_METADATA_KEYS = new Set([
  "attempt",
  "deleted_count",
  "file_count",
  "page_count",
  "request_count",
  "returned_count",
  "revision"
]);

export function auditSafeLifecycleEvent(
  input: AuditSafeLifecycleInput
): AuditSafeLifecycleEvent {
  const event: AuditSafeLifecycleEvent = {
    event_type: input.eventType,
    account_audit_id: input.accountAuditId,
    metadata: auditSafeMetadata(input.metadata)
  };

  if (input.callerAuditId != null) {
    event.caller_audit_id = input.callerAuditId;
  }
  if (input.inputItemId != null) {
    event.input_item_id = input.inputItemId;
  }
  if (input.outputResultId != null) {
    event.output_result_id = input.outputResultId;
  }
  if (input.outputFileId != null) {
    event.output_file_id = input.outputFileId;
  }
  if (input.itemStatus != null) {
    event.item_status = input.itemStatus;
  }
  if (input.responseKind != null) {
    event.response_kind = input.responseKind;
  }
  if (input.nonFileBytes != null) {
    event.non_file_bytes = input.nonFileBytes;
  }
  if (input.fileBytes != null) {
    event.file_bytes = input.fileBytes;
  }
  if (input.quotaMetric != null) {
    event.quota_metric = input.quotaMetric;
  }
  if (input.limitName != null) {
    event.limit_name = input.limitName;
  }
  if (input.deletionReason != null) {
    event.deletion_reason = input.deletionReason;
  }
  if (input.requestId != null) {
    event.request_id = input.requestId;
  }
  if (input.correlationId != null) {
    event.correlation_id = input.correlationId;
  }
  if (input.callerItemIdHash != null) {
    event.caller_item_id_hash = input.callerItemIdHash;
  }

  return event;
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

export function quotaWindowKey(
  limitName: LimitName,
  at: Date
): QuotaWindowKey | null {
  const definition = getLimitDefinition(limitName);
  if (!definition.windowKind) {
    return null;
  }

  return {
    metric: limitName,
    windowKind: definition.windowKind,
    windowStartUtc: quotaWindowStartUtc(at, definition.windowKind)
  };
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

export function storedByteAccounting(
  input: StoredByteAccountingInput
): StoredByteAccounting {
  const nonFileQueuePayloadBytes =
    (input.inputPayloadBytes ?? 0) + (input.outputPayloadBytes ?? 0);
  const fileBytes = input.fileBytes ?? 0;

  return {
    nonFileQueuePayloadBytes,
    fileBytes,
    overallStoredAccountDataBytes: nonFileQueuePayloadBytes + fileBytes
  };
}

export function consumesMonthlyCallerApiRequestQuota(
  operationKind: LimitOperationKind
) {
  return !["input_delete", "output_ack", "cleanup"].includes(operationKind);
}

function quotaWindowStartUtc(at: Date, windowKind: LimitWindowKind) {
  const start = new Date(at.getTime());
  start.setUTCSeconds(0, 0);

  if (windowKind === "day" || windowKind === "calendar_month") {
    start.setUTCHours(0, 0, 0, 0);
  }

  if (windowKind === "calendar_month") {
    start.setUTCDate(1);
  }

  return start.toISOString();
}
