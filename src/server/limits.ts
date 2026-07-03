export const LIMIT_NAMES = [
  "input_submissions_per_calendar_month",
  "input_submissions_per_day",
  "authenticated_caller_api_requests_per_calendar_month",
  "queued_input_items",
  "input_retention_days",
  "unacknowledged_output_timeout_days",
  "downgrade_grace_days",
  "file_upload_enabled",
  "input_request_body_bytes_excluding_files",
  "human_answer_request_body_bytes_excluding_files",
  "stored_non_file_queue_payload_bytes",
  "overall_stored_account_data_bytes",
  "uploaded_bytes_per_file",
  "burst_input_submissions_per_account_per_minute",
  "concurrent_write_requests_per_account",
  "concurrent_file_uploading_requests_per_account",
  "output_check_read_requests_per_account_per_minute",
  "output_ack_requests_per_account_per_minute",
  "caller_connect_approvals_per_account_per_minute",
  "caller_rotate_approvals_per_account_per_minute",
  "caller_revoke_approvals_per_account_per_minute",
  "caller_connect_start_requests_per_ip_per_minute",
  "caller_connect_poll_requests_per_ip_per_minute",
  "caller_connect_exchange_requests_per_ip_per_minute",
  "caller_connect_activation_requests_per_ip_per_minute",
  "caller_rotate_start_requests_per_ip_per_minute",
  "caller_rotate_poll_requests_per_ip_per_minute",
  "caller_rotate_exchange_requests_per_ip_per_minute",
  "caller_rotate_activation_requests_per_ip_per_minute",
  "caller_revoke_start_requests_per_ip_per_minute",
  "caller_revoke_poll_requests_per_ip_per_minute",
  "caller_revoke_confirm_requests_per_ip_per_minute"
] as const;

export type LimitName = (typeof LIMIT_NAMES)[number];

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
  "input_submission",
  "output_check_read",
  "output_file_download",
  "status"
] as const satisfies readonly LimitOperationKind[];

export type LimitReasonCode =
  | "monthly_input_submission_quota_exceeded"
  | "daily_input_submission_quota_exceeded"
  | "monthly_caller_api_quota_exceeded"
  | "queued_input_item_limit_exceeded"
  | "pending_input_retention_expired"
  | "unacknowledged_output_timeout_expired"
  | "downgrade_grace_expired"
  | "file_upload_upgrade_required"
  | "input_request_too_large"
  | "human_answer_request_too_large"
  | "stored_non_file_payload_limit_exceeded"
  | "overall_stored_account_data_limit_exceeded"
  | "uploaded_file_too_large"
  | "input_submission_rate_limited"
  | "concurrent_write_limit_exceeded"
  | "concurrent_file_upload_limit_exceeded"
  | "output_check_read_rate_limited"
  | "output_ack_rate_limited"
  | "caller_connect_approval_rate_limited"
  | "caller_rotate_approval_rate_limited"
  | "caller_revoke_approval_rate_limited"
  | "caller_connect_start_rate_limited"
  | "caller_connect_poll_rate_limited"
  | "caller_connect_exchange_rate_limited"
  | "caller_connect_activation_rate_limited"
  | "caller_rotate_start_rate_limited"
  | "caller_rotate_poll_rate_limited"
  | "caller_rotate_exchange_rate_limited"
  | "caller_rotate_activation_rate_limited"
  | "caller_revoke_start_rate_limited"
  | "caller_revoke_poll_rate_limited"
  | "caller_revoke_confirm_rate_limited";
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

export type LimitDefinition = {
  name: LimitName;
  category: LimitCategory;
  unit: LimitUnit;
  operationKinds: readonly LimitOperationKind[];
  windowKind?: LimitWindowKind;
  resetRule: LimitResetRule;
  reasonCode: LimitReasonCode;
  reason: string;
  errorCode: LimitErrorCode;
  statusLabel: string;
  doctorCheckName: string;
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

export type DoctorLimitMetadata = {
  checkName: string;
  profileId: LimitProfileId;
  limitName: LimitName;
  operationKinds: readonly LimitOperationKind[];
  mode: LimitSetting["mode"];
  configured: true;
  reasonCode: LimitReasonCode;
};

const LIMIT_DEFINITIONS: Readonly<Record<LimitName, LimitDefinition>> = {
  input_submissions_per_calendar_month: {
    name: "input_submissions_per_calendar_month",
    category: "product",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "calendar_month",
    resetRule: "fixed_window_end",
    reasonCode: "monthly_input_submission_quota_exceeded",
    reason:
      "Monthly input submission limit reached; wait for the next UTC calendar month or upgrade.",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Monthly input submissions",
    doctorCheckName: "limits.input_submissions.calendar_month"
  },
  input_submissions_per_day: {
    name: "input_submissions_per_day",
    category: "product",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "day",
    resetRule: "fixed_window_end",
    reason:
      "Daily input submission limit reached; wait for the next UTC day or upgrade.",
    reasonCode: "daily_input_submission_quota_exceeded",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Daily input submissions",
    doctorCheckName: "limits.input_submissions.day"
  },
  authenticated_caller_api_requests_per_calendar_month: {
    name: "authenticated_caller_api_requests_per_calendar_month",
    category: "product",
    unit: "requests",
    operationKinds: MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS,
    windowKind: "calendar_month",
    resetRule: "fixed_window_end",
    reason:
      "Monthly caller API request limit reached; cleanup operations remain available.",
    reasonCode: "monthly_caller_api_quota_exceeded",
    errorCode: "quota_limit_exceeded",
    statusLabel: "Monthly caller API requests",
    doctorCheckName: "limits.caller_api.calendar_month"
  },
  queued_input_items: {
    name: "queued_input_items",
    category: "product",
    unit: "items",
    operationKinds: ["input_submission"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Queued input item limit reached; delete pending items or acknowledge outputs to free queue space.",
    reasonCode: "queued_input_item_limit_exceeded",
    errorCode: "storage_limit_exceeded",
    statusLabel: "Queued input items",
    doctorCheckName: "limits.queued_input_items"
  },
  input_retention_days: {
    name: "input_retention_days",
    category: "cleanup",
    unit: "days",
    operationKinds: ["cleanup"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Pending input reached the hosted-free retention window and is eligible for cleanup.",
    reasonCode: "pending_input_retention_expired",
    errorCode: "retention_limit_exceeded",
    statusLabel: "Pending input retention",
    doctorCheckName: "limits.input_retention"
  },
  unacknowledged_output_timeout_days: {
    name: "unacknowledged_output_timeout_days",
    category: "cleanup",
    unit: "days",
    operationKinds: ["cleanup", "output_ack"],
    resetRule: "cleanup_or_storage_free",
    reason:
      "Unacknowledged output reached the timeout window and is eligible for cleanup.",
    reasonCode: "unacknowledged_output_timeout_expired",
    errorCode: "retention_limit_exceeded",
    statusLabel: "Unacknowledged output timeout",
    doctorCheckName: "limits.output_timeout"
  },
  downgrade_grace_days: {
    name: "downgrade_grace_days",
    category: "billing",
    unit: "days",
    operationKinds: ["billing", "cleanup"],
    resetRule: "billing_grace_end",
    reason:
      "Billing or downgrade grace expired; current tier limits now apply.",
    reasonCode: "downgrade_grace_expired",
    errorCode: "billing_grace_expired",
    statusLabel: "Downgrade grace",
    doctorCheckName: "limits.billing_grace"
  },
  file_upload_enabled: {
    name: "file_upload_enabled",
    category: "product",
    unit: "boolean",
    operationKinds: ["file_upload", "input_submission"],
    resetRule: "not_applicable",
    reason: "File uploads require a paid hosted account.",
    reasonCode: "file_upload_upgrade_required",
    errorCode: "upgrade_required",
    statusLabel: "File uploads",
    doctorCheckName: "limits.file_uploads"
  },
  input_request_body_bytes_excluding_files: {
    name: "input_request_body_bytes_excluding_files",
    category: "runtime",
    unit: "bytes",
    operationKinds: ["input_submission"],
    resetRule: "not_applicable",
    reason: "Input request body exceeds the accepted byte ceiling.",
    reasonCode: "input_request_too_large",
    errorCode: "request_too_large",
    statusLabel: "Input request body bytes",
    doctorCheckName: "limits.input_request_bytes"
  },
  human_answer_request_body_bytes_excluding_files: {
    name: "human_answer_request_body_bytes_excluding_files",
    category: "runtime",
    unit: "bytes",
    operationKinds: ["human_answer_submission"],
    resetRule: "not_applicable",
    reason: "Human answer request body exceeds the accepted byte ceiling.",
    reasonCode: "human_answer_request_too_large",
    errorCode: "request_too_large",
    statusLabel: "Human answer request body bytes",
    doctorCheckName: "limits.human_answer_request_bytes"
  },
  stored_non_file_queue_payload_bytes: {
    name: "stored_non_file_queue_payload_bytes",
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
    statusLabel: "Stored non-file queue bytes",
    doctorCheckName: "limits.stored_non_file_queue_bytes"
  },
  overall_stored_account_data_bytes: {
    name: "overall_stored_account_data_bytes",
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
    statusLabel: "Overall stored account bytes",
    doctorCheckName: "limits.overall_stored_account_bytes"
  },
  uploaded_bytes_per_file: {
    name: "uploaded_bytes_per_file",
    category: "runtime",
    unit: "bytes",
    operationKinds: ["file_upload"],
    resetRule: "not_applicable",
    reason: "Uploaded file exceeds the raw byte ceiling.",
    reasonCode: "uploaded_file_too_large",
    errorCode: "request_too_large",
    statusLabel: "Uploaded bytes per file",
    doctorCheckName: "limits.uploaded_bytes_per_file"
  },
  burst_input_submissions_per_account_per_minute: {
    name: "burst_input_submissions_per_account_per_minute",
    category: "runtime",
    unit: "submissions",
    operationKinds: ["input_submission"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Input submissions are temporarily rate limited.",
    reasonCode: "input_submission_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Input submission burst rate",
    doctorCheckName: "limits.input_submission.minute"
  },
  concurrent_write_requests_per_account: {
    name: "concurrent_write_requests_per_account",
    category: "runtime",
    unit: "concurrent_requests",
    operationKinds: ["input_submission", "human_answer_submission"],
    resetRule: "cleanup_or_storage_free",
    reason: "Too many concurrent account write requests are in progress.",
    reasonCode: "concurrent_write_limit_exceeded",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Concurrent write requests",
    doctorCheckName: "limits.concurrent_writes"
  },
  concurrent_file_uploading_requests_per_account: {
    name: "concurrent_file_uploading_requests_per_account",
    category: "runtime",
    unit: "concurrent_requests",
    operationKinds: ["file_upload"],
    resetRule: "cleanup_or_storage_free",
    reason: "Too many concurrent file-upload requests are in progress.",
    reasonCode: "concurrent_file_upload_limit_exceeded",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Concurrent file uploads",
    doctorCheckName: "limits.concurrent_file_uploads"
  },
  output_check_read_requests_per_account_per_minute: {
    name: "output_check_read_requests_per_account_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["output_check_read"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Output check/read requests are temporarily rate limited.",
    reasonCode: "output_check_read_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Output check/read request rate",
    doctorCheckName: "limits.output_check_read.minute"
  },
  output_ack_requests_per_account_per_minute: {
    name: "output_ack_requests_per_account_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["output_ack"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Output acknowledgements are temporarily rate limited.",
    reasonCode: "output_ack_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Output acknowledgement request rate",
    doctorCheckName: "limits.output_ack.minute"
  },
  caller_connect_approvals_per_account_per_minute: {
    name: "caller_connect_approvals_per_account_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect approvals are temporarily rate limited.",
    reasonCode: "caller_connect_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect approval request rate",
    doctorCheckName: "limits.caller_connect_approval.minute"
  },
  caller_rotate_approvals_per_account_per_minute: {
    name: "caller_rotate_approvals_per_account_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate approvals are temporarily rate limited.",
    reasonCode: "caller_rotate_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate approval request rate",
    doctorCheckName: "limits.caller_rotate_approval.minute"
  },
  caller_revoke_approvals_per_account_per_minute: {
    name: "caller_revoke_approvals_per_account_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_approval"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke approvals are temporarily rate limited.",
    reasonCode: "caller_revoke_approval_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke approval request rate",
    doctorCheckName: "limits.caller_revoke_approval.minute"
  },
  caller_connect_start_requests_per_ip_per_minute: {
    name: "caller_connect_start_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect start requests are temporarily rate limited.",
    reasonCode: "caller_connect_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect start request rate",
    doctorCheckName: "limits.caller_connect_start.minute"
  },
  caller_connect_poll_requests_per_ip_per_minute: {
    name: "caller_connect_poll_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect device polling is temporarily rate limited.",
    reasonCode: "caller_connect_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect poll request rate",
    doctorCheckName: "limits.caller_connect_poll.minute"
  },
  caller_connect_exchange_requests_per_ip_per_minute: {
    name: "caller_connect_exchange_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_exchange"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect exchange requests are temporarily rate limited.",
    reasonCode: "caller_connect_exchange_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect exchange request rate",
    doctorCheckName: "limits.caller_connect_exchange.minute"
  },
  caller_connect_activation_requests_per_ip_per_minute: {
    name: "caller_connect_activation_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_connect_activation"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller connect activation requests are temporarily rate limited.",
    reasonCode: "caller_connect_activation_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller connect activation request rate",
    doctorCheckName: "limits.caller_connect_activation.minute"
  },
  caller_rotate_start_requests_per_ip_per_minute: {
    name: "caller_rotate_start_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate start requests are temporarily rate limited.",
    reasonCode: "caller_rotate_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate start request rate",
    doctorCheckName: "limits.caller_rotate_start.minute"
  },
  caller_rotate_poll_requests_per_ip_per_minute: {
    name: "caller_rotate_poll_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate device polling is temporarily rate limited.",
    reasonCode: "caller_rotate_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate poll request rate",
    doctorCheckName: "limits.caller_rotate_poll.minute"
  },
  caller_rotate_exchange_requests_per_ip_per_minute: {
    name: "caller_rotate_exchange_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_exchange"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate exchange requests are temporarily rate limited.",
    reasonCode: "caller_rotate_exchange_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate exchange request rate",
    doctorCheckName: "limits.caller_rotate_exchange.minute"
  },
  caller_rotate_activation_requests_per_ip_per_minute: {
    name: "caller_rotate_activation_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_rotate_activation"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller rotate activation requests are temporarily rate limited.",
    reasonCode: "caller_rotate_activation_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller rotate activation request rate",
    doctorCheckName: "limits.caller_rotate_activation.minute"
  },
  caller_revoke_start_requests_per_ip_per_minute: {
    name: "caller_revoke_start_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_start"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke start requests are temporarily rate limited.",
    reasonCode: "caller_revoke_start_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke start request rate",
    doctorCheckName: "limits.caller_revoke_start.minute"
  },
  caller_revoke_poll_requests_per_ip_per_minute: {
    name: "caller_revoke_poll_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_poll"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke device polling is temporarily rate limited.",
    reasonCode: "caller_revoke_poll_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke poll request rate",
    doctorCheckName: "limits.caller_revoke_poll.minute"
  },
  caller_revoke_confirm_requests_per_ip_per_minute: {
    name: "caller_revoke_confirm_requests_per_ip_per_minute",
    category: "runtime",
    unit: "requests",
    operationKinds: ["caller_revoke_confirm"],
    windowKind: "minute",
    resetRule: "fixed_window_end",
    reason: "Caller revoke confirmation requests are temporarily rate limited.",
    reasonCode: "caller_revoke_confirm_rate_limited",
    errorCode: "rate_limit_exceeded",
    statusLabel: "Caller revoke confirmation request rate",
    doctorCheckName: "limits.caller_revoke_confirm.minute"
  }
};

const HOSTED_FREE_LIMITS = {
  input_submissions_per_calendar_month: enabled(5_000),
  input_submissions_per_day: enabled(1_000),
  authenticated_caller_api_requests_per_calendar_month: enabled(100_000),
  queued_input_items: enabled(1_000),
  input_retention_days: enabled(60),
  unacknowledged_output_timeout_days: enabled(14),
  downgrade_grace_days: notApplicable("free_tier_not_billed"),
  file_upload_enabled: disabled("file_upload_disabled"),
  input_request_body_bytes_excluding_files: enabled(128_000),
  human_answer_request_body_bytes_excluding_files: enabled(128_000),
  stored_non_file_queue_payload_bytes: enabled(32_000_000),
  overall_stored_account_data_bytes: notApplicable(
    "free_tier_uses_non_file_storage_cap"
  ),
  uploaded_bytes_per_file: disabled("file_upload_disabled"),
  burst_input_submissions_per_account_per_minute: enabled(120),
  concurrent_write_requests_per_account: enabled(20),
  concurrent_file_uploading_requests_per_account: enabled(5),
  output_check_read_requests_per_account_per_minute: enabled(120),
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
} satisfies Record<LimitName, LimitSetting>;

const HOSTED_PAID_LIMITS = {
  input_submissions_per_calendar_month: disabled("paid_tier_unlimited"),
  input_submissions_per_day: disabled("paid_tier_unlimited"),
  authenticated_caller_api_requests_per_calendar_month: disabled(
    "paid_tier_unlimited"
  ),
  queued_input_items: disabled("paid_tier_unlimited"),
  input_retention_days: disabled("paid_tier_no_retention_cleanup"),
  unacknowledged_output_timeout_days: enabled(14),
  downgrade_grace_days: enabled(7),
  file_upload_enabled: enabled(1),
  input_request_body_bytes_excluding_files: enabled(128_000),
  human_answer_request_body_bytes_excluding_files: enabled(128_000),
  stored_non_file_queue_payload_bytes: disabled(
    "paid_tier_uses_overall_storage_cap"
  ),
  overall_stored_account_data_bytes: enabled(1_000_000_000),
  uploaded_bytes_per_file: enabled(32_000_000),
  burst_input_submissions_per_account_per_minute: enabled(120),
  concurrent_write_requests_per_account: enabled(20),
  concurrent_file_uploading_requests_per_account: enabled(5),
  output_check_read_requests_per_account_per_minute: enabled(120),
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

export function getLimitDefinition(limitName: LimitName) {
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
  const definition = LIMIT_DEFINITIONS[limitName];

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
  const definition = LIMIT_DEFINITIONS[limitName];
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

export function doctorLimitMetadata(
  selector: LimitProfileSelector
): readonly DoctorLimitMetadata[] {
  const profile = getLimitProfile(selector);

  return LIMIT_NAMES.map((limitName) => {
    const definition = LIMIT_DEFINITIONS[limitName];
    const setting = profile.limits[limitName];

    return {
      checkName: definition.doctorCheckName,
      profileId: profile.profileId,
      limitName,
      operationKinds: definition.operationKinds,
      mode: setting.mode,
      configured: true,
      reasonCode: definition.reasonCode
    };
  });
}

export function fileUploadEnabled(selector: LimitProfileSelector) {
  const setting = getLimitProfile(selector).limits.file_upload_enabled;

  return setting.mode === "enabled" && setting.value === 1;
}

export function fixedWindowLimitNames(): readonly LimitName[] {
  return LIMIT_NAMES.filter((limitName) => {
    return Boolean(LIMIT_DEFINITIONS[limitName].windowKind);
  });
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
