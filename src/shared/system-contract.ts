import rawSystemContract from "../../system-contract.json" with { type: "json" };

export type SystemContract = Readonly<{
  hostedAppBaseUrl: string;
  scheduledCleanupCron: string;
  inputSubmissionBodyBytes: number;
  humanAnswerResponseBodyBytes: number;
  rawFileBytes: number;
  outputPageDefaultLimit: number;
  outputPageMaxLimit: number;
  controlPlaneSetupCodeExpirySeconds: number;
  defaultDevicePollIntervalSeconds: number;
  unacknowledgedOutputTimeoutDays: number;
  billingDowngradeGraceDays: number;
}>;

const SYSTEM_CONTRACT_JSON_FIELDS = [
  "billing_downgrade_grace_days",
  "control_plane_setup_code_expiry_seconds",
  "default_device_poll_interval_seconds",
  "hosted_app_base_url",
  "human_answer_response_body_bytes",
  "input_submission_body_bytes",
  "output_page_default_limit",
  "output_page_max_limit",
  "raw_file_bytes",
  "scheduled_cleanup_cron",
  "unacknowledged_output_timeout_days"
] as const;
const MAX_DEVICE_POLL_INTERVAL_SECONDS = 3600;

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `system-contract.json ${name} must be a positive safe integer.`
    );
  }
  const numericValue = value as number;
  if (numericValue <= 0) {
    throw new TypeError(
      `system-contract.json ${name} must be a positive safe integer.`
    );
  }
  return numericValue;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `system-contract.json ${name} must be a non-empty string.`
    );
  }
  return value;
}

export function validateSystemContract(value: unknown): SystemContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("system-contract.json must contain an object.");
  }

  const contract = value as Record<string, unknown>;
  const actualFields = Object.keys(contract).sort();
  if (
    actualFields.length !== SYSTEM_CONTRACT_JSON_FIELDS.length ||
    actualFields.some(
      (field, index) => field !== SYSTEM_CONTRACT_JSON_FIELDS[index]
    )
  ) {
    throw new TypeError("system-contract.json fields must be exact.");
  }
  const hostedAppBaseUrl = nonEmptyString(
    contract.hosted_app_base_url,
    "hosted_app_base_url"
  );
  try {
    const url = new URL(hostedAppBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      hostedAppBaseUrl !== url.origin
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(
      "system-contract.json hosted_app_base_url must be an absolute HTTPS origin without credentials or a trailing slash."
    );
  }

  const outputPageDefaultLimit = positiveSafeInteger(
    contract.output_page_default_limit,
    "output_page_default_limit"
  );
  const outputPageMaxLimit = positiveSafeInteger(
    contract.output_page_max_limit,
    "output_page_max_limit"
  );
  if (outputPageDefaultLimit > outputPageMaxLimit) {
    throw new RangeError(
      "system-contract.json output_page_default_limit must not exceed output_page_max_limit."
    );
  }

  const controlPlaneSetupCodeExpirySeconds = positiveSafeInteger(
    contract.control_plane_setup_code_expiry_seconds,
    "control_plane_setup_code_expiry_seconds"
  );
  const defaultDevicePollIntervalSeconds = positiveSafeInteger(
    contract.default_device_poll_interval_seconds,
    "default_device_poll_interval_seconds"
  );
  if (defaultDevicePollIntervalSeconds > MAX_DEVICE_POLL_INTERVAL_SECONDS) {
    throw new RangeError(
      `system-contract.json default_device_poll_interval_seconds must not exceed ${MAX_DEVICE_POLL_INTERVAL_SECONDS}.`
    );
  }
  if (defaultDevicePollIntervalSeconds > controlPlaneSetupCodeExpirySeconds) {
    throw new RangeError(
      "system-contract.json default_device_poll_interval_seconds must not exceed control_plane_setup_code_expiry_seconds."
    );
  }

  return Object.freeze({
    hostedAppBaseUrl,
    scheduledCleanupCron: nonEmptyString(
      contract.scheduled_cleanup_cron,
      "scheduled_cleanup_cron"
    ),
    inputSubmissionBodyBytes: positiveSafeInteger(
      contract.input_submission_body_bytes,
      "input_submission_body_bytes"
    ),
    humanAnswerResponseBodyBytes: positiveSafeInteger(
      contract.human_answer_response_body_bytes,
      "human_answer_response_body_bytes"
    ),
    rawFileBytes: positiveSafeInteger(
      contract.raw_file_bytes,
      "raw_file_bytes"
    ),
    outputPageDefaultLimit,
    outputPageMaxLimit,
    controlPlaneSetupCodeExpirySeconds,
    defaultDevicePollIntervalSeconds,
    unacknowledgedOutputTimeoutDays: positiveSafeInteger(
      contract.unacknowledged_output_timeout_days,
      "unacknowledged_output_timeout_days"
    ),
    billingDowngradeGraceDays: positiveSafeInteger(
      contract.billing_downgrade_grace_days,
      "billing_downgrade_grace_days"
    )
  });
}

export const SYSTEM_CONTRACT = validateSystemContract(rawSystemContract);
