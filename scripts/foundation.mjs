import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CRON_SCHEDULE } from "../src/server/scheduled.ts";
import { parseEnv } from "./dotenv.mjs";
import { ROOT } from "./repo-root.mjs";
import {
  assertNoForbiddenWorkflowCommands,
  CI_WORKFLOW_PATHS,
  validateDatabaseTestCommand,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
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
function readPhase4ContractDocContents() {
  return readPathContents(PHASE4_CONTRACT_DOC_FILES);
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

function build() {
  checkRequiredFiles();
  checkMakefileSurface();
  checkLockfileState();

  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const packageJson = /** @type {PackageJson} */ (readJson("package.json"));
  const workflows = readWorkflowContents();
  const packageErrors = validateToolchainPackage(toolchain, packageJson);
  assert.deepEqual(packageErrors, [], packageErrors.join("\n"));
  const workflowErrors = validateWorkflowVersionPins(toolchain, workflows);
  assert.deepEqual(workflowErrors, [], workflowErrors.join("\n"));
  const commandsErrors = validateCommandsVersionPins(
    toolchain,
    readText("docs/agent-layer/COMMANDS.md")
  );
  assert.deepEqual(commandsErrors, [], commandsErrors.join("\n"));
  const goModuleErrors = validateGoModuleTooling(
    toolchain,
    readText("cli/go.mod")
  );
  assert.deepEqual(goModuleErrors, [], goModuleErrors.join("\n"));
  const goWorkflowErrors = validateWorkflowGoChecks(toolchain, workflows);
  assert.deepEqual(goWorkflowErrors, [], goWorkflowErrors.join("\n"));
  const goreleaserErrors = validateGoReleaserTooling(
    toolchain,
    readText("Makefile"),
    readText(".goreleaser.yaml")
  );
  assert.deepEqual(goreleaserErrors, [], goreleaserErrors.join("\n"));

  console.log("Build consistency checks passed.");
}

function smoke() {
  checkRequiredFiles();

  const envExample = readText(".env.example");
  const envExampleErrors = validateRequiredEnvExample(envExample);
  assert.deepEqual(envExampleErrors, [], envExampleErrors.join("\n"));
  const requiredNames = requiredEnvNames(envExample);
  assert.ok(requiredNames.includes("DATABASE_URL"));
  assert.ok(requiredNames.includes("CALLER_KEY_HASH_SECRET"));

  const toolchain = /** @type {Toolchain} */ (readJson("toolchain.json"));
  const workflows = readWorkflowContents();
  const nodeVersion = toolchain.node.version;
  const wranglerConfig = readText("wrangler.jsonc");

  const workflowFailures = assertNoForbiddenWorkflowCommands(workflows);
  assert.deepEqual(workflowFailures, [], workflowFailures.join("\n"));
  const productionDeployWorkflowFailures = validateProductionDeployWorkflow(
    workflows[PRODUCTION_DEPLOY_WORKFLOW_PATH],
    nodeVersion
  );
  assert.deepEqual(
    productionDeployWorkflowFailures,
    [],
    productionDeployWorkflowFailures.join("\n")
  );
  const productionRollbackWorkflowFailures = validateProductionRollbackWorkflow(
    workflows[PRODUCTION_ROLLBACK_WORKFLOW_PATH],
    nodeVersion
  );
  assert.deepEqual(
    productionRollbackWorkflowFailures,
    [],
    productionRollbackWorkflowFailures.join("\n")
  );
  const productionReconciliationWorkflowFailures =
    validateProductionReconciliationWorkflow(
      workflows[PRODUCTION_RECONCILE_WORKFLOW_PATH],
      nodeVersion
    );
  assert.deepEqual(
    productionReconciliationWorkflowFailures,
    [],
    productionReconciliationWorkflowFailures.join("\n")
  );
  const abandonedReleaseDetectionWorkflowFailures =
    validateAbandonedReleaseDetectionWorkflow(
      workflows[ABANDONED_RELEASE_DETECTION_WORKFLOW_PATH],
      nodeVersion
    );
  assert.deepEqual(
    abandonedReleaseDetectionWorkflowFailures,
    [],
    abandonedReleaseDetectionWorkflowFailures.join("\n")
  );
  const migrationWorkflowFailures = validateMigrationReplayWorkflow(workflows);
  assert.deepEqual(
    migrationWorkflowFailures,
    [],
    migrationWorkflowFailures.join("\n")
  );
  const policyGatesWorkflowFailures = validatePolicyGatesWorkflow(workflows);
  assert.deepEqual(
    policyGatesWorkflowFailures,
    [],
    policyGatesWorkflowFailures.join("\n")
  );

  const scopeFailures = validateRuntimeProofScope(
    readRuntimeProofSourceContents()
  );
  assert.deepEqual(scopeFailures, [], scopeFailures.join("\n"));

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
    wranglerConfig,
    RUNTIME_CRON_SCHEDULE
  );
  assert.deepEqual(cronScheduleFailures, [], cronScheduleFailures.join("\n"));
  const requiredSecretFailures =
    validateWranglerRequiredSecrets(wranglerConfig);
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
    if (name === "stripe") {
      checks.push(
        versionResult(
          "stripe",
          ["version"],
          cli.version,
          semanticVersionFromOutput
        )
      );
    } else {
      checks.push(
        versionResult(
          cli.authCheck[0],
          ["--version"],
          cli.version,
          semanticVersionFromOutput
        )
      );
    }
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
