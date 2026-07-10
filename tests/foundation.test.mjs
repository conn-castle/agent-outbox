import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import {
  assertNoForbiddenWorkflowCommands,
  extractDocumentedHttpContractRouteMarkers,
  extractImplementedHttpContractRouteMarkers,
  missingEnvNames,
  redactCommandResult,
  runQuiet,
  supabaseProjectsIncludeRef,
  validateCommandsVersionPins,
  validateGoReleaserTooling,
  validateGoModuleTooling,
  validateMigrationReplayWorkflow,
  validatePhase3FoundationSourceContents,
  validatePhase4ContractDocContents,
  validateRequiredEnvExample,
  validateRuntimeProofScope,
  validateToolchainPackage,
  validateProductionDeployWorkflow,
  validateWorkflowGoChecks,
  validateWranglerCronSchedule,
  validateWranglerRequiredSecrets,
  validateWorkflowVersionPins
} from "../scripts/foundation.mjs";
import {
  REQUIRED_PUBLIC_VAR_NAMES as WORKER_DEPLOY_PUBLIC_VAR_NAMES,
  REQUIRED_SECRET_NAMES as WORKER_DEPLOY_SECRET_NAMES,
  buildWranglerDeployArgsWithConfig,
  buildWranglerDeployArgs,
  runWorkerDeploy,
  secretsDotenvContent,
  validateWorkerDeployEnvironment,
  workerBuildEnvironment,
  wranglerDeployEnvironment,
  wranglerConfigWithHyperdrive
} from "../scripts/worker-deploy.mjs";
import {
  DATABASE_CONNECTION_MODE_HYPERDRIVE,
  DATABASE_CONNECTION_MODE_VAR,
  DATABASE_HYPERDRIVE_BINDING,
  runtimeDatabaseConnectionString,
  runtimeDatabaseEnv
} from "../worker/hyperdrive.mjs";
import { readRuntimeSmokeEnv } from "../scripts/runtime-smoke.mjs";
import {
  flywayDockerEnvironmentNames,
  flywayEnvironmentFromConnection,
  flywayConnectionFromDatabaseUrl,
  validateMigrationFilenames
} from "../scripts/flyway.mjs";
import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  generateCallerApiKeyMaterial,
  parseCallerApiKey,
  parseCallerBearerApiKey,
  storedCallerCredentialDigestFromLookupRow,
  validateCallerBearer
} from "../src/server/caller-auth.ts";
import { callerCredentialLastUsedStatement } from "../src/server/caller-api-auth.ts";
import {
  authorizeAccountMembership,
  authorizeCallerAccount
} from "../src/server/authorization.ts";
import {
  runProductTransaction,
  transactionContextCanaryStatements as databaseCanaryStatements
} from "../src/server/database.ts";
import {
  InsecureServerEnvironmentError,
  MissingServerEnvironmentError,
  runtimeConfigStatus
} from "../src/server/env.ts";
import {
  accountLimitStatusMetadata,
  doctorLimitMetadata,
  fileUploadEnabled,
  getLimitDefinition,
  limitErrorMetadata
} from "../src/server/limits.ts";
import { runtimeCanaryResponseBody } from "../src/server/runtime-canary.ts";
import {
  activeLimitBlockMetadata,
  auditSafeLifecycleEvent,
  consumesMonthlyCallerApiRequestQuota,
  quotaWindowKey,
  storedByteAccounting
} from "../src/server/accounting.ts";
import {
  accountQuotaWindowMaintenanceStatement,
  activeLimitMaintenanceStatement,
  callerSetupCleanupCutoff,
  duplicateAcknowledgementLookupStatement,
  downgradeGraceExpiryStatement,
  expiredBillingGraceDowngradeStatement,
  globalQuotaWindowMaintenanceStatements,
  neverActivatedCallerPruningStatement,
  outputTimeoutCleanupStatement,
  pendingInputRetentionStatement,
  preReadUndoStatement,
  quotaWindowMaintenanceStatements,
  quotaWindowPruningCutoff,
  quotaWindowPruningStatement,
  terminalOutputDeletionStatement
} from "../src/server/cleanup.ts";
import { safeErrorName, safeLogEvent } from "../src/server/logging.ts";
import {
  cleanupAccountTargetsStatement,
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary,
  runScheduledCleanup,
  scheduledCleanupStatementsForAccount
} from "../src/server/scheduled.ts";
import { sentryCaptureEnabled } from "../src/server/sentry.ts";

const { Client } = pg;

// A 32-character secret that satisfies CALLER_KEY_HASH_SECRET_MIN_LENGTH.
const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";
const FLYWAY_TOOLCHAIN_FIXTURE = {
  version: "12.10.0",
  image: "flyway/flyway",
  source: "test"
};

/**
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
function workerDeployEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    CLOUDFLARE_API_TOKEN: "cf-worker-token",
    CLOUDFLARE_HYPERDRIVE_ID: "hyperdrive-test-id",
    CLERK_SECRET_KEY: "sk_test_clerk",
    SENTRY_DSN: "https://public@example.invalid/1",
    CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE,
    SMOKE_OR_CLEANUP_TOKEN: "runtime-smoke-token",
    STRIPE_SECRET_KEY: "sk_live_runtime",
    STRIPE_WEBHOOK_SECRET: "whsec_runtime",
    APP_ENV: "production",
    APP_BASE_URL: "https://app.agent-outbox.dev",
    PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev",
    SENTRY_RELEASE: "agent-outbox@2026.07.08",
    CLERK_PUBLISHABLE_KEY: "pk_live_clerk",
    SENTRY_BROWSER_DSN: "https://browser@example.invalid/2",
    STRIPE_PAID_MONTHLY_PRICE_ID: "price_monthly",
    STRIPE_PAID_YEARLY_PRICE_ID: "price_yearly",
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_runtime",
    ...overrides
  };
}

/**
 * @param {Record<string, string | undefined>} values
 * @param {() => void} callback
 */
function withProcessEnv(values, callback) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * @param {import("pg").Client} client
 */
async function resetRoleAndRollback(client) {
  for (const sql of ["rollback", "reset role"]) {
    try {
      await client.query(sql);
    } catch {
      // Best effort cleanup after failed database verification.
    }
  }
}

/**
 * @param {import("pg").Client} client
 */
async function revokeCurrentUserAppRoleGrant(client) {
  await client.query(
    `
      do $$
      begin
        execute format('revoke agent_outbox_app from %I', current_user);
      end
      $$;
    `
  );
}

/**
 * @param {import("pg").Client} client
 * @param {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string, ipQuotaAddress?: string }} ids
 */
async function cleanupPhase3DatabaseVerificationRows(client, ids) {
  if (
    !ids.accountA &&
    !ids.accountB &&
    !ids.accountAuditA &&
    !ids.accountAuditB &&
    !ids.userA &&
    !ids.ipQuotaAddress
  ) {
    return;
  }

  await client.query("begin");

  try {
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.audit_break_glass",
      "on"
    ]);

    if (ids.accountAuditA || ids.accountAuditB) {
      await client.query(
        `
          delete from public.agent_outbox_audit_events
          where account_audit_id = any($1::uuid[])
        `,
        [[ids.accountAuditA, ids.accountAuditB].filter(Boolean)]
      );
    }

    if (ids.ipQuotaAddress) {
      await client.query(
        `
          delete from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
        `,
        [ids.ipQuotaAddress]
      );
    }

    if (ids.accountA || ids.accountB) {
      await client.query(
        `
          delete from public.agent_outbox_accounts
          where account_id = any($1::uuid[])
        `,
        [[ids.accountA, ids.accountB].filter(Boolean)]
      );
    }

    if (ids.userA) {
      await client.query(
        `
          delete from public.agent_outbox_users
          where user_id = $1
        `,
        [ids.userA]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

const initialMigration = readFileSync(
  new URL(
    "../db/migrations/V20260630000000__initial_schema.sql",
    import.meta.url
  ),
  "utf8"
);

const outputFileSizeInvariantMigration = readFileSync(
  new URL(
    "../db/migrations/V20260703223000__output_file_size_invariant.sql",
    import.meta.url
  ),
  "utf8"
);

const scheduledCleanupAccountTargetsMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123745__scheduled_cleanup_account_targets.sql",
    import.meta.url
  ),
  "utf8"
);

const outputFileSingleRowInvariantMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123815__output_file_single_row_invariant.sql",
    import.meta.url
  ),
  "utf8"
);

const outputOperationAuthMatrixMigration = readFileSync(
  new URL(
    "../db/migrations/V20260704123900__output_operation_auth_matrix.sql",
    import.meta.url
  ),
  "utf8"
);

const neverActivatedCallerPruneMigration = readFileSync(
  new URL(
    "../db/migrations/V20260705040000__prune_never_activated_callers.sql",
    import.meta.url
  ),
  "utf8"
);

const phase3FoundationSourceContents = Object.fromEntries(
  [
    "src/server/accounting.ts",
    "src/server/authorization.ts",
    "src/server/caller-auth.ts",
    "src/server/cleanup.ts",
    "src/server/database.ts",
    "src/server/limits.ts",
    "db/migrations/V20260630000000__initial_schema.sql"
  ].map((relativePath) => [
    relativePath,
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
  ])
);

const phase4ContractDocContents = Object.fromEntries(
  [
    "docs/spec/README.md",
    "docs/spec/http-api.md",
    "docs/spec/input-schema.md",
    "docs/spec/output-schema.md",
    "docs/spec/errors.md"
  ].map((relativePath) => [
    relativePath,
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
  ])
);

const callerFacingRouteContents = Object.fromEntries(
  [
    "app/api/account/status/route.ts",
    "app/api/caller/status/route.ts",
    "app/api/input/delete/route.ts",
    "app/api/input/replace/route.ts",
    "app/api/input/send/route.ts",
    "app/api/output/[output_result_id]/ack/route.ts",
    "app/api/output/[output_result_id]/files/[file_id]/route.ts",
    "app/api/output/[output_result_id]/read/route.ts",
    "app/api/output/check/route.ts",
    "app/api/output/read-all/route.ts",
    "app/api/runtime/canary/route.ts"
  ].map((relativePath) => [
    relativePath,
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
  ])
);

const phase3ProductTables = [
  "agent_outbox_accounts",
  "agent_outbox_users",
  "agent_outbox_account_members",
  "agent_outbox_callers",
  "agent_outbox_caller_credentials",
  "agent_outbox_input_items",
  "agent_outbox_input_link_buttons",
  "agent_outbox_input_actions",
  "agent_outbox_input_action_popup_options",
  "agent_outbox_output_results",
  "agent_outbox_output_files",
  "agent_outbox_audit_events",
  "agent_outbox_account_quota_windows",
  "agent_outbox_account_limit_blocks",
  "agent_outbox_cleanup_runs"
];

const databaseTestsEnabled =
  process.env.AGENT_OUTBOX_ENABLE_DATABASE_TESTS === "1";
const phase3DatabaseVerificationUrl = databaseTestsEnabled
  ? process.env.DATABASE_MIGRATION_URL
  : undefined;

if (databaseTestsEnabled) {
  assert.ok(
    phase3DatabaseVerificationUrl,
    "DATABASE_MIGRATION_URL is required when AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1"
  );
}

test("missingEnvNames reports names without exposing configured secret values", () => {
  const example =
    "DATABASE_URL=\nAWS_PROFILE=\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";
  const actual =
    "DATABASE_URL=postgres://user:password@example/db\nAWS_PROFILE=\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";

  assert.deepEqual(missingEnvNames(example, actual), [
    "CALLER_KEY_HASH_SECRET"
  ]);
});

test("runtime smoke loads an explicit operator env file before root .env", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-runtime-smoke-root-")
  );
  const explicitDir = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-runtime-smoke-env-")
  );
  const explicitEnvPath = path.join(explicitDir, "production-smoke.env");

  try {
    writeFileSync(path.join(root, ".env"), "APP_BASE_URL=http://localhost\n");
    writeFileSync(
      explicitEnvPath,
      "APP_BASE_URL=https://app.agent-outbox.dev\nSMOKE_OR_CLEANUP_TOKEN=smoke-token\n"
    );

    assert.equal(
      readRuntimeSmokeEnv({ env: {}, root }).get("APP_BASE_URL"),
      "http://localhost"
    );
    const explicitValues = readRuntimeSmokeEnv({
      env: { AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: explicitEnvPath },
      root
    });
    assert.equal(
      explicitValues.get("APP_BASE_URL"),
      "https://app.agent-outbox.dev"
    );
    assert.equal(explicitValues.get("SMOKE_OR_CLEANUP_TOKEN"), "smoke-token");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(explicitDir, { force: true, recursive: true });
  }
});

test("runtime smoke fails loudly when an explicit operator env file is missing", () => {
  const missingEnvPath = path.join(
    os.tmpdir(),
    `agent-outbox-missing-smoke-${process.pid}.env`
  );

  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: { AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: missingEnvPath }
      }),
    {
      message: `Runtime smoke env file does not exist: ${missingEnvPath}`
    }
  );
});

test("redactCommandResult excludes stdout and stderr from failed provider checks", () => {
  const result = redactCommandResult({
    status: 1,
    signal: null,
    stdout: "account@example.com",
    stderr: "token sk_test_secret"
  });

  assert.deepEqual(result, { status: 1, signal: null, error: null });
});

test("runQuiet times out stuck provider commands without exposing command output", () => {
  const result = runQuiet(
    process.execPath,
    ["-e", "console.log('account@example.com'); setTimeout(() => {}, 1000);"],
    25
  );

  assert.deepEqual(redactCommandResult(result), {
    status: null,
    signal: "SIGTERM",
    error: "ETIMEDOUT"
  });
});

test("supabaseProjectsIncludeRef checks project refs without exposing project output", () => {
  const projectsJson = JSON.stringify([
    { id: "not-agent-outbox", name: "Other" },
    { id: "agent-outbox-ref", name: "Agent Outbox" }
  ]);

  assert.equal(
    supabaseProjectsIncludeRef(projectsJson, "agent-outbox-ref"),
    true
  );
  assert.equal(supabaseProjectsIncludeRef(projectsJson, "missing-ref"), false);
});

test("validateToolchainPackage accepts runtime dependencies only when toolchain-pinned", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
    },
    runtimePins: {
      next: { package: "next", version: "16.2.9" }
    },
    runtimeDevTools: {
      pgTypes: { package: "@types/pg", version: "8.20.0" }
    },
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: { next: "16.2.9" },
    devDependencies: {
      "@types/pg": "8.20.0",
      prettier: "3.9.3"
    }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), []);
});

test("validateToolchainPackage rejects provider CLIs without auth checks", () => {
  const toolchain = /** @type {any} */ ({
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {
      cloudflareOpenNext: {
        package: "@opennextjs/cloudflare",
        version: "1.20.1"
      }
    }
  });
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: {},
    devDependencies: { "@opennextjs/cloudflare": "1.20.1" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "toolchain.json providerCli.cloudflareOpenNext.authCheck is required"
  ]);
});

test("validateToolchainPackage rejects unpinned runtime dependencies", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
    },
    runtimePins: {
      next: { package: "next", version: "16.2.9" }
    },
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: { next: "16.2.9", lodash: "4.17.21" },
    devDependencies: { prettier: "3.9.3" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "dependency lodash is not pinned in toolchain.json"
  ]);
});

test("validateToolchainPackage treats npm as Node runtime metadata, not a devDependency", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    devDependencies: {}
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), []);
});

test("validateToolchainPackage rejects Node types from a newer runtime major", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      nodeTypes: { package: "@types/node", version: "26.0.1" }
    },
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    devDependencies: { "@types/node": "26.0.1" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "@types/node major 26 must match Node major 24"
  ]);
});

test("workflow guard rejects deploy and publish commands", () => {
  const failures = assertNoForbiddenWorkflowCommands({
    ".github/workflows/release-check.yml":
      "run: wrangler deploy\nrun: supabase migration up --linked"
  });

  assert.deepEqual(failures, [
    ".github/workflows/release-check.yml contains forbidden command: wrangler deploy",
    ".github/workflows/release-check.yml contains forbidden command: supabase migration"
  ]);
});

test("production deploy workflow guard accepts only the manual deploy contract", () => {
  const deployWorkflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8"
  );

  assert.deepEqual(
    assertNoForbiddenWorkflowCommands({
      ".github/workflows/deploy-production.yml": deployWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateProductionDeployWorkflow(deployWorkflow, "24.18.0"),
    []
  );
});

test("production deploy workflow guard rejects automatic and incomplete deploy workflows", () => {
  const unsafeWorkflow = `
    on:
      workflow_dispatch:
      push:
        branches: [main]
    jobs:
      deploy:
        environment: staging
        steps:
          - uses: actions/setup-node@v6
            with:
              node-version: 25.0.0
          - run: pnpm run worker:deploy
  `;

  assert.deepEqual(
    validateProductionDeployWorkflow(unsafeWorkflow, "24.18.0"),
    [
      ".github/workflows/deploy-production.yml must include production environment",
      ".github/workflows/deploy-production.yml must include Node 24.18.0",
      ".github/workflows/deploy-production.yml must include main-branch deploy guard",
      ".github/workflows/deploy-production.yml must include production deploy concurrency group",
      ".github/workflows/deploy-production.yml must be manual-only and not include push:",
      ".github/workflows/deploy-production.yml must include run: corepack pnpm run worker:dry-run",
      ".github/workflows/deploy-production.yml must include run: corepack pnpm run worker:deploy",
      ".github/workflows/deploy-production.yml must include CLOUDFLARE_HYPERDRIVE_ID"
    ]
  );
});

test("worker deploy wrapper builds, passes explicit bindings, and removes the temp secrets file", () => {
  const env = workerDeployEnv();
  const tempBase = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-worker-deploy-test-")
  );
  /** @type {{ command: string, args: string[] }[]} */
  const calls = [];
  /** @type {string | null} */
  let secretsFilePath = null;
  /** @type {string | null} */
  let configFilePath = null;

  try {
    runWorkerDeploy({
      env,
      tempBase,
      spawnSyncImpl(command, args) {
        calls.push({ command, args });

        if (args[0] === "exec") {
          const secretsFileIndex = args.indexOf("--secrets-file") + 1;
          secretsFilePath = args[secretsFileIndex] ?? null;
          assert.ok(secretsFilePath, "deploy command must pass --secrets-file");
          assert.equal(existsSync(secretsFilePath), true);
          const secretNames = readFileSync(secretsFilePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("=", 1)[0]);
          assert.deepEqual(secretNames, WORKER_DEPLOY_SECRET_NAMES);

          const configFileIndex = args.indexOf("--config") + 1;
          configFilePath = args[configFileIndex] ?? null;
          assert.ok(configFilePath, "deploy command must pass --config");
          assert.equal(existsSync(configFilePath), true);
          const config = JSON.parse(readFileSync(configFilePath, "utf8"));
          assert.deepEqual(config.hyperdrive, [
            {
              binding: DATABASE_HYPERDRIVE_BINDING,
              id: env.CLOUDFLARE_HYPERDRIVE_ID
            }
          ]);
        }

        return { status: 0, signal: null, error: undefined };
      }
    });

    assert.deepEqual(calls[0], {
      command: "pnpm",
      args: ["run", "worker:build"]
    });
    assert.equal(calls[1].command, "pnpm");
    assert.deepEqual(calls[1].args.slice(0, 7), [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      configFilePath,
      "--env-file",
      "/dev/null"
    ]);
    assert.equal(calls[1].args.includes("--secrets-file"), true);
    assert.equal(calls[1].args.includes("--keep-vars"), false);

    const varBindings = calls[1].args.flatMap((arg, index, args) =>
      arg === "--var" ? [args[index + 1]] : []
    );
    const expectedPublicVarBindings = [
      `${DATABASE_CONNECTION_MODE_VAR}:${DATABASE_CONNECTION_MODE_HYPERDRIVE}`,
      ...WORKER_DEPLOY_PUBLIC_VAR_NAMES.map((name) => `${name}:${env[name]}`),
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:${env.CLERK_PUBLISHABLE_KEY}`
    ];
    assert.deepEqual(varBindings, expectedPublicVarBindings);
    assert.equal(
      varBindings.some((binding) =>
        binding.startsWith("CLOUDFLARE_API_TOKEN:")
      ),
      false
    );
    assert.ok(secretsFilePath, "test must observe a secrets file path");
    assert.equal(existsSync(secretsFilePath), false);
    assert.ok(configFilePath, "test must observe a config file path");
    assert.equal(existsSync(configFilePath), false);
  } finally {
    rmSync(tempBase, { force: true, recursive: true });
  }
});

test("worker deploy secrets file writes raw dotenv values and rejects ambiguous characters", () => {
  const content = secretsDotenvContent(workerDeployEnv());
  assert.equal(content.includes('"'), false);
  assert.equal(content.includes("CLERK_SECRET_KEY=sk_test_clerk"), true);
  assert.throws(
    () =>
      secretsDotenvContent(
        workerDeployEnv({
          CLERK_SECRET_KEY: 'sk_test_"quoted"'
        })
      ),
    /must not contain whitespace, quotes, or backslashes/
  );
  assert.throws(
    () =>
      secretsDotenvContent(
        workerDeployEnv({
          SMOKE_OR_CLEANUP_TOKEN: "token with space"
        })
      ),
    /must not contain whitespace, quotes, or backslashes/
  );
});

test("worker deploy command environments keep runtime secrets out of build and deploy subprocesses", () => {
  const env = workerDeployEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/agent-outbox-home"
  });
  const buildEnv = workerBuildEnvironment(env);
  const deployEnv = wranglerDeployEnvironment(env);

  for (const name of WORKER_DEPLOY_SECRET_NAMES) {
    assert.equal(buildEnv[name], undefined);
    assert.equal(deployEnv[name], undefined);
  }
  assert.equal(buildEnv.APP_BASE_URL, env.APP_BASE_URL);
  assert.equal(buildEnv.CLERK_PUBLISHABLE_KEY, env.CLERK_PUBLISHABLE_KEY);
  assert.equal(
    buildEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    env.CLERK_PUBLISHABLE_KEY
  );
  assert.equal(deployEnv.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(deployEnv.APP_BASE_URL, undefined);
});

test("worker deploy wrapper requires production config and appends optional analytics only when set", () => {
  assert.deepEqual(
    validateWorkerDeployEnvironment(
      workerDeployEnv({
        APP_ENV: "development",
        APP_BASE_URL: "http://localhost:38000",
        CLOUDFLARE_HYPERDRIVE_ID: undefined,
        SENTRY_RELEASE: ""
      })
    ),
    [
      "CLOUDFLARE_HYPERDRIVE_ID is required for production Worker deploy",
      "SENTRY_RELEASE is required for production Worker deploy",
      "APP_ENV must be production for production Worker deploy",
      "APP_BASE_URL must be https://app.agent-outbox.dev for production Worker deploy"
    ]
  );

  const withoutAnalytics = buildWranglerDeployArgsWithConfig(
    workerDeployEnv(),
    "/tmp/worker-secrets.env",
    "/tmp/wrangler.jsonc"
  );
  assert.deepEqual(withoutAnalytics.slice(0, 5), [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "/tmp/wrangler.jsonc"
  ]);
  assert.equal(
    withoutAnalytics.includes(
      "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN:analytics-token"
    ),
    false
  );
  const withAnalytics = buildWranglerDeployArgs(
    workerDeployEnv({
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "analytics-token"
    }),
    "/tmp/worker-secrets.env"
  );
  assert.equal(
    withAnalytics.includes(
      "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN:analytics-token"
    ),
    true
  );
});

test("worker deploy wrapper injects Hyperdrive binding into temporary Wrangler config", () => {
  const config = JSON.parse(
    wranglerConfigWithHyperdrive(
      `{
        "name": "agent-outbox",
        "hyperdrive": [
          { "binding": "OTHER_DATABASE", "id": "other-id" },
          { "binding": "${DATABASE_HYPERDRIVE_BINDING}", "id": "old-id" }
        ]
      }`,
      "new-hyperdrive-id"
    )
  );

  assert.deepEqual(config.hyperdrive, [
    { binding: "OTHER_DATABASE", id: "other-id" },
    { binding: DATABASE_HYPERDRIVE_BINDING, id: "new-hyperdrive-id" }
  ]);
});

test("Worker runtime database env prefers Hyperdrive and fails loud when required binding is absent", () => {
  const envWithHyperdrive = {
    DATABASE_APP_ROLE_URL: "postgres://pooler",
    [DATABASE_HYPERDRIVE_BINDING]: {
      connectionString: "postgres://hyperdrive"
    },
    [DATABASE_CONNECTION_MODE_VAR]: DATABASE_CONNECTION_MODE_HYPERDRIVE
  };

  assert.equal(
    runtimeDatabaseConnectionString(envWithHyperdrive),
    "postgres://hyperdrive"
  );
  assert.equal(
    /** @type {{ DATABASE_APP_ROLE_URL: string }} */ (
      runtimeDatabaseEnv(envWithHyperdrive)
    ).DATABASE_APP_ROLE_URL,
    "postgres://hyperdrive"
  );

  const missingBinding = {
    DATABASE_APP_ROLE_URL: "postgres://pooler",
    [DATABASE_CONNECTION_MODE_VAR]: DATABASE_CONNECTION_MODE_HYPERDRIVE
  };
  assert.equal(runtimeDatabaseConnectionString(missingBinding), undefined);
  assert.equal(
    /** @type {{ DATABASE_APP_ROLE_URL: string }} */ (
      runtimeDatabaseEnv(missingBinding)
    ).DATABASE_APP_ROLE_URL,
    ""
  );

  assert.equal(
    runtimeDatabaseConnectionString({
      DATABASE_APP_ROLE_URL: "postgres://pooler"
    }),
    "postgres://pooler"
  );
});

test("wrangler required secrets stay limited to true Worker secrets", () => {
  const wranglerConfig = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );

  assert.deepEqual(validateWranglerRequiredSecrets(wranglerConfig), []);
  assert.deepEqual(
    validateWranglerRequiredSecrets(
      `{
        "secrets": {
          "required": ["DATABASE_APP_ROLE_URL", "APP_ENV"]
        }
      }`
    ),
    [
      "wrangler.jsonc secrets.required missing CLERK_SECRET_KEY",
      "wrangler.jsonc secrets.required missing SENTRY_DSN",
      "wrangler.jsonc secrets.required missing CALLER_KEY_HASH_SECRET",
      "wrangler.jsonc secrets.required missing SMOKE_OR_CLEANUP_TOKEN",
      "wrangler.jsonc secrets.required missing STRIPE_SECRET_KEY",
      "wrangler.jsonc secrets.required missing STRIPE_WEBHOOK_SECRET",
      "wrangler.jsonc secrets.required must not include non-Worker secret or config DATABASE_APP_ROLE_URL",
      "wrangler.jsonc secrets.required must not include non-Worker secret or config APP_ENV"
    ]
  );
});

test("validateMigrationReplayWorkflow requires raw Postgres-backed CI replay", () => {
  const validWorkflow = `
    services:
      postgres:
        image: postgres:17
    env:
      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci
      FLYWAY_DOCKER_NETWORK: host
    steps:
      - run: make migration-replay
      - run: >-
          corepack pnpm exec node --test --test-name-pattern "phase 3 local
          database" tests/foundation.test.mjs
  `;

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": validWorkflow,
      ".github/workflows/release-check.yml": validWorkflow
    }),
    []
  );

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": "steps: []",
      ".github/workflows/release-check.yml": validWorkflow
    }),
    [
      ".github/workflows/ci.yml must include migration replay token: postgres:17",
      ".github/workflows/ci.yml must include migration replay token: DATABASE_MIGRATION_URL",
      ".github/workflows/ci.yml must include migration replay token: FLYWAY_DOCKER_NETWORK: host",
      ".github/workflows/ci.yml must include migration replay token: make migration-replay",
      '.github/workflows/ci.yml must include migration replay token: node --test --test-name-pattern "phase 3 local',
      '.github/workflows/ci.yml must include migration replay token: database" tests/foundation.test.mjs',
      '.github/workflows/ci.yml must include migration replay token: AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"'
    ]
  );
});

test("validateWorkflowVersionPins rejects CI Node drift", () => {
  const failures = validateWorkflowVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    { ".github/workflows/ci.yml": "node-version: 26.1.0" }
  );

  assert.deepEqual(failures, [
    ".github/workflows/ci.yml node-version 26.1.0 must match toolchain.json 24.18.0"
  ]);
});

test("validateCommandsVersionPins rejects stale pinned documentation versions", () => {
  const failures = validateCommandsVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `26.0.0`. Uses pnpm `12.0.0`. Runs Flyway `12.0.0`."
  );

  assert.deepEqual(failures, [
    "COMMANDS.md pinned Node 26.0.0 must match toolchain.json 24.18.0",
    "COMMANDS.md pnpm 12.0.0 must match toolchain.json 11.9.0",
    "COMMANDS.md Flyway 12.0.0 must match toolchain.json 12.10.0"
  ]);
});

test("validateCommandsVersionPins allows lower-bound Node prerequisites", () => {
  const failures = validateCommandsVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `24.18.0`. Uses pnpm `11.9.0`. Project scripts run on pinned Node `24.18.0`. Runs Flyway `12.10.0`."
  );

  assert.deepEqual(failures, []);
});

test("validateGoModuleTooling requires pinned Go module directives and dependencies", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      cobra: { module: "github.com/spf13/cobra", version: "1.10.2" },
      goKeyring: { module: "github.com/zalando/go-keyring", version: "0.2.8" }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };

  assert.deepEqual(
    validateGoModuleTooling(
      toolchain,
      `
module agent-outbox

go 1.26.4

require (
  github.com/spf13/cobra v1.10.2
  github.com/zalando/go-keyring v0.2.8
)
`
    ),
    []
  );

  assert.deepEqual(
    validateGoModuleTooling(
      toolchain,
      `
module agent-outbox

go 1.25.0

toolchain go1.25.0

require github.com/spf13/cobra v1.10.1
`
    ),
    [
      "cli/go.mod go directive must be 1.26.4",
      "cli/go.mod toolchain directive must be go1.26.4 when present",
      "cli/go.mod must require github.com/spf13/cobra v1.10.2",
      "cli/go.mod must require github.com/zalando/go-keyring v0.2.8"
    ]
  );

  assert.deepEqual(
    validateGoModuleTooling(
      { ...toolchain, goTooling: {} },
      `
module agent-outbox

go 1.26.4

require (
  github.com/spf13/cobra v1.10.2
  github.com/zalando/go-keyring v0.2.8
)
`
    ),
    [
      "toolchain.json goTooling.cobra module/version is required",
      "toolchain.json goTooling.goKeyring module/version is required"
    ]
  );
});

test("validateGoReleaserTooling requires pinned package verification module", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      goreleaser: {
        module: "github.com/goreleaser/goreleaser/v2",
        version: "2.16.0"
      }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const makefile = `GORELEASER_MODULE := github.com/goreleaser/goreleaser/v2@v2.16.0

package-check:
\tgo run $(GORELEASER_MODULE) check .goreleaser.yaml
\tgo run $(GORELEASER_MODULE) release --snapshot --clean

release-check: check go-check package-check
`;
  const goreleaser = `homebrew_casks:
  - name: agent-outbox
    skip_upload: true

release:
  disable: true
`;

  assert.deepEqual(
    validateGoReleaserTooling(toolchain, makefile, goreleaser),
    []
  );

  const reorderedRelease = `homebrew_casks:
  - name: agent-outbox
    skip_upload: true

release:
  prerelease: auto
  disable: true
`;
  assert.deepEqual(
    validateGoReleaserTooling(toolchain, makefile, reorderedRelease),
    []
  );

  assert.deepEqual(
    validateGoReleaserTooling({ ...toolchain, goTooling: {} }, "", ""),
    ["toolchain.json goTooling.goreleaser module/version is required"]
  );

  assert.deepEqual(
    validateGoReleaserTooling(
      toolchain,
      "package-check:",
      "homebrew_casks:\nrelease:\n"
    ),
    [
      "Makefile package-check must use pinned GoReleaser github.com/goreleaser/goreleaser/v2@v2.16.0",
      "Makefile package-check must validate .goreleaser.yaml",
      "Makefile package-check must build a clean snapshot release",
      "Makefile release-check must run check, go-check, and package-check",
      ".goreleaser.yaml must disable release publishing",
      ".goreleaser.yaml Homebrew cask config must set skip_upload: true"
    ]
  );

  assert.deepEqual(
    validateGoReleaserTooling(
      toolchain,
      makefile,
      `homebrew_casks:
  - name: agent-outbox

archives:
  - id: agent-outbox
    skip_upload: true

release:
  disable: true
`
    ),
    [".goreleaser.yaml Homebrew cask config must set skip_upload: true"]
  );
});

test("validateWorkflowGoChecks requires Go gate jobs in CI workflows", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      githubActionsSetupGo: { version: "v6" }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const validCiWorkflow = `
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
      - run: make go-check
  `;
  const validReleaseWorkflow = `
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
      - run: make release-check
  `;

  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": "jobs: {}",
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    [
      ".github/workflows/ci.yml must include Go gate token: uses: actions/setup-go@v6",
      ".github/workflows/ci.yml must include Go gate token: go-version-file: cli/go.mod",
      ".github/workflows/ci.yml must include Go gate token: cache-dependency-path: cli/go.sum",
      ".github/workflows/ci.yml must include Go gate token: run: make go-check"
    ]
  );
  // A job merely named `make go-check` (no run step) must fail: the gate no
  // longer executes even though the token string is present.
  const ciWorkflowNamedButNotRun = `
      name: make go-check
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
  `;
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": ciWorkflowNamedButNotRun,
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    [".github/workflows/ci.yml must include Go gate token: run: make go-check"]
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": validCiWorkflow
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: run: make release-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": "jobs: {}"
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: uses: actions/setup-go@v6",
      ".github/workflows/release-check.yml must include Go gate token: go-version-file: cli/go.mod",
      ".github/workflows/release-check.yml must include Go gate token: cache-dependency-path: cli/go.sum",
      ".github/workflows/release-check.yml must include Go gate token: run: make release-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks({ ...toolchain, goTooling: {} }, {}),
    ["toolchain.json goTooling.githubActionsSetupGo.version is required"]
  );
});

test("validateRequiredEnvExample allows optional local development names", () => {
  const template =
    "APP_ENV=development\nPORT=38000\nAPP_BASE_URL=http://localhost:38000\nPUBLIC_APP_BASE_URL=http://localhost:38000\nSUPABASE_PROJECT_REF=\nDATABASE_URL=\nDATABASE_APP_ROLE_URL=\nDATABASE_MIGRATION_URL=\nCLERK_SECRET_KEY=\nCLERK_PUBLISHABLE_KEY=\nSTRIPE_ACCOUNT_ID=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PAID_MONTHLY_PRICE_ID=\nSTRIPE_PAID_YEARLY_PRICE_ID=\nSTRIPE_BILLING_PORTAL_CONFIGURATION_ID=\nSENTRY_DSN=\nSENTRY_BROWSER_DSN=\nSENTRY_RELEASE=\nSENTRY_ORG=\nSENTRY_PROJECT=\nSENTRY_AUTH_TOKEN=\nAGENT_OUTBOX_SENTRY_RELEASE_UPLOAD=\nAGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH=\nNEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN=\nCALLER_KEY_HASH_SECRET=\nSMOKE_OR_CLEANUP_TOKEN=\nAWS_PROFILE=\nCLOUDFLARE_DNS_API_TOKEN=\nCLOUDFLARE_WAF_API_TOKEN=\nAGENT_OUTBOX_BASE_URL=\nAGENT_OUTBOX_CONFIG_PATH=\nAGENT_OUTBOX_CALLER=\n";

  assert.deepEqual(validateRequiredEnvExample(template), []);
});

test("validateRequiredEnvExample rejects missing and unknown names", () => {
  const failures = validateRequiredEnvExample(
    "APP_ENV=development\nAPP_BASE_URL=http://localhost:3000\nEXTRA_SECRET=\n"
  );

  assert.ok(
    failures.includes(".env.example missing required name DATABASE_URL")
  );
  assert.ok(
    failures.includes(".env.example contains unknown name EXTRA_SECRET")
  );
});

test("validateRuntimeProofScope rejects runtime schema mutation and later-phase routes", () => {
  const failures = validateRuntimeProofScope({
    "app/human/queue/page.tsx": "export default function Queue() {}",
    "src/server/schema.ts":
      "await sql`create table agent_outbox_input_items ();`"
  });

  assert.deepEqual(failures, [
    "app/human/queue/page.tsx is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/schema.ts contains out-of-scope token: create table"
  ]);
});

test("validateRuntimeProofScope allows implemented caller API route paths", () => {
  const failures = validateRuntimeProofScope({
    "app/api/input/send/route.ts": "export async function POST() {}",
    "app/api/input/replace/route.ts": "export async function POST() {}",
    "app/api/input/delete/route.ts": "export async function POST() {}",
    "app/api/output/check/route.ts": "export async function GET() {}",
    "app/api/output/[output_result_id]/read/route.ts":
      "export async function POST() {}",
    "app/api/output/read-all/route.ts": "export async function POST() {}",
    "app/api/output/[output_result_id]/ack/route.ts":
      "export async function POST() {}",
    "app/api/output/[output_result_id]/files/[file_id]/route.ts":
      "export async function GET() {}",
    "app/api/caller/status/route.ts": "export async function GET() {}",
    "app/api/caller/connect/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/exchange/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/activate/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/abort/route.ts": "export async function POST() {}",
    "app/api/caller/rotate/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/exchange/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/activate/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/abort/route.ts": "export async function POST() {}",
    "app/api/caller/revoke/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/confirm/route.ts": "export async function POST() {}",
    "app/api/account/status/route.ts": "export async function GET() {}",
    "app/api/billing/checkout/route.ts": "export async function POST() {}",
    "app/api/billing/portal/route.ts": "export async function POST() {}",
    "app/api/billing/webhook/route.ts": "export async function POST() {}",
    "src/server/billing.ts": "await stripe.checkout.sessions.create({});"
  });

  assert.deepEqual(failures, []);
});

test("validateRuntimeProofScope allows Phase 3 product foundation identifiers", () => {
  const failures = validateRuntimeProofScope({
    "src/server/accounting.ts":
      "const table = 'agent_outbox_input_items'; const output = 'agent_outbox_output_results';"
  });

  assert.deepEqual(failures, []);
});

test("validateRuntimeProofScope rejects later-phase storage and source drift", () => {
  const failures = validateRuntimeProofScope({
    "app/api/account/portal/route.ts": "export async function POST() {}",
    "app/api/account/delete/route.ts": "export async function POST() {}",
    "app/api/caller/rotate/route.ts": "export async function POST() {}",
    "app/api/caller/revoke/route.ts": "export async function POST() {}",
    "app/api/caller/list/route.ts": "export async function POST() {}",
    "app/api/input/[caller_item_id]/route.ts":
      "export async function DELETE() {}",
    "app/api/human/answer/route.ts": "export async function POST() {}",
    "src/components/human/Queue.tsx": "export function Queue() {}",
    "src/cli/main.ts": "export function main() {}",
    "src/server/steward-email.ts": "export const source = 'email';",
    "src/server/email-source.ts": "export const source = 'email';",
    "src/server/files.ts": "await supabase.storage.from('files');",
    "src/server/source.ts": "const source = 'gmail classifier';"
  });

  assert.deepEqual(failures, [
    "app/api/account/portal/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/account/delete/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/rotate/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/revoke/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/list/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/input/[caller_item_id]/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/human/answer/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/cli/main.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/steward-email.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/email-source.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/files.ts contains out-of-scope token: supabase.storage",
    "src/server/source.ts contains out-of-scope token: gmail",
    "src/server/source.ts contains out-of-scope token: classifier"
  ]);
});

test("validateRuntimeProofScope allows current app boundary copy", () => {
  assert.deepEqual(
    validateRuntimeProofScope({
      "app/page.tsx":
        "A protected human review queue UI is current functionality. Caller registration, billing, paid file-upload workflows, and Steward behavior are scheduled for later phases."
    }),
    []
  );
});

test("validatePhase3FoundationSourceContents requires Phase 3 modules and markers", () => {
  assert.deepEqual(
    validatePhase3FoundationSourceContents(phase3FoundationSourceContents),
    []
  );
  assert.ok(
    validatePhase3FoundationSourceContents({}).includes(
      "src/server/accounting.ts is missing from Phase 3 foundation source"
    )
  );
});

test("validatePhase4ContractDocContents requires contract docs and markers", () => {
  assert.deepEqual(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      ...callerFacingRouteContents
    }),
    []
  );
  assert.ok(
    validatePhase4ContractDocContents({}).includes(
      "docs/spec/README.md is missing from Phase 4 contract docs"
    )
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "docs/spec/errors.md": "# API Errors\n"
    }).includes(
      "docs/spec/errors.md is missing Phase 4 contract marker: Error Envelope"
    )
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "app/api/output/read-all/route.ts": "export async function POST() {}",
      "docs/spec/http-api.md":
        "Human Answer Boundary\n```http\nPOST /api/input/send\n```\n```http\nGET /api/output/check\n```\n```http\nGET /api/caller/status\n```\n"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/read-all"
    )
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "app/api/output/custom/route.ts": "export async function POST() {}",
      "app/api/runtime/custom/route.ts": "export async function GET() {}"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/custom"
    )
  );
});

test("documented HTTP route markers require exact http code-block method paths", () => {
  assert.deepEqual(
    extractDocumentedHttpContractRouteMarkers(`
\`\`\`http
GET /api/output/check?limit=25
\`\`\`
\`\`\`http
POST /api/output/read-all
\`\`\`
GET /api/output/check
`),
    ["GET /api/output/check", "POST /api/output/read-all"]
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "docs/spec/http-api.md":
        "Human Answer Boundary\n```http\nPOST /api/output/read-all-extra\n```\n",
      "app/api/output/read-all/route.ts": "export async function POST() {}"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/read-all"
    )
  );
});

test("implemented HTTP route markers derive from caller-facing route files", () => {
  assert.deepEqual(
    extractImplementedHttpContractRouteMarkers({
      "app/api/output/read-all/route.ts": "export async function POST() {}",
      "app/api/output/[output_result_id]/files/[file_id]/route.ts":
        "export async function GET() {}",
      "app/api/output/commented/route.ts": `
        // export async function GET() {}
        const sample = "export async function DELETE";
        export async function POST() {}
      `,
      "app/api/runtime/canary/route.ts": "export async function GET() {}"
    }),
    [
      "GET /api/output/{output_result_id}/files/{file_id}",
      "POST /api/output/commented",
      "POST /api/output/read-all"
    ]
  );
});

test("worker cron schedule stays aligned with runtime scheduled canary", () => {
  const wranglerConfig = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const workerEntry = readFileSync(
    new URL("../worker/entry.mjs", import.meta.url),
    "utf8"
  );

  assert.deepEqual(
    validateWranglerCronSchedule(wranglerConfig, RUNTIME_CRON_SCHEDULE),
    []
  );
  assert.match(workerEntry, /runScheduledCanary/);
  assert.match(workerEntry, /runScheduledCleanup/);
  assert.match(workerEntry, /context\.waitUntil\(cleanup\)/);
  assert.deepEqual(
    validateWranglerCronSchedule(
      `{
        // Wrangler accepts JSONC comments.
        "triggers": {
          "crons": ["17 * * * *"],
        },
        "note": "commas inside strings, ] and } stay intact"
      }`,
      RUNTIME_CRON_SCHEDULE
    ),
    []
  );
  assert.deepEqual(
    validateWranglerCronSchedule(
      '{ "triggers": { "crons": ["42 * * * *"] } }',
      RUNTIME_CRON_SCHEDULE
    ),
    [
      "wrangler.jsonc triggers.crons must include runtime scheduled canary 17 * * * *"
    ]
  );
});

test("validateMigrationFilenames enforces Flyway versioned SQL names", () => {
  assert.deepEqual(
    validateMigrationFilenames([
      "V20260630000000__initial_schema.sql",
      "V20260701010203__add_queue_indexes.sql",
      "V20260701010204__add_queue_index_online.sql.conf"
    ]),
    [
      "V20260701010204__add_queue_index_online.sql.conf must have matching SQL migration V20260701010204__add_queue_index_online.sql"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames([
      "20260630000000_initial_schema.sql",
      "V20260630000000__initial_schema.sql",
      "V20260630000000__other_change.sql"
    ]),
    [
      "20260630000000_initial_schema.sql must match VYYYYMMDDHHMMSS__lower_snake_description.sql or VYYYYMMDDHHMMSS__lower_snake_description.sql.conf",
      "migration version 20260630000000 is duplicated"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames(
      [
        "V20260701010204__add_queue_index_online.sql",
        "V20260701010204__add_queue_index_online.sql.conf"
      ],
      {
        "V20260701010204__add_queue_index_online.sql": `
          create index concurrently example_idx on public.example(id);
        `,
        "V20260701010204__add_queue_index_online.sql.conf":
          "executeInTransaction=false\n"
      }
    ),
    []
  );
  assert.deepEqual(
    validateMigrationFilenames(
      [
        "V20260701010205__add_unique_queue_index_online.sql",
        "V20260701010205__add_unique_queue_index_online.sql.conf"
      ],
      {
        "V20260701010205__add_unique_queue_index_online.sql": `
          create unique index concurrently example_unique_idx on public.example(id);
        `,
        "V20260701010205__add_unique_queue_index_online.sql.conf":
          "executeInTransaction=false\n"
      }
    ),
    []
  );
  assert.deepEqual(
    validateMigrationFilenames(
      ["V20260701010205__add_unique_queue_index_online.sql"],
      {
        "V20260701010205__add_unique_queue_index_online.sql": `
          create unique index concurrently example_unique_idx on public.example(id);
        `
      }
    ),
    [
      "V20260701010205__add_unique_queue_index_online.sql uses CREATE [UNIQUE]/DROP INDEX CONCURRENTLY and must have V20260701010205__add_unique_queue_index_online.sql.conf with executeInTransaction=false"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames(
      ["V20260701010204__add_queue_index_online.sql"],
      {
        "V20260701010204__add_queue_index_online.sql": `
          drop index concurrently if exists public.example_idx;
        `
      }
    ),
    [
      "V20260701010204__add_queue_index_online.sql uses CREATE [UNIQUE]/DROP INDEX CONCURRENTLY and must have V20260701010204__add_queue_index_online.sql.conf with executeInTransaction=false"
    ]
  );
});

test("flywayConnectionFromDatabaseUrl converts PostgreSQL URLs without leaking credentials into JDBC URLs", () => {
  withProcessEnv({ FLYWAY_USER: undefined, FLYWAY_PASSWORD: undefined }, () => {
    assert.deepEqual(
      flywayConnectionFromDatabaseUrl(
        "postgresql://agent%20user:s3cr%40t@example.com:5432/agent_outbox?sslmode=require"
      ),
      {
        jdbcUrl:
          "jdbc:postgresql://example.com:5432/agent_outbox?sslmode=require",
        user: "agent user",
        password: "s3cr@t"
      }
    );
  });
});

test("flyway validation scopes pending migration ignores to pre-migrate replay", () => {
  const connection = {
    jdbcUrl: "jdbc:postgresql://example.test:5432/agent_outbox",
    user: "migration_user",
    password: "secret"
  };

  withProcessEnv(
    {
      FLYWAY_CONNECT_RETRIES: undefined,
      FLYWAY_IGNORE_MIGRATION_PATTERNS: "*:pending"
    },
    () => {
      assert.deepEqual(flywayDockerEnvironmentNames(), [
        "FLYWAY_URL",
        "FLYWAY_LOCATIONS",
        "FLYWAY_CONNECT_RETRIES",
        "FLYWAY_USER",
        "FLYWAY_PASSWORD"
      ]);
      assert.equal(
        flywayEnvironmentFromConnection(connection)
          .FLYWAY_IGNORE_MIGRATION_PATTERNS,
        undefined
      );
      assert.deepEqual(
        flywayDockerEnvironmentNames({ ignorePendingMigrations: true }),
        [
          "FLYWAY_URL",
          "FLYWAY_LOCATIONS",
          "FLYWAY_CONNECT_RETRIES",
          "FLYWAY_USER",
          "FLYWAY_PASSWORD",
          "FLYWAY_IGNORE_MIGRATION_PATTERNS"
        ]
      );
      assert.equal(
        flywayEnvironmentFromConnection(connection, {
          ignorePendingMigrations: true
        }).FLYWAY_IGNORE_MIGRATION_PATTERNS,
        "*:pending"
      );
    }
  );
});

test("validateCallerBearer accepts only the configured smoke token", () => {
  assert.deepEqual(validateCallerBearer(null, "smoke-token"), {
    ok: false,
    status: 401,
    code: "missing_authorization"
  });
  assert.deepEqual(validateCallerBearer("Basic smoke-token", "smoke-token"), {
    ok: false,
    status: 401,
    code: "invalid_authorization_scheme"
  });
  assert.deepEqual(validateCallerBearer("Bearer wrong", "smoke-token"), {
    ok: false,
    status: 403,
    code: "invalid_bearer_token"
  });
  assert.deepEqual(
    validateCallerBearer(" bearer smoke-token ", "smoke-token"),
    {
      ok: true,
      callerId: "runtime-smoke-caller"
    }
  );
});

test("caller API key helpers create display-once material and lookup metadata", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE }, () => {
    const material = generateCallerApiKeyMaterial();
    const parsed = parseCallerApiKey(material.plaintextApiKey);

    assert.equal(parsed.ok, true);
    assert.equal(material.keyId, parsed.ok ? parsed.keyId : null);
    assert.match(material.plaintextApiKey, /^aob_live_[a-z2-7]+_[a-z2-7]+$/);
    assert.notEqual(material.secretDigest, material.plaintextApiKey);
    assert.equal(material.secretDigest.length, 64);
    assert.match(
      initialMigration,
      /secret_hmac_sha256 text not null,\n  status text not null/
    );
    assert.match(
      initialMigration,
      /check \(secret_hmac_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/
    );
    assert.match(
      initialMigration,
      /create or replace function public\.agent_outbox_lookup_caller_credential\(p_key_id text\)/
    );

    assert.deepEqual(callerCredentialLookupStatement(material.keyId), {
      sql: "select * from public.agent_outbox_lookup_caller_credential($1)",
      values: [material.keyId]
    });
    assert.deepEqual(
      storedCallerCredentialDigestFromLookupRow({
        account_id: "account-123",
        caller_id: "caller-123",
        key_id: material.keyId,
        secret_hmac_sha256: material.secretDigest,
        status: "active",
        revoked_at: null,
        expires_at: "2099-01-01T00:00:00.000Z"
      }),
      {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        expiresAt: "2099-01-01T00:00:00.000Z",
        revokedAt: null,
        status: "active"
      }
    );
    assert.deepEqual(parseCallerBearerApiKey("Bearer malformed"), {
      ok: false,
      status: 401,
      code: "invalid_caller_api_key"
    });
    assert.equal(
      parseCallerBearerApiKey(`bEaReR ${material.plaintextApiKey}`).ok,
      true
    );
  });
});

test("caller key digest fails loud when the server hash secret is missing", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: undefined }, () => {
    assert.throws(
      () => callerApiKeySecretDigest("caller-secret"),
      (error) => {
        assert.ok(error instanceof MissingServerEnvironmentError);
        assert.equal(error.missingName, "CALLER_KEY_HASH_SECRET");
        assert.doesNotMatch(error.message, /caller-secret/);
        return true;
      }
    );
  });
});

test("caller key digest rejects a hash secret weaker than the minimum length", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: "short-secret" }, () => {
    assert.throws(
      () => callerApiKeySecretDigest("caller-secret"),
      (error) => {
        assert.ok(error instanceof InsecureServerEnvironmentError);
        assert.equal(error.insecureName, "CALLER_KEY_HASH_SECRET");
        assert.doesNotMatch(error.message, /caller-secret/);
        return true;
      }
    );
  });
});

test("authorization helpers deny cross-account human and caller access", () => {
  assert.deepEqual(
    authorizeAccountMembership(
      {
        surface: "human",
        userId: "user_a",
        memberships: [
          {
            accountId: "account_a",
            userId: "user_a",
            role: "owner"
          }
        ]
      },
      "account_b"
    ),
    {
      ok: false,
      status: 403,
      surface: "human",
      code: "cross_account_denied",
      requestedAccountId: "account_b",
      userId: "user_a"
    }
  );

  assert.deepEqual(
    authorizeCallerAccount(
      {
        surface: "caller",
        accountId: "account_a",
        callerId: "caller_a",
        keyId: "key_a"
      },
      { accountId: "account_a", callerId: "caller_b" }
    ),
    {
      ok: false,
      status: 403,
      surface: "caller",
      code: "caller_scope_denied",
      accountId: "account_a",
      callerId: "caller_a",
      requestedAccountId: "account_a",
      requestedCallerId: "caller_b"
    }
  );

  assert.deepEqual(
    authorizeCallerAccount(
      {
        surface: "caller",
        accountId: "account_a",
        callerId: "caller_a",
        keyId: "key_a"
      },
      { accountId: "account_b", callerId: "caller_b" }
    ),
    {
      ok: false,
      status: 403,
      surface: "caller",
      code: "cross_account_denied",
      accountId: "account_a",
      callerId: "caller_a",
      requestedAccountId: "account_b",
      requestedCallerId: "caller_b"
    }
  );
});

test("limits metadata uses explicit disabled states and maps self-hosted to paid without Stripe state", () => {
  const freeStatus = accountLimitStatusMetadata("hosted-free");
  const paidStatus = accountLimitStatusMetadata("hosted-paid");
  const selfHostedStatus = accountLimitStatusMetadata("self-hosted");
  /**
   * @param {import("../src/server/limits.ts").AccountLimitStatusMetadata} status
   * @param {import("../src/server/limits.ts").LimitName} limitName
   */
  const limitStatus = (status, limitName) => {
    const limit = status.limits.find((entry) => entry.limitName === limitName);
    assert.ok(limit, limitName);
    return limit;
  };

  assert.equal(fileUploadEnabled("hosted-free"), false);
  assert.equal(fileUploadEnabled("hosted-paid"), true);
  assert.equal(fileUploadEnabled("self-hosted"), true);
  assert.equal(freeStatus.stripeBillingState, "not_applicable");
  assert.equal(paidStatus.stripeBillingState, "required");
  assert.equal(selfHostedStatus.stripeBillingState, "not_applicable");
  assert.equal(selfHostedStatus.effectiveTier, "paid");
  assert.equal(
    doctorLimitMetadata("hosted-free").length,
    freeStatus.limits.length
  );

  for (const status of [freeStatus, paidStatus, selfHostedStatus]) {
    assert.deepEqual(
      limitStatus(status, "input_send_replace_requests_per_account_per_minute")
        .setting,
      { mode: "enabled", value: 600 }
    );
    assert.deepEqual(
      limitStatus(status, "input_delete_requests_per_account_per_minute")
        .setting,
      { mode: "enabled", value: 600 }
    );
    assert.deepEqual(
      limitStatus(
        status,
        "output_file_download_requests_per_account_per_minute"
      ).setting,
      { mode: "enabled", value: 60 }
    );
    assert.equal(
      limitStatus(
        status,
        "authenticated_caller_api_requests_per_calendar_month"
      ).setting.mode,
      status.profileId === "hosted-free" ? "enabled" : "disabled"
    );
  }

  assert.deepEqual(
    doctorLimitMetadata("hosted-free")
      .filter((entry) =>
        [
          "input_send_replace_requests_per_account_per_minute",
          "input_delete_requests_per_account_per_minute",
          "output_file_download_requests_per_account_per_minute"
        ].includes(entry.limitName)
      )
      .map((entry) => entry.checkName),
    [
      "limits.input_send_replace.minute",
      "limits.input_delete.minute",
      "limits.output_file_download.minute"
    ]
  );
});

test("limit error and active block metadata derive reason fields from the limits catalog", () => {
  assert.deepEqual(
    limitErrorMetadata(
      "hosted-free",
      "output_check_read_requests_per_account_per_minute",
      {
        usedUnits: 121,
        limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
      }
    ),
    {
      status: 429,
      code: "rate_limit_exceeded",
      limitName: "output_check_read_requests_per_account_per_minute",
      limitReasonCode: "output_check_read_rate_limited",
      limitReason: "Output check/read requests are temporarily rate limited.",
      limitResetsAt: "2026-06-30T12:01:00.000Z",
      usedUnits: 121,
      limitUnits: 120,
      unit: "requests"
    }
  );

  assert.deepEqual(
    [
      limitErrorMetadata(
        "hosted-free",
        "input_send_replace_requests_per_account_per_minute",
        {
          usedUnits: 601,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      ),
      limitErrorMetadata(
        "hosted-free",
        "input_delete_requests_per_account_per_minute",
        {
          usedUnits: 601,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      ),
      limitErrorMetadata(
        "hosted-free",
        "output_file_download_requests_per_account_per_minute",
        {
          usedUnits: 61,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      )
    ],
    [
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "input_send_replace_requests_per_account_per_minute",
        limitReasonCode: "input_send_replace_rate_limited",
        limitReason:
          "Input send/replace requests are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 601,
        limitUnits: 600,
        unit: "requests"
      },
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "input_delete_requests_per_account_per_minute",
        limitReasonCode: "input_delete_rate_limited",
        limitReason: "Input delete requests are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 601,
        limitUnits: 600,
        unit: "requests"
      },
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "output_file_download_requests_per_account_per_minute",
        limitReasonCode: "output_file_download_rate_limited",
        limitReason: "Output file downloads are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 61,
        limitUnits: 60,
        unit: "requests"
      }
    ]
  );

  assert.deepEqual(
    activeLimitBlockMetadata({
      selector: "hosted-free",
      accountId: "account_a",
      operationKind: "output_check_read",
      limitName: "output_check_read_requests_per_account_per_minute",
      usedUnits: 121,
      limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
    }),
    {
      account_id: "account_a",
      operation_kind: "output_check_read",
      limit_name: "output_check_read_requests_per_account_per_minute",
      limit_reason_code: "output_check_read_rate_limited",
      limit_reason: "Output check/read requests are temporarily rate limited.",
      limit_resets_at: "2026-06-30T12:01:00.000Z",
      used_units: 121,
      limit_units: 120
    }
  );
  assert.deepEqual(
    getLimitDefinition("input_send_replace_requests_per_account_per_minute")
      .operationKinds,
    ["input_send_replace"]
  );
  assert.deepEqual(
    getLimitDefinition("input_delete_requests_per_account_per_minute")
      .operationKinds,
    ["input_delete"]
  );
  assert.deepEqual(
    getLimitDefinition("output_file_download_requests_per_account_per_minute")
      .operationKinds,
    ["output_file_download"]
  );
  assert.throws(
    () =>
      activeLimitBlockMetadata({
        selector: "hosted-free",
        accountId: "account_a",
        operationKind: "output_ack",
        limitName: "output_check_read_requests_per_account_per_minute"
      }),
    /does not apply/
  );
});

test("accounting helpers keep audit data content-safe and use quota windows for flow limits", () => {
  const unsafeAuditInput = /** @type {any} */ ({
    eventType: "input_answered",
    accountAuditId: "account_audit",
    callerAuditId: "caller_audit",
    inputItemId: "input_id",
    outputResultId: "output_id",
    itemStatus: "answered",
    responseKind: "free_text",
    nonFileBytes: 120,
    callerItemIdHash: "hash_only",
    metadata: {
      revision: 2,
      caller_display: "raw caller name",
      safe_string: "looks safe but is still untrusted"
    },
    // Runtime callers may accidentally pass raw content; the helper must not keep it.
    titleHtml: "<strong>private</strong>",
    freeTextAnswer: "private text",
    callerDisplayName: "raw caller name"
  });
  const auditEvent = auditSafeLifecycleEvent(unsafeAuditInput);

  assert.deepEqual(auditEvent, {
    event_type: "input_answered",
    account_audit_id: "account_audit",
    caller_audit_id: "caller_audit",
    input_item_id: "input_id",
    output_result_id: "output_id",
    item_status: "answered",
    response_kind: "free_text",
    non_file_bytes: 120,
    caller_item_id_hash: "hash_only",
    metadata: { revision: 2 }
  });
  assert.deepEqual(
    quotaWindowKey(
      "authenticated_caller_api_requests_per_calendar_month",
      new Date("2026-06-30T12:34:56.789Z")
    ),
    {
      metric: "authenticated_caller_api_requests_per_calendar_month",
      windowKind: "calendar_month",
      windowStartUtc: "2026-06-01T00:00:00.000Z"
    }
  );
  assert.equal(consumesMonthlyCallerApiRequestQuota("output_check_read"), true);
  assert.deepEqual(
    storedByteAccounting({
      inputPayloadBytes: 100,
      outputPayloadBytes: 25,
      fileBytes: 900
    }),
    {
      nonFileQueuePayloadBytes: 125,
      fileBytes: 900,
      overallStoredAccountDataBytes: 1025
    }
  );
  assert.throws(
    () =>
      auditSafeLifecycleEvent({
        eventType: "input_deleted",
        accountAuditId: "account_audit",
        nonFileBytes: -1
      }),
    /nonFileBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      auditSafeLifecycleEvent({
        eventType: "file_deleted",
        accountAuditId: "account_audit",
        fileBytes: Number.NaN
      }),
    /fileBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      storedByteAccounting({
        inputPayloadBytes: Number.MAX_SAFE_INTEGER,
        outputPayloadBytes: 1
      }),
    /nonFileQueuePayloadBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      storedByteAccounting({
        inputPayloadBytes: 1,
        outputPayloadBytes: 1,
        fileBytes: 0.5
      }),
    /fileBytes must be a non-negative safe integer/
  );
});

test("cleanup statement builders target lifecycle database functions", () => {
  const duplicateAck = duplicateAcknowledgementLookupStatement(
    { accountId: "account-123", callerId: "caller-123" },
    "output-123"
  );
  assert.match(duplicateAck.sql, /agent_outbox_audit_events/);
  assert.match(duplicateAck.sql, /agent_outbox_callers/);
  assert.match(duplicateAck.sql, /event\.output_result_id = \$3::uuid/);
  assert.match(duplicateAck.sql, /caller\.account_id = \$1::uuid/);
  assert.match(duplicateAck.sql, /caller\.caller_id = \$2::uuid/);
  assert.match(duplicateAck.sql, /agent_outbox_context_account_id/);
  assert.match(duplicateAck.sql, /agent_outbox_context_allows_caller/);
  assert.deepEqual(duplicateAck.values, [
    "account-123",
    "caller-123",
    "output-123"
  ]);
  assert.deepEqual(
    terminalOutputDeletionStatement("output-123", "acknowledgement", "req-1"),
    {
      sql: "select * from public.agent_outbox_delete_output_result($1, $2, $3)",
      values: ["output-123", "acknowledgement", "req-1"]
    }
  );
  assert.deepEqual(preReadUndoStatement("output-123", "req-1"), {
    sql: "select * from public.agent_outbox_restore_unread_output($1, $2)",
    values: ["output-123", "req-1"]
  });
  assert.deepEqual(
    pendingInputRetentionStatement(
      new Date("2026-06-30T00:00:00.000Z"),
      "req-1"
    ),
    {
      sql: "select public.agent_outbox_delete_retained_pending_inputs($1, $2) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z", "req-1"]
    }
  );
  assert.deepEqual(
    outputTimeoutCleanupStatement(new Date("2026-06-30T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_delete_expired_outputs($1) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z"]
    }
  );
  assert.deepEqual(
    downgradeGraceExpiryStatement(
      32_000_000,
      new Date("2026-06-30T00:00:00.000Z")
    ),
    {
      sql: "select * from public.agent_outbox_cleanup_downgrade_grace_expiry($1, $2)",
      values: [32_000_000, "2026-06-30T00:00:00.000Z"]
    }
  );
  assert.throws(
    () =>
      downgradeGraceExpiryStatement(-1, new Date("2026-06-30T00:00:00.000Z")),
    /nonFilePayloadLimitBytes must be a non-negative safe integer/
  );
  const expiredGraceDowngrade = expiredBillingGraceDowngradeStatement(
    32_000_000,
    new Date("2026-06-30T00:00:00.000Z")
  );
  assert.match(
    expiredGraceDowngrade.sql,
    /agent_outbox_cleanup_downgrade_grace_expiry\(\$1, \$2\)/
  );
  assert.match(expiredGraceDowngrade.sql, /tier = 'hosted_free'/);
  assert.match(expiredGraceDowngrade.sql, /billing_status = 'not_applicable'/);
  assert.deepEqual(expiredGraceDowngrade.values, [
    32_000_000,
    "2026-06-30T00:00:00.000Z"
  ]);
  assert.throws(
    () =>
      expiredBillingGraceDowngradeStatement(
        Number.MAX_SAFE_INTEGER + 1,
        new Date("2026-06-30T00:00:00.000Z")
      ),
    /nonFilePayloadLimitBytes must be a non-negative safe integer/
  );
  const quotaPruneBefore = new Date("2026-06-01T00:00:00.000Z");
  const accountQuotaPruning = {
    sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
    values: ["2026-06-01T00:00:00.000Z"]
  };
  assert.deepEqual(
    quotaWindowPruningStatement(quotaPruneBefore),
    accountQuotaPruning
  );
  const quotaMaintenanceNow = new Date("2026-07-15T12:34:56.000Z");
  assert.equal(
    callerSetupCleanupCutoff(quotaMaintenanceNow).toISOString(),
    "2026-07-08T12:34:56.000Z"
  );
  assert.deepEqual(
    neverActivatedCallerPruningStatement(
      callerSetupCleanupCutoff(quotaMaintenanceNow)
    ),
    {
      sql: "select public.agent_outbox_prune_never_activated_callers($1) as deleted_count",
      values: ["2026-07-08T12:34:56.000Z"]
    }
  );
  assert.equal(
    quotaWindowPruningCutoff(quotaMaintenanceNow).toISOString(),
    "2026-07-01T00:00:00.000Z"
  );
  // IP quota rows are minute-only, so their prune uses a minute-anchored cutoff
  // (start of the current minute) rather than the account month-anchored cutoff.
  assert.equal(
    quotaWindowPruningCutoff(quotaMaintenanceNow, ["minute"]).toISOString(),
    "2026-07-15T12:34:00.000Z"
  );
  assert.deepEqual(quotaWindowMaintenanceStatements(quotaMaintenanceNow), [
    {
      sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
      values: ["2026-07-01T00:00:00.000Z"]
    },
    {
      sql: "select public.agent_outbox_prune_ip_quota_windows($1) as deleted_count",
      values: ["2026-07-15T12:34:00.000Z"]
    },
    {
      sql: "select public.agent_outbox_prune_caller_setup_requests($1) as deleted_count",
      values: ["2026-07-08T12:34:56.000Z"]
    },
    {
      sql: "select public.agent_outbox_prune_stripe_webhook_events($1) as deleted_count",
      values: ["2026-04-16T12:34:56.000Z"]
    }
  ]);
  assert.deepEqual(
    accountQuotaWindowMaintenanceStatement(quotaMaintenanceNow),
    {
      sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
      values: ["2026-07-01T00:00:00.000Z"]
    }
  );
  assert.deepEqual(
    globalQuotaWindowMaintenanceStatements(quotaMaintenanceNow),
    [
      {
        sql: "select public.agent_outbox_prune_ip_quota_windows($1) as deleted_count",
        values: ["2026-07-15T12:34:00.000Z"]
      },
      {
        sql: "select public.agent_outbox_prune_caller_setup_requests($1) as deleted_count",
        values: ["2026-07-08T12:34:56.000Z"]
      },
      {
        sql: "select public.agent_outbox_prune_stripe_webhook_events($1) as deleted_count",
        values: ["2026-04-16T12:34:56.000Z"]
      }
    ]
  );
  assert.deepEqual(
    activeLimitMaintenanceStatement(new Date("2026-06-30T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_prune_expired_limit_blocks($1) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z"]
    }
  );
});

test("scheduled cleanup runs global and account-scoped maintenance under cleanup context", async () => {
  /** @type {import("../src/server/database.ts").ProductTransactionContext[]} */
  const contexts = [];
  /** @type {import("../src/server/database.ts").TransactionContextStatement[][]} */
  const statementsByContext = [];
  const now = new Date("2026-07-15T12:34:56.000Z");
  /**
   * @param {import("pg").QueryResultRow[]} rows
   * @returns {import("pg").QueryResult<import("pg").QueryResultRow>}
   */
  function cleanupQueryResult(rows) {
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }

  const result = await runScheduledCleanup({
    connectionString: "postgresql://cleanup-test",
    now,
    requestId: "cleanup-test-request",
    async runTransaction(connectionString, context, callback) {
      assert.equal(connectionString, "postgresql://cleanup-test");
      contexts.push(context);
      /** @type {import("../src/server/database.ts").TransactionContextStatement[]} */
      const statements = [];
      statementsByContext.push(statements);

      /**
       * @param {import("../src/server/database.ts").TransactionContextStatement} statement
       * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
       */
      const query = async (statement) => {
        statements.push(statement);
        if (statement.sql.includes("agent_outbox_cleanup_account_targets")) {
          return cleanupQueryResult([
            { account_id: "account-free", tier: "hosted_free" },
            { account_id: "account-paid", tier: "hosted_paid" }
          ]);
        }

        return cleanupQueryResult([{ deleted_count: 1 }]);
      };

      return await callback(
        /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
          query
        )
      );
    }
  });

  assert.deepEqual(contexts, [
    { requestId: "cleanup-test-request", authSurface: "cleanup" },
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-free"
    },
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-paid"
    }
  ]);
  assert.deepEqual(statementsByContext[0], [
    cleanupAccountTargetsStatement(),
    ...globalQuotaWindowMaintenanceStatements(now)
  ]);
  assert.deepEqual(
    statementsByContext[1],
    scheduledCleanupStatementsForAccount({
      tier: "hosted_free",
      now,
      requestId: "cleanup-test-request"
    })
  );
  assert.deepEqual(
    statementsByContext[2],
    scheduledCleanupStatementsForAccount({
      tier: "hosted_paid",
      now,
      requestId: "cleanup-test-request"
    })
  );
  assert.deepEqual(result, {
    ok: true,
    code: "scheduled_cleanup_completed",
    request_id: "cleanup-test-request",
    recorded_at: result.recorded_at,
    accounts_seen: 2,
    accounts_cleaned: 2,
    statements_run: 13,
    rows_affected: 13
  });
  assert.match(result.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    statementsByContext[1].filter((statement) =>
      statement.sql.includes("agent_outbox_delete_retained_pending_inputs")
    ),
    [
      pendingInputRetentionStatement(
        new Date("2026-05-16T12:34:56.000Z"),
        "cleanup-test-request"
      )
    ]
  );
  assert.deepEqual(
    statementsByContext[1].filter((statement) =>
      statement.sql.includes("agent_outbox_delete_expired_outputs")
    ),
    [outputTimeoutCleanupStatement(now)]
  );
  assert.deepEqual(
    statementsByContext[2].filter((statement) =>
      statement.sql.includes("agent_outbox_delete_retained_pending_inputs")
    ),
    []
  );
  assert.deepEqual(
    statementsByContext[2].filter((statement) =>
      statement.sql.includes("agent_outbox_cleanup_downgrade_grace_expiry")
    ),
    [expiredBillingGraceDowngradeStatement(32_000_000, now)]
  );
});

test("scheduled cleanup continues account maintenance after one account fails", async () => {
  /** @type {import("../src/server/database.ts").ProductTransactionContext[]} */
  const contexts = [];
  const now = new Date("2026-07-15T12:34:56.000Z");
  const accountFailure = new Error("lock timeout");
  /**
   * @param {import("pg").QueryResultRow[]} rows
   * @returns {import("pg").QueryResult<import("pg").QueryResultRow>}
   */
  function cleanupQueryResult(rows) {
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }

  /** @type {unknown} */
  let thrown;
  try {
    await runScheduledCleanup({
      connectionString: "postgresql://cleanup-test",
      now,
      requestId: "cleanup-test-request",
      async runTransaction(connectionString, context, callback) {
        assert.equal(connectionString, "postgresql://cleanup-test");
        contexts.push(context);

        if (context.accountId === "account-free") {
          throw accountFailure;
        }

        /**
         * @param {import("../src/server/database.ts").TransactionContextStatement} statement
         * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
         */
        const query = async (statement) => {
          if (statement.sql.includes("agent_outbox_cleanup_account_targets")) {
            return cleanupQueryResult([
              { account_id: "account-free", tier: "hosted_free" },
              { account_id: "account-paid", tier: "hosted_paid" }
            ]);
          }

          return cleanupQueryResult([{ deleted_count: 1 }]);
        };

        return await callback(
          /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
            query
          )
        );
      }
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof AggregateError);
  assert.match(
    thrown.message,
    /^Scheduled cleanup failed for 1 account\(s\): account-free$/
  );
  assert.deepEqual(thrown.errors, [accountFailure]);
  assert.deepEqual(contexts, [
    { requestId: "cleanup-test-request", authSurface: "cleanup" },
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-free"
    },
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-paid"
    }
  ]);
});

test("safeLogEvent strips request bodies and arbitrary caller-controlled fields", () => {
  /** @type {import("../src/server/logging.ts").RuntimeLogEvent & { request_body: string, caller_display_name: string }} */
  const unsafeEvent = {
    level: "error",
    error_id: "err_123",
    error_name: "DatabaseConnectionError",
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
    duration_ms: 17,
    operation: "runtime.structured_error.canary",
    operation_kind: "output_check_read",
    account_id: "00000000-0000-4000-8000-000000000001",
    caller_id: "00000000-0000-4000-8000-000000000002",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_resets_at: "2026-07-07T12:01:00.000Z",
    used_units: 121,
    limit_units: 120,
    message: "safe message",
    request_body: "raw review content",
    caller_display_name: "caller supplied name"
  };
  const event = safeLogEvent(unsafeEvent);

  assert.deepEqual(event, {
    level: "error",
    error_id: "err_123",
    error_name: "DatabaseConnectionError",
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
    duration_ms: 17,
    operation: "runtime.structured_error.canary",
    operation_kind: "output_check_read",
    account_id: "00000000-0000-4000-8000-000000000001",
    caller_id: "00000000-0000-4000-8000-000000000002",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_resets_at: "2026-07-07T12:01:00.000Z",
    used_units: 121,
    limit_units: 120,
    message: "safe message"
  });

  const unsafeName = new Error("raw detail");
  unsafeName.name = "Bad Error raw detail";
  assert.equal(safeErrorName(unsafeName), "Error");
  assert.equal(safeErrorName("raw thrown value"), "UnknownError");
  assert.equal(
    safeLogEvent({
      ...unsafeEvent,
      error_name: "Bad Error raw detail"
    }).error_name,
    "Error"
  );
});

test("runtimeConfigStatus reports missing provider values without exposing values", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: undefined,
      DATABASE_APP_ROLE_URL: undefined,
      SENTRY_DSN: undefined,
      SMOKE_OR_CLEANUP_TOKEN: undefined,
      CALLER_KEY_HASH_SECRET: undefined
    },
    () => {
      const status = runtimeConfigStatus();

      assert.equal(status.configured, false);
      assert.deepEqual(status.missing, [
        "CLERK_PUBLISHABLE_KEY",
        "DATABASE_APP_ROLE_URL",
        "SENTRY_DSN",
        "SMOKE_OR_CLEANUP_TOKEN",
        "CALLER_KEY_HASH_SECRET"
      ]);
      assert.deepEqual(status.insecure, []);
    }
  );
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: "pk_test_secret",
      DATABASE_APP_ROLE_URL: "postgresql://example",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      CALLER_KEY_HASH_SECRET: "short-secret"
    },
    () => {
      const status = runtimeConfigStatus();

      assert.equal(status.configured, false);
      assert.deepEqual(status.missing, []);
      assert.deepEqual(status.insecure, ["CALLER_KEY_HASH_SECRET"]);
    }
  );
});

test("runtime canary keeps configuration detail behind smoke bearer auth", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: "pk_test_secret",
      DATABASE_APP_ROLE_URL: "postgresql://example",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE
    },
    () => {
      const publicBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        null
      );

      assert.equal(publicBody.ok, true);
      assert.equal(publicBody.code, "runtime_canary_ok");
      assert.equal(publicBody.origin, "https://example.test");
      assert.equal(publicBody.one_app_api_origin, true);
      assert.equal(Object.hasOwn(publicBody, "environment"), false);
      assert.equal(Object.hasOwn(publicBody, "postgres_driver"), false);
      assert.equal(Object.hasOwn(publicBody, "out_of_scope"), false);

      const rejectedBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "Bearer wrong-token"
      );
      assert.equal(Object.hasOwn(rejectedBody, "environment"), false);

      withProcessEnv({ SMOKE_OR_CLEANUP_TOKEN: undefined }, () => {
        const unsetTokenBody = runtimeCanaryResponseBody(
          "https://example.test/api/runtime/canary",
          "Bearer smoke-token"
        );
        assert.equal(Object.hasOwn(unsetTokenBody, "environment"), false);
        assert.equal(Object.hasOwn(unsetTokenBody, "postgres_driver"), false);
        assert.equal(Object.hasOwn(unsetTokenBody, "out_of_scope"), false);
      });

      const smokeBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "Bearer smoke-token"
      );
      const trimmedSmokeBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "  Bearer smoke-token  "
      );

      assert("environment" in smokeBody);
      assert("environment" in trimmedSmokeBody);
      assert("postgres_driver" in smokeBody);
      assert("out_of_scope" in smokeBody);
      assert.equal(smokeBody.environment.configured, true);
      assert.deepEqual(smokeBody.environment.missing, []);
      assert.deepEqual(smokeBody.environment.insecure, []);
      assert.equal(smokeBody.environment.appEnv, "development");
      assert.deepEqual(smokeBody.postgres_driver, {
        package: "pg",
        client: "function"
      });
      assert.deepEqual(smokeBody.out_of_scope, [
        "full_human_review_queue_ui",
        "caller_registration",
        "steward_behavior"
      ]);
    }
  );
});

test("sentryCaptureEnabled only allows production runtime capture", () => {
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), true)
  );
  withProcessEnv(
    {
      APP_ENV: "development",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: "true",
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: undefined,
      NODE_ENV: "test"
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: undefined,
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
});

test("database canary statements keep transaction context scoped to one transaction", () => {
  assert.deepEqual(databaseCanaryStatements("request-123"), [
    { sql: "begin" },
    {
      sql: "select set_config($1, $2, true)",
      values: ["agent_outbox.request_id", "request-123"]
    },
    {
      sql: "select current_setting($1, true) as request_id",
      values: ["agent_outbox.request_id"]
    },
    {
      sql: "select current_user as role_name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit from pg_catalog.pg_roles r where r.rolname = current_user"
    },
    { sql: "rollback" }
  ]);
});

test("phase 3 product tables have row level security enabled and forced", () => {
  for (const table of phase3ProductTables) {
    assert.match(
      initialMigration,
      new RegExp(`alter table public\\.${table} enable row level security;`),
      `${table} must enable row level security`
    );
    assert.match(
      initialMigration,
      new RegExp(`alter table public\\.${table} force row level security;`),
      `${table} must force row level security`
    );
  }
});

test("phase 3 migration keeps audit events append-only for the app role", () => {
  const auditGrantStatements = initialMigration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => {
      return (
        statement.startsWith("grant ") &&
        statement.includes("agent_outbox_audit_events") &&
        statement.includes("agent_outbox_app")
      );
    });

  assert.match(
    initialMigration,
    /create trigger agent_outbox_audit_events_append_only/
  );
  assert.deepEqual(auditGrantStatements, [
    "grant select, insert on public.agent_outbox_audit_events to agent_outbox_app"
  ]);
});

test("phase 3 migration uses canonical sources for usage and limit state", () => {
  assert.doesNotMatch(initialMigration, /agent_outbox_account_current_usage/);
  assert.doesNotMatch(initialMigration, /agent_outbox_usage_rollups_daily/);
  assert.match(initialMigration, /limit_name text not null/);
  assert.match(initialMigration, /limit_reason_code text not null/);
  assert.doesNotMatch(initialMigration, /limit_name text not null\s+check/is);
});

test("phase 3 migration defines account-scoped cleanup primitives", () => {
  for (const functionName of [
    "agent_outbox_delete_output_result",
    "agent_outbox_restore_unread_output",
    "agent_outbox_delete_expired_outputs",
    "agent_outbox_delete_retained_pending_inputs",
    "agent_outbox_cleanup_downgrade_grace_expiry",
    "agent_outbox_prune_quota_windows",
    "agent_outbox_prune_expired_limit_blocks",
    "agent_outbox_output_ack_already_recorded"
  ]) {
    assert.match(
      initialMigration,
      new RegExp(`create or replace function public\\.${functionName}\\(`),
      `${functionName} must exist`
    );
  }

  assert.match(initialMigration, /'output_acknowledged'/);
  assert.match(initialMigration, /'output_timeout'/);
  assert.match(initialMigration, /'input_retention'/);
  assert.match(initialMigration, /'downgrade_grace_file_output'/);
  assert.match(initialMigration, /'downgrade_grace_non_file_payload_limit'/);
  assert.match(
    initialMigration,
    /if input_status = 'answered' and target_output_id is not null then/
  );
  assert.match(
    initialMigration,
    /from public\.agent_outbox_delete_output_result\(\s*target_output_id,\s*'downgrade_grace_non_file_payload_limit'/s
  );
  assert.match(
    initialMigration,
    /if p_non_file_payload_limit_bytes is null or p_non_file_payload_limit_bytes < 0 then[\s\S]*non_file_payload_limit_bytes must be non-negative/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_delete_expired_outputs[\s\S]*for update skip locked[\s\S]*create or replace function public\.agent_outbox_delete_retained_pending_inputs/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_delete_retained_pending_inputs[\s\S]*for update of i skip locked[\s\S]*create or replace function public\.agent_outbox_cleanup_downgrade_grace_expiry/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_cleanup_downgrade_grace_expiry[\s\S]*for update of o skip locked[\s\S]*with file_input_targets/
  );
  assert.match(
    initialMigration,
    /with file_input_targets as \([\s\S]*for update of i skip locked/
  );
});

test("output operation auth migration narrows destructive SQL functions", () => {
  assert.match(
    outputOperationAuthMatrixMigration,
    /create or replace function public\.agent_outbox_delete_output_result\(\s*p_output_result_id uuid,\s*p_deletion_reason text,\s*p_request_id text default null\s*\)/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /p_deletion_reason = 'acknowledgement'[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'caller'[\s\S]*o\.caller_id = public\.agent_outbox_context_caller_id\(\)/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /p_deletion_reason in \([\s\S]*'output_timeout'[\s\S]*'downgrade_grace_file_output'[\s\S]*'downgrade_grace_non_file_payload_limit'[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'cleanup'/s
  );
  assert.match(
    outputOperationAuthMatrixMigration,
    /create or replace function public\.agent_outbox_restore_unread_output\(\s*p_output_result_id uuid,\s*p_request_id text default null\s*\)[\s\S]*public\.agent_outbox_context_auth_surface\(\) = 'human'[\s\S]*public\.agent_outbox_context_has_account_membership\(\)/s
  );
  assert.doesNotMatch(
    outputOperationAuthMatrixMigration,
    /agent_outbox_context_allows_caller\(o\.caller_id\)/
  );
});

test("phase 3 migration keeps representative policies tied to transaction context", () => {
  assert.match(initialMigration, /agent_outbox_context_account_id\(\)/);
  assert.match(initialMigration, /agent_outbox_context_caller_id\(\)/);
  assert.match(initialMigration, /agent_outbox_context_user_id\(\)/);
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_allows_caller\(p_caller_id uuid\)/
  );
  assert.match(
    initialMigration,
    /when 'caller' then\s+public\.agent_outbox_context_caller_id\(\) is not null\s+and p_caller_id = public\.agent_outbox_context_caller_id\(\)/s
  );
  assert.doesNotMatch(
    initialMigration,
    /agent_outbox_context_caller_id\(\) is null/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_has_account_membership\(\)/
  );
  assert.match(
    initialMigration,
    /create or replace function public\.agent_outbox_context_allows_account\(p_account_id uuid\)/
  );
  assert.match(
    initialMigration,
    /when 'human' then public\.agent_outbox_context_has_account_membership\(\)/
  );
  assert.doesNotMatch(initialMigration, /when 'human' then true/);
  assert.match(
    initialMigration,
    /create policy agent_outbox_input_items_account_context/
  );
  assert.match(
    initialMigration,
    /create policy agent_outbox_output_results_account_context/
  );
  assert.match(
    initialMigration,
    /create policy agent_outbox_callers_account_context/
  );
});

test("phase 3 migration keeps output and file ownership tied to parents", () => {
  assert.match(
    initialMigration,
    /unique \(account_id, caller_id, input_item_id\)/
  );
  assert.match(
    initialMigration,
    /foreign key \(account_id, caller_id, input_item_id\)\s+references public\.agent_outbox_input_items\(account_id, caller_id, input_item_id\)/s
  );
  assert.match(
    initialMigration,
    /unique \(account_id, caller_id, output_result_id\)/
  );
  assert.match(
    initialMigration,
    /foreign key \(account_id, caller_id, output_result_id\)\s+references public\.agent_outbox_output_results\(account_id, caller_id, output_result_id\)/s
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /constraint agent_outbox_output_files_size_matches_bytes/
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /check \(size_bytes = octet_length\(file_bytes\)\) not valid/
  );
  assert.match(
    outputFileSizeInvariantMigration,
    /validate constraint agent_outbox_output_files_size_matches_bytes/
  );
  assert.match(outputFileSingleRowInvariantMigration, /having count\(\*\) > 1/);
  assert.match(
    outputFileSingleRowInvariantMigration,
    /raise exception 'agent_outbox_output_files already contains multiple rows for one output_result_id'/
  );
  assert.match(
    outputFileSingleRowInvariantMigration,
    /constraint agent_outbox_output_files_one_row_per_result\s+unique \(output_result_id\)/s
  );
});

test("scheduled cleanup account targets are cleanup-surface only", () => {
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /create or replace function public\.agent_outbox_cleanup_account_targets\(\)/
  );
  assert.match(scheduledCleanupAccountTargetsMigration, /security definer/);
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /agent_outbox_context_auth_surface\(\) <> 'cleanup'/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /raise exception 'agent_outbox_cleanup_account_targets forbidden'/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /select account\.account_id, account\.tier[\s\S]*from public\.agent_outbox_accounts account/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /revoke execute on function public\.agent_outbox_cleanup_account_targets\(\) from public;/
  );
  assert.match(
    scheduledCleanupAccountTargetsMigration,
    /grant execute on function public\.agent_outbox_cleanup_account_targets\(\) to agent_outbox_app;/
  );
});

test("never-activated caller prune migration is cleanup-scoped and preserves history", () => {
  assert.match(
    neverActivatedCallerPruneMigration,
    /create or replace function public\.agent_outbox_prune_never_activated_callers\(\s*p_before timestamptz\s*\)/s
  );
  assert.match(neverActivatedCallerPruneMigration, /security definer/);
  assert.match(
    neverActivatedCallerPruneMigration,
    /set search_path = public, pg_temp/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /agent_outbox_context_auth_surface\(\) is distinct from 'cleanup'[\s\S]*agent_outbox_context_account_id\(\) is null/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /raise exception 'agent_outbox_prune_never_activated_callers forbidden'/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /delete from public\.agent_outbox_callers caller/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /caller\.account_id = public\.agent_outbox_context_account_id\(\)/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /credential\.activated_at is not null[\s\S]*credential\.status in \('active', 'revoked'\)[\s\S]*credential\.revoked_at is not null/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /event\.caller_audit_id = caller\.caller_audit_id/
  );
  assert.doesNotMatch(neverActivatedCallerPruneMigration, /event\.caller_id/);
  assert.match(
    neverActivatedCallerPruneMigration,
    /from public\.agent_outbox_input_items input[\s\S]*input\.caller_id = caller\.caller_id/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /from public\.agent_outbox_output_results output[\s\S]*output\.caller_id = caller\.caller_id/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /revoke execute on function public\.agent_outbox_prune_never_activated_callers\(timestamptz\) from public;/
  );
  assert.match(
    neverActivatedCallerPruneMigration,
    /grant execute on function public\.agent_outbox_prune_never_activated_callers\(timestamptz\) to agent_outbox_app;/
  );
  assert.match(neverActivatedCallerPruneMigration, /'anon'/);
  assert.match(neverActivatedCallerPruneMigration, /'authenticated'/);
  assert.match(neverActivatedCallerPruneMigration, /'service_role'/);
});

test("phase 3 migration restricts app function execution to the app role", () => {
  for (const functionSignature of [
    "agent_outbox_context_account_id()",
    "agent_outbox_context_user_id()",
    "agent_outbox_context_caller_id()",
    "agent_outbox_context_auth_surface()",
    "agent_outbox_context_has_account_membership()",
    "agent_outbox_context_allows_account(uuid)",
    "agent_outbox_context_allows_caller(uuid)",
    "agent_outbox_context_allows_caller_audit_id(uuid)",
    "agent_outbox_lookup_caller_credential(text)",
    "agent_outbox_reject_account_audit_id_mutation()",
    "agent_outbox_reject_caller_audit_id_mutation()",
    "agent_outbox_reject_audit_mutation()",
    "agent_outbox_output_ack_already_recorded(uuid)",
    "agent_outbox_delete_output_result(uuid, text, text)",
    "agent_outbox_restore_unread_output(uuid, text)",
    "agent_outbox_delete_expired_outputs(timestamptz)",
    "agent_outbox_delete_retained_pending_inputs(timestamptz, text)",
    "agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz)",
    "agent_outbox_prune_quota_windows(timestamptz)",
    "agent_outbox_prune_expired_limit_blocks(timestamptz)"
  ]) {
    const escapedSignature = functionSignature.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    assert.match(
      initialMigration,
      new RegExp(
        `revoke execute on function public\\.${escapedSignature} from public;`
      )
    );
    assert.match(
      initialMigration,
      new RegExp(
        `grant execute on function public\\.${escapedSignature} to agent_outbox_app;`
      )
    );
  }
  assert.match(initialMigration, /foreach provider_role in array array/);
  assert.match(initialMigration, /'anon'/);
  assert.match(initialMigration, /'authenticated'/);
  assert.match(initialMigration, /'service_role'/);
});

test("initial migration keeps the app role restricted before schema access", () => {
  assert.match(initialMigration, /create role agent_outbox_app/);
  assert.match(initialMigration, /nosuperuser/);
  assert.match(initialMigration, /nocreatedb/);
  assert.match(initialMigration, /nocreaterole/);
  assert.match(initialMigration, /noreplication/);
  assert.match(initialMigration, /noinherit/);
  assert.match(initialMigration, /nobypassrls/);
  assert.match(initialMigration, /pg_catalog\.pg_auth_members/);
  assert.match(
    initialMigration,
    /raise exception 'agent_outbox_app must be a restricted non-bypass role before migrations run'/
  );
  assert.match(
    initialMigration,
    /raise exception 'agent_outbox_app must not be a member of any role before migrations run'/
  );
  assert.match(
    initialMigration,
    /grant usage on schema extensions to agent_outbox_app;/
  );
  assert.doesNotMatch(initialMigration, /timezone\('utc', now\(\)\)/);
  assert.match(
    initialMigration,
    /create trigger agent_outbox_accounts_audit_id_immutable/
  );
  assert.match(
    initialMigration,
    /create trigger agent_outbox_callers_audit_id_immutable/
  );
});

test(
  "phase 3 local database enforces representative policies and shared cleanup",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database policy verification"
  },
  async () => {
    const databaseVerificationUrl = phase3DatabaseVerificationUrl;
    assert.ok(databaseVerificationUrl);
    const client = new Client({
      application_name: "agent-outbox-phase3-db-verification",
      connectionString: databaseVerificationUrl
    });
    const runId = crypto.randomUUID();
    const accountLabelA = `phase3-a-${runId}`;
    const accountLabelB = `phase3-b-${runId}`;
    const ipQuotaAddress = `2001:db8::${runId.slice(0, 4)}:${runId.slice(4, 8)}`;
    const ipQuotaPolicyMetric = `phase3_policy_probe_${runId}`;
    /** @type {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string, callerA?: string, callerA2?: string, callerB?: string, reclaimCaller?: string, auditPreservedCaller?: string, activatedPreservedCaller?: string, revokedPreservedCaller?: string, answeredInput?: string, fileOutputInput?: string, fileUploadInput?: string, output?: string, fileOutput?: string, ipQuotaAddress?: string }} */
    const ids = { ipQuotaAddress };
    let grantedAppRoleForTest = false;

    await client.connect();

    try {
      const rolePosture = await client.query(
        `
          select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
          from pg_catalog.pg_roles
          where rolname = 'agent_outbox_app'
        `
      );
      assert.deepEqual(rolePosture.rows[0], {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false
      });
      const appRoleMemberships = await client.query(
        `
          select 1
          from pg_catalog.pg_auth_members membership
          join pg_catalog.pg_roles app_role
            on app_role.oid = membership.member
          where app_role.rolname = 'agent_outbox_app'
        `
      );
      assert.deepEqual(appRoleMemberships.rows, []);
      const extensionSchemaUsage = await client.query(
        "select has_schema_privilege('agent_outbox_app', 'extensions', 'usage') as app_usage"
      );
      assert.deepEqual(extensionSchemaUsage.rows[0], { app_usage: true });
      const functionPrivileges = await client.query(
        `
          select
            function_name,
            has_function_privilege('public', function_name, 'execute') as public_execute,
            has_function_privilege('agent_outbox_app', function_name, 'execute') as app_execute
          from unnest($1::text[]) as function_name
          order by function_name
        `,
        [
          [
            "public.agent_outbox_context_account_id()",
            "public.agent_outbox_context_user_id()",
            "public.agent_outbox_context_caller_id()",
            "public.agent_outbox_context_auth_surface()",
            "public.agent_outbox_context_has_account_membership()",
            "public.agent_outbox_context_allows_account(uuid)",
            "public.agent_outbox_context_allows_caller(uuid)",
            "public.agent_outbox_context_allows_caller_audit_id(uuid)",
            "public.agent_outbox_lookup_caller_credential(text)",
            "public.agent_outbox_reject_account_audit_id_mutation()",
            "public.agent_outbox_reject_caller_audit_id_mutation()",
            "public.agent_outbox_reject_audit_mutation()",
            "public.agent_outbox_output_ack_already_recorded(uuid)",
            "public.agent_outbox_delete_output_result(uuid, text, text)",
            "public.agent_outbox_restore_unread_output(uuid, text)",
            "public.agent_outbox_delete_expired_outputs(timestamptz)",
            "public.agent_outbox_delete_retained_pending_inputs(timestamptz, text)",
            "public.agent_outbox_cleanup_downgrade_grace_expiry(bigint, timestamptz)",
            "public.agent_outbox_prune_quota_windows(timestamptz)",
            "public.agent_outbox_prune_ip_quota_windows(timestamptz)",
            "public.agent_outbox_prune_caller_setup_requests(timestamptz)",
            "public.agent_outbox_prune_never_activated_callers(timestamptz)",
            "public.agent_outbox_prune_expired_limit_blocks(timestamptz)",
            "public.agent_outbox_cleanup_account_targets()"
          ]
        ]
      );
      assert.deepEqual(
        functionPrivileges.rows.map((row) => ({
          public_execute: row.public_execute,
          app_execute: row.app_execute
        })),
        functionPrivileges.rows.map(() => ({
          public_execute: false,
          app_execute: true
        }))
      );
      const providerRoleRows = await client.query(
        `
          select rolname
          from pg_catalog.pg_roles
          where rolname = any($1::name[])
          order by rolname
        `,
        [["anon", "authenticated", "service_role"]]
      );
      for (const row of providerRoleRows.rows) {
        const providerFunctionPrivileges = await client.query(
          `
            select has_function_privilege($1, function_name, 'execute') as provider_execute
            from unnest($2::text[]) as function_name
            order by function_name
          `,
          [
            row.rolname,
            functionPrivileges.rows.map(
              (functionRow) => functionRow.function_name
            )
          ]
        );
        assert.deepEqual(
          providerFunctionPrivileges.rows.map(
            (privilegeRow) => privilegeRow.provider_execute
          ),
          providerFunctionPrivileges.rows.map(() => false)
        );
      }
      const hadAppRoleBeforeGrant = await client.query(
        "select pg_has_role(current_user, 'agent_outbox_app', 'member') as is_member"
      );
      if (hadAppRoleBeforeGrant.rows[0]?.is_member !== true) {
        await client.query(
          `
            do $$
            begin
              execute format('grant agent_outbox_app to %I', current_user);
            end
            $$;
          `
        );
        grantedAppRoleForTest = true;
      }

      await client.query("begin");

      const accountRows = await client.query(
        `
          insert into public.agent_outbox_accounts(label)
          values ($1), ($2)
          returning account_id, account_audit_id, label
        `,
        [accountLabelA, accountLabelB]
      );
      for (const row of accountRows.rows) {
        if (row.label === accountLabelA) {
          ids.accountA = row.account_id;
          ids.accountAuditA = row.account_audit_id;
        } else {
          ids.accountB = row.account_id;
          ids.accountAuditB = row.account_audit_id;
        }
      }

      const userRows = await client.query(
        `
          insert into public.agent_outbox_users(clerk_user_id)
          values ($1)
          returning user_id
        `,
        [`phase3-user-${runId}`]
      );
      ids.userA = userRows.rows[0].user_id;

      await client.query(
        `
          insert into public.agent_outbox_account_members(account_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [ids.accountA, ids.userA]
      );

      const callerRows = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values
            ($1, 'Caller A', $2),
            ($1, 'Caller A2', $3),
            ($4, 'Caller B', $5)
          returning caller_id, caller_slug
        `,
        [
          ids.accountA,
          `caller-a-${runId}`,
          `caller-a2-${runId}`,
          ids.accountB,
          `caller-b-${runId}`
        ]
      );
      for (const row of callerRows.rows) {
        if (row.caller_slug === `caller-a-${runId}`) {
          ids.callerA = row.caller_id;
        } else if (row.caller_slug === `caller-a2-${runId}`) {
          ids.callerA2 = row.caller_id;
        } else {
          ids.callerB = row.caller_id;
        }
      }

      const abandonedCallerSlugs = {
        reclaim: `reclaim-${runId}`,
        audit: `preserve-audit-${runId}`,
        activated: `preserve-activated-${runId}`,
        revoked: `preserve-revoked-${runId}`
      };
      const abandonedCallerRows = await client.query(
        `
          insert into public.agent_outbox_callers(
            account_id,
            display_name,
            caller_slug,
            created_at,
            updated_at
          )
          values
            ($1, 'Reclaim abandoned caller', $2, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Audit preserved caller', $3, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Activated preserved caller', $4, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($1, 'Revoked preserved caller', $5, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
          returning caller_id, caller_slug, caller_audit_id
        `,
        [
          ids.accountA,
          abandonedCallerSlugs.reclaim,
          abandonedCallerSlugs.audit,
          abandonedCallerSlugs.activated,
          abandonedCallerSlugs.revoked
        ]
      );
      const abandonedCallerRowsBySlug = new Map(
        abandonedCallerRows.rows.map((row) => [row.caller_slug, row])
      );
      ids.reclaimCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.reclaim
      )?.caller_id;
      ids.auditPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.audit
      )?.caller_id;
      ids.activatedPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.activated
      )?.caller_id;
      ids.revokedPreservedCaller = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.revoked
      )?.caller_id;
      assert.ok(ids.reclaimCaller);
      assert.ok(ids.auditPreservedCaller);
      assert.ok(ids.activatedPreservedCaller);
      assert.ok(ids.revokedPreservedCaller);
      const auditPreservedCallerAuditId = abandonedCallerRowsBySlug.get(
        abandonedCallerSlugs.audit
      )?.caller_audit_id;
      assert.ok(auditPreservedCallerAuditId);

      await client.query(
        `
          insert into public.agent_outbox_audit_events(
            event_type,
            account_audit_id,
            caller_audit_id,
            request_id
          )
          values ('caller_registered', $1, $2, $3)
        `,
        [ids.accountAuditA, auditPreservedCallerAuditId, `audit-${runId}`]
      );

      const credentialKeyId = `key-${runId}`;
      const credentialA2KeyId = `key-a2-${runId}`;
      const credentialDigest = "c".repeat(64);
      const credentialRows = await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            activated_at
          )
          values
            ($1, $2, $3, 'aob_live_phase3_test', 'test', $4, 'active', '2026-06-30T12:00:00.000Z'),
            ($1, $5, $6, 'aob_live_phase3_a2', 'a2ky', $7, 'active', '2026-06-30T12:00:00.000Z')
          returning caller_credential_id, key_id
        `,
        [
          ids.accountA,
          ids.callerA,
          credentialKeyId,
          credentialDigest,
          ids.callerA2,
          credentialA2KeyId,
          "d".repeat(64)
        ]
      );
      const credentialIdsByKeyId = new Map(
        credentialRows.rows.map((row) => [row.key_id, row.caller_credential_id])
      );
      const activeCredentialAId = credentialIdsByKeyId.get(credentialKeyId);
      const activeCredentialA2Id = credentialIdsByKeyId.get(credentialA2KeyId);
      assert.ok(activeCredentialAId);
      assert.ok(activeCredentialA2Id);

      const abandonedSetupLabels = {
        reclaim: `abandoned-reclaim-${runId}`,
        audit: `abandoned-audit-${runId}`
      };
      const abandonedSetupRows = await client.query(
        `
          insert into public.agent_outbox_caller_setup_requests(
            operation,
            flow,
            local_caller_name,
            display_name,
            callback_url,
            account_id,
            caller_id,
            approved_by_user_id,
            status,
            expires_at,
            updated_at,
            approved_at,
            exchanged_at
          )
          values
            ('connect', 'browser', $1, 'Abandoned reclaim', 'http://127.0.0.1/callback', $3, $4, $6, 'exchanged', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ('connect', 'browser', $2, 'Abandoned audit', 'http://127.0.0.1/callback', $3, $5, $6, 'exchanged', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
          returning setup_request_id, local_caller_name
        `,
        [
          abandonedSetupLabels.reclaim,
          abandonedSetupLabels.audit,
          ids.accountA,
          ids.reclaimCaller,
          ids.auditPreservedCaller,
          ids.userA
        ]
      );
      const abandonedSetupIdsByLabel = new Map(
        abandonedSetupRows.rows.map((row) => [
          row.local_caller_name,
          row.setup_request_id
        ])
      );
      const reclaimSetupRequestId = abandonedSetupIdsByLabel.get(
        abandonedSetupLabels.reclaim
      );
      const auditSetupRequestId = abandonedSetupIdsByLabel.get(
        abandonedSetupLabels.audit
      );
      assert.ok(reclaimSetupRequestId);
      assert.ok(auditSetupRequestId);

      await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            activated_at,
            revoked_at,
            expires_at,
            last_used_at,
            pending_replacement_setup_request_id
          )
          values
            ($1, $2, $3, 'aob_live_abandoned', 'abnd', $4, 'pending_activation', null, null, '2026-06-02T00:00:00.000Z', null, $5),
            ($1, $6, $7, 'aob_live_abandoned_audit', 'aadt', $8, 'pending_activation', null, null, '2026-06-02T00:00:00.000Z', null, $9),
            ($1, $10, $11, 'aob_live_activated', 'actv', $12, 'expired', '2026-06-01T00:00:00.000Z', null, '2026-06-02T00:00:00.000Z', null, null),
            ($1, $13, $14, 'aob_live_revoked', 'rvkd', $15, 'expired', null, '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', null, null)
        `,
        [
          ids.accountA,
          ids.reclaimCaller,
          `abandoned-${runId}`,
          "1".repeat(64),
          reclaimSetupRequestId,
          ids.auditPreservedCaller,
          `abandoned-audit-${runId}`,
          "2".repeat(64),
          auditSetupRequestId,
          ids.activatedPreservedCaller,
          `activated-history-${runId}`,
          "3".repeat(64),
          ids.revokedPreservedCaller,
          `revoked-history-${runId}`,
          "4".repeat(64)
        ]
      );

      const setupPrunePrefix = `setup-prune-${runId}`;
      const setupLabels = {
        terminalStale: `${setupPrunePrefix}-terminal-stale`,
        terminalFresh: `${setupPrunePrefix}-terminal-fresh`,
        pendingExpired: `${setupPrunePrefix}-pending-expired`,
        pendingLive: `${setupPrunePrefix}-pending-live`,
        approvedExpired: `${setupPrunePrefix}-approved-expired`,
        referencedPendingReplacement: `${setupPrunePrefix}-referenced-pending-replacement`,
        cascadeProbe: `setup-cascade-${runId}`,
        duplicatePendingProbe: `setup-duplicate-pending-${runId}`
      };
      const setupRows = await client.query(
        `
          insert into public.agent_outbox_caller_setup_requests(
            operation,
            flow,
            local_caller_name,
            display_name,
            callback_url,
            account_id,
            caller_id,
            approved_by_user_id,
            status,
            expires_at,
            updated_at,
            approved_at,
            exchanged_at,
            denied_at
          )
          values
            ('connect', 'browser', $1, 'Terminal stale', 'http://127.0.0.1/callback', $9, $10, $12, 'exchanged', '2026-07-14T12:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null),
            ('connect', 'browser', $2, 'Terminal fresh', 'http://127.0.0.1/callback', $9, $10, $12, 'denied', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null, '2026-06-20T00:00:00.000Z'),
            ('connect', 'browser', $3, 'Pending expired', 'http://127.0.0.1/callback', $9, $10, null, 'pending', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null, null),
            ('connect', 'browser', $4, 'Pending live', 'http://127.0.0.1/callback', $9, $10, null, 'pending', '2026-06-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null, null),
            ('connect', 'browser', $5, 'Approved expired', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $6, 'Referenced pending replacement', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $7, 'Cascade probe', 'http://127.0.0.1/callback', $9, $11, $12, 'approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', null, null),
            ('rotate', 'browser', $8, 'Duplicate pending probe', 'http://127.0.0.1/callback', $9, $10, $12, 'approved', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', null, null)
          returning setup_request_id, local_caller_name
        `,
        [
          setupLabels.terminalStale,
          setupLabels.terminalFresh,
          setupLabels.pendingExpired,
          setupLabels.pendingLive,
          setupLabels.approvedExpired,
          setupLabels.referencedPendingReplacement,
          setupLabels.cascadeProbe,
          setupLabels.duplicatePendingProbe,
          ids.accountA,
          ids.callerA,
          ids.callerA2,
          ids.userA
        ]
      );
      const setupRequestIdsByLabel = new Map(
        setupRows.rows.map((row) => [
          row.local_caller_name,
          row.setup_request_id
        ])
      );
      const referencedSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.referencedPendingReplacement
      );
      const cascadeSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.cascadeProbe
      );
      const duplicatePendingSetupRequestId = setupRequestIdsByLabel.get(
        setupLabels.duplicatePendingProbe
      );
      assert.ok(referencedSetupRequestId);
      assert.ok(cascadeSetupRequestId);
      assert.ok(duplicatePendingSetupRequestId);

      const pendingReplacementKeyId = `pending-${runId}`;
      const cascadePendingReplacementKeyId = `pending-cascade-${runId}`;
      await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status,
            expires_at,
            pending_replacement_for_credential_id,
            pending_replacement_setup_request_id
          )
          values
            ($1, $2, $3, 'aob_live_pending_a', 'pend', $4, 'pending_activation', '2026-07-01T00:00:00.000Z', $5, $6),
            ($1, $7, $8, 'aob_live_pending_a2', 'pa2k', $9, 'pending_activation', '2026-07-01T00:00:00.000Z', $10, $11)
        `,
        [
          ids.accountA,
          ids.callerA,
          pendingReplacementKeyId,
          "e".repeat(64),
          activeCredentialAId,
          referencedSetupRequestId,
          ids.callerA2,
          cascadePendingReplacementKeyId,
          "f".repeat(64),
          activeCredentialA2Id,
          cascadeSetupRequestId
        ]
      );

      const inputRows = await client.query(
        `
          insert into public.agent_outbox_input_items(
            account_id,
            caller_id,
            caller_item_id,
            caller_item_id_hash,
            row_type_display,
            row_type_icon,
            title_html,
            subtitle_html,
            summary_html,
            status,
            non_file_payload_bytes,
            updated_at,
            answered_at
          )
          values
            ($1, $2, 'item-a', $3, 'Review', 'Inbox', 'Title A', 'Subtitle A', 'Summary A', 'pending', 10, '2026-06-30T12:00:00.000Z', null),
            ($1, $4, 'item-a2', $5, 'Review', 'Inbox', 'Title A2', 'Subtitle A2', 'Summary A2', 'pending', 10, '2026-06-30T12:00:00.000Z', null),
            ($6, $7, 'item-b', $8, 'Review', 'Inbox', 'Title B', 'Subtitle B', 'Summary B', 'pending', 10, '2026-06-30T12:00:00.000Z', null),
            ($1, $2, 'answered-over-cap', $9, 'Review', 'Inbox', 'Answered title', 'Answered subtitle', 'Answered summary', 'answered', 100, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
            ($1, $2, 'ack-output', $10, 'Review', 'Inbox', 'Ack title', 'Ack subtitle', 'Ack summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'timeout-output', $11, 'Review', 'Inbox', 'Timeout title', 'Timeout subtitle', 'Timeout summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'undo-output', $12, 'Review', 'Inbox', 'Undo title', 'Undo subtitle', 'Undo summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'retained-pending', $13, 'Review', 'Inbox', 'Retention title', 'Retention subtitle', 'Retention summary', 'pending', 10, '2026-01-01T00:00:00.000Z', null),
            ($1, $2, 'file-output', $14, 'Review', 'Inbox', 'File output title', 'File output subtitle', 'File output summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'file-upload-pending', $15, 'Review', 'Inbox', 'File upload title', 'File upload subtitle', 'File upload summary', 'pending', 12, '2026-06-29T12:00:00.000Z', null)
          returning input_item_id, caller_item_id
        `,
        [
          ids.accountA,
          ids.callerA,
          `hash-a-${runId}`,
          ids.callerA2,
          `hash-a2-${runId}`,
          ids.accountB,
          ids.callerB,
          `hash-b-${runId}`,
          `hash-answered-${runId}`,
          `hash-ack-${runId}`,
          `hash-timeout-${runId}`,
          `hash-undo-${runId}`,
          `hash-retained-${runId}`,
          `hash-file-output-${runId}`,
          `hash-file-upload-${runId}`
        ]
      );
      const inputIdsByCallerItemId = new Map(
        inputRows.rows.map((row) => [row.caller_item_id, row.input_item_id])
      );
      ids.answeredInput = inputIdsByCallerItemId.get("answered-over-cap");
      ids.fileOutputInput = inputIdsByCallerItemId.get("file-output");
      ids.fileUploadInput = inputIdsByCallerItemId.get("file-upload-pending");

      await client.query(
        `
          insert into public.agent_outbox_input_actions(
            input_item_id,
            display_order,
            display,
            icon,
            action_value,
            popup_kind
          )
          values ($1, 0, 'Upload', 'upload', 'upload', 'file_upload')
        `,
        [ids.fileUploadInput]
      );

      /**
       * @param {string} callerItemId
       * @param {string} expiresAt
       * @returns {Promise<string>}
       */
      async function createOutput(callerItemId, expiresAt) {
        const output = await client.query(
          `
            insert into public.agent_outbox_output_results(
              account_id,
              caller_id,
              input_item_id,
              caller_item_id,
              action_value,
              response_kind,
              response_payload,
              response_payload_bytes,
              expires_at
            )
            values (
              $1,
              $2,
              $3,
              $4,
              'approve',
              'none',
              '{}'::jsonb,
              25,
              $5
            )
            returning output_result_id
          `,
          [
            ids.accountA,
            ids.callerA,
            inputIdsByCallerItemId.get(callerItemId),
            callerItemId,
            expiresAt
          ]
        );

        return output.rows[0].output_result_id;
      }

      ids.output = await createOutput(
        "answered-over-cap",
        "2026-07-14T12:00:00.000Z"
      );
      const ackOutputId = await createOutput(
        "ack-output",
        "2026-07-14T12:00:00.000Z"
      );
      const timeoutOutputId = await createOutput(
        "timeout-output",
        "2026-06-30T11:59:00.000Z"
      );
      const undoOutputId = await createOutput(
        "undo-output",
        "2026-07-14T12:00:00.000Z"
      );
      ids.fileOutput = await createOutput(
        "file-output",
        "2026-07-14T12:00:00.000Z"
      );
      const accountBOutput = await client.query(
        `
          insert into public.agent_outbox_output_results(
            account_id,
            caller_id,
            input_item_id,
            caller_item_id,
            action_value,
            response_kind,
            response_payload,
            response_payload_bytes,
            expires_at
          )
          values (
            $1,
            $2,
            $3,
            'item-b',
            'approve',
            'none',
            '{}'::jsonb,
            25,
            '2026-07-14T12:00:00.000Z'
          )
          returning output_result_id
        `,
        [ids.accountB, ids.callerB, inputIdsByCallerItemId.get("item-b")]
      );
      const accountBOutputId = accountBOutput.rows[0].output_result_id;

      await client.query(
        `
          insert into public.agent_outbox_output_files(
            output_result_id,
            account_id,
            caller_id,
            filename,
            mime_type,
            size_bytes,
            sha256,
            file_bytes
          )
          values
            ($1, $2, $3, 'ack.txt', 'text/plain', 3, repeat('a', 64), decode('61636b', 'hex')),
            ($4, $2, $3, 'undo.txt', 'text/plain', 4, repeat('b', 64), decode('756e646f', 'hex')),
            ($5, $2, $3, 'file-output.txt', 'text/plain', 5, repeat('e', 64), decode('66696c6531', 'hex'))
        `,
        [ackOutputId, ids.accountA, ids.callerA, undoOutputId, ids.fileOutput]
      );

      /**
       * @param {string} authSurface
       * @param {{ accountId?: string, callerId?: string, userId?: string }} context
       */
      async function setOperationContext(authSurface, context = {}) {
        const settings = {
          "agent_outbox.auth_surface": authSurface,
          "agent_outbox.account_id": context.accountId ?? "",
          "agent_outbox.caller_id": context.callerId ?? "",
          "agent_outbox.user_id": context.userId ?? ""
        };

        for (const [name, value] of Object.entries(settings)) {
          await client.query("select set_config($1, $2, true)", [name, value]);
        }
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");

      await setOperationContext("human", {
        accountId: ids.accountA,
        userId: ids.userA
      });
      const humanAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-human-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(humanAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA
      });
      const callerTimeoutDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'output_timeout',
            'phase3-deny-caller-timeout'
          )
        `,
        [timeoutOutputId]
      );
      assert.deepEqual(callerTimeoutDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("cleanup", {
        accountId: ids.accountA
      });
      const cleanupAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-cleanup-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(cleanupAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA2
      });
      const wrongCallerAcknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-deny-wrong-caller-ack'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(wrongCallerAcknowledgementDeletion.rows[0], {
        output_deleted: false,
        input_deleted: false,
        files_deleted: 0
      });

      await setOperationContext("caller", {
        accountId: ids.accountA,
        callerId: ids.callerA
      });
      const callerUndoRestore = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-deny-caller-undo')",
        [undoOutputId]
      );
      assert.deepEqual(callerUndoRestore.rows[0], {
        output_deleted: false,
        input_restored: false,
        files_deleted: 0
      });

      await setOperationContext("cleanup", {
        accountId: ids.accountA
      });
      const cleanupUndoRestore = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-deny-cleanup-undo')",
        [undoOutputId]
      );
      assert.deepEqual(cleanupUndoRestore.rows[0], {
        output_deleted: false,
        input_restored: false,
        files_deleted: 0
      });

      const operationAuthPreservation = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $1) as ack_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $2) as timeout_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $3) as undo_output_count,
            (select count(*)::int from public.agent_outbox_output_files where output_result_id in ($1, $3)) as file_count
        `,
        [ackOutputId, timeoutOutputId, undoOutputId]
      );
      assert.deepEqual(operationAuthPreservation.rows[0], {
        ack_output_count: 1,
        timeout_output_count: 1,
        undo_output_count: 1,
        file_count: 2
      });
      await client.query("reset role");
      await client.query("commit");

      await client.query(
        `
          insert into public.agent_outbox_account_quota_windows(
            account_id,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values ($1, 'input_submissions_per_day', 'day', '2026-06-01T00:00:00.000Z', 5, '2026-06-01T00:00:00.000Z')
        `,
        [ids.accountA]
      );

      await client.query(
        `
          insert into public.agent_outbox_ip_quota_windows(
            ip_address,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values (
            $1::inet,
            'caller_connect_start_requests_per_ip_per_minute',
            'minute',
            '2026-06-01T00:00:00.000Z',
            5,
            '2026-06-01T00:00:00.000Z'
          )
        `,
        [ids.ipQuotaAddress]
      );

      await client.query(
        `
          insert into public.agent_outbox_account_limit_blocks(
            account_id,
            operation_kind,
            limit_name,
            limit_reason_code,
            limit_reason,
            limit_resets_at,
            used_units,
            limit_units
          )
          values (
            $1,
            'output_check_read',
            'output_check_read_requests_per_account_per_minute',
            'output_check_read_rate_limited',
            'Output check/read requests are temporarily rate limited.',
            '2026-06-30T11:59:00.000Z',
            121,
            120
          )
        `,
        [ids.accountA]
      );

      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      const directCredentialRows = await client.query(
        `
          select key_id
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.deepEqual(directCredentialRows.rows, []);
      const lookedUpCredential = await client.query(
        `
          select *
          from public.agent_outbox_lookup_caller_credential($1)
        `,
        [credentialKeyId]
      );
      assert.deepEqual(lookedUpCredential.rows[0], {
        account_id: ids.accountA,
        caller_id: ids.callerA,
        key_id: credentialKeyId,
        key_prefix: "aob_live_phase3_test",
        key_last_four: "test",
        secret_hmac_sha256: credentialDigest,
        status: "active",
        revoked_at: null,
        expires_at: null
      });
      await client.query("reset role");
      await client.query("commit");

      const lastUsedAccountId = ids.accountA;
      const lastUsedCallerId = ids.callerA;
      assert.ok(lastUsedAccountId);
      assert.ok(lastUsedCallerId);
      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = '2026-06-30T11:00:00.000Z'
          where key_id = $1
        `,
        [credentialA2KeyId]
      );

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await setOperationContext("caller", {
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId
      });
      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = null
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const nullLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const nullLastUsedUpdate = await client.query(
        nullLastUsedStatement.sql,
        nullLastUsedStatement.values ?? []
      );
      assert.equal(nullLastUsedUpdate.rowCount, 1);
      const nullLastUsedRows = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.ok(nullLastUsedRows.rows[0].last_used_at);

      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = '2026-06-30T11:00:00.000Z'
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const staleLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const staleLastUsedUpdate = await client.query(
        staleLastUsedStatement.sql,
        staleLastUsedStatement.values ?? []
      );
      assert.equal(staleLastUsedUpdate.rowCount, 1);
      const scopedLastUsedRows = await client.query(
        `
          select key_id, last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
          order by key_id
        `,
        [credentialKeyId]
      );
      assert.deepEqual(
        scopedLastUsedRows.rows.map((row) => row.key_id),
        [credentialKeyId]
      );
      assert.notEqual(
        scopedLastUsedRows.rows[0].last_used_at.toISOString(),
        "2026-06-30T11:00:00.000Z"
      );

      await client.query(
        `
          update public.agent_outbox_caller_credentials
          set last_used_at = now()
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const freshLastUsedBefore = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      const freshLastUsedStatement = callerCredentialLastUsedStatement({
        accountId: lastUsedAccountId,
        callerId: lastUsedCallerId,
        keyId: credentialKeyId
      });
      const freshLastUsedUpdate = await client.query(
        freshLastUsedStatement.sql,
        freshLastUsedStatement.values ?? []
      );
      assert.equal(freshLastUsedUpdate.rowCount, 0);
      const freshLastUsedAfter = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialKeyId]
      );
      assert.equal(
        freshLastUsedAfter.rows[0].last_used_at.toISOString(),
        freshLastUsedBefore.rows[0].last_used_at.toISOString()
      );
      await client.query("reset role");
      await client.query("commit");

      const otherCallerLastUsedRows = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [credentialA2KeyId]
      );
      assert.equal(
        otherCallerLastUsedRows.rows[0].last_used_at.toISOString(),
        "2026-06-30T11:00:00.000Z"
      );

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_caller_credentials(
                account_id,
                caller_id,
                key_id,
                key_prefix,
                key_last_four,
                secret_hmac_sha256,
                status,
                expires_at,
                pending_replacement_for_credential_id,
                pending_replacement_setup_request_id
              )
              values (
                $1,
                $2,
                $3,
                'aob_live_pending_dup',
                'pdup',
                $4,
                'pending_activation',
                '2026-07-01T00:00:00.000Z',
                $5,
                $6
              )
            `,
            [
              ids.accountA,
              ids.callerA,
              `pending-duplicate-${runId}`,
              "a".repeat(64),
              activeCredentialAId,
              duplicatePendingSetupRequestId
            ]
          ),
          (error) => {
            const databaseError =
              /** @type {{ code?: string, constraint?: string }} */ (error);
            assert.equal(databaseError.code, "23505");
            assert.equal(
              databaseError.constraint,
              "agent_outbox_one_pending_replacement_per_caller"
            );
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const cascadePendingBefore = await client.query(
        `
          select count(*)::int as credential_count
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [cascadePendingReplacementKeyId]
      );
      assert.equal(cascadePendingBefore.rows[0].credential_count, 1);
      const deletedCascadeSetup = await client.query(
        `
          delete from public.agent_outbox_caller_setup_requests
          where setup_request_id = $1
          returning setup_request_id
        `,
        [cascadeSetupRequestId]
      );
      assert.equal(deletedCascadeSetup.rows.length, 1);
      const cascadePendingAfter = await client.query(
        `
          select count(*)::int as credential_count
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [cascadePendingReplacementKeyId]
      );
      assert.equal(cascadePendingAfter.rows[0].credential_count, 0);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_accounts
              set account_audit_id = '00000000-0000-0000-0000-000000000001'
              where account_id = $1
            `,
            [ids.accountA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_callers
              set caller_audit_id = '00000000-0000-0000-0000-000000000002'
              where caller_id = $1
            `,
            [ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const humanNonMemberRows = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id = 'item-b'
        `
      );
      assert.deepEqual(humanNonMemberRows.rows, []);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_results(
                account_id,
                caller_id,
                input_item_id,
                caller_item_id,
                action_value,
                response_kind,
                response_payload,
                response_payload_bytes,
                expires_at
              )
              values (
                $1,
                $2,
                $3,
                'item-a2',
                'approve',
                'none',
                '{}'::jsonb,
                25,
                '2026-07-14T12:00:00.000Z'
              )
            `,
            [ids.accountA, ids.callerA, inputIdsByCallerItemId.get("item-a2")]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23503");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_files(
                output_result_id,
                account_id,
                caller_id,
                filename,
                mime_type,
                size_bytes,
                sha256,
                file_bytes
              )
              values ($1, $2, $3, 'bad.txt', 'text/plain', 3, repeat('d', 64), decode('626164', 'hex'))
            `,
            [accountBOutputId, ids.accountA, ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23503");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_output_files(
                output_result_id,
                account_id,
                caller_id,
                display_order,
                filename,
                mime_type,
                size_bytes,
                sha256,
                file_bytes
              )
              values ($1, $2, $3, 1, 'duplicate.txt', 'text/plain', 3, repeat('f', 64), decode('647570', 'hex'))
            `,
            [ackOutputId, ids.accountA, ids.callerA]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "23505");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.caller_id",
        ids.callerA
      ]);
      const visibleItems = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id in ('answered-over-cap', 'item-a', 'item-a2', 'item-b')
          order by caller_item_id
        `
      );
      assert.deepEqual(
        visibleItems.rows.map((row) => row.caller_item_id),
        ["answered-over-cap", "item-a"]
      );
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const missingCallerItems = await client.query(
        `
          select caller_item_id
          from public.agent_outbox_input_items
          where caller_item_id in ('answered-over-cap', 'item-a', 'item-a2', 'item-b')
        `
      );
      assert.deepEqual(missingCallerItems.rows, []);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);
      const controlPlaneIpQuota = await client.query(
        `
          insert into public.agent_outbox_ip_quota_windows(
            ip_address,
            metric,
            window_kind,
            window_start_utc,
            used_units,
            updated_at
          )
          values (
            $1::inet,
            $2,
            'minute',
            '2026-06-20T00:00:00.000Z',
            2,
            '2026-06-20T00:00:00.000Z'
          )
          returning metric, window_kind, used_units::int as used_units
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(controlPlaneIpQuota.rows, [
        { metric: ipQuotaPolicyMetric, window_kind: "minute", used_units: 2 }
      ]);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              update public.agent_outbox_ip_quota_windows
              set used_units = used_units + 1
              where ip_address = $1::inet
                and metric = $2
            `,
            [ids.ipQuotaAddress, ipQuotaPolicyMetric]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      try {
        await assert.rejects(
          client.query(
            `
              insert into public.agent_outbox_ip_quota_windows(
                ip_address,
                metric,
                window_kind,
                window_start_utc,
                used_units,
                updated_at
              )
              values (
                $1::inet,
                $2,
                'minute',
                '2026-06-20T00:00:00.000Z',
                1,
                '2026-06-20T00:00:00.000Z'
              )
            `,
            [ids.ipQuotaAddress, `${ipQuotaPolicyMetric}_cleanup_insert`]
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await resetRoleAndRollback(client);
      }

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const cleanupVisibleIpQuota = await client.query(
        `
          select metric, window_kind, used_units::int as used_units
          from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
            and metric = $2
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(cleanupVisibleIpQuota.rows, [
        { metric: ipQuotaPolicyMetric, window_kind: "minute", used_units: 2 }
      ]);
      const cleanupDeletedIpQuota = await client.query(
        `
          delete from public.agent_outbox_ip_quota_windows
          where ip_address = $1::inet
            and metric = $2
          returning metric
        `,
        [ids.ipQuotaAddress, ipQuotaPolicyMetric]
      );
      assert.deepEqual(cleanupDeletedIpQuota.rows, [
        { metric: ipQuotaPolicyMetric }
      ]);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);
      await client.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            processing_status,
            received_at,
            processed_at
          )
          values
            ($1, 'checkout.session.completed', 'processed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ($2, 'customer.subscription.updated', 'processed', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            ($3, 'invoice.payment_failed', 'processing', '2026-01-01T00:00:00.000Z', null)
        `,
        [`evt_old_${runId}`, `evt_recent_${runId}`, `evt_processing_${runId}`]
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("savepoint non_cleanup_stripe_webhook_prune");
      await assert.rejects(
        client.query(
          "select public.agent_outbox_prune_stripe_webhook_events($1) as deleted_count",
          ["2026-04-01T00:00:00.000Z"]
        ),
        (error) => {
          const databaseError = /** @type {{ code?: string }} */ (error);
          assert.equal(databaseError.code, "42501");
          return true;
        }
      );
      await client.query(
        "rollback to savepoint non_cleanup_stripe_webhook_prune"
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const prunedStripeWebhookEvents = await client.query(
        "select public.agent_outbox_prune_stripe_webhook_events($1)::int as deleted_count",
        ["2026-04-01T00:00:00.000Z"]
      );
      assert.deepEqual(prunedStripeWebhookEvents.rows, [{ deleted_count: 1 }]);
      const retainedStripeWebhookEvents = await client.query(
        `
          select stripe_event_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = any($1::text[])
          order by stripe_event_id
        `,
        [[`evt_old_${runId}`, `evt_recent_${runId}`, `evt_processing_${runId}`]]
      );
      assert.deepEqual(
        retainedStripeWebhookEvents.rows.map((row) => row.stripe_event_id),
        [`evt_processing_${runId}`, `evt_recent_${runId}`].sort()
      );

      // Direct RLS verification for agent_outbox_stripe_webhook_events
      // Currently under "cleanup" surface
      const cleanupSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupSelect.rowCount, 1);

      await client.query("savepoint stripe_cleanup_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type, processing_status) values ($1, 'type', 'processing')",
          [`evt_cleanup_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_cleanup_insert_fail");

      const cleanupUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupUpdate.rowCount, 0);

      const cleanupDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_recent_${runId}`]
      );
      assert.equal(cleanupDelete.rowCount, 1);

      // Switch to control_plane surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "control_plane"
      ]);

      await client.query(
        "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type, processing_status) values ($1, 'checkout.session.completed', 'processing')",
        [`evt_cp_${runId}`]
      );

      const cpSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpSelect.rowCount, 1);

      const cpUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set processing_status = 'processed', processed_at = now() where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpUpdate.rowCount, 1);

      const cpDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpDelete.rowCount, 0);

      // Switch to human surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);

      const humanSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanSelect.rowCount, 0);

      await client.query("savepoint stripe_human_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type, processing_status) values ($1, 'type', 'processing')",
          [`evt_human_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_human_insert_fail");

      const humanUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanUpdate.rowCount, 0);

      const humanDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(humanDelete.rowCount, 0);

      // Switch to caller surface
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);

      const callerSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerSelect.rowCount, 0);

      await client.query("savepoint stripe_caller_insert_fail");
      await assert.rejects(
        client.query(
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type, processing_status) values ($1, 'type', 'processing')",
          [`evt_caller_insert_${runId}`]
        ),
        (error) => {
          const dbError = /** @type {{ code?: string }} */ (error);
          assert.equal(dbError.code, "42501");
          return true;
        }
      );
      await client.query("rollback to savepoint stripe_caller_insert_fail");

      const callerUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'updated' where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerUpdate.rowCount, 0);

      const callerDelete = await client.query(
        "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(callerDelete.rowCount, 0);

      await client.query("reset role");
      await client.query("rollback");

      const productTransactionProbe = await runProductTransaction(
        databaseVerificationUrl,
        {
          requestId: `phase3-tx-${runId}`,
          authSurface: "caller",
          accountId: ids.accountA,
          callerId: ids.callerA
        },
        async (query) => {
          await query({ sql: "set role agent_outbox_app" });
          const contextRows = await query({
            sql: `
              select
                current_setting('agent_outbox.request_id', true) as request_id,
                current_setting('agent_outbox.auth_surface', true) as auth_surface,
                current_setting('agent_outbox.account_id', true) as account_id,
                current_setting('agent_outbox.caller_id', true) as caller_id
            `
          });
          const itemRows = await query({
            sql: `
              select caller_item_id
              from public.agent_outbox_input_items
              where caller_item_id in ('item-a', 'item-a2', 'item-b')
              order by caller_item_id
            `
          });

          return {
            context: contextRows.rows[0],
            itemIds: itemRows.rows.map((row) => row.caller_item_id)
          };
        }
      );
      assert.deepEqual(productTransactionProbe, {
        context: {
          request_id: `phase3-tx-${runId}`,
          auth_surface: "caller",
          account_id: ids.accountA,
          caller_id: ids.callerA
        },
        itemIds: ["item-a"]
      });

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "caller"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.caller_id",
        ids.callerA
      ]);
      const acknowledgementDeletion = await client.query(
        `
          select *
          from public.agent_outbox_delete_output_result(
            $1,
            'acknowledgement',
            'phase3-db-test'
          )
        `,
        [ackOutputId]
      );
      assert.deepEqual(acknowledgementDeletion.rows[0], {
        output_deleted: true,
        input_deleted: true,
        files_deleted: 1
      });
      const duplicateAck = await client.query(
        "select public.agent_outbox_output_ack_already_recorded($1) as already_recorded",
        [ackOutputId]
      );
      assert.equal(duplicateAck.rows[0].already_recorded, true);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "human"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      const undoDeletion = await client.query(
        "select * from public.agent_outbox_restore_unread_output($1, 'phase3-db-test')",
        [undoOutputId]
      );
      assert.deepEqual(undoDeletion.rows[0], {
        output_deleted: true,
        input_restored: true,
        files_deleted: 1
      });
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const expiredOutputs = await client.query(
        "select public.agent_outbox_delete_expired_outputs('2026-06-30T12:00:00.000Z') as deleted_count"
      );
      assert.equal(expiredOutputs.rows[0].deleted_count, 1);
      const retainedInputs = await client.query(
        "select public.agent_outbox_delete_retained_pending_inputs('2026-02-01T00:00:00.000Z') as deleted_count"
      );
      assert.equal(retainedInputs.rows[0].deleted_count, 1);
      const prunedQuotaWindows = await client.query(
        "select public.agent_outbox_prune_quota_windows('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedQuotaWindows.rows[0].deleted_count, 1);
      const prunedIpQuotaWindows = await client.query(
        "select public.agent_outbox_prune_ip_quota_windows('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedIpQuotaWindows.rows[0].deleted_count, 1);
      const prunedSetupRequests = await client.query(
        "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedSetupRequests.rows[0].deleted_count, 3);
      const prunedNeverActivatedCallers = await client.query(
        "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedNeverActivatedCallers.rows[0].deleted_count, 1);
      const prunedLimitBlocks = await client.query(
        "select public.agent_outbox_prune_expired_limit_blocks('2026-06-30T12:00:00.000Z') as deleted_count"
      );
      assert.equal(prunedLimitBlocks.rows[0].deleted_count, 1);
      const cleanupResult = await client.query(
        `
          select *
          from public.agent_outbox_cleanup_downgrade_grace_expiry(
            30,
            '2026-06-30T12:00:00.000Z'
          )
        `
      );
      assert.equal(cleanupResult.rows[0].oldest_inputs_deleted, 1);
      assert.equal(cleanupResult.rows[0].expired_outputs_deleted, 0);
      assert.equal(cleanupResult.rows[0].file_outputs_deleted, 1);
      assert.equal(cleanupResult.rows[0].file_inputs_deleted, 1);
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      const accountlessPrunedSetupRequests = await client.query(
        "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z') as deleted_count"
      );
      assert.equal(accountlessPrunedSetupRequests.rows[0].deleted_count, 0);
      await client.query("savepoint accountless_never_activated_prune");
      try {
        await assert.rejects(
          client.query(
            "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await client.query(
          "rollback to savepoint accountless_never_activated_prune"
        );
      }
      await client.query("reset role");
      await client.query("commit");

      await client.query("begin");
      await client.query("set role agent_outbox_app");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("savepoint non_cleanup_never_activated_prune");
      try {
        await assert.rejects(
          client.query(
            "select public.agent_outbox_prune_never_activated_callers('2026-06-15T00:00:00.000Z') as deleted_count"
          ),
          (error) => {
            const databaseError = /** @type {{ code?: string }} */ (error);
            assert.equal(databaseError.code, "42501");
            return true;
          }
        );
      } finally {
        await client.query(
          "rollback to savepoint non_cleanup_never_activated_prune"
        );
      }
      await client.query("reset role");
      await client.query("commit");

      const accountlessCleanupPreservation = await client.query(
        `
          select
            (
              select count(*)::int
              from public.agent_outbox_caller_setup_requests
              where setup_request_id = $1
            ) as setup_request_count,
            (
              select count(*)::int
              from public.agent_outbox_caller_credentials
              where key_id = $2
                and pending_replacement_setup_request_id = $1
            ) as credential_count
        `,
        [referencedSetupRequestId, pendingReplacementKeyId]
      );
      assert.deepEqual(accountlessCleanupPreservation.rows[0], {
        setup_request_count: 1,
        credential_count: 1
      });

      const neverActivatedCleanupRows = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_callers where caller_id = $1) as reclaimed_caller_count,
            (select count(*)::int from public.agent_outbox_caller_setup_requests where setup_request_id = $2) as reclaimed_setup_count,
            (select count(*)::int from public.agent_outbox_caller_credentials where key_id = $3) as reclaimed_credential_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $4) as audit_preserved_caller_count,
            (select count(*)::int from public.agent_outbox_caller_setup_requests where setup_request_id = $5) as audit_preserved_setup_count,
            (select count(*)::int from public.agent_outbox_caller_credentials where key_id = $6) as audit_preserved_credential_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $7) as activated_preserved_caller_count,
            (select count(*)::int from public.agent_outbox_callers where caller_id = $8) as revoked_preserved_caller_count
        `,
        [
          ids.reclaimCaller,
          reclaimSetupRequestId,
          `abandoned-${runId}`,
          ids.auditPreservedCaller,
          auditSetupRequestId,
          `abandoned-audit-${runId}`,
          ids.activatedPreservedCaller,
          ids.revokedPreservedCaller
        ]
      );
      assert.deepEqual(neverActivatedCleanupRows.rows[0], {
        reclaimed_caller_count: 0,
        reclaimed_setup_count: 0,
        reclaimed_credential_count: 0,
        audit_preserved_caller_count: 1,
        audit_preserved_setup_count: 1,
        audit_preserved_credential_count: 1,
        activated_preserved_caller_count: 1,
        revoked_preserved_caller_count: 1
      });

      const reusedCallerSlug = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values ($1, 'Reused reclaimed caller', $2)
          returning caller_slug
        `,
        [ids.accountA, abandonedCallerSlugs.reclaim]
      );
      assert.deepEqual(reusedCallerSlug.rows, [
        { caller_slug: abandonedCallerSlugs.reclaim }
      ]);

      const deletedRows = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $1) as input_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $2) as output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $3) as ack_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $4) as timeout_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $5) as undo_output_count,
            (select count(*)::int from public.agent_outbox_output_results where output_result_id = $8) as file_output_count,
            (select count(*)::int from public.agent_outbox_output_files where output_result_id in ($3, $5, $8)) as file_count,
            (select status from public.agent_outbox_input_items where input_item_id = $6) as undo_input_status,
            (select count(*)::int from public.agent_outbox_input_items where caller_item_id = 'retained-pending' and account_id = $7) as retained_input_count,
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $9) as file_input_count,
            (select count(*)::int from public.agent_outbox_input_items where input_item_id = $10) as file_upload_input_count,
            (select count(*)::int from public.agent_outbox_account_quota_windows where account_id = $7) as quota_window_count,
            (select count(*)::int from public.agent_outbox_ip_quota_windows where ip_address = $11::inet) as ip_quota_window_count,
            (select count(*)::int from public.agent_outbox_account_limit_blocks where account_id = $7) as limit_block_count
        `,
        [
          ids.answeredInput,
          ids.output,
          ackOutputId,
          timeoutOutputId,
          undoOutputId,
          inputIdsByCallerItemId.get("undo-output"),
          ids.accountA,
          ids.fileOutput,
          ids.fileOutputInput,
          ids.fileUploadInput,
          ids.ipQuotaAddress
        ]
      );
      assert.deepEqual(deletedRows.rows[0], {
        input_count: 0,
        output_count: 0,
        ack_output_count: 0,
        timeout_output_count: 0,
        undo_output_count: 0,
        file_output_count: 0,
        file_count: 0,
        undo_input_status: "pending",
        retained_input_count: 0,
        file_input_count: 0,
        file_upload_input_count: 0,
        quota_window_count: 0,
        ip_quota_window_count: 0,
        limit_block_count: 0
      });

      const remainingSetupRequests = await client.query(
        `
          select local_caller_name
          from public.agent_outbox_caller_setup_requests
          where local_caller_name like $1
          order by local_caller_name
        `,
        [`${setupPrunePrefix}-%`]
      );
      assert.deepEqual(
        remainingSetupRequests.rows.map((row) => row.local_caller_name),
        [
          setupLabels.pendingLive,
          setupLabels.referencedPendingReplacement,
          setupLabels.terminalFresh
        ].sort()
      );
      const preservedPendingReplacement = await client.query(
        `
          select key_id, pending_replacement_setup_request_id::text as setup_request_id
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [pendingReplacementKeyId]
      );
      assert.deepEqual(preservedPendingReplacement.rows, [
        {
          key_id: pendingReplacementKeyId,
          setup_request_id: referencedSetupRequestId
        }
      ]);

      const auditRows = await client.query(
        `
          select event_type, deletion_reason
          from public.agent_outbox_audit_events
          where output_result_id = any($1::uuid[])
          order by deletion_reason, event_type
        `,
        [
          [
            ids.output,
            ackOutputId,
            timeoutOutputId,
            undoOutputId,
            ids.fileOutput
          ]
        ]
      );
      assert.deepEqual(auditRows.rows, [
        {
          event_type: "file_deleted",
          deletion_reason: "acknowledgement"
        },
        {
          event_type: "output_acknowledged",
          deletion_reason: "acknowledgement"
        },
        {
          event_type: "file_deleted",
          deletion_reason: "downgrade_grace_file_output"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_file_output"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_non_file_payload_limit"
        },
        {
          event_type: "output_deleted",
          deletion_reason: "output_timeout"
        },
        {
          event_type: "file_deleted",
          deletion_reason: "pre_read_undo"
        },
        {
          event_type: "output_undone",
          deletion_reason: "pre_read_undo"
        }
      ]);

      const terminalOutputByteAuditRows = await client.query(
        `
          select event_type, deletion_reason, non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where output_result_id = any($1::uuid[])
            and event_type in ('output_acknowledged', 'output_deleted')
          order by deletion_reason, event_type
        `,
        [[ids.output, ackOutputId, timeoutOutputId, ids.fileOutput]]
      );
      assert.deepEqual(terminalOutputByteAuditRows.rows, [
        {
          event_type: "output_acknowledged",
          deletion_reason: "acknowledgement",
          non_file_bytes: 35
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_file_output",
          non_file_bytes: 35
        },
        {
          event_type: "output_deleted",
          deletion_reason: "downgrade_grace_non_file_payload_limit",
          non_file_bytes: 125
        },
        {
          event_type: "output_deleted",
          deletion_reason: "output_timeout",
          non_file_bytes: 35
        }
      ]);

      const retentionAuditRows = await client.query(
        `
          select
            event_type,
            deletion_reason,
            caller_item_id_hash,
            non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where input_item_id = $1
        `,
        [inputIdsByCallerItemId.get("retained-pending")]
      );
      assert.deepEqual(retentionAuditRows.rows, [
        {
          event_type: "input_deleted",
          deletion_reason: "input_retention",
          caller_item_id_hash: `hash-retained-${runId}`,
          non_file_bytes: 10
        }
      ]);

      const fileUploadAuditRows = await client.query(
        `
          select
            event_type,
            deletion_reason,
            caller_item_id_hash,
            non_file_bytes::int as non_file_bytes
          from public.agent_outbox_audit_events
          where input_item_id = $1
        `,
        [ids.fileUploadInput]
      );
      assert.deepEqual(fileUploadAuditRows.rows, [
        {
          event_type: "input_deleted",
          deletion_reason: "downgrade_grace_file_input",
          caller_item_id_hash: `hash-file-upload-${runId}`,
          non_file_bytes: 12
        }
      ]);
    } finally {
      try {
        await resetRoleAndRollback(client);
      } catch (error) {
        console.error("Teardown error in resetRoleAndRollback:", error);
      }
      try {
        await cleanupPhase3DatabaseVerificationRows(client, ids);
      } catch (error) {
        console.error(
          "Teardown error in cleanupPhase3DatabaseVerificationRows:",
          error
        );
      }
      try {
        if (grantedAppRoleForTest) {
          await revokeCurrentUserAppRoleGrant(client);
        }
      } catch (error) {
        console.error(
          "Teardown error in revokeCurrentUserAppRoleGrant:",
          error
        );
      }
      try {
        await client.end();
      } catch (error) {
        console.error("Teardown error in client.end:", error);
      }
    }
  }
);

test("scheduled canary ignores invalid scheduled timestamps", () => {
  const originalLog = console.log;
  console.log = () => {};

  try {
    const canary = runScheduledCanary({
      trigger: "cron",
      cron: "17 * * * *",
      scheduledTime: Number.NaN
    });

    assert.equal(canary.scheduled_time, null);
  } finally {
    console.log = originalLog;
  }
});
