import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

export type AccountTier = "hosted_free" | "hosted_paid" | "self_hosted";
export type LimitProfileId = "hosted-free" | "hosted-paid" | "self-hosted";
export type LimitProfileSelector = LimitProfileId;

export type LimitCategory = "product" | "runtime" | "billing" | "cleanup";
export type LimitUnit =
  | "requests"
  | "submissions"
  | "items"
  | "days"
  | "bytes"
  | "concurrent_requests"
  | "boolean";
export type LimitWindowKind = "minute" | "day" | "calendar_month";
export type LimitResetRule =
  | "fixed_window_end"
  | "cleanup_or_storage_free"
  | "billing_grace_end"
  | "not_applicable";
export type LimitOperationKind =
  | "caller_api_request"
  | "input_send_replace"
  | "input_submission"
  | "input_delete"
  | "human_answer_submission"
  | "output_check_read"
  | "output_file_download"
  | "output_ack"
  | "caller_connect_approval"
  | "caller_rotate_approval"
  | "caller_revoke_approval"
  | "caller_connect_start"
  | "caller_connect_poll"
  | "caller_connect_exchange"
  | "caller_connect_activation"
  | "caller_rotate_start"
  | "caller_rotate_poll"
  | "caller_rotate_exchange"
  | "caller_rotate_activation"
  | "caller_revoke_start"
  | "caller_revoke_poll"
  | "caller_revoke_confirm"
  | "file_upload"
  | "storage_write"
  | "status"
  | "cleanup"
  | "billing";

export const MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS = [
  "caller_api_request",
  "input_send_replace",
  "input_submission",
  "output_check_read",
  "output_file_download",
  "status"
] as const satisfies readonly LimitOperationKind[];

export type LimitErrorCode =
  | "quota_limit_exceeded"
  | "rate_limit_exceeded"
  | "storage_limit_exceeded"
  | "retention_limit_exceeded"
  | "upgrade_required"
  | "request_too_large"
  | "billing_grace_expired";
export type LimitDisabledReason =
  | "paid_tier_unlimited"
  | "paid_tier_no_retention_cleanup"
  | "file_upload_disabled"
  | "paid_tier_uses_overall_storage_cap";
export type LimitNotApplicableReason =
  | "free_tier_not_billed"
  | "self_hosted_no_stripe_billing"
  | "free_tier_uses_non_file_storage_cap";

export type EnabledLimit = {
  mode: "enabled";
  value: number;
};

export type DisabledLimit = {
  mode: "disabled";
  disabledReason: LimitDisabledReason;
};

export type NotApplicableLimit = {
  mode: "not_applicable";
  notApplicableReason: LimitNotApplicableReason;
};

export type LimitSetting = EnabledLimit | DisabledLimit | NotApplicableLimit;

type LimitDefinition<ReasonCode extends string = LimitReasonCode> = {
  category: LimitCategory;
  unit: LimitUnit;
  operationKinds: readonly LimitOperationKind[];
  windowKind?: LimitWindowKind;
  resetRule: LimitResetRule;
  reasonCode: ReasonCode;
  reason: string;
  errorCode: LimitErrorCode;
  statusLabel: string;
};

export type LimitProfile = {
  profileId: LimitProfileId;
  label: string;
  hosted: boolean;
  effectiveTier: "free" | "paid";
  billing: {
    stripeBillingState: "required" | "not_applicable";
  };
  limits: Readonly<Record<LimitName, LimitSetting>>;
};

export type LimitStatusMetadata = {
  profileId: LimitProfileId;
  limitName: LimitName;
  statusLabel: string;
  category: LimitCategory;
  unit: LimitUnit;
  operationKinds: readonly LimitOperationKind[];
  windowKind: LimitWindowKind | null;
  resetRule: LimitResetRule;
  setting: LimitSetting;
  reasonCode: LimitReasonCode;
};

export type AccountLimitStatusMetadata = {
  profileId: LimitProfileId;
  label: string;
  hosted: boolean;
  effectiveTier: "free" | "paid";
  stripeBillingState: "required" | "not_applicable";
  fileUploadEnabled: boolean;
  limits: readonly LimitStatusMetadata[];
};

export type LimitErrorMetadata = {
  status: 413 | 429 | 402;
  code: LimitErrorCode;
  limitName: LimitName;
  limitReasonCode: LimitReasonCode;
  limitReason: string;
  limitResetsAt: string | null;
  usedUnits: number | null;
  limitUnits: number | null;
  unit: LimitUnit;
};

const LIMIT_DEFINITIONS = {
  input_submissions_per_calendar_month: {
    category: "product",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "calendar_month",
    resetRule: "fixed_window_end",
    reasonCode: "monthly_input_submission_quota_exceeded",
    reason:
      "Monthly input submission limit reached; wait for the next UTC calendar month or upgrade.",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Monthly input submissions"
  },
  input_submissions_per_day: {
    category: "product",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "day",
    resetRule: "fixed_window_end",
    reason:
      "Daily input submission limit reached; wait for the next UTC day or upgrade.",
    reasonCode: "daily_input_submission_quota_exceeded",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Daily input submissions"
  },
  authenticated_caller_api_requests_per_calendar_month: {
    category: "product",
    unit: "requests",
    operationKinds: MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS,
    windowKind: "calendar_month",
    resetRule: "fixed_window_end",
    reason:
      "Monthly caller API request limit reached; cleanup operations remain available.",
    reasonCode: "monthly_caller_api_quota_exceeded",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Monthly caller API requests"
  },
  queued_input_items: {
    category: "product",
    unit: "items",
    operationKinds: ["input_submission"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Queued input item limit reached; delete pending items or acknowledge outputs to free queue space.",
    reasonCode: "queued_input_item_limit_exceeded",
    errorCode: "storage_limit_exceeded",
    statusLabel: "Queued input items"
  },
  input_retention_days: {
    category: "cleanup",
    unit: "days",
    operationKinds: ["cleanup"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Pending input reached the hosted-free retention window and is eligible for cleanup.",
    reasonCode: "pending_input_retention_expired",
    errorCode: "retention_limit_exceeded",
    statusLabel: "Pending input retention"
  },
  unacknowledged_output_timeout_days: {
    category: "cleanup",
    unit: "days",
    operationKinds: ["cleanup", "output_ack"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Unacknowledged output reached the timeout window and is eligible for cleanup.",
    reasonCode: "unacknowledged_output_timeout_expired",
    errorCode: "retention_limit_exceeded",
    statusLabel: "Unacknowledged output timeout"
  },
  downgrade_grace_days: {
    category: "billing",
    unit: "days",
    operationKinds: ["billing", "cleanup"],
    resetRule: "billing_grace_end",
    reason:
      "Billing or downgrade grace expired; current tier limits now apply.",
    reasonCode: "downgrade_grace_expired",
    errorCode: "billing_grace_expired",
    statusLabel: "Downgrade grace"
  },
  file_upload_enabled: {
    category: "product",
    unit: "boolean",
    operationKinds: ["file_upload", "input_submission"],
    resetRule: "not_applicable",
    reason: "File uploads require a paid hosted account.",
    reasonCode: "file_upload_upgrade_required",
    errorCode: "upgrade_required",
    statusLabel: "File uploads"
  },
  input_request_body_bytes_excluding_files: {
    category: "runtime",
    unit: "bytes",
    operationKinds: ["input_submission"],
    resetRule: "not_applicable",
    reason: "Input request body exceeds the accepted byte ceiling.",
    reasonCode: "input_request_too_large",
    errorCode: "request_too_large",
    statusLabel: "Input request body bytes"
  },
  human_answer_request_body_bytes_excluding_files: {
    category: "runtime",
    unit: "bytes",
    operationKinds: ["human_answer_submission"],
    resetRule: "not_applicable",
    reason: "Human answer request body exceeds the accepted byte ceiling.",
    reasonCode: "human_answer_request_too_large",
    errorCode: "request_too_large",
    statusLabel: "Human answer request body bytes"
  },
  stored_non_file_queue_payload_bytes: {
    category: "product",
    unit: "bytes",
    operationKinds: [
      "storage_write",
      "input_submission",
      "human_answer_submission"
    ],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Stored non-file queue payload byte limit reached; delete or acknowledge queue data to free storage.",
    reasonCode: "stored_non_file_payload_limit_exceeded",
    errorCode: "storage_limit_exceeded",
    statusLabel: "Stored non-file queue bytes"
  },
  overall_stored_account_data_bytes: {
    category: "product",
    unit: "bytes",
    operationKinds: [
      "storage_write",
      "input_submission",
      "human_answer_submission",
      "file_upload"
    ],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Stored account data byte limit reached; delete or acknowledge data to free storage.",
    reasonCode: "overall_stored_account_data_limit_exceeded",
    errorCode: "storage_limit_exceeded",
    statusLabel: "Overall stored account bytes"
  },
  uploaded_bytes_per_file: {
    category: "runtime",
    unit: "bytes",
    operationKinds: ["file_upload"],
    resetRule: "not_applicable",
    reason: "Uploaded file exceeds the raw byte ceiling.",
    reasonCode: "uploaded_file_too_large",
    errorCode: "request_too_large",
    statusLabel: "Uploaded bytes per file"
  },
  burst_input_submissions_per_account_per_minute: {
    category: "runtime",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Input submissions are temporarily rate limited.",
    reasonCode: "input_submission_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Input submission burst rate"
  },
  concurrent_write_requests_per_account: {
    category: "runtime",
    unit: "concurrent_requests",
    operationKinds: ["input_submission", "human_answer_submission"],
    resetRule: "cleanup_or_storage_free",
    reason: "Too many concurrent account write requests are in progress.",
    reasonCode: "concurrent_write_limit_exceeded",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Concurrent write requests"
  },
  concurrent_file_uploading_requests_per_account: {
    category: "runtime",
    unit: "concurrent_requests",
    operationKinds: ["file_upload"],
    resetRule: "cleanup_or_storage_free",
    reason: "Too many concurrent file-upload requests are in progress.",
    reasonCode: "concurrent_file_upload_limit_exceeded",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Concurrent file uploads"
  },
  input_send_replace_requests_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["input_send_replace"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Input send/replace requests are temporarily rate limited.",
    reasonCode: "input_send_replace_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Input send/replace request rate"
  },
  input_delete_requests_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["input_delete"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Input delete requests are temporarily rate limited.",
    reasonCode: "input_delete_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Input delete request rate"
  },
  output_check_read_requests_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["output_check_read"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Output check/read requests are temporarily rate limited.",
    reasonCode: "output_check_read_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Output check/read request rate"
  },
  output_file_download_requests_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["output_file_download"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Output file downloads are temporarily rate limited.",
    reasonCode: "output_file_download_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Output file download request rate"
  },
  output_ack_requests_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["output_ack"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Output acknowledgements are temporarily rate limited.",
    reasonCode: "output_ack_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Output acknowledgement request rate"
  },
  caller_connect_approvals_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect approvals are temporarily rate limited.",
    reasonCode: "caller_connect_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect approval request rate"
  },
  caller_rotate_approvals_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate approvals are temporarily rate limited.",
    reasonCode: "caller_rotate_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate approval request rate"
  },
  caller_revoke_approvals_per_account_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke approvals are temporarily rate limited.",
    reasonCode: "caller_revoke_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke approval request rate"
  },
  caller_connect_start_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect start requests are temporarily rate limited.",
    reasonCode: "caller_connect_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect start request rate"
  },
  caller_connect_poll_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect device polling is temporarily rate limited.",
    reasonCode: "caller_connect_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect poll request rate"
  },
  caller_connect_exchange_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_exchange"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect exchange requests are temporarily rate limited.",
    reasonCode: "caller_connect_exchange_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect exchange request rate"
  },
  caller_connect_activation_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_activation"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect activation requests are temporarily rate limited.",
    reasonCode: "caller_connect_activation_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect activation request rate"
  },
  caller_rotate_start_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate start requests are temporarily rate limited.",
    reasonCode: "caller_rotate_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate start request rate"
  },
  caller_rotate_poll_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate device polling is temporarily rate limited.",
    reasonCode: "caller_rotate_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate poll request rate"
  },
  caller_rotate_exchange_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_exchange"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate exchange requests are temporarily rate limited.",
    reasonCode: "caller_rotate_exchange_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate exchange request rate"
  },
  caller_rotate_activation_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_activation"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate activation requests are temporarily rate limited.",
    reasonCode: "caller_rotate_activation_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate activation request rate"
  },
  caller_revoke_start_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke start requests are temporarily rate limited.",
    reasonCode: "caller_revoke_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke start request rate"
  },
  caller_revoke_poll_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke device polling is temporarily rate limited.",
    reasonCode: "caller_revoke_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke poll request rate"
  },
  caller_revoke_confirm_requests_per_ip_per_minute: {
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_confirm"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke confirmation requests are temporarily rate limited.",
    reasonCode: "caller_revoke_confirm_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke confirmation request rate"
  }
} as const satisfies Record<string, LimitDefinition<string>>;

export type LimitName = keyof typeof LIMIT_DEFINITIONS;
export type LimitReasonCode =
  (typeof LIMIT_DEFINITIONS)[LimitName]["reasonCode"];

const LIMIT_NAMES = Object.keys(LIMIT_DEFINITIONS) as LimitName[];

const SHARED_LIMITS = {
  unacknowledged_output_timeout_days: enabled(
    SYSTEM_CONTRACT.unacknowledgedOutputTimeoutDays
  ),
  input_request_body_bytes_excluding_files: enabled(
    SYSTEM_CONTRACT.inputSubmissionBodyBytes
  ),
  human_answer_request_body_bytes_excluding_files: enabled(
    SYSTEM_CONTRACT.humanAnswerResponseBodyBytes
  ),
  burst_input_submissions_per_account_per_minute: enabled(120),
  concurrent_write_requests_per_account: enabled(20),
  concurrent_file_uploading_requests_per_account: enabled(5),
  input_send_replace_requests_per_account_per_minute: enabled(600),
  input_delete_requests_per_account_per_minute: enabled(600),
  output_check_read_requests_per_account_per_minute: enabled(120),
  output_file_download_requests_per_account_per_minute: enabled(60),
  output_ack_requests_per_account_per_minute: enabled(600),
  caller_connect_approvals_per_account_per_minute: enabled(30),
  caller_rotate_approvals_per_account_per_minute: enabled(30),
  caller_revoke_approvals_per_account_per_minute: enabled(30),
  caller_connect_start_requests_per_ip_per_minute: enabled(30),
  caller_connect_poll_requests_per_ip_per_minute: enabled(30),
  caller_connect_exchange_requests_per_ip_per_minute: enabled(30),
  caller_connect_activation_requests_per_ip_per_minute: enabled(30),
  caller_rotate_start_requests_per_ip_per_minute: enabled(30),
  caller_rotate_poll_requests_per_ip_per_minute: enabled(30),
  caller_rotate_exchange_requests_per_ip_per_minute: enabled(30),
  caller_rotate_activation_requests_per_ip_per_minute: enabled(30),
  caller_revoke_start_requests_per_ip_per_minute: enabled(30),
  caller_revoke_poll_requests_per_ip_per_minute: enabled(30),
  caller_revoke_confirm_requests_per_ip_per_minute: enabled(30)
} satisfies Partial<Record<LimitName, LimitSetting>>;

const HOSTED_FREE_LIMITS = {
  ...SHARED_LIMITS,
  input_submissions_per_calendar_month: enabled(5_000),
  input_submissions_per_day: enabled(1_000),
  authenticated_caller_api_requests_per_calendar_month: enabled(100_000),
  queued_input_items: enabled(1_000),
  input_retention_days: enabled(60),
  downgrade_grace_days: notApplicable("free_tier_not_billed"),
  file_upload_enabled: disabled("file_upload_disabled"),
  stored_non_file_queue_payload_bytes: enabled(32_000_000),
  overall_stored_account_data_bytes: notApplicable(
    "free_tier_uses_non_file_storage_cap"
  ),
  uploaded_bytes_per_file: disabled("file_upload_disabled")
} satisfies Record<LimitName, LimitSetting>;

const HOSTED_PAID_LIMITS = {
  ...SHARED_LIMITS,
  input_submissions_per_calendar_month: disabled("paid_tier_unlimited"),
  input_submissions_per_day: disabled("paid_tier_unlimited"),
  authenticated_caller_api_requests_per_calendar_month: disabled(
    "paid_tier_unlimited"
  ),
  queued_input_items: disabled("paid_tier_unlimited"),
  input_retention_days: disabled("paid_tier_no_retention_cleanup"),
  downgrade_grace_days: enabled(SYSTEM_CONTRACT.billingDowngradeGraceDays),
  file_upload_enabled: enabled(1),
  stored_non_file_queue_payload_bytes: disabled(
    "paid_tier_uses_overall_storage_cap"
  ),
  overall_stored_account_data_bytes: enabled(1_000_000_000),
  uploaded_bytes_per_file: enabled(SYSTEM_CONTRACT.rawFileBytes)
} satisfies Record<LimitName, LimitSetting>;

const SELF_HOSTED_LIMITS = {
  ...HOSTED_PAID_LIMITS,
  downgrade_grace_days: notApplicable("self_hosted_no_stripe_billing")
} satisfies Record<LimitName, LimitSetting>;

export const LIMIT_PROFILES = {
  "hosted-free": {
    profileId: "hosted-free",
    label: "Hosted Free",
    hosted: true,
    effectiveTier: "free",
    billing: {
      stripeBillingState: "not_applicable"
    },
    limits: HOSTED_FREE_LIMITS
  },
  "hosted-paid": {
    profileId: "hosted-paid",
    label: "Hosted Paid",
    hosted: true,
    effectiveTier: "paid",
    billing: {
      stripeBillingState: "required"
    },
    limits: HOSTED_PAID_LIMITS
  },
  "self-hosted": {
    profileId: "self-hosted",
    label: "Self-Hosted",
    hosted: false,
    effectiveTier: "paid",
    billing: {
      stripeBillingState: "not_applicable"
    },
    limits: SELF_HOSTED_LIMITS
  }
} as const satisfies Record<LimitProfileId, LimitProfile>;

export function getLimitProfile(selector: LimitProfileSelector): LimitProfile {
  return LIMIT_PROFILES[selector];
}

export function isLimitName(value: string): value is LimitName {
  return Object.hasOwn(LIMIT_DEFINITIONS, value);
}

export function getLimitDefinition(limitName: LimitName): LimitDefinition {
  return LIMIT_DEFINITIONS[limitName];
}

export function limitProfileSelectorForAccountTier(
  tier: AccountTier | null | undefined
): LimitProfileSelector | null {
  if (tier === "hosted_paid") {
    return "hosted-paid";
  }
  if (tier === "self_hosted") {
    return "self-hosted";
  }
  if (tier === "hosted_free") {
    return "hosted-free";
  }
  return null;
}

export function accountLimitStatusMetadata(
  selector: LimitProfileSelector
): AccountLimitStatusMetadata {
  const profile = getLimitProfile(selector);

  return {
    profileId: profile.profileId,
    label: profile.label,
    hosted: profile.hosted,
    effectiveTier: profile.effectiveTier,
    stripeBillingState: profile.billing.stripeBillingState,
    fileUploadEnabled: fileUploadEnabled(profile.profileId),
    limits: LIMIT_NAMES.map((limitName) => {
      return limitStatusMetadata(profile.profileId, limitName);
    })
  };
}

export function limitStatusMetadata(
  selector: LimitProfileSelector,
  limitName: LimitName
): LimitStatusMetadata {
  const profile = getLimitProfile(selector);
  const definition = getLimitDefinition(limitName);

  return {
    profileId: profile.profileId,
    limitName,
    statusLabel: definition.statusLabel,
    category: definition.category,
    unit: definition.unit,
    operationKinds: definition.operationKinds,
    windowKind: definition.windowKind ?? null,
    resetRule: definition.resetRule,
    setting: profile.limits[limitName],
    reasonCode: definition.reasonCode
  };
}

export function limitErrorMetadata(
  selector: LimitProfileSelector,
  limitName: LimitName,
  options: {
    usedUnits?: number | null;
    limitResetsAt?: Date | null;
  } = {}
): LimitErrorMetadata {
  const profile = getLimitProfile(selector);
  const definition = getLimitDefinition(limitName);
  const setting = profile.limits[limitName];

  return {
    status: httpStatusForLimit(definition),
    code: definition.errorCode,
    limitName,
    limitReasonCode: definition.reasonCode,
    limitReason: definition.reason,
    limitResetsAt: normalizeOptionalUtcTimestamp(options.limitResetsAt),
    usedUnits: options.usedUnits ?? null,
    limitUnits: setting.mode === "enabled" ? setting.value : null,
    unit: definition.unit
  };
}

export function storageLimitName(
  selector: LimitProfileSelector
): "stored_non_file_queue_payload_bytes" | "overall_stored_account_data_bytes" {
  return getLimitProfile(selector).effectiveTier === "free"
    ? "stored_non_file_queue_payload_bytes"
    : "overall_stored_account_data_bytes";
}

export function fileUploadEnabled(selector: LimitProfileSelector) {
  const setting = getLimitProfile(selector).limits.file_upload_enabled;

  return setting.mode === "enabled" && setting.value === 1;
}

export function fixedWindowLimitNames(): readonly LimitName[] {
  return LIMIT_NAMES.filter((limitName) => {
    return Boolean(getLimitDefinition(limitName).windowKind);
  });
}

export function quotaWindowStartUtc(windowKind: LimitWindowKind, at: Date) {
  const start = new Date(at.getTime());
  start.setUTCSeconds(0, 0);
  if (windowKind === "day" || windowKind === "calendar_month") {
    start.setUTCHours(0, 0, 0, 0);
  }
  if (windowKind === "calendar_month") {
    start.setUTCDate(1);
  }
  return start;
}

function enabled(value: number): EnabledLimit {
  return { mode: "enabled", value };
}

function disabled(disabledReason: LimitDisabledReason): DisabledLimit {
  return { mode: "disabled", disabledReason };
}

function notApplicable(
  notApplicableReason: LimitNotApplicableReason
): NotApplicableLimit {
  return { mode: "not_applicable", notApplicableReason };
}

function httpStatusForLimit(definition: LimitDefinition) {
  if (definition.errorCode === "request_too_large") {
    return 413;
  }

  if (
    definition.errorCode === "upgrade_required" ||
    definition.errorCode === "billing_grace_expired"
  ) {
    return 402;
  }

  return 429;
}

function normalizeOptionalUtcTimestamp(value: Date | null | undefined) {
  if (!value) {
    return null;
  }

  return value.toISOString();
}
