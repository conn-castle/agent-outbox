import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoForbiddenWorkflowCommands,
  missingEnvNames,
  redactCommandResult,
  runQuiet,
  supabaseProjectsIncludeRef,
  validateCommandsVersionPins,
  validateRequiredEnvExample,
  validateRuntimeProofScope,
  validateToolchainPackage,
  validateWorkerCronProofConfig,
  validateWorkflowVersionPins
} from "../scripts/foundation.mjs";
import { validateCallerBearer } from "../src/server/caller-auth.ts";
import { transactionContextCanaryStatements as databaseCanaryStatements } from "../src/server/database.ts";
import { runtimeConfigStatus } from "../src/server/env.ts";
import { safeLogEvent } from "../src/server/logging.ts";
import { runScheduledCanary } from "../src/server/scheduled.ts";
import { sentryCaptureEnabled } from "../src/server/sentry.ts";

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
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
    },
    runtimePins: {
      next: { package: "next", version: "16.2.9" },
      opennext: {
        package: "@opennextjs/cloudflare",
        version: "1.20.1",
        dependencyType: /** @type {"devDependencies"} */ ("devDependencies")
      }
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
      "@opennextjs/cloudflare": "1.20.1",
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
    ".github/workflows/release-check.yml": "run: wrangler deploy"
  });

  assert.deepEqual(failures, [
    ".github/workflows/release-check.yml contains forbidden command: wrangler deploy"
  ]);
});

test("validateWorkflowVersionPins rejects CI Node drift", () => {
  const failures = validateWorkflowVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
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
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `26.0.0`. Uses pnpm `12.0.0`."
  );

  assert.deepEqual(failures, [
    "COMMANDS.md pinned Node 26.0.0 must match toolchain.json 24.18.0",
    "COMMANDS.md pnpm 12.0.0 must match toolchain.json 11.9.0"
  ]);
});

test("validateCommandsVersionPins allows lower-bound Node prerequisites", () => {
  const failures = validateCommandsVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `24.18.0`. Uses pnpm `11.9.0`. Project scripts run on pinned Node `24.18.0`."
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

test("validateRuntimeProofScope rejects product implementation tokens", () => {
  const failures = validateRuntimeProofScope({
    "app/api/input/route.ts": "await sql`create table input_items ();`"
  });

  assert.deepEqual(failures, [
    "app/api/input/route.ts contains out-of-scope token: create table",
    "app/api/input/route.ts contains out-of-scope token: input_items"
  ]);
});

test("validateRuntimeProofScope allows explicit Phase 2 boundary markers", () => {
  assert.deepEqual(
    validateRuntimeProofScope({
      "app/page.tsx":
        "Queue lifecycle, file workflows, billing, cleanup, and Steward behavior are out of scope."
    }),
    []
  );
});

test("validateWorkerCronProofConfig rejects a route-only scheduled canary", () => {
  const failures = validateWorkerCronProofConfig({
    wranglerConfig: {
      main: ".open-next/worker.js",
      triggers: { crons: [] }
    },
    workerEntryContent: "export default { async fetch() {} };"
  });

  assert.deepEqual(failures, [
    "wrangler.jsonc must use worker/entry.mjs as the Worker entrypoint",
    "wrangler.jsonc must configure the runtime cron schedule 17 * * * *",
    "worker/entry.mjs must export a scheduled handler",
    "worker/entry.mjs must execute the scheduled canary"
  ]);
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
    validateCallerBearer(" Bearer smoke-token ", "smoke-token"),
    {
      ok: true,
      callerId: "runtime-smoke-caller"
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
      SMOKE_OR_CLEANUP_TOKEN: undefined
    },
    () => {
      const status = runtimeConfigStatus();

      assert.equal(status.configured, false);
      assert.deepEqual(status.missing, [
        "CLERK_PUBLISHABLE_KEY",
        "DATABASE_APP_ROLE_URL",
        "SENTRY_DSN",
        "SMOKE_OR_CLEANUP_TOKEN"
      ]);
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
