import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  validateMigrationReplayWorkflow,
  validatePhase3FoundationSourceContents,
  validatePhase4ContractDocContents,
  validateRequiredEnvExample,
  validateRuntimeProofScope,
  validateToolchainPackage,
  validateWranglerCronSchedule,
  validateWorkflowVersionPins
} from "../scripts/foundation.mjs";
import {
  flywayDockerEnvironmentNames,
  flywayEnvironmentFromConnection,
  flywayConnectionFromDatabaseUrl,
  validateMigrationFilenames
} from "../scripts/flyway.mjs";
import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  formatCallerApiKey,
  generateCallerApiKeyMaterial,
  parseCallerApiKey,
  parseCallerBearerApiKey,
  storedCallerCredentialDigestFromLookupRow,
  validateCallerBearer,
  verifyCallerApiKeyAgainstCredential
} from "../src/server/caller-auth.ts";
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
  limitErrorMetadata
} from "../src/server/limits.ts";
import {
  activeLimitBlockMetadata,
  auditSafeLifecycleEvent,
  consumesMonthlyCallerApiRequestQuota,
  quotaWindowKey,
  storedByteAccounting
} from "../src/server/accounting.ts";
import {
  activeLimitMaintenanceStatement,
  duplicateAcknowledgementLookupStatement,
  downgradeGraceExpiryStatement,
  pendingInputRetentionStatement,
  preReadUndoStatement,
  quotaWindowPruningStatement,
  terminalOutputDeletionStatement
} from "../src/server/cleanup.ts";
import { safeLogEvent } from "../src/server/logging.ts";
import {
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary
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
 * @param {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string }} ids
 */
async function cleanupPhase3DatabaseVerificationRows(client, ids) {
  if (
    !ids.accountA &&
    !ids.accountB &&
    !ids.accountAuditA &&
    !ids.accountAuditB &&
    !ids.userA
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

test("validateRequiredEnvExample allows optional local development names", () => {
  const template =
    "APP_ENV=development\nPORT=38000\nAPP_BASE_URL=http://localhost:38000\nPUBLIC_APP_BASE_URL=http://localhost:38000\nSUPABASE_PROJECT_REF=\nDATABASE_URL=\nDATABASE_APP_ROLE_URL=\nDATABASE_MIGRATION_URL=\nCLERK_SECRET_KEY=\nCLERK_PUBLISHABLE_KEY=\nSTRIPE_ACCOUNT_ID=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PAID_MONTHLY_PRICE_ID=\nSTRIPE_BILLING_PORTAL_CONFIGURATION_ID=\nSENTRY_DSN=\nSENTRY_BROWSER_DSN=\nSENTRY_AUTH_TOKEN=\nCALLER_KEY_HASH_SECRET=\nSMOKE_OR_CLEANUP_TOKEN=\nAWS_PROFILE=\nCLOUDFLARE_DNS_API_TOKEN=\n";

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
    "app/human/queue/page.tsx is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "src/server/schema.ts contains out-of-scope token: create table"
  ]);
});

test("validateRuntimeProofScope allows Phase 4 caller API route paths", () => {
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
    "app/api/account/status/route.ts": "export async function GET() {}"
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

test("validateRuntimeProofScope rejects later-phase billing and storage drift", () => {
  const failures = validateRuntimeProofScope({
    "app/api/billing/checkout/route.ts": "export async function POST() {}",
    "app/api/account/portal/route.ts": "export async function POST() {}",
    "app/api/account/delete/route.ts": "export async function POST() {}",
    "app/api/caller/connect/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/route.ts": "export async function POST() {}",
    "app/api/caller/revoke/route.ts": "export async function POST() {}",
    "app/api/input/[caller_item_id]/route.ts":
      "export async function DELETE() {}",
    "app/api/human/answer/route.ts": "export async function POST() {}",
    "src/components/human/Queue.tsx": "export function Queue() {}",
    "src/cli/main.ts": "export function main() {}",
    "src/server/steward-email.ts": "export const source = 'email';",
    "src/server/email-source.ts": "export const source = 'email';",
    "src/server/billing.ts": "await stripe.checkout.sessions.create({});",
    "src/server/files.ts": "await supabase.storage.from('files');",
    "src/server/source.ts": "const source = 'gmail classifier';"
  });

  assert.deepEqual(failures, [
    "app/api/billing/checkout/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/account/portal/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/account/delete/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/caller/connect/browser/start/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/caller/rotate/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/caller/revoke/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/input/[caller_item_id]/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "app/api/human/answer/route.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "src/cli/main.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "src/server/steward-email.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "src/server/email-source.ts is unrelated later-phase implementation scope, not Phase 4 caller API scope",
    "src/server/billing.ts contains out-of-scope token: stripe.checkout",
    "src/server/billing.ts contains out-of-scope token: checkout.sessions",
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

  assert.deepEqual(
    validateWranglerCronSchedule(wranglerConfig, RUNTIME_CRON_SCHEDULE),
    []
  );
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
      "V20260701010203__add_queue_indexes.sql"
    ]),
    []
  );
  assert.deepEqual(
    validateMigrationFilenames([
      "20260630000000_initial_schema.sql",
      "V20260630000000__initial_schema.sql",
      "V20260630000000__other_change.sql"
    ]),
    [
      "20260630000000_initial_schema.sql must match VYYYYMMDDHHMMSS__lower_snake_description.sql",
      "migration version 20260630000000 is duplicated"
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

test("caller API key helpers create display-once material and verify only active matching credentials", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE }, () => {
    const material = generateCallerApiKeyMaterial();
    const otherMaterial = generateCallerApiKeyMaterial();
    const parsed = parseCallerApiKey(material.plaintextApiKey);
    const otherParsed = parseCallerApiKey(otherMaterial.plaintextApiKey);
    const wrongSecretApiKey =
      otherParsed.ok && parsed.ok
        ? formatCallerApiKey({
            keyId: parsed.keyId,
            secret: otherParsed.secret
          })
        : "";

    assert.equal(parsed.ok, true);
    assert.equal(otherParsed.ok, true);
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

    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(material.plaintextApiKey, {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "active"
      }),
      {
        ok: true,
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        keyPrefix: material.keyPrefix,
        keyLastCharacters: material.keyLastCharacters
      }
    );

    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(material.plaintextApiKey, {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "revoked"
      }),
      { ok: false, code: "caller_key_revoked" }
    );
    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(wrongSecretApiKey, {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "revoked"
      }),
      { ok: false, code: "invalid_caller_key_secret" }
    );
    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(material.plaintextApiKey, {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "expired"
      }),
      { ok: false, code: "caller_key_expired" }
    );
    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(material.plaintextApiKey, {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "active",
        expiresAt: "2000-01-01T00:00:00.000Z"
      }),
      { ok: false, code: "caller_key_expired" }
    );
    assert.deepEqual(
      verifyCallerApiKeyAgainstCredential(
        material.plaintextApiKey,
        /** @type {any} */ ({
          keyId: material.keyId,
          secretDigest: material.secretDigest
        })
      ),
      { ok: false, code: "caller_key_not_active" }
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
  assert.equal(consumesMonthlyCallerApiRequestQuota("output_ack"), false);
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

test("cleanup statement builders target account-scoped database functions", () => {
  assert.deepEqual(duplicateAcknowledgementLookupStatement("output-123"), {
    sql: "select public.agent_outbox_output_ack_already_recorded($1) as already_recorded",
    values: ["output-123"]
  });
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
  assert.deepEqual(
    quotaWindowPruningStatement(new Date("2026-06-01T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
      values: ["2026-06-01T00:00:00.000Z"]
    }
  );
  assert.deepEqual(
    activeLimitMaintenanceStatement(new Date("2026-06-30T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_prune_expired_limit_blocks($1) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z"]
    }
  );
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
    operation: "runtime.structured_error.canary",
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
    operation: "runtime.structured_error.canary",
    message: "safe message"
  });
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

test("sentryCaptureEnabled only allows production runtime capture", () => {
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
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
    /** @type {{ accountA?: string, accountB?: string, accountAuditA?: string, accountAuditB?: string, userA?: string, callerA?: string, callerA2?: string, callerB?: string, answeredInput?: string, fileOutputInput?: string, fileUploadInput?: string, output?: string, fileOutput?: string }} */
    const ids = {};
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
            "public.agent_outbox_prune_expired_limit_blocks(timestamptz)"
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

      const credentialKeyId = `key-${runId}`;
      const credentialDigest = "c".repeat(64);
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
            activated_at
          )
          values ($1, $2, $3, 'aob_live_phase3_test', 'test', $4, 'active', '2026-06-30T12:00:00.000Z')
        `,
        [ids.accountA, ids.callerA, credentialKeyId, credentialDigest]
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
          ids.fileUploadInput
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
        limit_block_count: 0
      });

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
      await resetRoleAndRollback(client);
      await cleanupPhase3DatabaseVerificationRows(client, ids);
      if (grantedAppRoleForTest) {
        await revokeCurrentUserAppRoleGrant(client);
      }
      await client.end();
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
