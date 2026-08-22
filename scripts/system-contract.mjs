import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = path.join(ROOT, "system-contract.json");
const GENERATED_GO_PATH = path.join(
  ROOT,
  "cli/internal/foundation/system_contract_generated.go"
);
const MAX_DEVICE_POLL_INTERVAL_SECONDS = 3600;

const REQUIRED_FIELDS = [
  "hosted_app_base_url",
  "hosted_website_base_url",
  "scheduled_cleanup_cron",
  "input_submission_body_bytes",
  "human_answer_response_body_bytes",
  "raw_file_bytes",
  "output_page_default_limit",
  "output_page_max_limit",
  "control_plane_setup_code_expiry_seconds",
  "default_device_poll_interval_seconds",
  "unacknowledged_output_timeout_days",
  "billing_downgrade_grace_days"
];

/**
 * @typedef {{
 *   hostedAppBaseUrl: string,
 *   hostedWebsiteBaseUrl: string,
 *   scheduledCleanupCron: string,
 *   inputSubmissionBodyBytes: number,
 *   humanAnswerResponseBodyBytes: number,
 *   rawFileBytes: number,
 *   outputPageDefaultLimit: number,
 *   outputPageMaxLimit: number,
 *   controlPlaneSetupCodeExpirySeconds: number,
 *   defaultDevicePollIntervalSeconds: number,
 *   unacknowledgedOutputTimeoutDays: number,
 *   billingDowngradeGraceDays: number
 * }} SystemContract
 */

/** @param {unknown} value @param {string} name @returns {number} */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `system-contract.json ${name} must be a positive safe integer.`
    );
  }
  const numericValue = /** @type {number} */ (value);
  if (numericValue <= 0) {
    throw new TypeError(
      `system-contract.json ${name} must be a positive safe integer.`
    );
  }
  return numericValue;
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `system-contract.json ${name} must be a non-empty string.`
    );
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function httpsOrigin(value, name) {
  const origin = nonEmptyString(value, name);
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      origin !== url.origin
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(
      `system-contract.json ${name} must be an absolute HTTPS origin without credentials or a trailing slash.`
    );
  }
  return origin;
}

/** @param {unknown} value @returns {SystemContract} */
export function validateSystemContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("system-contract.json must contain an object.");
  }
  const contract = /** @type {Record<string, unknown>} */ (value);
  const actualFields = Object.keys(contract).sort();
  assert.deepEqual(
    actualFields,
    [...REQUIRED_FIELDS].sort(),
    "system-contract.json fields must be exact"
  );

  const hostedAppBaseUrl = httpsOrigin(
    contract.hosted_app_base_url,
    "hosted_app_base_url"
  );
  const hostedWebsiteBaseUrl = httpsOrigin(
    contract.hosted_website_base_url,
    "hosted_website_base_url"
  );
  if (hostedWebsiteBaseUrl === hostedAppBaseUrl) {
    throw new TypeError(
      "system-contract.json hosted_website_base_url must differ from hosted_app_base_url."
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
    hostedWebsiteBaseUrl,
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

/** @returns {SystemContract} */
export function readSystemContract() {
  return validateSystemContract(
    JSON.parse(readFileSync(CONTRACT_PATH, "utf8"))
  );
}

/** @param {SystemContract} contract */
export function renderGeneratedGoSystemContract(contract) {
  const constants = /** @type {Array<[string, string | number]>} */ ([
    [
      "SystemContractHostedAppBaseURL",
      JSON.stringify(contract.hostedAppBaseUrl)
    ],
    [
      "SystemContractHostedWebsiteBaseURL",
      JSON.stringify(contract.hostedWebsiteBaseUrl)
    ],
    [
      "SystemContractScheduledCleanupCron",
      JSON.stringify(contract.scheduledCleanupCron)
    ],
    [
      "SystemContractInputSubmissionBodyBytes",
      contract.inputSubmissionBodyBytes
    ],
    [
      "SystemContractHumanAnswerResponseBodyBytes",
      contract.humanAnswerResponseBodyBytes
    ],
    ["SystemContractRawFileBytes", contract.rawFileBytes],
    ["SystemContractOutputPageDefaultLimit", contract.outputPageDefaultLimit],
    ["SystemContractOutputPageMaxLimit", contract.outputPageMaxLimit],
    [
      "SystemContractControlPlaneSetupCodeExpirySeconds",
      contract.controlPlaneSetupCodeExpirySeconds
    ],
    [
      "SystemContractDefaultDevicePollIntervalSeconds",
      contract.defaultDevicePollIntervalSeconds
    ],
    [
      "SystemContractUnacknowledgedOutputTimeoutDays",
      contract.unacknowledgedOutputTimeoutDays
    ],
    [
      "SystemContractBillingDowngradeGraceDays",
      contract.billingDowngradeGraceDays
    ]
  ]);
  const longestName = Math.max(...constants.map(([name]) => name.length));
  const body = constants
    .map(([name, value]) => `\t${name.padEnd(longestName)} = ${value}`)
    .join("\n");
  return `// Code generated by node scripts/system-contract.mjs generate; DO NOT EDIT.\n\npackage foundation\n\nconst (\n${body}\n)\n`;
}

/** @param {unknown} wrangler */
function wranglerCustomDomainHostnames(wrangler) {
  if (
    !wrangler ||
    typeof wrangler !== "object" ||
    !("routes" in wrangler) ||
    !Array.isArray(wrangler.routes)
  ) {
    return [];
  }
  /** @type {string[]} */
  const hostnames = [];
  for (const route of wrangler.routes) {
    if (
      !route ||
      typeof route !== "object" ||
      !("custom_domain" in route) ||
      !("pattern" in route) ||
      route.custom_domain !== true ||
      typeof route.pattern !== "string"
    ) {
      continue;
    }
    hostnames.push(route.pattern);
  }
  return hostnames.sort();
}

/** @param {string} relativePath */
function source(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** @param {string} input */
export function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }

  if (inBlockComment) {
    throw new SyntaxError("Unterminated JSONC block comment.");
  }

  return output;
}

/** @param {string[]} failures @param {string} relativePath @param {string[]} markers */
function requireMarkers(failures, relativePath, markers) {
  const contents = source(relativePath);
  for (const marker of markers) {
    if (!contents.includes(marker)) {
      failures.push(`${relativePath} must include ${JSON.stringify(marker)}.`);
    }
  }
}

/** @param {SystemContract} [contract] */
export function systemContractDriftFailures(contract = readSystemContract()) {
  const failures = [];
  const generated = renderGeneratedGoSystemContract(contract);
  if (
    source("cli/internal/foundation/system_contract_generated.go") !== generated
  ) {
    failures.push(
      "cli/internal/foundation/system_contract_generated.go is stale; run node scripts/system-contract.mjs generate."
    );
  }

  requireMarkers(failures, "src/server/limits.ts", [
    'from "../shared/system-contract.ts"',
    "SYSTEM_CONTRACT.inputSubmissionBodyBytes",
    "SYSTEM_CONTRACT.humanAnswerResponseBodyBytes",
    "SYSTEM_CONTRACT.rawFileBytes",
    "SYSTEM_CONTRACT.unacknowledgedOutputTimeoutDays",
    "SYSTEM_CONTRACT.billingDowngradeGraceDays"
  ]);
  requireMarkers(failures, "src/server/input-schema.ts", [
    "SYSTEM_CONTRACT.inputSubmissionBodyBytes",
    "SYSTEM_CONTRACT.hostedAppBaseUrl",
    '${INPUT_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte limit'
  ]);
  requireMarkers(failures, "src/server/human-answer.ts", [
    "SYSTEM_CONTRACT.humanAnswerResponseBodyBytes",
    "SYSTEM_CONTRACT.unacknowledgedOutputTimeoutDays",
    "${HUMAN_ANSWER_RESPONSE_BYTE_LIMIT}-byte cap"
  ]);
  requireMarkers(failures, "src/server/output-queue.ts", [
    "SYSTEM_CONTRACT.outputPageDefaultLimit",
    "SYSTEM_CONTRACT.outputPageMaxLimit"
  ]);
  requireMarkers(failures, "src/server/caller-connect.ts", [
    "SYSTEM_CONTRACT.controlPlaneSetupCodeExpirySeconds",
    "SYSTEM_CONTRACT.defaultDevicePollIntervalSeconds"
  ]);
  requireMarkers(failures, "src/server/caller-credential-operations.ts", [
    "SYSTEM_CONTRACT.controlPlaneSetupCodeExpirySeconds",
    "SYSTEM_CONTRACT.defaultDevicePollIntervalSeconds"
  ]);
  requireMarkers(failures, "src/server/scheduled.ts", [
    "SYSTEM_CONTRACT.scheduledCleanupCron"
  ]);
  requireMarkers(failures, "src/server/billing.ts", [
    "SYSTEM_CONTRACT.billingDowngradeGraceDays"
  ]);
  requireMarkers(failures, "scripts/worker-deploy.mjs", [
    "systemContract.hostedAppBaseUrl"
  ]);
  requireMarkers(failures, "cli/internal/command/dataplane.go", [
    "foundation.SystemContractInputSubmissionBodyBytes",
    "foundation.SystemContractOutputPageDefaultLimit",
    "foundation.SystemContractOutputPageMaxLimit",
    '"page-size",\n\t\tfoundation.SystemContractOutputPageDefaultLimit'
  ]);
  requireMarkers(failures, "cli/internal/command/controlplane.go", [
    "foundation.SystemContractDefaultDevicePollIntervalSeconds"
  ]);
  requireMarkers(failures, "cli/internal/foundation/config.go", [
    "SystemContractHostedAppBaseURL"
  ]);
  requireMarkers(failures, "cli/internal/foundation/http.go", [
    "SystemContractRawFileBytes"
  ]);
  const wrangler = JSON.parse(stripJsonComments(source("wrangler.jsonc")));
  const hostedAppHostname = new URL(contract.hostedAppBaseUrl).hostname;
  const hostedWebsiteHostname = new URL(contract.hostedWebsiteBaseUrl).hostname;
  const customDomainHostnames = wranglerCustomDomainHostnames(wrangler);
  if (
    customDomainHostnames.length !== 2 ||
    customDomainHostnames[0] !== hostedWebsiteHostname ||
    customDomainHostnames[1] !== hostedAppHostname
  ) {
    failures.push(
      "wrangler.jsonc routes must contain the system-contract hosted website and app hostnames as custom domains."
    );
  }
  if (
    !Array.isArray(wrangler?.triggers?.crons) ||
    wrangler.triggers.crons.length !== 1 ||
    wrangler.triggers.crons[0] !== contract.scheduledCleanupCron
  ) {
    failures.push(
      "wrangler.jsonc triggers.crons must contain the system-contract scheduled_cleanup_cron exactly once."
    );
  }

  requireMarkers(failures, "docs/spec/input-schema.md", [
    `Input submission request body: ${contract.inputSubmissionBodyBytes.toLocaleString("en-US")} bytes`,
    `Human uploaded raw file bytes: ${contract.rawFileBytes.toLocaleString("en-US")} bytes`
  ]);
  requireMarkers(failures, "docs/spec/output-schema.md", [
    `Default page size: ${contract.outputPageDefaultLimit}.`,
    `Maximum page size: ${contract.outputPageMaxLimit}.`,
    `${contract.unacknowledgedOutputTimeoutDays}-day output timeout`
  ]);
  requireMarkers(failures, "docs/spec/http-api.md", [
    contract.hostedAppBaseUrl,
    `expire after ${contract.controlPlaneSetupCodeExpirySeconds / 60} minutes`,
    `poll_interval_seconds: ${contract.defaultDevicePollIntervalSeconds}`
  ]);
  requireMarkers(failures, "docs/spec/README.md", [contract.hostedAppBaseUrl]);
  requireMarkers(failures, "docs/spec/public-api.md", [
    contract.hostedAppBaseUrl,
    `limit=${contract.outputPageDefaultLimit}`,
    `"page_limit": ${contract.outputPageDefaultLimit}`
  ]);
  requireMarkers(failures, "docs/spec/public-api-capabilities.md", [
    contract.hostedAppBaseUrl,
    contract.inputSubmissionBodyBytes.toLocaleString("en-US")
  ]);
  requireMarkers(failures, "docs/spec/public-api-reliability.md", [
    `"limit": ${contract.outputPageDefaultLimit}`,
    `${contract.unacknowledgedOutputTimeoutDays} days`
  ]);
  requireMarkers(failures, "src/components/docs/ApiDocsPage.tsx", [
    "SYSTEM_CONTRACT.hostedAppBaseUrl"
  ]);
  requireMarkers(failures, "docs/ops/resources.md", [
    contract.hostedWebsiteBaseUrl,
    contract.hostedAppBaseUrl,
    contract.scheduledCleanupCron
  ]);
  requireMarkers(failures, "docs/ops/services/cloudflare.md", [
    `cron schedule is \`${contract.scheduledCleanupCron}\``
  ]);
  requireMarkers(failures, "src/shared/hosted-origins.ts", [
    "SYSTEM_CONTRACT.hostedWebsiteBaseUrl",
    "SYSTEM_CONTRACT.hostedAppBaseUrl"
  ]);
  requireMarkers(failures, "docs/architecture.md", [
    "System Contract Ownership",
    "system-contract.json",
    contract.hostedWebsiteBaseUrl,
    contract.hostedAppBaseUrl
  ]);

  return failures;
}

function main() {
  const command = process.argv[2];
  const contract = readSystemContract();
  if (command === "generate") {
    writeFileSync(GENERATED_GO_PATH, renderGeneratedGoSystemContract(contract));
    console.log(
      "Generated cli/internal/foundation/system_contract_generated.go."
    );
    return;
  }
  if (command === "check") {
    const failures = systemContractDriftFailures(contract);
    assert.deepEqual(failures, [], failures.join("\n"));
    console.log("System contract drift checks passed.");
    return;
  }
  console.error("Usage: node scripts/system-contract.mjs <generate|check>");
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
