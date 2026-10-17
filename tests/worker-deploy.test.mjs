import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GH_SPAWN_MAX_BUFFER_BYTES } from "../scripts/release/gateway-github.mjs";

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
  buildStagedVersionDeployArgs,
  buildWranglerVersionsUploadArgs,
  parseUploadedWorkerVersionId,
  runWorkerVersionUpload,
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

test("staged and promote commands are non-interactive exact-id placements", () => {
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

const DEBUG_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_DEBUG_ID = "223e4567-e89b-12d3-a456-426614174000";
const UNINJECTED =
  "console.log(globalThis._debugIds, globalThis._sentryDebugIds);\n//# sourceMappingURL=entry.js.map\n";
const uploadEnv = () =>
  workerDeployEnv({
    SENTRY_ORG: "proof-org",
    SENTRY_PROJECT: "proof-project",
    SENTRY_AUTH_TOKEN: "local-proof-not-a-token",
    AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD: "1",
    AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH: "1"
  });

/**
 * @param {(step: number, dir: string, args: string[]) => void | { status: number, stdout: string, stderr: string }} [hook]
 * @param {Record<string, string | undefined>} [env]
 */
function uploadScenario(hook = () => {}, env = uploadEnv()) {
  const tempBase = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-worker-deploy-test-")
  );
  /** @type {{args: string[], options: import("node:child_process").SpawnSyncOptions, config?: Record<string, any>}[]} */
  const calls = [];
  let bundleDir = "";
  let hash = "";
  const run = () =>
    runWorkerVersionUpload({
      env,
      tempBase,
      spawnSyncImpl(command, args, options) {
        assert.equal(command, "corepack");
        const step = calls.length;
        const config =
          args[2] === "wrangler"
            ? JSON.parse(
                readFileSync(args[args.indexOf("--config") + 1], "utf8")
              )
            : undefined;
        calls.push({ args, options, config });
        const dir = args.includes("--outdir")
          ? args[args.indexOf("--outdir") + 1]
          : bundleDir;
        if (step === 1) {
          bundleDir = dir;
          mkdirSync(dir);
          writeFileSync(path.join(dir, "README.md"), "Wrangler output");
          writeFileSync(path.join(dir, "entry.js"), UNINJECTED);
          writeFileSync(
            path.join(dir, "entry.js.map"),
            JSON.stringify({
              version: 3,
              sources: ["private.ts"],
              sourcesContent: ["PRIVATE_SOURCE_CANARY"],
              names: [],
              mappings: "AAAA"
            })
          );
        } else if (step === 2) {
          const entry = path.join(dir, "entry.js");
          writeFileSync(
            entry,
            `!function(){e._sentryDebugIds[n]="${DEBUG_ID}"}();\n${readFileSync(entry, "utf8")}//# debugId=${DEBUG_ID}\n`
          );
          const map = path.join(dir, "entry.js.map");
          writeFileSync(
            map,
            JSON.stringify({
              ...JSON.parse(readFileSync(map, "utf8")),
              debugId: DEBUG_ID
            })
          );
          hash = createHash("sha256").update(readFileSync(entry)).digest("hex");
        } else if (step === 4) {
          mkdirSync(dir);
          writeFileSync(path.join(dir, "entry.js"), readFileSync(config.main));
          writeFileSync(path.join(dir, "README.md"), "Wrangler output");
        }
        const failure = hook(step, dir, args);
        if (failure) return failure;
        return {
          status: 0,
          stdout: step === 5 ? `Worker Version ID: ${CANDIDATE_VERSION}\n` : "",
          stderr: ""
        };
      }
    });
  return {
    run,
    calls,
    tempBase,
    env,
    hash: () => hash,
    clean() {
      assert.deepEqual(readdirSync(tempBase), []);
      for (const { args } of calls) {
        for (const flag of ["--config", "--secrets-file", "--outdir"]) {
          if (args.includes(flag))
            assert.equal(existsSync(args[args.indexOf(flag) + 1]), false);
        }
      }
      rmSync(tempBase, { recursive: true });
    }
  };
}

test("Worker upload sends one Sentry identity before uploading the exact no-bundle bytes with private maps disabled", () => {
  const env = uploadEnv();
  env.CALLER_KEY_HASH_SECRET = `${HASH_SECRET_FIXTURE}#after-hash`;
  env.CLERK_SECRET_KEY = "`sk_test_backticked`";
  env.SMOKE_OR_CLEANUP_TOKEN =
    "token with space='quoted' \"double\" back\\slash";
  const scenario = uploadScenario((step, _dir, args) => {
    if (![1, 4, 5].includes(step)) return;
    assert.deepEqual(
      JSON.parse(
        readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8")
      ),
      Object.fromEntries(
        WORKER_DEPLOY_SECRET_NAMES.map((name) => [name, env[name]])
      )
    );
  }, env);
  try {
    assert.deepEqual(scenario.run(), {
      versionId: CANDIDATE_VERSION,
      debugId: DEBUG_ID,
      entrySha256: scenario.hash()
    });
    const calls = scenario.calls;
    assert.equal(calls.length, 6);
    assert.deepEqual(calls[0].args, ["pnpm", "run", "worker:build"]);
    const bundleDir = calls[1].args.at(-2);
    assert.ok(bundleDir?.startsWith(scenario.tempBase + path.sep));
    assert.deepEqual(calls[1].args, [
      "pnpm",
      ...buildWranglerVersionsUploadArgs(
        env,
        calls[1].args[calls[1].args.indexOf("--secrets-file") + 1],
        calls[1].args[6]
      ),
      "--dry-run",
      "--outdir",
      bundleDir,
      "--upload-source-maps"
    ]);
    assert.deepEqual(calls[2].args, [
      "pnpm",
      "exec",
      "sentry-cli",
      "sourcemaps",
      "inject",
      bundleDir
    ]);
    assert.deepEqual(calls[3].args, [
      "pnpm",
      "exec",
      "sentry-cli",
      "sourcemaps",
      "upload",
      "--strict",
      "--wait",
      bundleDir
    ]);
    assert.deepEqual(calls[4].args, [
      ...calls[5].args,
      "--dry-run",
      "--outdir",
      calls[4].args.at(-1)
    ]);
    assert.equal(calls[5].args.includes("--upload-source-maps"), false);
    const original = calls[1].config;
    for (const call of [calls[4], calls[5]]) {
      assert.ok(path.isAbsolute(call.config?.main));
      assert.ok(path.isAbsolute(call.config?.assets.directory));
      assert.equal(call.config?.assets.directory.includes(bundleDir), false);
      assert.deepEqual(call.config?.hyperdrive, [
        {
          binding: DATABASE_HYPERDRIVE_BINDING,
          id: env.CLOUDFLARE_HYPERDRIVE_ID
        }
      ]);
      assert.deepEqual(call.config, {
        ...original,
        main: path.join(bundleDir ?? "", "entry.js"),
        no_bundle: true,
        find_additional_modules: false,
        upload_source_maps: false
      });
      // Every argument except the derived config path stays identical.
      assert.deepEqual(
        call.args.slice(7, call.args.includes("--dry-run") ? -3 : undefined),
        calls[1].args.slice(7, -4)
      );
    }
    const vars = calls[5].args.flatMap((arg, i, args) =>
      arg === "--var" ? [args[i + 1]] : []
    );
    assert.deepEqual(vars, [
      `${DATABASE_CONNECTION_MODE_VAR}:${DATABASE_CONNECTION_MODE_HYPERDRIVE}`,
      ...WORKER_DEPLOY_PUBLIC_VAR_NAMES.map((name) => `${name}:${env[name]}`),
      `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:${env.CLERK_PUBLISHABLE_KEY}`
    ]);
    for (const [i, call] of calls.entries()) {
      assert.equal(
        call.options.env?.SENTRY_AUTH_TOKEN,
        [0, 3].includes(i) ? env.SENTRY_AUTH_TOKEN : undefined
      );
      assert.equal(
        call.options.env?.CLOUDFLARE_API_TOKEN,
        [1, 4, 5].includes(i) ? env.CLOUDFLARE_API_TOKEN : undefined
      );
      for (const name of WORKER_DEPLOY_SECRET_NAMES)
        assert.equal(call.options.env?.[name], undefined);
      assert.equal(
        call.args.some((arg) => arg.includes(env.SENTRY_AUTH_TOKEN ?? "")),
        false
      );
      if (i > 0)
        assert.equal(call.options.maxBuffer, GH_SPAWN_MAX_BUFFER_BYTES);
    }
    for (const i of [2, 3])
      assert.equal(calls[i].options.env?.SENTRY_LOAD_DOTENV, "0");
    assert.equal(calls[3].options.env?.SENTRY_ORG, env.SENTRY_ORG);
    assert.equal(calls[3].options.env?.SENTRY_PROJECT, env.SENTRY_PROJECT);
  } finally {
    scenario.clean();
  }
});

for (const name of [
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD",
  "AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH"
]) {
  for (const value of [undefined, "", "0"]) {
    if (value === "0" && name.startsWith("SENTRY_")) continue;
    test(`Worker upload rejects ${name}=${value} before any command`, () => {
      const scenario = uploadScenario(undefined, {
        ...uploadEnv(),
        [name]: value
      });
      try {
        assert.throws(
          scenario.run,
          new RegExp(
            `${name} ${name.startsWith("SENTRY_") ? "is required for Worker source map upload" : "must be 1 for production Worker version upload"}`
          )
        );
        assert.equal(scenario.calls.length, 0);
      } finally {
        scenario.clean();
      }
    });
  }
}

/** @type {[string, number, (dir: string) => void, RegExp][]} */
const invalidBundles = [
  [
    "extra module",
    1,
    (d) => writeFileSync(path.join(d, "chunk.wasm"), "x"),
    /chunk.wasm/
  ],
  [
    "missing map",
    1,
    (d) => rmSync(path.join(d, "entry.js.map")),
    /required regular files/
  ],
  ["nested directory", 1, (d) => mkdirSync(path.join(d, "nested")), /nested/],
  [
    "README directory",
    1,
    (d) => {
      rmSync(path.join(d, "README.md"));
      mkdirSync(path.join(d, "README.md"));
    },
    /README.md/
  ],
  [
    "entry symlink",
    1,
    (d) => {
      rmSync(path.join(d, "entry.js"));
      symlinkSync("README.md", path.join(d, "entry.js"));
    },
    /entry.js/
  ],
  [
    "native registration",
    1,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js"),
        `(e._debugIds = {}))[n] = "${DEBUG_ID}";\n${UNINJECTED}`
      ),
    /uninjected/
  ],
  [
    "Sentry registration",
    1,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js"),
        `e._sentryDebugIds[n]="${DEBUG_ID}";\n${UNINJECTED}`
      ),
    /uninjected/
  ],
  [
    "preexisting comment",
    1,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js"),
        `//# debugId=${DEBUG_ID}\n${UNINJECTED}`
      ),
    /uninjected/
  ],
  [
    "preexisting map ID",
    1,
    (d) => writeFileSync(path.join(d, "entry.js.map"), '{"debugId":"old"}'),
    /uninjected/
  ],
  [
    "invalid map JSON",
    1,
    (d) => writeFileSync(path.join(d, "entry.js.map"), "{"),
    /JSON/
  ],
  [
    "missing map URL",
    1,
    (d) => writeFileSync(path.join(d, "entry.js"), "export default {};"),
    /sourceMappingURL/
  ],
  [
    "two injected comments",
    2,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js"),
        readFileSync(path.join(d, "entry.js"), "utf8") +
          `//# debugId=${DEBUG_ID}\n`
      ),
    /injected Worker identity/
  ],
  [
    "registration mismatch",
    2,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js"),
        readFileSync(path.join(d, "entry.js"), "utf8").replace(
          `Ids[n]="${DEBUG_ID}"`,
          `Ids[n]="${OTHER_DEBUG_ID}"`
        )
      ),
    /injected Worker identity/
  ],
  [
    "map mismatch",
    2,
    (d) =>
      writeFileSync(
        path.join(d, "entry.js.map"),
        JSON.stringify({ debugId: OTHER_DEBUG_ID })
      ),
    /injected Worker identity/
  ],
  [
    "post-inject extra file",
    2,
    (d) => writeFileSync(path.join(d, "extra.js"), "x"),
    /extra.js/
  ],
  [
    "changed no-bundle bytes",
    4,
    (d) => writeFileSync(path.join(d, "entry.js"), "changed"),
    /differs/
  ],
  [
    "private map in verify output",
    4,
    (d) => writeFileSync(path.join(d, "entry.js.map"), "PRIVATE_SOURCE_CANARY"),
    /entry.js.map/
  ]
];
for (const [name, step, mutate, error] of invalidBundles) {
  test(`Worker upload fails closed on ${name}`, () => {
    const scenario = uploadScenario((i, dir) => {
      if (i === step) mutate(dir);
    });
    try {
      assert.throws(scenario.run, error);
      assert.equal(scenario.calls.length, step + 1);
    } finally {
      scenario.clean();
    }
  });
}

test("Worker outdir README is optional", () => {
  const scenario = uploadScenario((step, dir) => {
    if (step === 1 || step === 4) rmSync(path.join(dir, "README.md"));
  });
  try {
    assert.equal(scenario.run().debugId, DEBUG_ID);
  } finally {
    scenario.clean();
  }
});

for (let step = 0; step < 6; step++) {
  for (const failure of ["status", "spawn"]) {
    test(`Worker upload stops and cleans up on command ${step} ${failure} failure`, () => {
      const scenario = uploadScenario((i) => {
        if (i !== step) return;
        if (failure === "spawn") throw new Error(`step ${step} spawn error`);
        return {
          status: 1,
          stdout: `step ${step} progress`,
          stderr: "binding rejected"
        };
      });
      try {
        assert.throws(
          scenario.run,
          failure === "spawn"
            ? new RegExp(`step ${step} spawn error`)
            : /failed with status 1:\n.*progress\nbinding rejected/
        );
        assert.equal(scenario.calls.length, step + 1);
      } finally {
        scenario.clean();
      }
    });
  }
}

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
    "/tmp/secrets",
    "/tmp/wrangler.jsonc"
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

test("worker deploy wrapper requires production config and rejects a retired analytics token", () => {
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

  const withoutAnalytics = buildWranglerVersionsUploadArgs(
    workerDeployEnv(),
    "/tmp/worker-secrets.json",
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
  const withRetiredAnalyticsToken = buildWranglerVersionsUploadArgs(
    workerDeployEnv({
      NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: "analytics-token"
    }),
    "/tmp/worker-secrets.json",
    "/tmp/wrangler.jsonc"
  );
  assert.equal(
    withRetiredAnalyticsToken.includes(
      "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN:analytics-token"
    ),
    false
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
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8"
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /must run through scripts\/production-release\.mjs/
  );
});
