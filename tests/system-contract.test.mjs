import assert from "node:assert/strict";
import test from "node:test";

import {
  readSystemContract,
  renderGeneratedGoSystemContract,
  systemContractDriftFailures,
  validateSystemContract
} from "../scripts/system-contract.mjs";
import {
  SYSTEM_CONTRACT,
  validateSystemContract as validateTypeScriptSystemContract
} from "../src/shared/system-contract.ts";

test("system contract has the approved stable external values", () => {
  assert.deepEqual(SYSTEM_CONTRACT, {
    hostedAppBaseUrl: "https://app.agent-outbox.dev",
    scheduledCleanupCron: "17 * * * *",
    inputSubmissionBodyBytes: 128_000,
    humanAnswerResponseBodyBytes: 128_000,
    rawFileBytes: 32_000_000,
    outputPageDefaultLimit: 25,
    outputPageMaxLimit: 100,
    controlPlaneSetupCodeExpirySeconds: 600,
    defaultDevicePollIntervalSeconds: 5,
    unacknowledgedOutputTimeoutDays: 14,
    billingDowngradeGraceDays: 7
  });
  assert.ok(Object.isFrozen(SYSTEM_CONTRACT));
});

test("both system-contract readers reject invalid schema and invariants", () => {
  const invalid = {
    hosted_app_base_url: "https://app.agent-outbox.dev",
    scheduled_cleanup_cron: "17 * * * *",
    input_submission_body_bytes: 128_000,
    human_answer_response_body_bytes: 128_000,
    raw_file_bytes: 32_000_000,
    output_page_default_limit: 101,
    output_page_max_limit: 100,
    control_plane_setup_code_expiry_seconds: 600,
    default_device_poll_interval_seconds: 5,
    unacknowledged_output_timeout_days: 14,
    billing_downgrade_grace_days: 7
  };

  assert.throws(() => validateSystemContract(invalid));
  assert.throws(() => validateTypeScriptSystemContract(invalid));
  assert.throws(() => validateSystemContract({ ...invalid, extra: true }));
  assert.throws(() =>
    validateTypeScriptSystemContract({ ...invalid, extra: true })
  );
  const insecure = {
    ...invalid,
    hosted_app_base_url: "http://app.agent-outbox.dev",
    output_page_default_limit: 25
  };
  assert.throws(() => validateSystemContract(insecure));
  assert.throws(() => validateTypeScriptSystemContract(insecure));

  const impossiblePolling = {
    ...invalid,
    output_page_default_limit: 25,
    control_plane_setup_code_expiry_seconds: 4
  };
  assert.throws(() => validateSystemContract(impossiblePolling));
  assert.throws(() => validateTypeScriptSystemContract(impossiblePolling));
});

test("generated Go contract is deterministic and all selected consumers remain aligned", () => {
  const contract = readSystemContract();
  assert.match(
    renderGeneratedGoSystemContract(contract),
    /SystemContractRawFileBytes\s+= 32000000/
  );
  assert.deepEqual(systemContractDriftFailures(contract), []);

  const changedContract = {
    ...contract,
    hostedAppBaseUrl: "https://replacement.example",
    rawFileBytes: contract.rawFileBytes + 1
  };
  const failures = systemContractDriftFailures(changedContract);
  assert.ok(
    failures.some((failure) => failure.includes("generated.go is stale"))
  );
  assert.ok(
    failures.some((failure) => failure.includes("wrangler.jsonc routes"))
  );
  assert.ok(
    failures.some((failure) => failure.includes("docs/spec/input-schema.md"))
  );
});
