import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CRON_SCHEDULE } from "../src/server/scheduled.ts";
import { parseEnv } from "./dotenv.mjs";
import { deployReleasePhaseOrderMatches } from "./release/order.mjs";
import { parseJsonc } from "./system-contract.mjs";

export { parseEnv };

/**
 * @typedef {{
 *   package?: string | null,
 *   version: string,
 *   dependencyType?: "dependencies" | "devDependencies"
 * }} ToolPin
 *
 * @typedef {ToolPin & { authCheck: string[] }} ProviderCliPin
 *
 * @typedef {{
 *   node: { version: string, npm: string },
 *   go: { version: string },
 *   goTooling?: {
 *     cobra?: { module: string, version: string },
 *     githubActionsSetupGo?: { version: string },
 *     goreleaser?: { module: string, version: string }
 *   },
 *   packageManager: { name: string, version: string },
 *   flyway: { version: string, image: string, source: string },
 *   phase1Tools: Record<string, ToolPin>,
 *   runtimePins: Record<string, ToolPin>,
 *   runtimeDevTools: Record<string, ToolPin>,
 *   providerCli: Record<string, ProviderCliPin>
 * }} Toolchain
 *
 * @typedef {{
 *   packageManager?: string,
 *   devEngines?: {
 *     runtime?: { name?: string, version?: string, onFail?: string },
 *     packageManager?: { name?: string, version?: string, onFail?: string }
 *   },
 *   scripts?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>
 * }} PackageJson
 *
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   error?: Error & { code?: string },
 *   stdout?: unknown,
 *   stderr?: unknown
 * }} CommandResult
 *
 * @typedef {{ ok: boolean, message: string }} CheckResult
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_FILES = [
  "Makefile",
  ".goreleaser.yaml",
  "toolchain.json",
  "package.json",
  "cli/go.mod",
  "cli/go.sum",
  "cli/cmd/agent-outbox/main.go",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".prettierrc.json",
  ".prettierignore",
  ".markdownlint-cli2.yaml",
  "tsconfig.json",
  "scripts/foundation.mjs",
  "scripts/dotenv.mjs",
  "scripts/release/identity.mjs",
  "scripts/release/order.mjs",
  "scripts/worker-deploy.mjs",
  "scripts/runtime-smoke.mjs",
  "scripts/hosted-health.mjs",
  "scripts/billing-smoke.mjs",
  "tests/foundation.test.mjs",
  ".env.example",
  "next.config.ts",
  "middleware.ts",
  "instrumentation.ts",
  "app/layout.tsx",
  "app/page.tsx",
  "app/api/runtime/canary/route.ts",
  "src/server/accounting.ts",
  "src/server/authorization.ts",
  "src/server/caller-auth.ts",
  "src/server/cleanup.ts",
  "src/server/database.ts",
  "src/server/limits.ts",
  "src/server/logging.ts",
  "src/server/scheduled.ts",
  "db/migrations/V20260630000000__initial_schema.sql",
  "db/migrations/V20260703223000__output_file_size_invariant.sql",
  "docs/spec/README.md",
  "docs/spec/http-api.md",
  "docs/spec/input-schema.md",
  "docs/spec/output-schema.md",
  "docs/spec/errors.md",
  "docs/agent-layer/COMMANDS.md",
  "docs/ops/migrations.md",
  "scripts/flyway.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/release-check.yml",
  ".github/workflows/policy-gates.yml",
  ".github/workflows/deploy-production.yml",
  ".github/workflows/reconcile-production-release.yml",
  ".github/workflows/detect-abandoned-production-release.yml",
  ".github/workflows/rollback-production.yml"
];

const FORBIDDEN_WORKFLOW_TOKENS = [
  "wrangler deploy",
  "npm publish",
  "pnpm publish",
  "gh release create",
  "stripe trigger",
  "stripe fixtures",
  "supabase db push",
  "supabase db reset",
  "supabase migration"
];

const REQUIRED_ENV_NAMES = [
  "APP_ENV",
  "PORT",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "SUPABASE_PROJECT_REF",
  "DATABASE_URL",
  "DATABASE_APP_ROLE_URL",
  "DATABASE_MIGRATION_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "STRIPE_ACCOUNT_ID",
  "SENTRY_DSN",
  "SENTRY_BROWSER_DSN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN"
];

const OPTIONAL_LOCAL_ENV_NAMES = [
  "AGENT_OUTBOX_BASE_URL",
  "AGENT_OUTBOX_CONFIG_PATH",
  "AGENT_OUTBOX_CALLER",
  "AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE",
  "AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE",
  "AGENT_OUTBOX_HOSTED_HEALTH_QUOTA_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_FILE_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_AUDIT_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_ABUSE_COST_EVIDENCE",
  "AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE",
  "AGENT_OUTBOX_BILLING_SMOKE_COOKIE",
  "AWS_PROFILE",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_ZONE_NAME",
  "CLOUDFLARE_NAMESERVERS",
  "CLOUDFLARE_DNS_API_TOKEN",
  "CLOUDFLARE_HYPERDRIVE_ID",
  "CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN",
  "CLOUDFLARE_TOKEN_MANAGEMENT_API_TOKEN",
  "CLOUDFLARE_WAF_API_TOKEN",
  "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN",
  "SENTRY_RELEASE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD",
  "AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH"
];

const COMMAND_TIMEOUT_MS = 30_000;

export const REQUIRED_WORKER_SECRET_NAMES = [
  "CLERK_SECRET_KEY",
  "SENTRY_DSN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET"
];

const RUNTIME_PROOF_SOURCE_DIRS = ["app", "src"];
const RUNTIME_PROOF_SOURCE_FILES = ["instrumentation.ts", "middleware.ts"];

const FORBIDDEN_RUNTIME_PROOF_PATH_PATTERNS = [
  /^app\/api\/(?:checkout|stripe)\//,
  /^app\/api\/account\/(?!status(?:\/|$))/,
  /^app\/api\/caller\/(?!(?:status\/route\.ts|connect\/(?:browser\/start|device\/start|device\/poll|exchange|activate|abort)\/route\.ts|rotate\/(?:browser\/start|device\/start|device\/poll|exchange|activate|abort)\/route\.ts|revoke\/(?:browser\/start|device\/start|device\/poll|confirm)\/route\.ts)$)/,
  /^app\/api\/input\/\[/,
  /^app\/api\/human\//,
  /^app\/human\/(?:queue|review|items?)\//,
  /^src\/cli\//,
  /^src\/.*(?:steward|email)/i,
  /^cli\//,
  /^cmd\//
];

const FORBIDDEN_RUNTIME_PROOF_TOKENS = [
  "create table",
  "alter table",
  "drop table",
  "create index",
  "uploadthing",
  "supabase.storage",
  "gmail",
  "classifier"
];

const PHASE3_FOUNDATION_MARKERS_BY_FILE = {
  "src/server/accounting.ts": [
    "auditSafeLifecycleEvent",
    "storedByteAccounting",
    "quotaWindowKey"
  ],
  "src/server/authorization.ts": [
    "authorizeAccountMembership",
    "authorizeCallerAccount"
  ],
  "src/server/caller-auth.ts": [
    "generateCallerApiKeyMaterial",
    "callerCredentialLookupStatement"
  ],
  "src/server/cleanup.ts": [
    "terminalOutputDeletionStatement",
    "downgradeGraceExpiryStatement",
    "agent_outbox_cleanup_downgrade_grace_expiry"
  ],
  "src/server/database.ts": ["runProductTransaction"],
  "src/server/limits.ts": [
    "authenticated_caller_api_requests_per_calendar_month",
    "self_hosted"
  ],
  "db/migrations/V20260630000000__initial_schema.sql": [
    "agent_outbox_context_allows_caller",
    "enable row level security",
    "agent_outbox_delete_output_result",
    "agent_outbox_cleanup_downgrade_grace_expiry",
    "agent_outbox_app",
    "nobypassrls"
  ]
};

const PHASE4_CONTRACT_DOC_MARKERS_BY_FILE = {
  "docs/spec/README.md": ["Raw HTTP is canonical", "CLI To HTTP Map"],
  "docs/spec/http-api.md": [
    "POST /api/input/send",
    "GET /api/output/check",
    "GET /api/caller/status",
    "Human Answer Boundary"
  ],
  "docs/spec/input-schema.md": [
    "ActionButton.value",
    "date_picker",
    "Input Semantics"
  ],
  "docs/spec/output-schema.md": [
    "Output Check Page",
    "Pagination",
    "File Download"
  ],
  "docs/spec/errors.md": [
    "Error Envelope",
    "rate_limit_exceeded",
    "invalid_caller_credentials"
  ]
};

const HTTP_ROUTE_METHOD_PATTERN =
  /^\s*export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/gm;
const HTTP_DOC_ROUTE_LINE_PATTERN =
  /^```http\s*\n(GET|POST|PUT|PATCH|DELETE)\s+([^\s\n]+)(?:[^\n]*)\n```/gm;

/**
 * @param {string} relativePath
 * @returns {unknown}
 */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function requiredEnvNames(exampleContent) {
  const exampleNames = new Set(parseEnv(exampleContent).keys());
  return REQUIRED_ENV_NAMES.filter((name) => exampleNames.has(name));
}

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function validateRequiredEnvExample(exampleContent) {
  const actualNames = [...parseEnv(exampleContent).keys()];
  const expectedNames = new Set(REQUIRED_ENV_NAMES);
  const allowedNames = new Set([
    ...REQUIRED_ENV_NAMES,
    ...OPTIONAL_LOCAL_ENV_NAMES
  ]);
  const actualNameSet = new Set(actualNames);

  const missing = REQUIRED_ENV_NAMES.filter((name) => !actualNameSet.has(name));
  const extra = actualNames.filter((name) => !allowedNames.has(name));

  return [
    ...missing.map((name) => `.env.example missing required name ${name}`),
    ...extra.map((name) => `.env.example contains unknown name ${name}`)
  ];
}

/**
 * @param {string} exampleContent
 * @param {string} actualContent
 * @returns {string[]}
 */
export function missingEnvNames(exampleContent, actualContent) {
  const actual = parseEnv(actualContent);
  return requiredEnvNames(exampleContent).filter((name) => !actual.get(name));
}

/**
 * @param {string} projectsJson
 * @param {string} expectedProjectRef
 * @returns {boolean}
 */
export function supabaseProjectsIncludeRef(projectsJson, expectedProjectRef) {
  const parsed = JSON.parse(projectsJson);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) {
    return false;
  }

  return projects.some((project) => {
    if (!project || typeof project !== "object") {
      return false;
    }

    const values = Object.values(project);
    return values.some((value) => value === expectedProjectRef);
  });
}

/**
 * @param {CommandResult} result
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, error: string | null }}
 */
export function redactCommandResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? result.error?.message ?? null
  };
}

/**
 * @param {Toolchain} toolchain
 * @param {PackageJson} packageJson
 * @returns {string[]}
 */
export function validateToolchainPackage(toolchain, packageJson) {
  const errors = [];

  if (
    packageJson.packageManager !== `pnpm@${toolchain.packageManager.version}`
  ) {
    errors.push("package.json packageManager does not match toolchain.json");
  }

  if (packageJson.devEngines?.runtime?.name !== "node") {
    errors.push("package.json devEngines.runtime must pin node");
  }

  if (packageJson.devEngines?.runtime?.version !== toolchain.node.version) {
    errors.push(
      "package.json devEngines.runtime does not match toolchain.json"
    );
  }

  if (packageJson.devEngines?.runtime?.onFail !== "download") {
    errors.push(
      "package.json devEngines.runtime must download the pinned runtime"
    );
  }

  if (
    packageJson.devEngines?.packageManager?.name !==
    toolchain.packageManager.name
  ) {
    errors.push("package.json devEngines.packageManager must pin pnpm");
  }

  if (
    packageJson.devEngines?.packageManager?.version !==
    toolchain.packageManager.version
  ) {
    errors.push(
      "package.json devEngines.packageManager does not match toolchain.json"
    );
  }

  const expectedDependencies = new Map();
  const expectedDevDependencies = new Map();
  for (const section of /** @type {const} */ (["phase1Tools", "providerCli"])) {
    for (const tool of Object.values(toolchain[section])) {
      if (tool.package) {
        expectedDevDependencies.set(tool.package, tool.version);
      }
    }
  }

  for (const [name, cli] of Object.entries(toolchain.providerCli)) {
    if (!Array.isArray(cli.authCheck) || cli.authCheck.length === 0) {
      errors.push(`toolchain.json providerCli.${name}.authCheck is required`);
    }
  }

  for (const tool of Object.values(toolchain.runtimeDevTools)) {
    if (tool.package) {
      expectedDevDependencies.set(tool.package, tool.version);
    }
  }

  for (const tool of Object.values(toolchain.runtimePins)) {
    if (!tool.package) {
      continue;
    }

    if (tool.dependencyType === "devDependencies") {
      expectedDevDependencies.set(tool.package, tool.version);
    } else {
      expectedDependencies.set(tool.package, tool.version);
    }
  }

  for (const [dependency, version] of expectedDependencies) {
    if (packageJson.dependencies?.[dependency] !== version) {
      errors.push(`dependency ${dependency} must be pinned to ${version}`);
    }
  }

  for (const [dependency, version] of expectedDevDependencies) {
    if (packageJson.devDependencies?.[dependency] !== version) {
      errors.push(`devDependency ${dependency} must be pinned to ${version}`);
    }
  }

  const nodeTypesVersion = packageJson.devDependencies?.["@types/node"];
  if (nodeTypesVersion) {
    const runtimeMajor = toolchain.node.version.split(".")[0];
    const typesMajor = nodeTypesVersion.split(".")[0];
    if (typesMajor !== runtimeMajor) {
      errors.push(
        `@types/node major ${typesMajor} must match Node major ${runtimeMajor}`
      );
    }
  }

  const allowedDependencies = new Set(expectedDependencies.keys());
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (!allowedDependencies.has(dependency)) {
      errors.push(`dependency ${dependency} is not pinned in toolchain.json`);
    }
  }

  const allowedDevDependencies = new Set(expectedDevDependencies.keys());
  for (const dependency of Object.keys(packageJson.devDependencies ?? {})) {
    if (!allowedDevDependencies.has(dependency)) {
      errors.push(
        `devDependency ${dependency} is not pinned in toolchain.json`
      );
    }
  }

  return errors;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function validateRuntimeProofScope(sourceContentsByPath) {
  const failures = [];

  for (const [relativePath, content] of Object.entries(sourceContentsByPath)) {
    for (const pattern of FORBIDDEN_RUNTIME_PROOF_PATH_PATTERNS) {
      if (pattern.test(relativePath)) {
        failures.push(
          `${relativePath} is unrelated later-phase implementation scope, not current caller API scope`
        );
      }
    }

    const lowered = content.toLowerCase();
    for (const token of FORBIDDEN_RUNTIME_PROOF_TOKENS) {
      if (lowered.includes(token)) {
        failures.push(`${relativePath} contains out-of-scope token: ${token}`);
      }
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function validatePhase3FoundationSourceContents(sourceContentsByPath) {
  const failures = [];

  for (const [relativePath, markers] of Object.entries(
    PHASE3_FOUNDATION_MARKERS_BY_FILE
  )) {
    const content = sourceContentsByPath[relativePath];
    if (content === undefined) {
      failures.push(
        `${relativePath} is missing from Phase 3 foundation source`
      );
      continue;
    }

    for (const marker of markers) {
      if (!content.includes(marker)) {
        failures.push(
          `${relativePath} is missing Phase 3 foundation marker: ${marker}`
        );
      }
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function validatePhase4ContractDocContents(sourceContentsByPath) {
  const failures = [];

  for (const [relativePath, markers] of Object.entries(
    PHASE4_CONTRACT_DOC_MARKERS_BY_FILE
  )) {
    const content = sourceContentsByPath[relativePath];
    if (content === undefined) {
      failures.push(`${relativePath} is missing from Phase 4 contract docs`);
      continue;
    }

    for (const marker of markers) {
      if (!content.includes(marker)) {
        failures.push(
          `${relativePath} is missing Phase 4 contract marker: ${marker}`
        );
      }
    }
  }

  const httpApiContent = sourceContentsByPath["docs/spec/http-api.md"];
  if (httpApiContent !== undefined) {
    const documentedRouteMarkers =
      extractDocumentedHttpContractRouteMarkers(httpApiContent);
    const markers =
      extractImplementedHttpContractRouteMarkers(sourceContentsByPath);

    for (const marker of markers) {
      if (!documentedRouteMarkers.includes(marker)) {
        failures.push(
          `docs/spec/http-api.md is missing implemented HTTP route contract: ${marker}`
        );
      }
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function extractImplementedHttpContractRouteMarkers(
  sourceContentsByPath
) {
  const markers = [];

  for (const [relativePath, content] of Object.entries(sourceContentsByPath)) {
    if (
      !relativePath.startsWith("app/api/") ||
      !relativePath.endsWith("/route.ts") ||
      relativePath.startsWith("app/api/runtime/")
    ) {
      continue;
    }

    const routePath = `/${relativePath
      .replace(/^app\//, "")
      .replace(/\/route\.ts$/, "")
      .replaceAll("[", "{")
      .replaceAll("]", "}")}`;

    for (const match of content.matchAll(HTTP_ROUTE_METHOD_PATTERN)) {
      markers.push(`${match[1]} ${routePath}`);
    }
  }

  return markers.sort();
}

/**
 * @param {string} httpApiContent
 * @returns {string[]}
 */
export function extractDocumentedHttpContractRouteMarkers(httpApiContent) {
  return [...httpApiContent.matchAll(HTTP_DOC_ROUTE_LINE_PATTERN)]
    .map((match) => `${match[1]} ${match[2].split("?")[0]}`)
    .sort();
}

/**
 * @param {string} wranglerConfigContent
 * @param {string} runtimeCronSchedule
 * @returns {string[]}
 */
export function validateWranglerCronSchedule(
  wranglerConfigContent,
  runtimeCronSchedule
) {
  let config;
  try {
    config = /** @type {{ triggers?: { crons?: unknown } }} */ (
      parseJsonc(wranglerConfigContent)
    );
  } catch {
    return ["wrangler.jsonc must be parseable JSONC for cron drift checks"];
  }

  const crons = config?.triggers?.crons;
  if (
    !Array.isArray(crons) ||
    !crons.every((cron) => typeof cron === "string")
  ) {
    return ["wrangler.jsonc triggers.crons must be a string array"];
  }

  const failures = [];
  if (crons.length !== 1) {
    failures.push(
      "wrangler.jsonc must define exactly one cron while the runtime scheduled canary reports one configured schedule"
    );
  }

  if (!crons.includes(runtimeCronSchedule)) {
    failures.push(
      `wrangler.jsonc triggers.crons must include runtime scheduled canary ${runtimeCronSchedule}`
    );
  }

  return failures;
}

/**
 * @param {string} wranglerConfigContent
 * @returns {string[]}
 */
export function validateWranglerRequiredSecrets(wranglerConfigContent) {
  let config;
  try {
    config = /** @type {{ secrets?: { required?: unknown } }} */ (
      parseJsonc(wranglerConfigContent)
    );
  } catch {
    return ["wrangler.jsonc must be parseable JSONC for secret drift checks"];
  }

  const requiredSecrets = config?.secrets?.required;
  if (
    !Array.isArray(requiredSecrets) ||
    !requiredSecrets.every((name) => typeof name === "string")
  ) {
    return ["wrangler.jsonc secrets.required must be a string array"];
  }

  const expected = new Set(REQUIRED_WORKER_SECRET_NAMES);
  const actual = new Set(requiredSecrets);
  const failures = [];
  for (const name of REQUIRED_WORKER_SECRET_NAMES) {
    if (!actual.has(name)) {
      failures.push(`wrangler.jsonc secrets.required missing ${name}`);
    }
  }
  for (const name of requiredSecrets) {
    if (!expected.has(name)) {
      failures.push(
        `wrangler.jsonc secrets.required must not include non-Worker secret or config ${name}`
      );
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function assertNoForbiddenWorkflowCommands(workflowContentsByPath) {
  const failures = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    for (const token of FORBIDDEN_WORKFLOW_TOKENS) {
      if (content.includes(token)) {
        failures.push(`${workflowPath} contains forbidden command: ${token}`);
      }
    }
  }

  return failures;
}

/**
 * @param {Toolchain} toolchain
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowVersionPins(toolchain, workflowContentsByPath) {
  const errors = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    const nodeVersions = [
      ...content.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)
    ].map((match) => match[1]);
    for (const version of nodeVersions) {
      if (version !== toolchain.node.version) {
        errors.push(
          `${workflowPath} node-version ${version} must match toolchain.json ${toolchain.node.version}`
        );
      }
    }
  }

  return errors;
}

/**
 * @param {string} content
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function workflowHasLine(content, pattern) {
  return content.split(/\r?\n/).some((line) => pattern.test(line));
}

/**
 * @param {string} content
 * @param {string} token
 * @returns {boolean}
 */
function workflowRunStepIncludes(content, token) {
  return workflowHasLine(
    content,
    new RegExp(`^\\s*(?:-\\s*)?run:\\s*${escapeRegExp(token)}\\s*$`)
  );
}

/**
 * @param {string} content
 * @param {string} jobName
 * @returns {string}
 */
function workflowJobContent(content, jobName) {
  const lines = content.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) {
    return "";
  }

  const jobPattern = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`);
  const jobIndex = lines.findIndex(
    (line, index) => index > jobsIndex && jobPattern.test(line)
  );
  if (jobIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || /^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(jobIndex, endIndex).join("\n");
}

/**
 * @param {string} content
 * @param {string} blockName
 * @param {number} indentation
 * @returns {string}
 */
function workflowMappingBlockContent(content, blockName, indentation) {
  const lines = content.split(/\r?\n/);
  const prefix = " ".repeat(indentation);
  const blockPattern = new RegExp(
    `^${escapeRegExp(prefix)}${escapeRegExp(blockName)}:\\s*(?:#.*)?$`
  );
  const blockIndex = lines.findIndex((line) => blockPattern.test(line));
  if (blockIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = blockIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    if (
      line.trim() !== "" &&
      line.length - line.trimStart().length <= indentation
    ) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(blockIndex, endIndex).join("\n");
}

/**
 * @param {string} jobContent
 * @param {string} stepName
 * @returns {string}
 */
function workflowNamedStepContent(jobContent, stepName) {
  const lines = jobContent.split(/\r?\n/);
  const stepPattern = new RegExp(
    `^      - name:\\s*${escapeRegExp(stepName)}\\s*$`
  );
  const stepIndex = lines.findIndex((line) => stepPattern.test(line));
  if (stepIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (/^      - /.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(stepIndex, endIndex).join("\n");
}

/**
 * @param {string} deployWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionDeployWorkflow(
  deployWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const validateRefJob = workflowJobContent(
    deployWorkflowContent,
    "validate-ref"
  );
  const deployJob = workflowJobContent(deployWorkflowContent, "deploy");
  const buildCliJob = workflowJobContent(deployWorkflowContent, "build-cli");
  const homebrewJob = workflowJobContent(
    deployWorkflowContent,
    "publish-cli-homebrew"
  );
  const uploadWorkerStep = workflowNamedStepContent(
    deployJob,
    "Upload inactive Worker version"
  );
  const stagedDeployStep = workflowNamedStepContent(
    deployJob,
    "Deploy prior@100 and candidate@0"
  );
  const promoteStep = workflowNamedStepContent(
    deployJob,
    "Promote candidate to 100%"
  );
  const captureRollbackStep = workflowNamedStepContent(
    deployJob,
    "Capture healthy rollback target"
  );
  const downloadCertifiedCliStep = workflowNamedStepContent(
    deployJob,
    "Download certified CLI artifacts"
  );
  const prepareDraftStep = workflowNamedStepContent(
    deployJob,
    "Prepare exact-candidate GitHub release draft"
  );
  const uploadCliStep = workflowNamedStepContent(
    deployJob,
    "Upload certified CLI assets to draft"
  );
  const requirePublicRepositoryStep = workflowNamedStepContent(
    deployJob,
    "Require public release repository"
  );
  const tapPreflightTokenStep = workflowNamedStepContent(
    deployJob,
    "Create Homebrew preflight token"
  );
  const tapPreflightAccessStep = workflowNamedStepContent(
    deployJob,
    "Verify Homebrew tap access"
  );
  const publishReleaseStep = workflowNamedStepContent(
    deployJob,
    "Publish exact-candidate GitHub release"
  );
  const requireMigrationCredentialStep = workflowNamedStepContent(
    deployJob,
    "Require production migration credential"
  );
  const migrationStep = workflowNamedStepContent(
    deployJob,
    "Apply production database migrations"
  );
  const preMigrationValidationStep = workflowNamedStepContent(
    deployJob,
    "Validate production migration history before apply"
  );
  const postMigrationValidationStep = workflowNamedStepContent(
    deployJob,
    "Validate production migration history after apply"
  );
  const verifyRollbackTargetStep = workflowNamedStepContent(
    deployJob,
    "Verify rollback target before deploy"
  );
  const overrideSmokeStep = workflowNamedStepContent(
    deployJob,
    "Verify candidate through version override"
  );
  const verifyStep = workflowNamedStepContent(
    deployJob,
    "Verify deployed release"
  );
  const cleanupStep = workflowNamedStepContent(
    deployJob,
    "Reconcile uncommitted release"
  );
  const ensureReleaseTagStep = workflowNamedStepContent(
    buildCliJob,
    "Ensure exact local release tag"
  );
  const buildCliStep = workflowNamedStepContent(
    buildCliJob,
    "Build tagged CLI release artifacts"
  );
  const validateCaskStep = workflowNamedStepContent(
    buildCliJob,
    "Validate generated Homebrew cask"
  );
  const uploadCertifiedCliStep = workflowNamedStepContent(
    buildCliJob,
    "Upload certified CLI artifacts"
  );
  const downloadPublishedCliStep = workflowNamedStepContent(
    homebrewJob,
    "Download certified CLI artifacts"
  );
  const publicAssetsStep = workflowNamedStepContent(
    homebrewJob,
    "Require publicly downloadable release assets"
  );
  const tapTokenStep = workflowNamedStepContent(
    homebrewJob,
    "Create GitHub App token for tap repo"
  );
  const updateCaskStep = workflowNamedStepContent(
    homebrewJob,
    "Update Homebrew cask"
  );
  const tapPullRequestStep = workflowNamedStepContent(
    homebrewJob,
    "Create PR in tap repo"
  );
  /** @type {[string, boolean][]} */
  const requirements = [
    [
      "workflow_dispatch trigger",
      workflowHasLine(deployWorkflowContent, /^\s*workflow_dispatch:\s*$/)
    ],
    [
      "production environment",
      workflowHasLine(deployJob, /^\s*environment:\s*production\s*$/)
    ],
    [
      `Node ${nodeVersion}`,
      workflowHasLine(
        deployJob,
        new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
      )
    ],
    [
      "main-ref validation job",
      workflowHasLine(
        validateRefJob,
        /^\s*run:\s*test "\$GITHUB_REF" = "refs\/heads\/main"\s*$/
      )
    ],
    [
      "certified release flow",
      deployWorkflowContent.includes(
        "uses: ./.github/workflows/release-check.yml"
      ) &&
        deployWorkflowContent.includes(
          "run: node scripts/production-release.mjs prepare"
        ) &&
        workflowHasLine(
          deployJob,
          /^\s*needs:\s*\[prepare-release, certify, build-cli\]\s*$/
        )
    ],
    [
      "pre-deploy CLI artifact certification",
      workflowHasLine(
        buildCliJob,
        /^\s*needs:\s*\[prepare-release, certify\]\s*$/
      ) &&
        ensureReleaseTagStep.includes("git show-ref --verify") &&
        ensureReleaseTagStep.includes(
          'git tag "${RELEASE_TAG}" "${GITHUB_SHA}"'
        ) &&
        workflowRunStepIncludes(
          buildCliStep,
          'make cli-release-dist RELEASE_TAG="${RELEASE_TAG}"'
        ) &&
        validateCaskStep.includes(
          "ruby -c dist/homebrew/Casks/agent-outbox.rb"
        ) &&
        validateCaskStep.includes(
          "brew style dist/homebrew/Casks/agent-outbox.rb"
        ) &&
        uploadCertifiedCliStep.includes("actions/upload-artifact@") &&
        uploadCertifiedCliStep.includes(
          "name: agent-outbox-release-${{ github.sha }}"
        )
    ],
    [
      "production deploy concurrency group",
      workflowHasLine(
        deployWorkflowContent,
        /^\s*group:\s*production-deploy\s*$/
      )
    ],
    ["rollback-target verification step", Boolean(verifyRollbackTargetStep)],
    [
      "production migration credential requirement step",
      Boolean(requireMigrationCredentialStep)
    ]
  ];
  for (const [description, present] of requirements) {
    if (!present) {
      failures.push(
        `.github/workflows/deploy-production.yml must include ${description}`
      );
    }
  }

  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        deployWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/deploy-production.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }

  if (
    uploadWorkerStep.includes("wrangler deploy") ||
    stagedDeployStep.includes("wrangler deploy") ||
    promoteStep.includes("wrangler deploy")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must upload an inactive Worker version through production-release.mjs"
    );
  }
  if (
    !requireMigrationCredentialStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !requireMigrationCredentialStep.includes(
      'if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]'
    ) ||
    !requireMigrationCredentialStep.includes('host="${host##*@}"') ||
    !migrationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !preMigrationValidationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !postMigrationValidationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before traffic promotion"
    );
  }
  if (
    !verifyStep.includes("AGENT_OUTBOX_EXPECTED_RELEASE: ${{ github.sha }}") ||
    !verifyStep.includes(
      'AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"'
    ) ||
    !overrideSmokeStep.includes("AGENT_OUTBOX_WORKER_VERSION_OVERRIDE") ||
    verifyStep.includes("AGENT_OUTBOX_WORKER_VERSION_OVERRIDE")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must smoke the candidate through a version override before promotion and without an override after promotion"
    );
  }
  const requireHumanReviewQueryCanary =
    'AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"';
  if (verifyRollbackTargetStep.includes(requireHumanReviewQueryCanary)) {
    failures.push(
      ".github/workflows/deploy-production.yml must keep rollback-target smoke compatible with the outgoing release contract"
    );
  }
  if (
    !workflowRunStepIncludes(
      verifyRollbackTargetStep,
      "corepack pnpm run smoke-runtime"
    ) ||
    !verifyRollbackTargetStep.includes("AGENT_OUTBOX_EXPECTED_RELEASE:") ||
    !verifyRollbackTargetStep.includes(
      "steps.rollback-target.outputs.rollback_release"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must prove the captured rollback target with smoke-runtime and AGENT_OUTBOX_EXPECTED_RELEASE"
    );
  }
  if (
    !uploadWorkerStep.includes("CLOUDFLARE_HYPERDRIVE_ID") ||
    !uploadWorkerStep.includes("AGENT_OUTBOX_RELEASE_TAG") ||
    !uploadWorkerStep.includes("AGENT_OUTBOX_GITHUB_RELEASE_ID")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply release and Hyperdrive metadata"
    );
  }
  const githubToken = "GH_TOKEN: ${{ github.token }}";
  if (
    !prepareDraftStep.includes(githubToken) ||
    !uploadCliStep.includes(githubToken) ||
    !captureRollbackStep.includes(githubToken) ||
    !uploadWorkerStep.includes(githubToken) ||
    !publishReleaseStep.includes(githubToken) ||
    !cleanupStep.includes(githubToken)
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply GH_TOKEN to GitHub release identity mutations"
    );
  }
  if (
    !/^\s*needs:\s*\[prepare-release, build-cli, deploy\]\s*$/m.test(
      homebrewJob
    ) ||
    !/^\s*contents:\s*read\s*$/m.test(homebrewJob) ||
    !downloadPublishedCliStep.includes("actions/download-artifact@") ||
    !downloadPublishedCliStep.includes(
      "name: agent-outbox-release-${{ github.sha }}"
    ) ||
    !publicAssetsStep.includes("curl -fsSL") ||
    !publicAssetsStep.includes("cmp -s") ||
    !publicAssetsStep.includes(
      "Make conn-castle/agent-outbox public before publishing its Homebrew cask."
    ) ||
    !tapTokenStep.includes("secrets.HOMEBREW_TAP_APP_ID") ||
    !tapTokenStep.includes("secrets.HOMEBREW_TAP_PRIVATE_KEY") ||
    !tapTokenStep.includes("repositories: homebrew-tap") ||
    !updateCaskStep.includes("dist/homebrew/Casks/agent-outbox.rb") ||
    !updateCaskStep.includes("homebrew-tap/Casks/agent-outbox.rb") ||
    !tapPullRequestStep.includes(
      "branch: bump-agent-outbox-${{ env.RELEASE_TAG }}"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must verify the public CLI release and open the guarded Homebrew cask PR after publication"
    );
  }
  const releasePreparedBeforeDeploy =
    /^\s*contents:\s*write\s*$/m.test(deployJob) &&
    downloadCertifiedCliStep.includes("actions/download-artifact@") &&
    downloadCertifiedCliStep.includes(
      "name: agent-outbox-release-${{ github.sha }}"
    ) &&
    requirePublicRepositoryStep.includes(".visibility") &&
    tapPreflightTokenStep.includes("actions/create-github-app-token@") &&
    tapPreflightTokenStep.includes("secrets.HOMEBREW_TAP_APP_ID") &&
    tapPreflightTokenStep.includes("secrets.HOMEBREW_TAP_PRIVATE_KEY") &&
    tapPreflightAccessStep.includes("repos/conn-castle/homebrew-tap") &&
    captureRollbackStep.includes("AGENT_OUTBOX_GITHUB_RELEASE_ID");
  if (!releasePreparedBeforeDeploy) {
    failures.push(
      ".github/workflows/deploy-production.yml must prepare and byte-verify the exact-candidate draft before production mutation"
    );
  }
  if (!publishReleaseStep.includes("id: publish-release")) {
    failures.push(
      ".github/workflows/deploy-production.yml must publish and prove the exact release only after live verification"
    );
  }
  const cleanupCoversUncommittedRelease =
    cleanupStep.includes("timeout-minutes: 15") &&
    /^\s*timeout-minutes:\s*60\s*$/m.test(deployJob);
  if (!cleanupCoversUncommittedRelease) {
    failures.push(
      ".github/workflows/deploy-production.yml must reconcile uncommitted releases through if: always() cleanup"
    );
  }
  if (
    !uploadWorkerStep.includes("CLERK_SECRET_KEY") ||
    !uploadWorkerStep.includes("STRIPE_SECRET_KEY") ||
    !uploadWorkerStep.includes("SENTRY_DSN") ||
    !uploadWorkerStep.includes("CLOUDFLARE_HYPERDRIVE_ID")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply Worker runtime secrets only to the version upload step"
    );
  }
  for (const [stepName, stepContent] of [
    ["Deploy prior@100 and candidate@0", stagedDeployStep],
    ["Promote candidate to 100%", promoteStep],
    ["Reconcile uncommitted release", cleanupStep]
  ]) {
    if (!stepContent.includes("CLOUDFLARE_API_TOKEN")) {
      failures.push(
        `.github/workflows/deploy-production.yml ${stepName} must supply CLOUDFLARE_API_TOKEN`
      );
    }
    const forbiddenSecrets = trafficOnlyForbiddenSecretNames(stepContent);
    if (forbiddenSecrets.length > 0) {
      failures.push(
        `.github/workflows/deploy-production.yml ${stepName} must not receive unused Worker runtime secrets (${forbiddenSecrets.join(", ")})`
      );
    }
  }
  if (!cleanupStep.includes("SMOKE_OR_CLEANUP_TOKEN")) {
    failures.push(
      ".github/workflows/deploy-production.yml cleanup must supply SMOKE_OR_CLEANUP_TOKEN to prove restored runtime SHA"
    );
  }
  if (!deployReleasePhaseOrderMatches(deployJob)) {
    failures.push(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    );
  }
  if (!deployJob.includes("persist-credentials: false")) {
    failures.push(
      ".github/workflows/deploy-production.yml must disable persisted checkout credentials on the production deploy job"
    );
  }

  return failures;
}

const TRAFFIC_ONLY_FORBIDDEN_SECRET_NAMES = [
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_BROWSER_DSN",
  "SENTRY_RELEASE",
  "CALLER_KEY_HASH_SECRET",
  "CLOUDFLARE_HYPERDRIVE_ID"
];

/** @param {string} stepContent */
function trafficOnlyForbiddenSecretNames(stepContent) {
  return TRAFFIC_ONLY_FORBIDDEN_SECRET_NAMES.filter((name) =>
    stepContent.includes(name)
  );
}

/**
 * @param {string} reconcileWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionReconciliationWorkflow(
  reconcileWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const reconcileJob = workflowJobContent(
    reconcileWorkflowContent,
    "reconcile"
  );
  const reconcileStep = workflowNamedStepContent(
    reconcileJob,
    "Reconcile GitHub and Cloudflare transaction state"
  );
  const required = [
    [
      "manual-only trigger",
      workflowHasLine(reconcileWorkflowContent, /^\s*workflow_dispatch:\s*$/)
    ],
    [
      "production serialization",
      workflowHasLine(
        reconcileWorkflowContent,
        /^\s*group:\s*production-deploy\s*$/
      ) &&
        workflowHasLine(
          reconcileWorkflowContent,
          /^\s*cancel-in-progress:\s*false\s*$/
        )
    ],
    [
      "required reconcile input",
      reconcileWorkflowContent.includes("release_tag:")
    ],
    [
      "current main validation",
      reconcileJob.includes('test "$GITHUB_REF" = "refs/heads/main"')
    ],
    [
      "protected reconcile job",
      /^\s*environment:\s*production\s*$/m.test(reconcileJob) &&
        /^\s*contents:\s*write\s*$/m.test(reconcileWorkflowContent)
    ],
    [
      `Node ${nodeVersion}`,
      workflowHasLine(
        reconcileJob,
        new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
      )
    ],
    [
      "shared reconciler",
      reconcileStep.includes("production-release.mjs reconcile") &&
        reconcileStep.includes("GH_TOKEN: ${{ github.token }}")
    ],
    [
      "traffic-only Cloudflare credentials",
      reconcileStep.includes("CLOUDFLARE_API_TOKEN") &&
        reconcileStep.includes("SMOKE_OR_CLEANUP_TOKEN") &&
        trafficOnlyForbiddenSecretNames(reconcileStep).length === 0
    ],
    [
      "disabled checkout credentials",
      reconcileJob.includes("persist-credentials: false")
    ]
  ];
  for (const [description, present] of required) {
    if (!present) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must include ${description}`
      );
    }
  }
  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        reconcileWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }
  for (const forbiddenMutation of [
    "wrangler deploy",
    "migration:migrate",
    "git tag"
  ]) {
    if (reconcileWorkflowContent.includes(forbiddenMutation)) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must not run ${forbiddenMutation}`
      );
    }
  }
  return failures;
}

/**
 * @param {string} detectWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateAbandonedReleaseDetectionWorkflow(
  detectWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const detectJob = workflowJobContent(detectWorkflowContent, "detect");
  const detectStep = workflowNamedStepContent(
    detectJob,
    "Detect abandoned release drafts"
  );
  if (
    !workflowHasLine(detectWorkflowContent, /^\s*schedule:\s*$/) ||
    !workflowHasLine(detectWorkflowContent, /^\s*workflow_dispatch:\s*$/) ||
    !detectStep.includes("production-release.mjs detect-abandoned") ||
    !detectStep.includes("GH_TOKEN: ${{ github.token }}") ||
    !workflowHasLine(
      detectJob,
      new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
    ) ||
    !workflowHasLine(detectWorkflowContent, /^\s*actions:\s*read\s*$/) ||
    !detectJob.includes("persist-credentials: false")
  ) {
    failures.push(
      ".github/workflows/detect-abandoned-production-release.yml must detect abandoned drafts on a schedule without mutating production"
    );
  }
  if (
    detectWorkflowContent.includes("production-deploy") ||
    detectWorkflowContent.includes("environment: production") ||
    detectWorkflowContent.includes("wrangler") ||
    detectWorkflowContent.includes("migration:migrate")
  ) {
    failures.push(
      ".github/workflows/detect-abandoned-production-release.yml must stay read-only and outside production-deploy concurrency"
    );
  }
  return failures;
}

/**
 * @param {string} rollbackWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionRollbackWorkflow(
  rollbackWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const validateJob = workflowJobContent(
    rollbackWorkflowContent,
    "validate-target"
  );
  const rollbackJob = workflowJobContent(rollbackWorkflowContent, "rollback");
  const requiredTokens = [
    "workflow_dispatch:",
    "environment: production",
    `node-version: ${nodeVersion}`,
    'run: test "$GITHUB_REF" = "refs/heads/main"',
    "group: production-deploy",
    "node scripts/production-release.mjs verify-rollback-version",
    "corepack pnpm exec wrangler rollback",
    "needs.validate-target.outputs.expected_release",
    "corepack pnpm run smoke-runtime"
  ];
  if (
    !requiredTokens.every((token) => rollbackWorkflowContent.includes(token)) ||
    validateJob === "" ||
    rollbackJob === ""
  ) {
    failures.push(
      ".github/workflows/rollback-production.yml must restore and verify a tagged release"
    );
  }
  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        rollbackWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/rollback-production.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }
  return failures;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateMigrationReplayWorkflow(workflowContentsByPath) {
  const failures = [];

  for (const workflowPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-check.yml"
  ]) {
    const content = workflowContentsByPath[workflowPath] ?? "";
    const migrationReplayJob = workflowJobContent(content, "migration-replay");
    const services = workflowMappingBlockContent(
      migrationReplayJob,
      "services",
      4
    );
    const postgresService = workflowMappingBlockContent(
      services,
      "postgres",
      6
    );
    const migrationStep = workflowNamedStepContent(
      migrationReplayJob,
      "Replay migrations from scratch"
    );
    const databaseStep = workflowNamedStepContent(
      migrationReplayJob,
      "Run database verification suite"
    );
    const jobEnvironment = workflowMappingBlockContent(
      migrationReplayJob,
      "env",
      4
    );
    const databaseEnvironment = workflowMappingBlockContent(
      databaseStep,
      "env",
      8
    );
    /** @param {RegExp} pattern */
    const hasJobEnvironment = (pattern) => pattern.test(jobEnvironment);
    /** @param {RegExp} pattern */
    const hasStepEnvironment = (pattern) => pattern.test(databaseEnvironment);
    const requirements = [
      ["a migration-replay job", migrationReplayJob !== ""],
      [
        "a Postgres 17 service in the migration-replay job",
        /^        image:\s*postgres:17\s*$/m.test(postgresService)
      ],
      [
        "make migration-replay in the named replay step",
        workflowRunStepIncludes(migrationStep, "make migration-replay")
      ],
      [
        "make test-database in the named database verification step",
        workflowRunStepIncludes(databaseStep, "make test-database")
      ],
      [
        "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification",
        hasJobEnvironment(
          /^      AGENT_OUTBOX_ENABLE_DATABASE_TESTS:\s*["']?1["']?\s*$/m
        ) ||
          hasStepEnvironment(
            /^          AGENT_OUTBOX_ENABLE_DATABASE_TESTS:\s*["']?1["']?\s*$/m
          )
      ],
      [
        "DATABASE_MIGRATION_URL for database verification",
        hasJobEnvironment(/^      DATABASE_MIGRATION_URL:\s*\S+\s*$/m) ||
          hasStepEnvironment(/^          DATABASE_MIGRATION_URL:\s*\S+\s*$/m)
      ],
      [
        "FLYWAY_DOCKER_NETWORK=host in the migration-replay job",
        /^      FLYWAY_DOCKER_NETWORK:\s*host\s*$/m.test(jobEnvironment)
      ],
      [
        "database verification after migration replay",
        migrationStep !== "" &&
          databaseStep !== "" &&
          migrationReplayJob.indexOf(databaseStep) >
            migrationReplayJob.indexOf(migrationStep)
      ]
    ];

    for (const [description, present] of requirements) {
      if (!present) {
        failures.push(`${workflowPath} must include ${description}`);
      }
    }
  }

  return failures;
}

const HUMAN_ONLY_APPROVAL_LABELS = [
  "megachange-approved",
  "migration-destructive-approved",
  "legal-policy-approved"
];

/**
 * @param {string} content
 * @param {number} indentation
 * @returns {{ kind: "scalar", value: string } | { kind: "mapping", value: string } | null}
 */
function readPermissionsDeclaration(content, indentation) {
  const prefix = " ".repeat(indentation);
  const scalar = content.match(
    new RegExp(`^${prefix}permissions:\\s+(\\S+)\\s*$`, "m")
  );
  if (scalar) {
    return { kind: "scalar", value: scalar[1] ?? "" };
  }
  if (new RegExp(`^${prefix}permissions:\\s*(?:#.*)?$`, "m").test(content)) {
    return {
      kind: "mapping",
      value: workflowMappingBlockContent(content, "permissions", indentation)
    };
  }
  return null;
}

/**
 * @param {{ kind: "scalar", value: string } | { kind: "mapping", value: string }} declaration
 * @returns {boolean}
 */
function permissionsAreReadOnly(declaration) {
  if (declaration.kind === "scalar") {
    return declaration.value === "read-all";
  }
  const lines = declaration.value.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (!/^[A-Za-z0-9_-]+:\s*(read|none)\s*$/.test(trimmed)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} content
 * @param {string} job
 * @returns {boolean}
 */
function policyGatesPermissionsAreReadOnly(content, job) {
  const workflowPerms = readPermissionsDeclaration(content, 0);
  const jobPerms = readPermissionsDeclaration(job, 4);
  if (workflowPerms === null && jobPerms === null) {
    return false;
  }
  if (workflowPerms !== null && !permissionsAreReadOnly(workflowPerms)) {
    return false;
  }
  if (jobPerms !== null && !permissionsAreReadOnly(jobPerms)) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validatePolicyGatesWorkflow(workflowContentsByPath) {
  const failures = [];
  const workflowPath = ".github/workflows/policy-gates.yml";
  const content = workflowContentsByPath[workflowPath] ?? "";
  const job = workflowJobContent(content, "policy-gates");
  const requirements = [
    [
      "a Policy gates workflow name",
      /^name:\s*Policy gates\s*$/m.test(content)
    ],
    [
      "pull_request label retrigger types",
      /^\s+types:\s*\[opened, synchronize, reopened, labeled, unlabeled\]\s*$/m.test(
        content
      )
    ],
    ["a policy-gates job", job !== ""],
    [
      "complete base-to-head changed-path enumeration",
      job.includes("scripts/policy-gates/collect-changed-files.mjs")
    ],
    [
      "megachange evaluation",
      job.includes("scripts/policy-gates/megachange-eval.mjs")
    ],
    [
      "destructive migration scan",
      job.includes("scripts/policy-gates/migration-discipline-scan.mjs")
    ],
    [
      "public legal-policy gate",
      job.includes("scripts/policy-gates/legal-policy-gate.mjs")
    ]
  ];

  for (const [requirement, ok] of requirements) {
    if (!ok) {
      failures.push(`${workflowPath} must include ${requirement}`);
    }
  }

  if (/^\s+push:/m.test(content)) {
    failures.push(`${workflowPath} must not run on push`);
  }

  for (const label of HUMAN_ONLY_APPROVAL_LABELS) {
    if (content.includes(`--add-label ${label}`)) {
      failures.push(
        `${workflowPath} must not apply human-only approval labels`
      );
      break;
    }
  }

  if (!policyGatesPermissionsAreReadOnly(content, job)) {
    failures.push(`${workflowPath} must declare read-only permissions`);
  }

  if (/pulls\/\$\{PR_NUMBER\}\/files/.test(job)) {
    failures.push(
      `${workflowPath} must not use the capped pull request files API`
    );
  }

  return failures;
}

/**
 * @param {PackageJson} packageJson
 * @param {string} makefileContent
 * @returns {string[]}
 */
export function validateDatabaseTestCommand(packageJson, makefileContent) {
  const failures = [];
  const expectedScript = "node --test --test-concurrency=1 tests/*.test.mjs";
  if (packageJson.scripts?.["test:database"] !== expectedScript) {
    failures.push(
      `package.json test:database must be exactly: ${expectedScript}`
    );
  }
  for (const hook of ["pretest:database", "posttest:database"]) {
    if (Object.hasOwn(packageJson.scripts ?? {}, hook)) {
      failures.push(`package.json must not define ${hook}`);
    }
  }

  const targetMatch = makefileContent.match(
    /(?:^|\n)test-database:\s*\n((?:\t[^\n]*(?:\n|$))*)/
  );
  const recipeLines = (targetMatch?.[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.slice(1));
  if (
    recipeLines.length !== 1 ||
    recipeLines[0] !== "corepack pnpm run test:database"
  ) {
    failures.push(
      "Makefile test-database must delegate only to corepack pnpm run test:database"
    );
  }

  return failures;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} commandsContent
 * @returns {string[]}
 */
export function validateCommandsVersionPins(toolchain, commandsContent) {
  const errors = [];
  const pinnedNodeVersions = [
    ...commandsContent.matchAll(/(?:CI provisions|pinned) Node `([^`]+)`/g)
  ].map((match) => match[1]);
  const pnpmVersions = [...commandsContent.matchAll(/pnpm `([^`]+)`/g)].map(
    (match) => match[1]
  );
  const flywayVersions = [...commandsContent.matchAll(/Flyway `([^`]+)`/g)].map(
    (match) => match[1]
  );

  if (pinnedNodeVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned Node version");
  }
  for (const version of pinnedNodeVersions) {
    if (version !== toolchain.node.version) {
      errors.push(
        `COMMANDS.md pinned Node ${version} must match toolchain.json ${toolchain.node.version}`
      );
    }
  }

  if (pnpmVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned pnpm version");
  }
  for (const version of pnpmVersions) {
    if (version !== toolchain.packageManager.version) {
      errors.push(
        `COMMANDS.md pnpm ${version} must match toolchain.json ${toolchain.packageManager.version}`
      );
    }
  }

  if (flywayVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned Flyway version");
  }
  for (const version of flywayVersions) {
    if (version !== toolchain.flyway.version) {
      errors.push(
        `COMMANDS.md Flyway ${version} must match toolchain.json ${toolchain.flyway.version}`
      );
    }
  }

  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} goModContent
 * @returns {string[]}
 */
export function validateGoModuleTooling(toolchain, goModContent) {
  const errors = [];
  const goVersion = toolchain.go.version;

  if (!new RegExp(`^go ${escapeRegExp(goVersion)}$`, "m").test(goModContent)) {
    errors.push(`cli/go.mod go directive must be ${goVersion}`);
  }

  const toolchainMatch = goModContent.match(/^toolchain\s+(\S+)$/m);
  if (toolchainMatch && toolchainMatch[1] !== `go${goVersion}`) {
    errors.push(
      `cli/go.mod toolchain directive must be go${goVersion} when present`
    );
  }

  validateGoModulePin(
    errors,
    goModContent,
    "cobra",
    toolchain.goTooling?.cobra
  );
  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} makefileContent
 * @param {string} goreleaserContent
 * @returns {string[]}
 */
export function validateGoReleaserTooling(
  toolchain,
  makefileContent,
  goreleaserContent
) {
  const tool = toolchain.goTooling?.goreleaser;
  if (!tool?.module || !tool?.version) {
    return ["toolchain.json goTooling.goreleaser module/version is required"];
  }

  const errors = [];
  const expected = `${tool.module}@v${tool.version}`;
  if (!makefileContent.includes(expected)) {
    errors.push(
      `Makefile package-check must use pinned GoReleaser ${expected}`
    );
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) check .goreleaser.yaml"
    )
  ) {
    errors.push("Makefile package-check must validate .goreleaser.yaml");
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) release --snapshot --clean"
    )
  ) {
    errors.push("Makefile package-check must build a clean snapshot release");
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) release --clean --skip=publish"
    )
  ) {
    errors.push(
      "Makefile cli-release-dist must build a clean tagged release without publishing"
    );
  }
  if (
    !makefileContent.includes(
      'cd cli && go run ./internal/tools/rendercask ../dist/homebrew/Casks/agent-outbox.rb "$(RELEASE_TAG)" ../dist/checksums.txt'
    )
  ) {
    errors.push(
      "Makefile cli-release-dist must render the Homebrew cask from release checksums"
    );
  }
  if (
    !makefileContent.includes("release-check: check go-check package-check")
  ) {
    errors.push(
      "Makefile release-check must run check, go-check, and package-check"
    );
  }
  if (
    !yamlTopLevelBlockHasScalar(goreleaserContent, "release", "disable", "true")
  ) {
    errors.push(".goreleaser.yaml must disable release publishing");
  }
  if (/^homebrew_casks:\s*(?:#.*)?$/m.test(goreleaserContent)) {
    errors.push(
      ".goreleaser.yaml must leave Homebrew cask rendering to the project-owned renderer"
    );
  }
  return errors;
}

/**
 * @param {string} content
 * @param {string} blockName
 * @param {string} scalarName
 * @param {string} value
 */
function yamlTopLevelBlockHasScalar(content, blockName, scalarName, value) {
  const lines = content.split(/\r?\n/);
  const startPattern = new RegExp(`^${escapeRegExp(blockName)}:\\s*(?:#.*)?$`);
  const nextTopLevelPattern = /^[A-Za-z0-9_-]+:\s*/;
  const scalarPattern = new RegExp(
    `^\\s*(?:-\\s*)?${escapeRegExp(scalarName)}:\\s*${escapeRegExp(value)}\\s*(?:#.*)?$`
  );
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    return false;
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (nextTopLevelPattern.test(line)) {
      break;
    }
    if (scalarPattern.test(line)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string[]} errors
 * @param {string} goModContent
 * @param {string} key
 * @param {{ module?: string, version?: string } | undefined} tool
 */
function validateGoModulePin(errors, goModContent, key, tool) {
  if (!tool?.module || !tool?.version) {
    errors.push(`toolchain.json goTooling.${key} module/version is required`);
    return;
  }
  const requirePattern = new RegExp(
    `\\b${escapeRegExp(tool.module)}\\s+v${escapeRegExp(tool.version)}\\b`
  );
  if (!requirePattern.test(goModContent)) {
    errors.push(`cli/go.mod must require ${tool.module} v${tool.version}`);
  }
}

/**
 * @param {Toolchain} toolchain
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowGoChecks(toolchain, workflowContentsByPath) {
  const failures = [];
  const setupGoVersion = toolchain.goTooling?.githubActionsSetupGo?.version;
  if (!setupGoVersion) {
    return [
      "toolchain.json goTooling.githubActionsSetupGo.version is required"
    ];
  }

  // release-check.yml runs the Go gate transitively through `make
  // release-check`; validateGoReleaserTooling asserts that Makefile chain.
  // Match the `run:` step form, not the bare token, so the check cannot pass on
  // a workflow that only names the job `make go-check` but no longer runs it.
  const gateTokenByWorkflowPath = {
    ".github/workflows/ci.yml": "run: make go-check",
    ".github/workflows/release-check.yml": "run: make release-check"
  };
  for (const [workflowPath, gateToken] of Object.entries(
    gateTokenByWorkflowPath
  )) {
    const content = workflowContentsByPath[workflowPath] ?? "";
    for (const requiredToken of [
      `uses: actions/setup-go@${setupGoVersion}`,
      "go-version-file: cli/go.mod",
      "cache-dependency-path: cli/go.sum",
      gateToken
    ]) {
      if (!content.includes(requiredToken)) {
        failures.push(
          `${workflowPath} must include Go gate token: ${requiredToken}`
        );
      }
    }
  }

  return failures;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @returns {Record<string, string>}
 */
function readWorkflowContents() {
  /** @type {Record<string, string>} */
  const workflows = {};
  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-check.yml",
    ".github/workflows/policy-gates.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/reconcile-production-release.yml",
    ".github/workflows/detect-abandoned-production-release.yml",
    ".github/workflows/rollback-production.yml"
  ]) {
    workflows[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }
  return workflows;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function runQuiet(command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : null;
  }

  return null;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} expected
 * @param {(output: string) => string} parser
 * @returns {CheckResult}
 */
function versionResult(command, args, expected, parser) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} version check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  const output = `${result.stdout}${result.stderr}`.trim();
  const actual = parser(output);
  if (actual !== expected) {
    return {
      ok: false,
      message: `${command} version ${actual || "unknown"} does not match ${expected}`
    };
  }

  return { ok: true, message: `${command} ${expected}` };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {CheckResult}
 */
function providerAuthResult(command, args) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} auth check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  return { ok: true, message: `${command} auth check passed` };
}

/**
 * @param {Map<string, string> | null} envValues
 * @returns {CheckResult}
 */
function supabaseProjectResult(envValues) {
  const projectRef = envValues?.get("SUPABASE_PROJECT_REF");
  if (!projectRef) {
    return {
      ok: false,
      message:
        "SUPABASE_PROJECT_REF is missing; create the dedicated Agent Outbox Supabase project and set it in .env"
    };
  }

  const result = runQuiet("supabase", ["projects", "list", "--output", "json"]);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: "supabase is not installed" };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `supabase project check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  try {
    if (supabaseProjectsIncludeRef(result.stdout, projectRef)) {
      return {
        ok: true,
        message: "supabase authenticated account can see SUPABASE_PROJECT_REF"
      };
    }
  } catch {
    return {
      ok: false,
      message: "supabase project check returned unreadable JSON"
    };
  }

  return {
    ok: false,
    message:
      "supabase authenticated account cannot see SUPABASE_PROJECT_REF; use the dedicated Agent Outbox Supabase account"
  };
}

function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter(
    (file) => !existsSync(path.join(ROOT, file))
  );
  assert.deepEqual(
    missing,
    [],
    `Missing required files: ${missing.join(", ")}`
  );
}

function checkMakefileSurface() {
  const makefile = readFileSync(path.join(ROOT, "Makefile"), "utf8");
  const targets = [
    "bootstrap",
    "setup",
    "doctor",
    "dev",
    "fix",
    "format",
    "lint",
    "typecheck",
    "test",
    "test-database",
    "browser",
    "build",
    "smoke",
    "smoke-runtime",
    "hosted-health",
    "billing-smoke",
    "migration-validate",
    "migration-migrate",
    "migration-replay",
    "go-build",
    "go-test",
    "go-lint",
    "go-fmt",
    "go-fmt-check",
    "go-check",
    "package-check",
    "check",
    "release-check",
    "clean"
  ];

  const missingTargets = targets.filter(
    (target) => !new RegExp(`(^|\\n)${target}:`).test(makefile)
  );
  assert.deepEqual(
    missingTargets,
    [],
    `Makefile missing targets: ${missingTargets.join(", ")}`
  );
  const databaseTestCommandFailures = validateDatabaseTestCommand(
    /** @type {PackageJson} */ (readJson("package.json")),
    makefile
  );
  assert.deepEqual(
    databaseTestCommandFailures,
    [],
    databaseTestCommandFailures.join("\n")
  );
}

function checkLockfileState() {
  const result = runQuiet("corepack", [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--lockfile-only",
    "--ignore-scripts",
    "--reporter=silent"
  ]);
  assert.equal(
    result.status,
    0,
    `pnpm-lock.yaml is missing or stale (${JSON.stringify(redactCommandResult(result))})`
  );
}

/**
 * @param {string} relativeDir
 * @returns {string[]}
 */
function listSourceFiles(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(relativePath);
    }

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      return [relativePath];
    }

    return [];
  });
}

/**
 * @returns {Record<string, string>}
 */
function readRuntimeProofSourceContents() {
  /** @type {Record<string, string>} */
  const contents = {};

  for (const relativePath of RUNTIME_PROOF_SOURCE_DIRS.flatMap(
    listSourceFiles
  )) {
    contents[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }

  for (const relativePath of RUNTIME_PROOF_SOURCE_FILES) {
    contents[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }

  return contents;
}

/**
 * @returns {Record<string, string>}
 */
function readPhase3FoundationSourceContents() {
  /** @type {Record<string, string>} */
  const contents = {};

  for (const relativePath of Object.keys(PHASE3_FOUNDATION_MARKERS_BY_FILE)) {
    contents[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }

  return contents;
}

/**
 * @returns {Record<string, string>}
 */
function readPhase4ContractDocContents() {
  /** @type {Record<string, string>} */
  const contents = {};

  for (const relativePath of Object.keys(PHASE4_CONTRACT_DOC_MARKERS_BY_FILE)) {
    contents[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }

  return contents;
}

/**
 * @returns {Record<string, string>}
 */
function readImplementedHttpRouteContents() {
  /** @type {Record<string, string>} */
  const contents = {};

  for (const relativePath of listSourceFiles("app/api")) {
    if (!relativePath.endsWith("/route.ts")) {
      continue;
    }

    contents[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }

  return contents;
}

function build() {
  checkRequiredFiles();
  checkMakefileSurface();
  checkLockfileState();

  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const packageJson = /** @type {PackageJson} */ (readJson("package.json"));
  const packageErrors = validateToolchainPackage(toolchain, packageJson);
  assert.deepEqual(packageErrors, [], packageErrors.join("\n"));
  const workflowErrors = validateWorkflowVersionPins(
    toolchain,
    readWorkflowContents()
  );
  assert.deepEqual(workflowErrors, [], workflowErrors.join("\n"));
  const commandsErrors = validateCommandsVersionPins(
    toolchain,
    readFileSync(path.join(ROOT, "docs/agent-layer/COMMANDS.md"), "utf8")
  );
  assert.deepEqual(commandsErrors, [], commandsErrors.join("\n"));
  const goModuleErrors = validateGoModuleTooling(
    toolchain,
    readFileSync(path.join(ROOT, "cli/go.mod"), "utf8")
  );
  assert.deepEqual(goModuleErrors, [], goModuleErrors.join("\n"));
  const goWorkflowErrors = validateWorkflowGoChecks(
    toolchain,
    readWorkflowContents()
  );
  assert.deepEqual(goWorkflowErrors, [], goWorkflowErrors.join("\n"));
  const goreleaserErrors = validateGoReleaserTooling(
    toolchain,
    readFileSync(path.join(ROOT, "Makefile"), "utf8"),
    readFileSync(path.join(ROOT, ".goreleaser.yaml"), "utf8")
  );
  assert.deepEqual(goreleaserErrors, [], goreleaserErrors.join("\n"));

  console.log("Build consistency checks passed.");
}

function smoke() {
  checkRequiredFiles();

  const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const envExampleErrors = validateRequiredEnvExample(envExample);
  assert.deepEqual(envExampleErrors, [], envExampleErrors.join("\n"));
  const requiredNames = requiredEnvNames(envExample);
  assert.ok(requiredNames.includes("DATABASE_URL"));
  assert.ok(requiredNames.includes("CALLER_KEY_HASH_SECRET"));

  const workflowFailures = assertNoForbiddenWorkflowCommands(
    readWorkflowContents()
  );
  assert.deepEqual(workflowFailures, [], workflowFailures.join("\n"));
  const productionDeployWorkflowFailures = validateProductionDeployWorkflow(
    readWorkflowContents()[".github/workflows/deploy-production.yml"],
    /** @type {Toolchain} */ (readJson("toolchain.json")).node.version
  );
  assert.deepEqual(
    productionDeployWorkflowFailures,
    [],
    productionDeployWorkflowFailures.join("\n")
  );
  const productionRollbackWorkflowFailures = validateProductionRollbackWorkflow(
    readWorkflowContents()[".github/workflows/rollback-production.yml"],
    /** @type {Toolchain} */ (readJson("toolchain.json")).node.version
  );
  assert.deepEqual(
    productionRollbackWorkflowFailures,
    [],
    productionRollbackWorkflowFailures.join("\n")
  );
  const productionReconciliationWorkflowFailures =
    validateProductionReconciliationWorkflow(
      readWorkflowContents()[
        ".github/workflows/reconcile-production-release.yml"
      ],
      /** @type {Toolchain} */ (readJson("toolchain.json")).node.version
    );
  assert.deepEqual(
    productionReconciliationWorkflowFailures,
    [],
    productionReconciliationWorkflowFailures.join("\n")
  );
  const abandonedReleaseDetectionWorkflowFailures =
    validateAbandonedReleaseDetectionWorkflow(
      readWorkflowContents()[
        ".github/workflows/detect-abandoned-production-release.yml"
      ],
      /** @type {Toolchain} */ (readJson("toolchain.json")).node.version
    );
  assert.deepEqual(
    abandonedReleaseDetectionWorkflowFailures,
    [],
    abandonedReleaseDetectionWorkflowFailures.join("\n")
  );
  const migrationWorkflowFailures = validateMigrationReplayWorkflow(
    readWorkflowContents()
  );
  assert.deepEqual(
    migrationWorkflowFailures,
    [],
    migrationWorkflowFailures.join("\n")
  );
  const policyGatesWorkflowFailures = validatePolicyGatesWorkflow(
    readWorkflowContents()
  );
  assert.deepEqual(
    policyGatesWorkflowFailures,
    [],
    policyGatesWorkflowFailures.join("\n")
  );

  const scopeFailures = validateRuntimeProofScope(
    readRuntimeProofSourceContents()
  );
  assert.deepEqual(scopeFailures, [], scopeFailures.join("\n"));

  const phase3FoundationFailures = validatePhase3FoundationSourceContents(
    readPhase3FoundationSourceContents()
  );
  assert.deepEqual(
    phase3FoundationFailures,
    [],
    phase3FoundationFailures.join("\n")
  );

  const phase4ContractDocFailures = validatePhase4ContractDocContents({
    ...readPhase4ContractDocContents(),
    ...readImplementedHttpRouteContents()
  });
  assert.deepEqual(
    phase4ContractDocFailures,
    [],
    phase4ContractDocFailures.join("\n")
  );
  const cronScheduleFailures = validateWranglerCronSchedule(
    readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"),
    RUNTIME_CRON_SCHEDULE
  );
  assert.deepEqual(cronScheduleFailures, [], cronScheduleFailures.join("\n"));
  const requiredSecretFailures = validateWranglerRequiredSecrets(
    readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")
  );
  assert.deepEqual(
    requiredSecretFailures,
    [],
    requiredSecretFailures.join("\n")
  );

  console.log("Structural smoke checks passed.");
}

function doctor() {
  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const checks = [];

  checks.push(
    versionResult(
      "node",
      ["--version"],
      `v${toolchain.node.version}`,
      (output) => output.split(/\s+/)[0]
    )
  );
  checks.push(
    versionResult(
      "go",
      ["version"],
      `go${toolchain.go.version}`,
      (output) => output.match(/go\d+\.\d+\.\d+/)?.[0] ?? ""
    )
  );
  checks.push(
    versionResult(
      "pnpm",
      ["--version"],
      toolchain.packageManager.version,
      (output) => output.split(/\s+/)[0]
    )
  );

  for (const [name, cli] of Object.entries(toolchain.providerCli)) {
    if (name === "stripe") {
      checks.push(
        versionResult(
          "stripe",
          ["version"],
          cli.version,
          (output) => output.match(/\d+\.\d+\.\d+/)?.[0] ?? ""
        )
      );
    } else {
      checks.push(
        versionResult(
          cli.authCheck[0],
          ["--version"],
          cli.version,
          (output) => output.match(/\d+\.\d+\.\d+/)?.[0] ?? ""
        )
      );
    }
  }

  const examplePath = path.join(ROOT, ".env.example");
  const envPath = path.join(ROOT, ".env");
  /** @type {Map<string, string> | null} */
  let envValues = null;
  if (!existsSync(envPath)) {
    checks.push({
      ok: false,
      message: ".env is missing; copy .env.example to .env"
    });
  } else {
    const actualEnv = readFileSync(envPath, "utf8");
    envValues = parseEnv(actualEnv);
    const missing = missingEnvNames(
      readFileSync(examplePath, "utf8"),
      actualEnv
    );
    checks.push(
      missing.length === 0
        ? { ok: true, message: ".env defines every required variable name" }
        : {
            ok: false,
            message: `.env missing required values: ${missing.join(", ")}`
          }
    );
  }

  for (const cli of Object.values(toolchain.providerCli)) {
    checks.push(providerAuthResult(cli.authCheck[0], cli.authCheck.slice(1)));
  }
  checks.push(supabaseProjectResult(envValues));

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.message}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function clean() {
  const generated = [
    "coverage",
    "dist",
    "build",
    ".next",
    ".open-next",
    ".turbo",
    ".wrangler",
    "test-results",
    "playwright-report",
    "tsconfig.tsbuildinfo"
  ];
  for (const relativePath of generated) {
    rmSync(path.join(ROOT, relativePath), { force: true, recursive: true });
  }
  console.log("Removed reproducible generated artifacts only.");
}

function main() {
  const command = process.argv[2];

  if (command === "build") {
    build();
  } else if (command === "smoke") {
    smoke();
  } else if (command === "doctor") {
    doctor();
  } else if (command === "clean") {
    clean();
  } else {
    console.error(
      "Usage: node scripts/foundation.mjs <build|smoke|doctor|clean>"
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
