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
  validateDatabaseTestCommand,
  validateGoReleaserTooling,
  validateGoModuleTooling,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
  validatePhase3FoundationSourceContents,
  validatePhase4ContractDocContents,
  validateRequiredEnvExample,
  validateRuntimeProofScope,
  validateToolchainPackage,
  validateProductionDeployWorkflow,
  validateProductionRollbackWorkflow,
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
import {
  assertRuntimeDatabaseCanary,
  assertRuntimeCanaryEnvironment,
  missingRuntimeSmokeEnvNames,
  readRuntimeSmokeEnv,
  runtimeSmokeAttemptCount
} from "../scripts/runtime-smoke.mjs";
import { validateBrowserFixtureRunId } from "../scripts/browser-fixture-run-id.mjs";
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
import { processStripeEventInTransaction } from "../src/server/billing.ts";
import {
  absoluteHttpOrigin,
  InsecureServerEnvironmentError,
  MissingServerEnvironmentError,
  runtimeConfigStatus
} from "../src/server/env.ts";
import { applicationSecurityHeaders } from "../src/server/http-security.ts";
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
import {
  assertMigrationOwnerCanSetAppRole,
  preserveBodyErrorDuringTeardown,
  teardownAttempt
} from "./helpers/database.mjs";

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
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_WORKFLOW_REF:
      "conn-castle/agent-outbox/.github/workflows/deploy-production.yml@refs/heads/main",
    AGENT_OUTBOX_RELEASE_TAG: "v1.2.3",
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
    SENTRY_RELEASE: "0123456789abcdef0123456789abcdef01234567",
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
  /** @type {Error[]} */
  const errors = [];
  for (const sql of ["rollback", "reset role"]) {
    try {
      await client.query(sql);
    } catch (error) {
      errors.push(
        new Error(`Database state reset failed for ${sql}.`, { cause: error })
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Database state reset failed.");
  }
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

  const cleanupRole = await client.query(
    `select rolsuper or rolbypassrls as bypasses_rls from pg_catalog.pg_roles where rolname = current_user`
  );
  const bypassesRls = cleanupRole.rows[0]?.bypasses_rls === true;
  if (!bypassesRls) {
    await client.query("set role agent_outbox_app");
  }
  await client.query("begin");

  try {
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.audit_break_glass",
      "on"
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.auth_surface",
      "cleanup"
    ]);

    if (bypassesRls && (ids.accountAuditA || ids.accountAuditB)) {
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

    for (const accountId of [ids.accountA, ids.accountB].filter(Boolean)) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        accountId
      ]);
      await client.query(
        `
          delete from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
    }

    if (ids.userA) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);
      await client.query(
        `
          delete from public.agent_outbox_users
          where user_id = $1
        `,
        [ids.userA]
      );
    }

    await client.query("commit");
    if (!bypassesRls) {
      await client.query("reset role");
    }
  } catch (error) {
    await client.query("rollback");
    if (!bypassesRls) {
      await client.query("reset role");
    }
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

const failClosedFunctionAuthGuardsMigration = readFileSync(
  new URL(
    "../db/migrations/V20260812155500__fail_closed_function_auth_guards.sql",
    import.meta.url
  ),
  "utf8"
);

const stripeWebhookCompletedLedgerMigrationPath = new URL(
  "../db/migrations/V20260711114816__stripe_webhook_completed_ledger.sql",
  import.meta.url
);

const stripeWebhookEventOrderingMigrationPath = new URL(
  "../db/migrations/V20260812194000__stripe_webhook_event_ordering.sql",
  import.meta.url
);

/**
 * Executes one transactional migration file inside the caller's open transaction.
 * @param {import("pg").Client} client
 * @param {URL} migrationPath
 */
async function executeTransactionalMigrationFile(client, migrationPath) {
  if (!migrationPath.pathname.endsWith(".sql")) {
    throw new Error("Transactional migration executor requires a .sql file.");
  }
  const sql = readFileSync(migrationPath, "utf8");
  if (/\bconcurrently\b/i.test(sql)) {
    throw new Error(
      "Transactional migration executor rejects online migrations."
    );
  }
  await client.query(sql);
}

/**
 * @param {import("pg").Client} observer
 * @param {number} backendPid
 */
async function waitForDatabaseLock(observer, backendPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observer.query(
      `select wait_event_type from pg_catalog.pg_stat_activity where pid = $1`,
      [backendPid]
    );
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Backend ${backendPid} did not enter a database lock wait.`);
}

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
    "DATABASE_URL=\nAWS_PROFILE=conn\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";
  const actual =
    "DATABASE_URL=postgres://user:password@example/db\nAWS_PROFILE=conn\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";

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

test("runtime smoke process-env mode reads only remote smoke client inputs", () => {
  const values = readRuntimeSmokeEnv({
    env: {
      AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
      AGENT_OUTBOX_EXPECTED_RELEASE: "release-sha",
      APP_BASE_URL: "https://app.agent-outbox.dev",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1",
      STRIPE_SECRET_KEY: "must-not-be-copied"
    }
  });

  assert.deepEqual(Object.fromEntries(values), {
    APP_BASE_URL: "https://app.agent-outbox.dev",
    SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
    AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1",
    AGENT_OUTBOX_EXPECTED_RELEASE: "release-sha"
  });
  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: {
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
          APP_BASE_URL: "https://app.agent-outbox.dev",
          SMOKE_OR_CLEANUP_TOKEN: "smoke-token"
        }
      }),
    /AGENT_OUTBOX_EXPECTED_RELEASE is required in process-env mode/
  );
  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: {
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
          AGENT_OUTBOX_EXPECTED_RELEASE: "   ",
          APP_BASE_URL: "https://app.agent-outbox.dev",
          SMOKE_OR_CLEANUP_TOKEN: "smoke-token"
        }
      }),
    /AGENT_OUTBOX_EXPECTED_RELEASE is required in process-env mode/
  );
});

test("runtime smoke rejects a healthy response from the wrong release", () => {
  assert.doesNotThrow(() =>
    assertRuntimeCanaryEnvironment(
      { environment: { configured: true, release: "expected-sha" } },
      "expected-sha"
    )
  );
  assert.throws(
    () =>
      assertRuntimeCanaryEnvironment(
        { environment: { configured: true, release: "previous-sha" } },
        "expected-sha"
      ),
    /did not report the expected deployed release/
  );
  assert.equal(runtimeSmokeAttemptCount({}), 1);
  assert.equal(
    runtimeSmokeAttemptCount({
      AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"
    }),
    6
  );
});

test("runtime smoke requires the production human review query canary", () => {
  assert.deepEqual(
    missingRuntimeSmokeEnvNames(
      new Map([
        ["APP_BASE_URL", "https://app.agent-outbox.dev"],
        ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"]
      ])
    ),
    [],
    "the post-deploy query flag must remain optional for outgoing releases"
  );
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseCanary({
      transaction_context_matched: true,
      restricted_role_matched: true
    })
  );
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseCanary({
      transaction_context_matched: true,
      restricted_role_matched: true,
      human_review_query_matched: true
    })
  );
  assert.throws(
    () =>
      assertRuntimeDatabaseCanary({
        transaction_context_matched: true,
        restricted_role_matched: true,
        human_review_query_matched: false
      }),
    /did not prove the human review query/
  );
  assert.throws(
    () =>
      assertRuntimeDatabaseCanary(
        {
          transaction_context_matched: true,
          restricted_role_matched: true
        },
        { requireHumanReviewQuery: true }
      ),
    /did not prove the human review query/
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
  const rollbackWorkflow = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
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
  assert.deepEqual(
    validateProductionRollbackWorkflow(rollbackWorkflow, "24.18.0"),
    []
  );
  const releaseCheckWorkflow = readFileSync(
    new URL("../.github/workflows/release-check.yml", import.meta.url),
    "utf8"
  );
  assert.match(
    releaseCheckWorkflow,
    /^  workflow_call:$/m,
    "production certification must call the exact release-check workflow"
  );

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(
    packageJson.scripts["worker:dry-run"],
    /^corepack pnpm run worker:build && /,
    "production dry-run must not depend on a globally available pnpm shim"
  );

  const openNextConfig = readFileSync(
    new URL("../open-next.config.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    openNextConfig,
    /config\.buildCommand = "corepack pnpm run next:build";/,
    "OpenNext build must not depend on a globally available pnpm shim"
  );

  const unscopedRollbackWorkflow = deployWorkflow.replace(
    "if: failure() && steps.deploy-attempt.outputs.attempted == 'true'",
    "if: always()"
  );
  assert.notEqual(
    unscopedRollbackWorkflow,
    deployWorkflow,
    "rollback-scope regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      unscopedRollbackWorkflow,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must roll back within the deploy job on a failed deploy and verify the restored release"
    ),
    true,
    "automatic rollback must stay scoped to a failed deploy attempt inside the deploy job"
  );

  const withoutProductionMigrations = deployWorkflow.replace(
    /      - name: Apply production database migrations[\s\S]*?(?=\n      - name: Mark deployment attempt)/,
    ""
  );
  assert.notEqual(
    withoutProductionMigrations,
    deployWorkflow,
    "production-migration regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutProductionMigrations,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before deploy"
    ),
    true,
    "production migrations must remain inside the protected release sequence"
  );

  const withoutPostDeployHumanQueryProof = deployWorkflow.replace(
    '          AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"\n',
    ""
  );
  assert.notEqual(
    withoutPostDeployHumanQueryProof,
    deployWorkflow,
    "post-deploy human-query regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutPostDeployHumanQueryProof,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must verify the deployed SHA after deploy"
    ),
    true,
    "the candidate release must prove the deployed human review query"
  );

  const nMinusOneIncompatibleSmoke = deployWorkflow.replace(
    '          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"',
    '          AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"\n' +
      '          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"'
  );
  assert.notEqual(
    nMinusOneIncompatibleSmoke,
    deployWorkflow,
    "N-1 smoke regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      nMinusOneIncompatibleSmoke,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must keep rollback-target smoke compatible with the outgoing release contract"
    ),
    true,
    "rollback-target smoke must tolerate fields absent from the outgoing release"
  );

  const firstAtHostMask = deployWorkflow.replace(
    'host="${host##*@}"',
    'host="${host#*@}"'
  );
  assert.notEqual(
    firstAtHostMask,
    deployWorkflow,
    "migration-host-mask regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(firstAtHostMask, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before deploy"
    ),
    true,
    "migration host masking must follow URL parsing through the final at-sign"
  );

  for (const stepName of [
    "Verify rollback target before deploy",
    "Require production migration credential",
    "Require publicly downloadable release assets"
  ]) {
    const withoutRequiredStep = deployWorkflow.replace(
      new RegExp(`      - name: ${stepName}[\\s\\S]*?(?=\\n      - name:)`),
      ""
    );
    assert.notEqual(
      withoutRequiredStep,
      deployWorkflow,
      `${stepName} regression fixture must modify the workflow`
    );
    assert.notDeepEqual(
      validateProductionDeployWorkflow(withoutRequiredStep, "24.18.0"),
      [],
      `${stepName} must remain required by the production workflow guard`
    );
  }

  const withoutHomebrewPublication = deployWorkflow.replace(
    /\n  publish-cli-homebrew:[\s\S]*$/,
    ""
  );
  assert.notEqual(
    withoutHomebrewPublication,
    deployWorkflow,
    "Homebrew-publication regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutHomebrewPublication,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must publish tagged CLI assets and open the guarded Homebrew cask PR after finalization"
    ),
    true,
    "numbered releases must retain CLI asset and Homebrew cask publication"
  );

  const clobberingCliAssets = deployWorkflow.replace(
    'gh release upload "$RELEASE_TAG" "$artifact"',
    'gh release upload "$RELEASE_TAG" "$artifact" --clobber'
  );
  assert.notEqual(
    clobberingCliAssets,
    deployWorkflow,
    "CLI asset clobber regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(clobberingCliAssets, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must publish tagged CLI assets and open the guarded Homebrew cask PR after finalization"
    ),
    true,
    "published CLI assets must never be deleted before replacement upload succeeds"
  );

  const withoutCliAssetIdentityCheck = deployWorkflow.replace(
    'if ! cmp -s "$artifact" "$existing_dir/$asset"; then',
    "if false; then"
  );
  assert.notEqual(
    withoutCliAssetIdentityCheck,
    deployWorkflow,
    "CLI asset identity-check regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutCliAssetIdentityCheck,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must publish tagged CLI assets and open the guarded Homebrew cask PR after finalization"
    ),
    true,
    "release reconciliation must retain only byte-identical existing CLI assets"
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

  const failures = validateProductionDeployWorkflow(unsafeWorkflow, "24.18.0");
  assert.equal(
    failures.includes(
      ".github/workflows/deploy-production.yml must be manual-only and not include push:"
    ),
    true
  );
  assert.equal(
    failures.includes(
      ".github/workflows/deploy-production.yml must include certified release flow"
    ),
    true
  );
});

test("worker deploy wrapper builds, passes explicit bindings, and removes the temp secrets file", () => {
  const env = workerDeployEnv();
  const tempBase = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-worker-deploy-test-")
  );
  /** @type {{ command: string, args: string[], env: NodeJS.ProcessEnv | undefined }[]} */
  const calls = [];
  /** @type {string | null} */
  let secretsFilePath = null;
  /** @type {string | null} */
  let configFilePath = null;

  try {
    runWorkerDeploy({
      env,
      tempBase,
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, env: options.env });

        if (args[0] === "pnpm" && args[1] === "exec") {
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

    assert.equal(calls[0].command, "corepack");
    assert.deepEqual(calls[0].args, ["pnpm", "run", "worker:build"]);
    assert.equal(calls[0].env?.APP_BASE_URL, env.APP_BASE_URL);
    assert.equal(calls[0].env?.CLOUDFLARE_API_TOKEN, undefined);
    for (const name of WORKER_DEPLOY_SECRET_NAMES) {
      assert.equal(calls[0].env?.[name], undefined);
    }
    assert.equal(calls[1].command, "corepack");
    assert.deepEqual(calls[1].args.slice(0, 8), [
      "pnpm",
      "exec",
      "wrangler",
      "deploy",
      "--config",
      configFilePath,
      "--env-file",
      "/dev/null"
    ]);
    assert.equal(calls[1].args.includes("--secrets-file"), true);
    assert.equal(calls[1].args.includes("--dry-run"), true);
    assert.equal(calls[1].args.includes("--keep-vars"), false);
    assert.equal(calls[1].args.includes("--tag"), true);
    assert.equal(calls[1].args.includes("v1.2.3"), true);

    assert.equal(calls[2].command, "corepack");
    assert.deepEqual(
      calls[2].args,
      calls[1].args.filter((arg) => arg !== "--dry-run")
    );
    for (const call of calls.slice(1)) {
      assert.equal(call.env?.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
      assert.equal(call.env?.APP_BASE_URL, undefined);
      for (const name of WORKER_DEPLOY_SECRET_NAMES) {
        assert.equal(call.env?.[name], undefined);
      }
    }

    const varBindings = calls[2].args.flatMap((arg, index, args) =>
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

test("worker build subprocess gets Sentry upload config, never the deploy subprocess or Worker vars", () => {
  const sentryUploadNames = [
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "SENTRY_AUTH_TOKEN",
    "AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD",
    "AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH"
  ];
  const env = workerDeployEnv({
    SENTRY_ORG: "conn-castle",
    SENTRY_PROJECT: "agent-outbox",
    SENTRY_AUTH_TOKEN: "sntrys_upload_token",
    AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
    AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
  });
  const buildEnv = workerBuildEnvironment(env);
  const deployEnv = wranglerDeployEnvironment(env);

  // The build subprocess needs the upload config plus the already-public
  // release id so the Sentry plugin can create the release and upload maps.
  for (const name of sentryUploadNames) {
    assert.equal(buildEnv[name], env[name]);
  }
  assert.equal(buildEnv.SENTRY_RELEASE, env.SENTRY_RELEASE);

  // The secret auth token must never reach the wrangler deploy subprocess...
  for (const name of sentryUploadNames) {
    assert.equal(deployEnv[name], undefined);
  }

  // ...nor become a Worker runtime --var binding.
  const varBindings = buildWranglerDeployArgs(env, "/tmp/secrets").flatMap(
    (arg, index, args) => (arg === "--var" ? [args[index + 1]] : [])
  );
  for (const name of sentryUploadNames) {
    assert.equal(
      varBindings.some((binding) => binding.startsWith(`${name}:`)),
      false
    );
  }

  // Absent by default: the passthrough must not fabricate empty values.
  const buildEnvUnset = workerBuildEnvironment(workerDeployEnv());
  for (const name of sentryUploadNames) {
    assert.equal(buildEnvUnset[name], undefined);
  }
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

test("worker deploy wrapper refuses local or non-production-workflow execution", () => {
  assert.deepEqual(
    validateWorkerDeployEnvironment(
      workerDeployEnv({
        GITHUB_ACTIONS: undefined,
        GITHUB_REF: "refs/heads/feature/local-deploy",
        GITHUB_WORKFLOW_REF:
          "conn-castle/agent-outbox/.github/workflows/ci.yml@refs/heads/main"
      })
    ).slice(-3),
    [
      "Production Worker deploys must run in GitHub Actions.",
      "Production Worker deploys must run from refs/heads/main.",
      "Production Worker deploys must run from deploy-production.yml."
    ]
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
jobs:
  migration-replay:
    services:
      postgres:
        image: postgres:17
    env:
      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci
      FLYWAY_DOCKER_NETWORK: host
    steps:
      - name: Replay migrations from scratch
        run: make migration-replay
      - name: Run database verification suite
        run: make test-database
  `;

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": validWorkflow,
      ".github/workflows/release-check.yml": validWorkflow
    }),
    []
  );

  const commentedWorkflow = validWorkflow
    .replace(
      "    services:\n      postgres:",
      `    services: # migration database services
    # The replay job uses raw Postgres.
      postgres: # canonical service`
    )
    .replace("    env:", "    env: # job environment");
  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": commentedWorkflow,
      ".github/workflows/release-check.yml": validWorkflow
    }),
    []
  );

  const stepScopedDatabaseEnvironment = validWorkflow
    .replace('      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n', "")
    .replace(
      "      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci\n",
      ""
    )
    .replace(
      "        run: make test-database",
      `        env:
          AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
          DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci
        run: make test-database`
    );
  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": stepScopedDatabaseEnvironment,
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
      ".github/workflows/ci.yml must include a migration-replay job",
      ".github/workflows/ci.yml must include a Postgres 17 service in the migration-replay job",
      ".github/workflows/ci.yml must include make migration-replay in the named replay step",
      ".github/workflows/ci.yml must include make test-database in the named database verification step",
      ".github/workflows/ci.yml must include AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification",
      ".github/workflows/ci.yml must include DATABASE_MIGRATION_URL for database verification",
      ".github/workflows/ci.yml must include FLYWAY_DOCKER_NETWORK=host in the migration-replay job",
      ".github/workflows/ci.yml must include database verification after migration replay"
    ]
  );

  const invalidWorkflows = [
    [
      "a commented-out command",
      validWorkflow.replace(
        "        run: make test-database",
        "        # run: make test-database"
      ),
      "make test-database in the named database verification step"
    ],
    [
      "a Postgres image token inside a run block without a service",
      validWorkflow
        .replace(
          `    services:
      postgres:
        image: postgres:17`,
          ""
        )
        .replace(
          `    steps:
      - name: Replay migrations from scratch`,
          `    steps:
      - name: Misleading image text
        run: |
          image: postgres:17
      - name: Replay migrations from scratch`
        ),
      "a Postgres 17 service in the migration-replay job"
    ],
    [
      "database verification before migration replay",
      validWorkflow.replace(
        /      - name: Replay migrations from scratch[\s\S]*?        run: make test-database/,
        `      - name: Run database verification suite
        run: make test-database
      - name: Replay migrations from scratch
        run: make migration-replay`
      ),
      "database verification after migration replay"
    ],
    [
      "database verification in another job",
      validWorkflow.replace(
        `      - name: Run database verification suite
        run: make test-database`,
        `  database-tests:
    steps:
      - name: Run database verification suite
        run: make test-database`
      ),
      "make test-database in the named database verification step"
    ],
    [
      "database opt-in on an unrelated job",
      validWorkflow.replace(
        '      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n',
        ""
      ).concat(`
  unrelated:
    env:
      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
`),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database opt-in outside an env block",
      validWorkflow.replace(
        "    env:\n      AGENT_OUTBOX_ENABLE_DATABASE_TESTS",
        "      AGENT_OUTBOX_ENABLE_DATABASE_TESTS"
      ),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database opt-in under step with",
      validWorkflow
        .replace('      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n', "")
        .replace(
          "        run: make test-database",
          `        with:
          AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
        run: make test-database`
        ),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database URL under the Postgres service environment",
      validWorkflow
        .replace(
          "      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci\n",
          ""
        )
        .replace(
          "        image: postgres:17",
          `        image: postgres:17
        env:
          DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci`
        ),
      "DATABASE_MIGRATION_URL for database verification"
    ],
    [
      "Flyway network under job outputs",
      validWorkflow.replace("      FLYWAY_DOCKER_NETWORK: host\n", "").replace(
        "    env:",
        `    outputs:
      FLYWAY_DOCKER_NETWORK: host
    env:`
      ),
      "FLYWAY_DOCKER_NETWORK=host in the migration-replay job"
    ]
  ];
  for (const [description, workflow, expectedFailure] of invalidWorkflows) {
    const failures = validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": workflow,
      ".github/workflows/release-check.yml": validWorkflow
    });
    assert.ok(
      failures.includes(
        `.github/workflows/ci.yml must include ${expectedFailure}`
      ),
      description
    );
  }
});

test("validatePolicyGatesWorkflow requires label-retriggered PR policy checks", () => {
  const validWorkflow = `
name: Policy gates
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: read
  pull-requests: read
jobs:
  policy-gates:
    steps:
      - run: node scripts/policy-gates/collect-changed-files.mjs
      - run: node scripts/policy-gates/megachange-eval.mjs
      - run: node scripts/policy-gates/migration-discipline-scan.mjs
      - run: node scripts/policy-gates/legal-policy-gate.mjs
`;

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow
    }),
    []
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "types: [opened, synchronize, reopened, labeled, unlabeled]",
        "types: [opened, synchronize, reopened]"
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include pull_request label retrigger types"
    ]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": `${validWorkflow}\n  push:\n    branches:\n      - main\n`
    }),
    [".github/workflows/policy-gates.yml must not run on push"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "node scripts/policy-gates/legal-policy-gate.mjs",
        "gh pr edit 1 --add-label legal-policy-approved"
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include public legal-policy gate",
      ".github/workflows/policy-gates.yml must not apply human-only approval labels"
    ]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        ""
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        "permissions:\n  contents: read\n  pull-requests: write\n"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        "permissions: write-all\n"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "    steps:",
        "    permissions:\n      pull-requests: write\n    steps:"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "    steps:",
        "    permissions: write-all\n    steps:"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "node scripts/policy-gates/collect-changed-files.mjs",
        'gh api "repos/x/y/pulls/${PR_NUMBER}/files"'
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include complete base-to-head changed-path enumeration",
      ".github/workflows/policy-gates.yml must not use the capped pull request files API"
    ]
  );
});

test("validateDatabaseTestCommand enforces the serialized root test command chain", () => {
  const validPackageJson = {
    scripts: {
      "test:database": "node --test --test-concurrency=1 tests/*.test.mjs"
    }
  };
  const validMakefile = `test-database:
\tcorepack pnpm run test:database
`;

  assert.deepEqual(
    validateDatabaseTestCommand(validPackageJson, validMakefile),
    []
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      {
        scripts: {
          "test:database":
            "node --test --test-concurrency=1 tests/foundation.test.mjs"
        }
      },
      validMakefile
    ),
    [
      "package.json test:database must be exactly: node --test --test-concurrency=1 tests/*.test.mjs"
    ]
  );
  for (const hook of ["pretest:database", "posttest:database"]) {
    assert.deepEqual(
      validateDatabaseTestCommand(
        {
          scripts: {
            ...validPackageJson.scripts,
            [hook]: "node unexpected-hook.mjs"
          }
        },
        validMakefile
      ),
      [`package.json must not define ${hook}`]
    );
  }
  assert.deepEqual(
    validateDatabaseTestCommand(
      {
        scripts: {
          "test:database": "node --test tests/*.test.mjs"
        }
      },
      validMakefile
    ),
    [
      "package.json test:database must be exactly: node --test --test-concurrency=1 tests/*.test.mjs"
    ]
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      validPackageJson,
      `test-database:
\t@true
`
    ),
    [
      "Makefile test-database must delegate only to corepack pnpm run test:database"
    ]
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      validPackageJson,
      `test-database:
\tcorepack pnpm run test:database
\t@true
`
    ),
    [
      "Makefile test-database must delegate only to corepack pnpm run test:database"
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

cli-release-dist:
\tgo run $(GORELEASER_MODULE) release --clean --skip=publish

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
      "Makefile cli-release-dist must build a clean tagged release without publishing",
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
    "APP_ENV=development\nPORT=38000\nAPP_BASE_URL=http://localhost:38000\nPUBLIC_APP_BASE_URL=http://localhost:38000\nSUPABASE_PROJECT_REF=\nDATABASE_URL=\nDATABASE_APP_ROLE_URL=\nDATABASE_MIGRATION_URL=\nCLERK_SECRET_KEY=\nCLERK_PUBLISHABLE_KEY=\nSTRIPE_ACCOUNT_ID=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PAID_MONTHLY_PRICE_ID=\nSTRIPE_PAID_YEARLY_PRICE_ID=\nSTRIPE_BILLING_PORTAL_CONFIGURATION_ID=\nSENTRY_DSN=\nSENTRY_BROWSER_DSN=\nSENTRY_RELEASE=\nSENTRY_ORG=\nSENTRY_PROJECT=\nSENTRY_AUTH_TOKEN=\nAGENT_OUTBOX_SENTRY_RELEASE_UPLOAD=\nAGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH=\nNEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN=\nCALLER_KEY_HASH_SECRET=\nSMOKE_OR_CLEANUP_TOKEN=\nAWS_PROFILE=conn\nCLOUDFLARE_DNS_API_TOKEN=\nCLOUDFLARE_WAF_API_TOKEN=\nAGENT_OUTBOX_BASE_URL=\nAGENT_OUTBOX_CONFIG_PATH=\nAGENT_OUTBOX_CALLER=\n";

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

test("validateRuntimeProofScope allows current product boundary copy", () => {
  assert.deepEqual(
    validateRuntimeProofScope({
      "app/page.tsx":
        "A protected human review queue UI, caller registration, billing, and paid file-upload workflows are current functionality. Steward-specific integration remains outside the generic product boundary."
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

test("browser fixture run ids are safe for shell and Docker interpolation", () => {
  assert.equal(validateBrowserFixtureRunId("run_2026-08.12"), "run_2026-08.12");
  for (const invalid of [
    "",
    "bad id",
    "$(touch-pwned)",
    "'quoted'",
    "semi;colon"
  ]) {
    assert.throws(
      () => validateBrowserFixtureRunId(invalid),
      /must contain only/
    );
  }
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

test("absoluteHttpOrigin accepts only an origin-safe HTTP(S) URL", () => {
  assert.equal(
    absoluteHttpOrigin("https://app.example.test"),
    "https://app.example.test"
  );
  assert.equal(
    absoluteHttpOrigin("http://127.0.0.1:38000/"),
    "http://127.0.0.1:38000"
  );
  for (const invalid of [
    undefined,
    "not-a-url",
    "mailto:operator@example.test",
    "https://user:secret@app.example.test",
    "https://app.example.test/path",
    "https://app.example.test/?mode=test",
    "https://app.example.test/#fragment"
  ]) {
    assert.equal(absoluteHttpOrigin(invalid), null);
  }
});

test("application security headers add HSTS only in production", () => {
  const development = applicationSecurityHeaders("development");
  assert.deepEqual(development, [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()"
    }
  ]);
  assert.deepEqual(applicationSecurityHeaders("production"), [
    ...development,
    { key: "Strict-Transport-Security", value: "max-age=31536000" }
  ]);
  assert.deepEqual(applicationSecurityHeaders("test", true), [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()"
    }
  ]);

  const nextConfig = readFileSync(
    new URL("../next.config.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    nextConfig,
    /source: "\/:path\*"[\s\S]*headers: applicationSecurityHeaders\([\s\S]*process\.env\.APP_ENV,[\s\S]*process\.env\.AGENT_OUTBOX_BROWSER_FIXTURE === "1"[\s\S]*\)/,
    "Next.js must apply the security-header policy to every application path"
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
      SENTRY_RELEASE: "release-sha",
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
      assert.equal(smokeBody.environment.release, "release-sha");
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
    failClosedFunctionAuthGuardsMigration,
    /agent_outbox_context_auth_surface\(\) is distinct from 'cleanup'/
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

test("function auth guards fail closed when transaction context is unset", () => {
  for (const functionName of [
    "agent_outbox_bootstrap_clerk_human",
    "agent_outbox_prune_ip_quota_windows",
    "agent_outbox_prune_caller_setup_requests",
    "agent_outbox_cleanup_account_targets",
    "agent_outbox_prune_stripe_webhook_events"
  ]) {
    assert.match(
      failClosedFunctionAuthGuardsMigration,
      new RegExp(
        `create or replace function public\\.${functionName}\\([\\s\\S]*?agent_outbox_context_auth_surface\\(\\) is distinct from`,
        "i"
      )
    );
  }
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
  "completed Stripe webhook claims serialize duplicates and rollback permits retry",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database policy verification"
  },
  async () => {
    const connectionString = phase3DatabaseVerificationUrl;
    assert.ok(connectionString);
    const first = new Client({ connectionString });
    const duplicate = new Client({ connectionString });
    const observer = new Client({ connectionString });
    const eventId = `evt_concurrent_${crypto.randomUUID()}`;
    const failedEventId = `evt_rollback_${crypto.randomUUID()}`;
    const rollbackCompatibleEventId = `evt_old_writer_${crypto.randomUUID()}`;
    const event = /** @type {any} */ ({
      id: eventId,
      created: 1783209600,
      type: "test.ignored"
    });

    await Promise.all([
      first.connect(),
      duplicate.connect(),
      observer.connect()
    ]);
    /** @type {Promise<boolean> | null} */
    let duplicateTransaction = null;
    let bodyError;
    try {
      await first.query("begin");
      await first.query("set role agent_outbox_app");
      await first.query(
        "select set_config('agent_outbox.auth_surface', 'control_plane', true)"
      );
      const firstProcessed = await processStripeEventInTransaction(
        /** @type {any} */ (
          (/** @type {any} */ statement) =>
            first.query(statement.sql, statement.values)
        ),
        event
      );
      assert.equal(firstProcessed, true);

      const duplicatePid = await duplicate.query(
        "select pg_catalog.pg_backend_pid() as pid"
      );
      duplicateTransaction = (async () => {
        await duplicate.query("begin");
        await duplicate.query("set role agent_outbox_app");
        await duplicate.query(
          "select set_config('agent_outbox.auth_surface', 'control_plane', true)"
        );
        const processed = await processStripeEventInTransaction(
          /** @type {any} */ (
            (/** @type {any} */ statement) =>
              duplicate.query(statement.sql, statement.values)
          ),
          event
        );
        await duplicate.query("commit");
        return processed;
      })();

      await waitForDatabaseLock(observer, duplicatePid.rows[0].pid);
      await first.query("commit");
      assert.equal(await duplicateTransaction, false);
      const committed = await observer.query(
        `
          select
            count(*)::int as count,
            min(processing_status) as processing_status,
            bool_and(processed_at is not null) as has_completion_time
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [eventId]
      );
      assert.deepEqual(committed.rows, [
        {
          count: 1,
          processing_status: "processed",
          has_completion_time: true
        }
      ]);

      await observer.query("begin");
      const oldWriterClaim = await observer.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            processing_status
          )
          values ($1, 'test.old-writer', 'processing')
          returning processing_status, processed_at is not null as has_completion_time
        `,
        [rollbackCompatibleEventId]
      );
      assert.deepEqual(oldWriterClaim.rows, [
        { processing_status: "processing", has_completion_time: true }
      ]);
      const oldWriterCompletion = await observer.query(
        `
          update public.agent_outbox_stripe_webhook_events
          set processing_status = 'processed', processed_at = now()
          where stripe_event_id = $1
          returning processing_status
        `,
        [rollbackCompatibleEventId]
      );
      assert.deepEqual(oldWriterCompletion.rows, [
        { processing_status: "processed" }
      ]);
      await observer.query("commit");

      await assert.rejects(
        runProductTransaction(
          connectionString,
          {
            requestId: `rollback-${failedEventId}`,
            authSurface: "control_plane"
          },
          async (query) => {
            await processStripeEventInTransaction(
              query,
              /** @type {any} */ ({
                id: failedEventId,
                created: 1783209600,
                type: "test.ignored"
              })
            );
            throw new Error("forced webhook transaction failure");
          }
        ),
        /forced webhook transaction failure/
      );
      const retried = await runProductTransaction(
        connectionString,
        { requestId: `retry-${failedEventId}`, authSurface: "control_plane" },
        (query) =>
          processStripeEventInTransaction(
            query,
            /** @type {any} */ ({
              id: failedEventId,
              created: 1783209600,
              type: "test.ignored"
            })
          )
      );
      assert.equal(retried, true);
    } catch (error) {
      bodyError = error;
    } finally {
      /** @type {Error[]} */
      const teardownErrors = [];
      const attempt = teardownAttempt(
        teardownErrors,
        "Stripe concurrency teardown failed"
      );

      await attempt("first transaction reset", () =>
        resetRoleAndRollback(first)
      );
      const pendingDuplicate = duplicateTransaction;
      if (pendingDuplicate) {
        await attempt("duplicate transaction settlement", () =>
          pendingDuplicate.then(() => undefined)
        );
      }
      await attempt("duplicate transaction reset", () =>
        resetRoleAndRollback(duplicate)
      );
      await attempt("cleanup timeout configuration", () =>
        observer.query("set statement_timeout = '5s'")
      );
      await attempt("test row cleanup", () =>
        observer.query(
          "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = any($1::text[])",
          [[eventId, failedEventId, rollbackCompatibleEventId]]
        )
      );
      await attempt("first client close", () => first.end());
      await attempt("duplicate client close", () => duplicate.end());
      await attempt("observer client close", () => observer.end());

      if (teardownErrors.length > 0) {
        const teardownError = new AggregateError(
          teardownErrors,
          "Stripe concurrency teardown failed."
        );
        if (bodyError !== undefined) {
          throw new AggregateError(
            [bodyError, teardownError],
            "Stripe concurrency test and teardown both failed."
          );
        }
        throw teardownError;
      }
      if (bodyError !== undefined) {
        throw bodyError;
      }
    }
  }
);

test(
  "Stripe webhook expand migration rejects each contradictory old-row shape without durable mutation",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database policy verification"
  },
  async () => {
    const client = new Client({
      connectionString: phase3DatabaseVerificationUrl
    });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`
        alter table public.agent_outbox_stripe_webhook_events
          alter column processing_status drop default,
          alter column processing_status set not null,
          alter column processed_at drop not null,
          alter column processed_at drop default;
        insert into public.agent_outbox_stripe_webhook_events(
          stripe_event_id, event_type, processing_status, processed_at
        ) values
          ('evt_guard_missing_completion', 'test.guard', 'processed', null),
          ('evt_guard_incomplete_status', 'test.guard', 'processing', now());
      `);
      await assert.rejects(
        executeTransactionalMigrationFile(
          client,
          stripeWebhookCompletedLedgerMigrationPath
        ),
        (error) => {
          assert.equal(/** @type {{ code?: string }} */ (error).code, "23514");
          return true;
        }
      );
      await client.query("rollback");

      const finalShape = await client.query(`
        select column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent_outbox_stripe_webhook_events'
          and column_name in ('processing_status', 'processed_at')
        order by column_name
      `);
      assert.equal(finalShape.rows.length, 2);
      assert.deepEqual(
        finalShape.rows.map((row) => ({
          column_name: row.column_name,
          is_nullable: row.is_nullable
        })),
        [
          { column_name: "processed_at", is_nullable: "NO" },
          { column_name: "processing_status", is_nullable: "NO" }
        ]
      );
      assert.match(finalShape.rows[0].column_default, /now\(\)/);
      assert.match(finalShape.rows[1].column_default, /processed/);
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  }
);

test(
  "Stripe webhook ordering migration backfills existing account projections",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database policy verification"
  },
  async () => {
    const client = new Client({
      connectionString: phase3DatabaseVerificationUrl
    });
    const accountId = crypto.randomUUID();
    const preMigrationWriterAccountId = crypto.randomUUID();
    const eventId = `evt_ordering_backfill_${crypto.randomUUID()}`;
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`
        drop trigger agent_outbox_accounts_clear_stripe_order_on_legacy_update
          on public.agent_outbox_accounts;
        drop function public.agent_outbox_clear_stripe_event_order_on_legacy_update();
        alter table public.agent_outbox_accounts
          drop constraint agent_outbox_accounts_stripe_event_order_pair,
          drop column stripe_last_event_created_at,
          drop column stripe_last_event_receipt_order;
        alter table public.agent_outbox_stripe_webhook_events
          drop constraint agent_outbox_stripe_webhook_events_receipt_order_unique,
          drop column stripe_receipt_order;
        drop sequence if exists public.agent_outbox_stripe_webhook_receipt_order_seq;
      `);
      await client.query(
        `
          insert into public.agent_outbox_accounts(
            account_id,
            label,
            stripe_customer_id,
            stripe_subscription_id,
            stripe_subscription_status
          ) values ($1, $2, $3, $4, 'active')
        `,
        [
          accountId,
          `stripe-ordering-backfill-${accountId}`,
          `cus_backfill_${accountId}`,
          `sub_backfill_${accountId}`
        ]
      );
      await client.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            processing_status,
            account_id,
            processed_at
          ) values ($1, 'customer.subscription.updated', 'processed', $2, $3)
        `,
        [eventId, accountId, "2026-07-05T12:34:56.789Z"]
      );
      await client.query(
        "insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)",
        [
          preMigrationWriterAccountId,
          `stripe-pre-ordering-writer-${preMigrationWriterAccountId}`
        ]
      );
      const preMigrationProcessed = await processStripeEventInTransaction(
        /** @type {any} */ (
          (/** @type {any} */ statement) =>
            client.query(statement.sql, statement.values)
        ),
        /** @type {any} */ ({
          id: `evt_pre_ordering_migration_${crypto.randomUUID()}`,
          created: 1783209600,
          type: "checkout.session.completed",
          data: {
            object: { client_reference_id: preMigrationWriterAccountId }
          }
        })
      );
      assert.equal(preMigrationProcessed, true);

      await executeTransactionalMigrationFile(
        client,
        stripeWebhookEventOrderingMigrationPath
      );

      const backfilled = await client.query(
        `
          select
            stripe_last_event_created_at = $2::timestamptz as floor_matches,
            stripe_last_event_receipt_order is not null as has_receipt_order
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-05T12:34:56.000Z"]
      );
      assert.deepEqual(backfilled.rows, [
        { floor_matches: true, has_receipt_order: true }
      ]);

      await client.query(
        `
          update public.agent_outbox_accounts
          set stripe_subscription_status = 'canceled'
          where account_id = $1
        `,
        [accountId]
      );
      const afterLegacyUpdate = await client.query(
        `
          select
            stripe_last_event_created_at is null as created_floor_cleared,
            stripe_last_event_receipt_order is null as receipt_order_cleared
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
      assert.deepEqual(afterLegacyUpdate.rows, [
        { created_floor_cleared: true, receipt_order_cleared: true }
      ]);
    } finally {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
    }
  }
);

test(
  "Stripe webhook projections retain newer account state while recording stale distinct events",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database policy verification"
  },
  async () => {
    const connectionString = phase3DatabaseVerificationUrl;
    assert.ok(connectionString);
    const client = new Client({ connectionString });
    const accountId = crypto.randomUUID();
    const subscriptionId = `sub_ordering_${crypto.randomUUID()}`;
    const customerId = `cus_ordering_${crypto.randomUUID()}`;
    const newerEventId = `evt_newer_${crypto.randomUUID()}`;
    const staleEventId = `evt_stale_${crypto.randomUUID()}`;
    const equalEventId = `evt_equal_${crypto.randomUUID()}`;
    const concurrentEarlierEventId = `evt_equal_earlier_${crypto.randomUUID()}`;
    const concurrentLaterEventId = `evt_equal_later_${crypto.randomUUID()}`;
    const newerCreated = 1783296000;
    const now = new Date("2026-07-05T00:00:00.000Z");
    /** @type {() => void} */
    let releaseConcurrentEarlier = () => {};
    /** @type {Promise<boolean> | null} */
    let concurrentEarlierProcessing = null;
    let bodyError;

    await client.connect();
    try {
      await client.query(
        "insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)",
        [accountId, `stripe-ordering-${accountId}`]
      );

      const event = (
        /** @type {string} */ eventId,
        /** @type {number} */ created,
        /** @type {string} */ status
      ) =>
        /** @type {any} */ ({
          id: eventId,
          created,
          type: "customer.subscription.updated",
          data: {
            object: {
              id: subscriptionId,
              customer: customerId,
              status,
              metadata: { account_id: accountId },
              items: { data: [] }
            }
          }
        });
      const process = (/** @type {any} */ stripeEvent) =>
        runProductTransaction(
          connectionString,
          {
            requestId: `stripe-ordering-${stripeEvent.id}`,
            authSurface: "control_plane"
          },
          (query) => processStripeEventInTransaction(query, stripeEvent, now)
        );

      assert.equal(
        await process(event(newerEventId, newerCreated, "active")),
        true
      );
      assert.equal(
        await process(event(staleEventId, newerCreated - 3600, "canceled")),
        true
      );

      const afterStale = await client.query(
        `
          select billing_status, stripe_subscription_status,
            stripe_last_event_created_at = $2::timestamptz as marker_matches
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-06T00:00:00.000Z"]
      );
      assert.deepEqual(afterStale.rows, [
        {
          billing_status: "active",
          stripe_subscription_status: "active",
          marker_matches: true
        }
      ]);
      const staleLedger = await client.query(
        `
          select account_id::text as account_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [staleEventId]
      );
      assert.deepEqual(staleLedger.rows, [{ account_id: null }]);

      assert.equal(
        await process(event(equalEventId, newerCreated, "past_due")),
        true
      );
      const afterEqual = await client.query(
        `
          select billing_status, stripe_subscription_status,
            stripe_last_event_created_at = $2::timestamptz as marker_matches
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-06T00:00:00.000Z"]
      );
      assert.deepEqual(afterEqual.rows, [
        {
          billing_status: "past_due",
          stripe_subscription_status: "past_due",
          marker_matches: true
        }
      ]);

      /** @type {(value?: void | PromiseLike<void>) => void} */
      let markConcurrentEarlierInserted = () => {};
      /** @type {Promise<void>} */
      const concurrentEarlierInserted = new Promise((resolve) => {
        markConcurrentEarlierInserted = resolve;
      });
      /** @type {Promise<void>} */
      const concurrentEarlierRelease = new Promise((resolve) => {
        releaseConcurrentEarlier = resolve;
      });
      concurrentEarlierProcessing = runProductTransaction(
        connectionString,
        {
          requestId: `stripe-ordering-${concurrentEarlierEventId}`,
          authSurface: "control_plane"
        },
        (query) =>
          processStripeEventInTransaction(
            /** @type {any} */ (
              async (/** @type {any} */ statement) => {
                const result = await query(statement);
                if (
                  /insert into public\.agent_outbox_stripe_webhook_events/.test(
                    statement.sql
                  )
                ) {
                  markConcurrentEarlierInserted();
                  await concurrentEarlierRelease;
                }
                return result;
              }
            ),
            event(concurrentEarlierEventId, newerCreated, "canceled"),
            now
          )
      );
      await Promise.race([
        concurrentEarlierInserted,
        concurrentEarlierProcessing.then(
          () => {
            throw new Error(
              "Earlier equal-second Stripe event completed before the deliberate interleave."
            );
          },
          (error) => {
            throw error;
          }
        )
      ]);

      assert.equal(
        await process(event(concurrentLaterEventId, newerCreated, "active")),
        true
      );
      releaseConcurrentEarlier();
      assert.equal(await concurrentEarlierProcessing, true);

      const afterConcurrentEqual = await client.query(
        `
          select billing_status, stripe_subscription_status
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
      assert.deepEqual(afterConcurrentEqual.rows, [
        {
          billing_status: "active",
          stripe_subscription_status: "active"
        }
      ]);
      const concurrentEarlierLedger = await client.query(
        `
          select account_id::text as account_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [concurrentEarlierEventId]
      );
      assert.deepEqual(concurrentEarlierLedger.rows, [{ account_id: null }]);
    } catch (error) {
      bodyError = error;
    } finally {
      /** @type {Error[]} */
      const teardownErrors = [];
      const attempt = teardownAttempt(
        teardownErrors,
        "Stripe ordering teardown failed"
      );
      releaseConcurrentEarlier();
      const pendingConcurrentEarlier = concurrentEarlierProcessing;
      if (pendingConcurrentEarlier) {
        await attempt("concurrent earlier event settlement", () =>
          pendingConcurrentEarlier.then(() => undefined)
        );
      }
      await attempt("Stripe ordering ledger cleanup", () =>
        client.query(
          "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = any($1::text[])",
          [
            [
              newerEventId,
              staleEventId,
              equalEventId,
              concurrentEarlierEventId,
              concurrentLaterEventId
            ]
          ]
        )
      );
      await attempt("Stripe ordering account cleanup", () =>
        client.query(
          "delete from public.agent_outbox_accounts where account_id = $1",
          [accountId]
        )
      );
      await attempt("Stripe ordering client close", () => client.end());

      if (teardownErrors.length > 0) {
        const teardownError = new AggregateError(
          teardownErrors,
          "Stripe ordering teardown failed."
        );
        if (bodyError !== undefined) {
          throw new AggregateError(
            [bodyError, teardownError],
            "Stripe ordering test and teardown both failed."
          );
        }
        throw teardownError;
      }
      if (bodyError !== undefined) {
        throw bodyError;
      }
    }
  }
);

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
    /** @type {unknown} */
    let bodyError;

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
      await assertMigrationOwnerCanSetAppRole(client);

      await client.query("set role agent_outbox_app");
      await client.query("begin");
      ids.accountA = crypto.randomUUID();
      ids.accountB = crypto.randomUUID();
      ids.userA = crypto.randomUUID();
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

      const accountARows = await client.query(
        `
          insert into public.agent_outbox_accounts(account_id, label)
          values ($1, $2)
          returning account_audit_id
        `,
        [ids.accountA, accountLabelA]
      );
      ids.accountAuditA = accountARows.rows[0].account_audit_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const accountBRows = await client.query(
        `
          insert into public.agent_outbox_accounts(account_id, label)
          values ($1, $2)
          returning account_audit_id
        `,
        [ids.accountB, accountLabelB]
      );
      ids.accountAuditB = accountBRows.rows[0].account_audit_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        ids.userA
      ]);

      await client.query(
        `
          insert into public.agent_outbox_users(user_id, clerk_user_id)
          values ($1, $2)
        `,
        [ids.userA, `phase3-user-${runId}`]
      );

      await client.query(
        `
          insert into public.agent_outbox_account_members(account_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [ids.accountA, ids.userA]
      );

      const callerARows = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values
            ($1, 'Caller A', $2),
            ($1, 'Caller A2', $3)
          returning caller_id, caller_slug
        `,
        [ids.accountA, `caller-a-${runId}`, `caller-a2-${runId}`]
      );
      for (const row of callerARows.rows) {
        if (row.caller_slug === `caller-a-${runId}`) {
          ids.callerA = row.caller_id;
        } else {
          ids.callerA2 = row.caller_id;
        }
      }
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const callerBRows = await client.query(
        `
          insert into public.agent_outbox_callers(account_id, display_name, caller_slug)
          values ($1, 'Caller B', $2)
          returning caller_id
        `,
        [ids.accountB, `caller-b-${runId}`]
      );
      ids.callerB = callerBRows.rows[0].caller_id;
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

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

      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
      const inputBRows = await client.query(
        `
          insert into public.agent_outbox_input_items(
            account_id, caller_id, caller_item_id, caller_item_id_hash,
            row_type_display, row_type_icon, title_html, subtitle_html,
            summary_html, status, non_file_payload_bytes, updated_at
          )
          values ($1, $2, 'item-b', $3, 'Review', 'Inbox', 'Title B', 'Subtitle B', 'Summary B', 'pending', 10, '2026-06-30T12:00:00.000Z')
          returning input_item_id, caller_item_id
        `,
        [ids.accountB, ids.callerB, `hash-b-${runId}`]
      );
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
      const inputARows = await client.query(
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
            ($1, $2, 'answered-over-cap', $6, 'Review', 'Inbox', 'Answered title', 'Answered subtitle', 'Answered summary', 'answered', 100, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
            ($1, $2, 'ack-output', $7, 'Review', 'Inbox', 'Ack title', 'Ack subtitle', 'Ack summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'timeout-output', $8, 'Review', 'Inbox', 'Timeout title', 'Timeout subtitle', 'Timeout summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'undo-output', $9, 'Review', 'Inbox', 'Undo title', 'Undo subtitle', 'Undo summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'retained-pending', $10, 'Review', 'Inbox', 'Retention title', 'Retention subtitle', 'Retention summary', 'pending', 10, '2026-01-01T00:00:00.000Z', null),
            ($1, $2, 'file-output', $11, 'Review', 'Inbox', 'File output title', 'File output subtitle', 'File output summary', 'answered', 10, '2026-06-30T12:00:00.000Z', '2026-06-30T12:00:00.000Z'),
            ($1, $2, 'file-upload-pending', $12, 'Review', 'Inbox', 'File upload title', 'File upload subtitle', 'File upload summary', 'pending', 12, '2026-06-29T12:00:00.000Z', null)
          returning input_item_id, caller_item_id
        `,
        [
          ids.accountA,
          ids.callerA,
          `hash-a-${runId}`,
          ids.callerA2,
          `hash-a2-${runId}`,
          `hash-answered-${runId}`,
          `hash-ack-${runId}`,
          `hash-timeout-${runId}`,
          `hash-undo-${runId}`,
          `hash-retained-${runId}`,
          `hash-file-output-${runId}`,
          `hash-file-upload-${runId}`
        ]
      );
      const inputRows = {
        rows: [...inputARows.rows, ...inputBRows.rows]
      };
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
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountB
      ]);
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
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);

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
        "agent_outbox.account_id",
        ids.accountA
      ]);
      for (const [name, sql] of [
        [
          "ip_quota",
          "select public.agent_outbox_prune_ip_quota_windows('2026-06-15T00:00:00.000Z')"
        ],
        [
          "caller_setup",
          "select public.agent_outbox_prune_caller_setup_requests('2026-06-15T00:00:00.000Z')"
        ],
        [
          "account_targets",
          "select * from public.agent_outbox_cleanup_account_targets()"
        ],
        [
          "stripe_webhooks",
          "select public.agent_outbox_prune_stripe_webhook_events('2026-06-15T00:00:00.000Z')"
        ]
      ]) {
        await client.query(`savepoint unset_auth_surface_${name}`);
        try {
          await assert.rejects(client.query(sql), (error) => {
            assert.equal(
              /** @type {{ code?: string }} */ (error).code,
              "42501"
            );
            return true;
          });
        } finally {
          await client.query(
            `rollback to savepoint unset_auth_surface_${name}`
          );
        }
      }
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
            received_at,
            processed_at
          )
          values
            ($1, 'checkout.session.completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ($2, 'customer.subscription.updated', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
        `,
        [`evt_old_${runId}`, `evt_recent_${runId}`]
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
        [[`evt_old_${runId}`, `evt_recent_${runId}`]]
      );
      assert.deepEqual(
        retainedStripeWebhookEvents.rows.map((row) => row.stripe_event_id),
        [`evt_recent_${runId}`]
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
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
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
        "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'checkout.session.completed')",
        [`evt_cp_${runId}`]
      );

      const cpSelect = await client.query(
        "select stripe_event_id from public.agent_outbox_stripe_webhook_events where stripe_event_id = $1",
        [`evt_cp_${runId}`]
      );
      assert.equal(cpSelect.rowCount, 1);

      const cpUpdate = await client.query(
        "update public.agent_outbox_stripe_webhook_events set event_type = 'checkout.session.async_payment_succeeded' where stripe_event_id = $1",
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
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
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
          "insert into public.agent_outbox_stripe_webhook_events (stripe_event_id, event_type) values ($1, 'type')",
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
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountA
      ]);
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
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const teardownErrors = [];
          const attempt = teardownAttempt(
            teardownErrors,
            "Phase 3 database teardown failed"
          );
          await attempt("transaction and role reset", () =>
            resetRoleAndRollback(client)
          );
          await attempt("test row cleanup", () =>
            cleanupPhase3DatabaseVerificationRows(client, ids)
          );
          await attempt("client close", () => client.end());
          if (teardownErrors.length > 0) {
            throw new AggregateError(
              teardownErrors,
              "Phase 3 database teardown failed."
            );
          }
        },
        "Phase 3 database test and teardown both failed."
      );
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
