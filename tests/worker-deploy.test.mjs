import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import {
  findExactWorkerVersion,
  parseWorkerVersionMessage,
  serializeWorkerVersionMessage,
  validateWorkerVersionReleaseTag
} from "../scripts/release/identity.mjs";
import {
  REQUIRED_PUBLIC_VAR_NAMES as WORKER_DEPLOY_PUBLIC_VAR_NAMES,
  REQUIRED_SECRET_NAMES as WORKER_DEPLOY_SECRET_NAMES,
  assertWorkerTriggersUnchanged,
  buildPromoteCandidateArgs,
  buildRestorePriorArgs,
  buildStagedVersionDeployArgs,
  buildWranglerVersionsUploadArgs,
  buildWranglerVersionsUploadArgsWithConfig,
  parseUploadedWorkerVersionId,
  runWorkerVersionUpload,
  secretsDotenvContent,
  validateWorkerDeployEnvironment,
  validateWorkerTrafficEnvironment,
  workerBuildEnvironment,
  wranglerConfigWithHyperdrive,
  wranglerDeployEnvironment
} from "../scripts/worker-deploy.mjs";
import {
  DATABASE_CONNECTION_MODE_HYPERDRIVE,
  DATABASE_CONNECTION_MODE_VAR,
  DATABASE_HYPERDRIVE_BINDING,
  runtimeDatabaseConnectionString,
  runtimeDatabaseEnv
} from "../worker/hyperdrive.mjs";
import {
  CANDIDATE_VERSION,
  DRAFT_ID,
  PRIOR_VERSION,
  RELEASE
} from "./helpers/release-fixtures.mjs";

test("Worker version messages are strict and uniquely matched", () => {
  const message = serializeWorkerVersionMessage({
    runId: RELEASE.runId,
    releaseId: DRAFT_ID,
    sha: RELEASE.expectedSha
  });
  assert.deepEqual(parseWorkerVersionMessage(message), {
    runId: RELEASE.runId,
    releaseId: String(DRAFT_ID),
    sha12: RELEASE.expectedSha.slice(0, 12)
  });
  const match = findExactWorkerVersion(
    [
      {
        id: "other",
        annotations: { "workers/message": "run 1 release 2 abcdefabcdef" }
      },
      { id: CANDIDATE_VERSION, annotations: { "workers/message": message } }
    ],
    { runId: RELEASE.runId, releaseId: DRAFT_ID, sha: RELEASE.expectedSha }
  );
  assert.equal(match.id, CANDIDATE_VERSION);
  assert.equal(
    parseUploadedWorkerVersionId(
      `Uploaded agent-outbox\nWorker Version ID: ${CANDIDATE_VERSION}\n`
    ),
    CANDIDATE_VERSION
  );
});

test("route and cron drift blocks the application release", () => {
  assert.doesNotThrow(() =>
    assertWorkerTriggersUnchanged(
      {
        routes: [{ pattern: "app.agent-outbox.dev", custom_domain: true }],
        triggers: { crons: ["17 * * * *"] }
      },
      {
        routes: [{ pattern: "app.agent-outbox.dev", custom_domain: true }],
        triggers: { crons: ["17 * * * *"] }
      }
    )
  );
  assert.doesNotThrow(() =>
    assertWorkerTriggersUnchanged(
      `{
        // live config
        "routes": [{ "custom_domain": true, "pattern": "app.agent-outbox.dev" }],
        "triggers": { "crons": ["17 * * * *"] },
      }`,
      {
        triggers: { crons: ["17 * * * *"] },
        routes: [{ pattern: "app.agent-outbox.dev", custom_domain: true }]
      }
    )
  );
  assert.throws(
    () =>
      assertWorkerTriggersUnchanged(
        { routes: [], triggers: { crons: ["17 * * * *"] } },
        { routes: [], triggers: { crons: ["0 * * * *"] } }
      ),
    /routes or cron triggers changed/
  );
});

test("staged, promote, and restore commands are non-interactive exact-id placements", () => {
  assert.deepEqual(
    buildStagedVersionDeployArgs(PRIOR_VERSION, CANDIDATE_VERSION).slice(0, 8),
    [
      "exec",
      "wrangler",
      "versions",
      "deploy",
      `${PRIOR_VERSION}@100%`,
      `${CANDIDATE_VERSION}@0%`,
      "--name",
      "agent-outbox"
    ]
  );
  assert.equal(
    buildPromoteCandidateArgs(CANDIDATE_VERSION).includes("--yes"),
    true
  );
  assert.deepEqual(buildRestorePriorArgs(PRIOR_VERSION).slice(4, 6), [
    `${PRIOR_VERSION}@100%`,
    "--name"
  ]);
  assert.equal(
    buildRestorePriorArgs(PRIOR_VERSION).includes(`${CANDIDATE_VERSION}@0%`),
    false
  );
});

test("manual rollback still requires the Worker version release tag", () => {
  assert.doesNotThrow(() =>
    validateWorkerVersionReleaseTag(
      {
        id: PRIOR_VERSION,
        annotations: { "workers/tag": "v1.2.3" }
      },
      PRIOR_VERSION,
      "v1.2.3"
    )
  );
  assert.throws(
    () =>
      validateWorkerVersionReleaseTag(
        {
          id: PRIOR_VERSION,
          annotations: { "workers/tag": "v1.2.4" }
        },
        PRIOR_VERSION,
        "v1.2.3"
      ),
    /does not carry release tag v1.2.3/
  );
});

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";

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
    GITHUB_RUN_ID: "33196586800",
    AGENT_OUTBOX_GITHUB_RELEASE_ID: "9001",
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
    const uploaded = runWorkerVersionUpload({
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

        const isUpload =
          args.includes("versions") &&
          args.includes("upload") &&
          !args.includes("--dry-run");
        return {
          status: 0,
          signal: null,
          error: undefined,
          stdout: isUpload
            ? "Worker Version ID: 123e4567-e89b-12d3-a456-426614174000\n"
            : "",
          stderr: ""
        };
      }
    });
    assert.equal(uploaded.versionId, "123e4567-e89b-12d3-a456-426614174000");

    assert.equal(calls[0].command, "corepack");
    assert.deepEqual(calls[0].args, ["pnpm", "run", "worker:build"]);
    assert.equal(calls[0].env?.APP_BASE_URL, env.APP_BASE_URL);
    assert.equal(calls[0].env?.CLOUDFLARE_API_TOKEN, undefined);
    for (const name of WORKER_DEPLOY_SECRET_NAMES) {
      assert.equal(calls[0].env?.[name], undefined);
    }
    assert.equal(calls[1].command, "corepack");
    assert.deepEqual(calls[1].args.slice(0, 6), [
      "pnpm",
      "exec",
      "wrangler",
      "versions",
      "upload",
      "--config"
    ]);
    assert.ok(configFilePath);
    assert.equal(calls[1].args.includes(configFilePath), true);
    assert.equal(calls[1].args.includes("--env-file"), true);
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
  const varBindings = buildWranglerVersionsUploadArgs(
    env,
    "/tmp/secrets"
  ).flatMap((arg, index, args) => (arg === "--var" ? [args[index + 1]] : []));
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

  const withoutAnalytics = buildWranglerVersionsUploadArgsWithConfig(
    workerDeployEnv(),
    "/tmp/worker-secrets.env",
    "/tmp/wrangler.jsonc"
  );
  assert.deepEqual(withoutAnalytics.slice(0, 6), [
    "exec",
    "wrangler",
    "versions",
    "upload",
    "--config",
    "/tmp/wrangler.jsonc"
  ]);
  assert.equal(
    withoutAnalytics.includes(
      "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN:analytics-token"
    ),
    false
  );
  const withAnalytics = buildWranglerVersionsUploadArgs(
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

test("traffic-only Worker operations require Cloudflare token without runtime secrets", () => {
  assert.deepEqual(
    validateWorkerTrafficEnvironment({
      CLOUDFLARE_API_TOKEN: "cf-worker-token",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "conn-castle/agent-outbox/.github/workflows/deploy-production.yml@refs/heads/main"
    }),
    []
  );
  assert.deepEqual(
    validateWorkerTrafficEnvironment({
      CLOUDFLARE_API_TOKEN: "cf-worker-token",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "conn-castle/agent-outbox/.github/workflows/reconcile-production-release.yml@refs/heads/main"
    }),
    []
  );
  assert.equal(
    validateWorkerTrafficEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "conn-castle/agent-outbox/.github/workflows/deploy-production.yml@refs/heads/main"
    }).includes(
      "CLOUDFLARE_API_TOKEN is required for Worker traffic operations"
    ),
    true
  );
  assert.equal(
    validateWorkerTrafficEnvironment(
      workerDeployEnv({
        CLERK_SECRET_KEY: undefined,
        STRIPE_SECRET_KEY: undefined,
        SENTRY_DSN: undefined,
        CLOUDFLARE_HYPERDRIVE_ID: undefined
      })
    ).length,
    0
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

test("worker-deploy CLI refuses standalone mutation commands", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/worker-deploy.mjs", "upload"],
    {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      encoding: "utf8"
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /must run through scripts\/production-release\.mjs/
  );
});
