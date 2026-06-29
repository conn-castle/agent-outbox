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
  validateToolchainPackage,
  validateWorkflowVersionPins
} from "../scripts/foundation.mjs";

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

test("validateToolchainPackage rejects runtime dependencies in Phase 1", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
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
    devDependencies: { prettier: "3.9.3" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "runtime dependency next is out of Phase 1 scope"
  ]);
});

test("validateToolchainPackage rejects Node types from a newer runtime major", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    phase1Tools: {
      nodeTypes: { package: "@types/node", version: "26.0.1" }
    },
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
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `24.18.0`. Uses pnpm `11.9.0`. Project scripts run on pinned Node `24.18.0`."
  );

  assert.deepEqual(failures, []);
});

test("validateRequiredEnvExample allows optional local development names", () => {
  const template =
    "APP_ENV=development\nAPP_BASE_URL=http://localhost:3000\nPUBLIC_APP_BASE_URL=http://localhost:3000\nSUPABASE_PROJECT_REF=\nDATABASE_URL=\nDATABASE_APP_ROLE_URL=\nDATABASE_MIGRATION_URL=\nCLERK_SECRET_KEY=\nCLERK_PUBLISHABLE_KEY=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PAID_MONTHLY_PRICE_ID=\nSTRIPE_BILLING_PORTAL_CONFIGURATION_ID=\nSENTRY_DSN=\nSENTRY_BROWSER_DSN=\nSENTRY_AUTH_TOKEN=\nCALLER_KEY_HASH_SECRET=\nSMOKE_OR_CLEANUP_TOKEN=\nAWS_PROFILE=\nCLOUDFLARE_API_TOKEN=\n";

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
