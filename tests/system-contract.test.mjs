import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonc,
  readSystemContract,
  renderGeneratedGoSystemContract,
  stripJsonComments,
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
    hostedWebsiteBaseUrl: "https://agent-outbox.dev",
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

test("JSONC comment stripping preserves comment-like text in strings", () => {
  const jsonc = String.raw`{
    // line comment
    "url": "https://app.agent-outbox.dev/path/*literal*/",
    "quoted": "escaped quote: \" // still a string",
    /* block
       comment */
    "enabled": true
  }`;

  assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), {
    url: "https://app.agent-outbox.dev/path/*literal*/",
    quoted: 'escaped quote: " // still a string',
    enabled: true
  });
  assert.throws(
    () => stripJsonComments('{ "enabled": true /* unterminated'),
    /Unterminated JSONC block comment/
  );
  assert.deepEqual(
    parseJsonc(`{
      // comment
      "routes": [{ "custom_domain": true, "pattern": "app.example" }],
      "triggers": { "crons": ["17 * * * *"] },
    }`),
    {
      routes: [{ custom_domain: true, pattern: "app.example" }],
      triggers: { crons: ["17 * * * *"] }
    }
  );
});

test("both system-contract readers reject invalid schema and invariants", () => {
  const valid = {
    hosted_app_base_url: "https://app.agent-outbox.dev",
    hosted_website_base_url: "https://agent-outbox.dev",
    scheduled_cleanup_cron: "17 * * * *",
    input_submission_body_bytes: 128_000,
    human_answer_response_body_bytes: 128_000,
    raw_file_bytes: 32_000_000,
    output_page_default_limit: 25,
    output_page_max_limit: 100,
    control_plane_setup_code_expiry_seconds: 600,
    default_device_poll_interval_seconds: 5,
    unacknowledged_output_timeout_days: 14,
    billing_downgrade_grace_days: 7
  };

  const invalidPagination = { ...valid, output_page_default_limit: 101 };
  assert.throws(() => validateSystemContract(invalidPagination));
  assert.throws(() => validateTypeScriptSystemContract(invalidPagination));
  assert.throws(() => validateSystemContract({ ...valid, extra: true }));
  assert.throws(() =>
    validateTypeScriptSystemContract({ ...valid, extra: true })
  );
  const insecure = {
    ...valid,
    hosted_app_base_url: "http://app.agent-outbox.dev"
  };
  assert.throws(() => validateSystemContract(insecure));
  assert.throws(() => validateTypeScriptSystemContract(insecure));
  const overlappingOrigins = {
    ...valid,
    hosted_website_base_url: valid.hosted_app_base_url
  };
  assert.throws(() => validateSystemContract(overlappingOrigins));
  assert.throws(() => validateTypeScriptSystemContract(overlappingOrigins));

  const impossiblePolling = {
    ...valid,
    control_plane_setup_code_expiry_seconds: 4
  };
  assert.throws(() => validateSystemContract(impossiblePolling));
  assert.throws(() => validateTypeScriptSystemContract(impossiblePolling));

  const pollingAboveDatabaseMaximum = {
    ...valid,
    control_plane_setup_code_expiry_seconds: 3601,
    default_device_poll_interval_seconds: 3601
  };
  assert.throws(
    () => validateSystemContract(pollingAboveDatabaseMaximum),
    /must not exceed 3600/
  );
  assert.throws(
    () => validateTypeScriptSystemContract(pollingAboveDatabaseMaximum),
    /must not exceed 3600/
  );
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

  const changedPollIntervalFailures = systemContractDriftFailures({
    ...contract,
    defaultDevicePollIntervalSeconds:
      contract.defaultDevicePollIntervalSeconds + 1
  });
  assert.ok(changedPollIntervalFailures.length > 0);
  assert.ok(
    changedPollIntervalFailures.every(
      (failure) =>
        !failure.includes(
          "db/migrations/V20260702000000__caller_setup_requests.sql"
        )
    )
  );
});
