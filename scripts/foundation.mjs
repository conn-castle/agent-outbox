import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CRON_SCHEDULE } from "../src/server/scheduled.ts";
import { parseEnv } from "./dotenv.mjs";
import { ROOT } from "./repo-root.mjs";
import {
  assertNoForbiddenWorkflowCommands,
  CI_WORKFLOW_PATHS,
  validateBrowserWorkflow,
  validateDatabaseTestCommand,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
  validateRequiredPullRequestChecks,
  validateReleaseCheckJob,
  validateWorkflowConcurrency,
  validateWorkflowGoChecks,
  validateWorkflowVersionPins
} from "./foundation/ci-workflows.mjs";
import { redactCommandResult, runQuiet } from "./foundation/commands.mjs";
import {
  firstVersionToken,
  goVersionFromOutput,
  providerAuthResult,
  semanticVersionFromOutput,
  supabaseProjectResult,
  versionResult
} from "./foundation/doctor.mjs";
import {
  missingEnvNames,
  requiredEnvNames,
  validateRequiredEnvExample
} from "./foundation/environment.mjs";
import {
  listSourceFiles,
  readJson,
  readPathContents,
  readText
} from "./foundation/repository.mjs";
import {
  PHASE3_FOUNDATION_SOURCE_FILES,
  PHASE4_CONTRACT_DOC_FILES,
  RUNTIME_PROOF_SOURCE_DIRS,
  RUNTIME_PROOF_SOURCE_FILES,
  validatePhase4ContractDocContents,
  validateRuntimeProofScope
} from "./foundation/source-contracts.mjs";
import {
  validateCommandsVersionPins,
  validateGoModuleTooling,
  validateGoReleaserTooling,
  validateToolchainPackage
} from "./foundation/toolchain.mjs";
import {
  validateWranglerCronSchedule,
  validateWranglerRequiredSecrets
} from "./foundation/wrangler-contracts.mjs";
import {
  ABANDONED_RELEASE_DETECTION_WORKFLOW_PATH,
  PRODUCTION_DEPLOY_WORKFLOW_PATH,
  PRODUCTION_RECONCILE_WORKFLOW_PATH,
  PRODUCTION_ROLLBACK_WORKFLOW_PATH,
  RELEASE_WORKFLOW_PATHS,
  validateAbandonedReleaseDetectionWorkflow,
  validateProductionDeployWorkflow,
  validateProductionReconciliationWorkflow,
  validateProductionRollbackWorkflow
} from "./release/workflow-contract.mjs";

/** @typedef {import("./foundation/toolchain.mjs").PackageJson} PackageJson */
/** @typedef {import("./foundation/toolchain.mjs").Toolchain} Toolchain */

const REQUIRED_FILES = [
  ...new Set([
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
    "scripts/repo-root.mjs",
    "scripts/dotenv.mjs",
    "scripts/regex.mjs",
    "scripts/workflow-yaml.mjs",
    "scripts/foundation/environment.mjs",
    "scripts/foundation/toolchain.mjs",
    "scripts/foundation/source-contracts.mjs",
    "scripts/foundation/wrangler-contracts.mjs",
    "scripts/foundation/ci-workflows.mjs",
    "scripts/foundation/commands.mjs",
    "scripts/foundation/doctor.mjs",
    "scripts/foundation/repository.mjs",
    "scripts/release/identity.mjs",
    "scripts/release/order.mjs",
    "scripts/release/workflow-contract.mjs",
    "scripts/worker-deploy.mjs",
    "scripts/runtime-smoke.mjs",
    "scripts/hosted-health.mjs",
    "scripts/hosted-checks.mjs",
    "scripts/billing-smoke.mjs",
    ".env.example",
    "next.config.ts",
    ...RUNTIME_PROOF_SOURCE_FILES,
    "app/layout.tsx",
    "app/page.tsx",
    "app/api/runtime/canary/route.ts",
    ...PHASE3_FOUNDATION_SOURCE_FILES,
    "src/server/logging.ts",
    "src/server/scheduled.ts",
    "db/migrations/V20260703223000__output_file_size_invariant.sql",
    ...PHASE4_CONTRACT_DOC_FILES,
    "docs/agent-layer/COMMANDS.md",
    "docs/ops/migrations.md",
    "scripts/flyway.mjs",
    ...CI_WORKFLOW_PATHS,
    ...RELEASE_WORKFLOW_PATHS
  ])
];

/**
 * @returns {Record<string, string>}
 */
function readWorkflowContents() {
  return readPathContents([...CI_WORKFLOW_PATHS, ...RELEASE_WORKFLOW_PATHS]);
}

/**
 * @returns {Record<string, string>}
 */
function readRuntimeProofSourceContents() {
  const relativePaths = [
    ...RUNTIME_PROOF_SOURCE_DIRS.flatMap(listSourceFiles),
    ...RUNTIME_PROOF_SOURCE_FILES
  ];
  return readPathContents(relativePaths);
}

/**
 * @returns {Record<string, string>}
 */
function readImplementedHttpRouteContents() {
  return readPathContents(
    listSourceFiles("app/api").filter((relativePath) =>
      relativePath.endsWith("/route.ts")
    )
  );
}

/**
 * Throws an AssertionError containing the ordered failures when any are present.
 *
 * @param {string[]} failures
 */
function assertNoFailures(failures) {
  assert.deepEqual(failures, [], failures.join("\n"));
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

/**
 * Asserts that required Makefile targets and the database test command exist.
 */
function checkMakefileSurface() {
  const makefile = readText("Makefile");
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
  assertNoFailures(
    validateDatabaseTestCommand(
      /** @type {PackageJson} */ (readJson("package.json")),
      makefile
    )
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
 * Validates required files, build commands, and toolchain pins, stopping at the
 * first failed assertion.
 */
function build() {
  checkRequiredFiles();
  checkMakefileSurface();
  checkLockfileState();

  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const packageJson = /** @type {PackageJson} */ (readJson("package.json"));
  const workflows = readWorkflowContents();
  assertNoFailures(validateToolchainPackage(toolchain, packageJson));
  assertNoFailures(validateWorkflowVersionPins(toolchain, workflows));
  assertNoFailures(
    validateCommandsVersionPins(
      toolchain,
      readText("docs/agent-layer/COMMANDS.md")
    )
  );
  assertNoFailures(validateGoModuleTooling(toolchain, readText("cli/go.mod")));
  assertNoFailures(validateWorkflowGoChecks(toolchain, workflows));
  assertNoFailures(
    validateGoReleaserTooling(
      toolchain,
      readText("Makefile"),
      readText(".goreleaser.yaml")
    )
  );

  console.log("Build consistency checks passed.");
}

/**
 * Validates repository structure, workflows, and runtime contracts without
 * provider credentials, stopping at the first failed assertion.
 */
function smoke() {
  checkRequiredFiles();

  const envExample = readText(".env.example");
  assertNoFailures(validateRequiredEnvExample(envExample));
  const requiredNames = requiredEnvNames(envExample);
  assert.ok(requiredNames.includes("DATABASE_URL"));
  assert.ok(requiredNames.includes("CALLER_KEY_HASH_SECRET"));

  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const workflows = readWorkflowContents();
  const nodeVersion = toolchain.node.version;
  const wranglerConfig = readText("wrangler.jsonc");

  assertNoFailures(assertNoForbiddenWorkflowCommands(workflows));
  for (const [validateReleaseWorkflow, workflowPath] of /** @type {const} */ ([
    [validateProductionDeployWorkflow, PRODUCTION_DEPLOY_WORKFLOW_PATH],
    [validateProductionRollbackWorkflow, PRODUCTION_ROLLBACK_WORKFLOW_PATH],
    [
      validateProductionReconciliationWorkflow,
      PRODUCTION_RECONCILE_WORKFLOW_PATH
    ],
    [
      validateAbandonedReleaseDetectionWorkflow,
      ABANDONED_RELEASE_DETECTION_WORKFLOW_PATH
    ]
  ])) {
    assertNoFailures(
      validateReleaseWorkflow(workflows[workflowPath], nodeVersion)
    );
  }
  assertNoFailures(validateMigrationReplayWorkflow(workflows));
  assertNoFailures(validatePolicyGatesWorkflow(workflows));
  const allWorkflows = readPathContents(
    readdirSync(path.join(ROOT, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`)
  );
  assertNoFailures(validateRequiredPullRequestChecks(allWorkflows));
  assertNoFailures(validateReleaseCheckJob(workflows, readText("Makefile")));
  assertNoFailures(
    validateBrowserWorkflow(workflows, readText("playwright.config.ts"))
  );
  assertNoFailures(validateWorkflowConcurrency(workflows));

  assertNoFailures(validateRuntimeProofScope(readRuntimeProofSourceContents()));

  assertNoFailures(
    validatePhase4ContractDocContents({
      ...readPathContents(PHASE4_CONTRACT_DOC_FILES),
      ...readImplementedHttpRouteContents()
    })
  );
  assertNoFailures(
    validateWranglerCronSchedule(wranglerConfig, RUNTIME_CRON_SCHEDULE)
  );
  assertNoFailures(validateWranglerRequiredSecrets(wranglerConfig));

  console.log("Structural smoke checks passed.");
}

/**
 * Reports tool versions, required environment values, and provider access in
 * check order, setting exit code 1 if any check fails.
 */
function doctor() {
  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const checks = [];

  checks.push(
    versionResult(
      "node",
      ["--version"],
      `v${toolchain.node.version}`,
      firstVersionToken
    )
  );
  checks.push(
    versionResult(
      "go",
      ["version"],
      `go${toolchain.go.version}`,
      goVersionFromOutput
    )
  );
  checks.push(
    versionResult(
      "pnpm",
      ["--version"],
      toolchain.packageManager.version,
      firstVersionToken
    )
  );

  for (const [name, cli] of Object.entries(toolchain.providerCli)) {
    const command = name === "stripe" ? "stripe" : cli.authCheck[0];
    const args = name === "stripe" ? ["version"] : ["--version"];
    checks.push(
      versionResult(command, args, cli.version, semanticVersionFromOutput)
    );
  }

  const envPath = path.join(ROOT, ".env");
  /** @type {Map<string, string> | null} */
  let envValues = null;
  if (!existsSync(envPath)) {
    checks.push({
      ok: false,
      message: ".env is missing; copy .env.example to .env"
    });
  } else {
    const actualEnv = readText(".env");
    envValues = parseEnv(actualEnv);
    const missing = missingEnvNames(readText(".env.example"), actualEnv);
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
    ".next-browser",
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
