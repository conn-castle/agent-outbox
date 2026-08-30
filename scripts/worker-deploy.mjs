import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DATABASE_CONNECTION_MODE_HYPERDRIVE,
  DATABASE_CONNECTION_MODE_VAR,
  DATABASE_HYPERDRIVE_BINDING
} from "../worker/hyperdrive.mjs";
import {
  CANDIDATE_WORKER_VERSION_ID_ENV_NAME,
  FULL_GIT_SHA,
  GITHUB_RELEASE_ID_ENV_NAME,
  PRIOR_WORKER_VERSION_ID_ENV_NAME,
  RELEASE_TAG_PATTERN,
  WORKER_NAME,
  WORKER_VERSION_ID,
  WorkerVersionMatchError,
  findExactWorkerVersion,
  isWorkerVersionId,
  parseWorkerVersionMessage,
  serializeWorkerVersionMessage,
  validateActionsContext
} from "./release/identity.mjs";
import { parseJsonc, readSystemContract } from "./system-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemContract = readSystemContract();
const PRODUCTION_APP_BASE_URL = systemContract.hostedAppBaseUrl;
const WRANGLER_CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");

/**
 * @typedef {{ error?: Error, status: number | null, stdout?: unknown, stderr?: unknown }} CommandStatus
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => CommandStatus} SpawnSyncLike
 */

export const HYPERDRIVE_ID_ENV_NAME = "CLOUDFLARE_HYPERDRIVE_ID";

export const REQUIRED_SECRET_NAMES = [
  "CLERK_SECRET_KEY",
  "SENTRY_DSN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET"
];

export const REQUIRED_PUBLIC_VAR_NAMES = [
  "APP_ENV",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "SENTRY_RELEASE",
  "CLERK_PUBLISHABLE_KEY",
  "SENTRY_BROWSER_DSN",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
];

export const FIXED_PUBLIC_VAR_BINDINGS = [
  {
    name: DATABASE_CONNECTION_MODE_VAR,
    value: DATABASE_CONNECTION_MODE_HYPERDRIVE
  }
];

const OPTIONAL_PUBLIC_VAR_NAMES = [
  "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN"
];
const COMMAND_ENV_PASSTHROUGH_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "RUNNER_TEMP",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_OPTIONS",
  "NEXT_TELEMETRY_DISABLED",
  "COREPACK_HOME",
  "PNPM_HOME"
];

// Threaded into the OpenNext build subprocess only (never the Worker runtime
// --var bindings and never the wrangler deploy subprocess) so the Sentry build
// plugin can create the release and upload source maps when upload is enabled.
// commandEnvironment drops empty/undefined values, so these are absent unless
// set. SENTRY_RELEASE is already a public var binding, so it is not repeated.
const SENTRY_UPLOAD_BUILD_PASSTHROUGH_NAMES = [
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD",
  "AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH"
];

const DERIVED_PUBLIC_VAR_BINDINGS = [
  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    sourceName: "CLERK_PUBLISHABLE_KEY"
  }
];

const REQUIRED_PROCESS_ENV_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  HYPERDRIVE_ID_ENV_NAME,
  "AGENT_OUTBOX_RELEASE_TAG",
  ...REQUIRED_SECRET_NAMES,
  ...REQUIRED_PUBLIC_VAR_NAMES
];

const REQUIRED_UPLOAD_IDENTITY_ENV_NAMES = [
  "GITHUB_RUN_ID",
  GITHUB_RELEASE_ID_ENV_NAME,
  "GITHUB_SHA"
];

/**
 * @param {unknown} output
 * @returns {string}
 */
export function parseUploadedWorkerVersionId(output) {
  const text = String(output ?? "");
  const matches = [
    ...text.matchAll(/Worker Version ID:\s*([0-9a-f-]{36})/gi)
  ].map((match) => match[1].toLowerCase());
  const unique = [...new Set(matches)];
  if (unique.length !== 1 || !WORKER_VERSION_ID.test(unique[0])) {
    throw new Error(
      "wrangler versions upload did not report exactly one Worker version id"
    );
  }
  return unique[0];
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeJson(record[key])])
    );
  }
  return value;
}

/**
 * @param {unknown} wranglerConfig
 * @returns {{ routes: unknown, triggers: unknown }}
 */
export function workerTriggerConfig(wranglerConfig) {
  const config =
    typeof wranglerConfig === "string"
      ? parseJsonc(wranglerConfig)
      : wranglerConfig;
  if (!config || typeof config !== "object") {
    throw new Error("Worker config must be a JSON object");
  }
  const record = /** @type {{ routes?: unknown, triggers?: unknown }} */ (
    config
  );
  return {
    routes: record.routes ?? [],
    triggers: record.triggers ?? {}
  };
}

/**
 * @param {unknown} liveConfig
 * @param {unknown} candidateConfig
 */
export function assertWorkerTriggersUnchanged(liveConfig, candidateConfig) {
  const live = canonicalizeJson(workerTriggerConfig(liveConfig));
  const candidate = canonicalizeJson(workerTriggerConfig(candidateConfig));
  if (JSON.stringify(live) !== JSON.stringify(candidate)) {
    throw new Error(
      "Worker routes or cron triggers changed; treat that as a separate operator-controlled infrastructure operation, not an application release"
    );
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string[]} allowedWorkflows
 * @returns {string[]}
 */
export function validateWorkerDeployEnvironment(
  env,
  allowedWorkflows = ["deploy-production.yml"]
) {
  const failures = [
    ...REQUIRED_PROCESS_ENV_NAMES.flatMap((name) => {
      const value = env[name];
      return typeof value === "string" && value.trim() !== ""
        ? []
        : [`${name} is required for production Worker deploy`];
    }),
    ...productionAppUrlFailures(env),
    ...validateActionsContext(env, {
      allowedWorkflows,
      actionsMessage: "Production Worker deploys must run in GitHub Actions.",
      refMessage: "Production Worker deploys must run from refs/heads/main.",
      workflowMessage: `Production Worker deploys must run from ${allowedWorkflows.join(" or ")}.`
    })
  ];

  if (
    env.GITHUB_SHA &&
    env.SENTRY_RELEASE &&
    env.SENTRY_RELEASE !== env.GITHUB_SHA
  ) {
    failures.push(
      "SENTRY_RELEASE must match GITHUB_SHA for production deploy."
    );
  }
  if (
    env.AGENT_OUTBOX_RELEASE_TAG &&
    !RELEASE_TAG_PATTERN.test(env.AGENT_OUTBOX_RELEASE_TAG)
  ) {
    failures.push("AGENT_OUTBOX_RELEASE_TAG must be a stable v<version> tag.");
  }

  return failures;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string[]}
 */
function productionAppUrlFailures(env) {
  /** @type {string[]} */
  const failures = [];
  if (env.APP_ENV && env.APP_ENV !== "production") {
    failures.push("APP_ENV must be production for production Worker deploy");
  }
  if (env.APP_BASE_URL && env.APP_BASE_URL !== PRODUCTION_APP_BASE_URL) {
    failures.push(
      `APP_BASE_URL must be ${PRODUCTION_APP_BASE_URL} for production Worker deploy`
    );
  }
  if (
    env.PUBLIC_APP_BASE_URL &&
    env.PUBLIC_APP_BASE_URL !== PRODUCTION_APP_BASE_URL
  ) {
    failures.push(
      `PUBLIC_APP_BASE_URL must be ${PRODUCTION_APP_BASE_URL} for production Worker deploy`
    );
  }
  return failures;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string[]} [allowedWorkflows]
 * @returns {string[]}
 */
export function validateWorkerTrafficEnvironment(
  env,
  allowedWorkflows = [
    "deploy-production.yml",
    "reconcile-production-release.yml"
  ]
) {
  const failures = [];
  if (
    typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
    env.CLOUDFLARE_API_TOKEN.trim() === ""
  ) {
    failures.push(
      "CLOUDFLARE_API_TOKEN is required for Worker traffic operations"
    );
  }
  failures.push(
    ...validateActionsContext(env, {
      allowedWorkflows,
      actionsMessage: "Production Worker deploys must run in GitHub Actions.",
      refMessage: "Production Worker deploys must run from refs/heads/main.",
      workflowMessage: `Production Worker deploys must run from ${allowedWorkflows.join(" or ")}.`
    }),
    ...productionAppUrlFailures(env)
  );
  return failures;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateWorkerVersionUploadEnvironment(env) {
  const failures = validateWorkerDeployEnvironment(env);
  for (const name of REQUIRED_UPLOAD_IDENTITY_ENV_NAMES) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") {
      failures.push(`${name} is required for Worker version upload`);
    }
  }
  const releaseId = env[GITHUB_RELEASE_ID_ENV_NAME];
  if (releaseId && !/^[1-9]\d*$/.test(releaseId)) {
    failures.push(
      `${GITHUB_RELEASE_ID_ENV_NAME} must be a positive GitHub release id`
    );
  }
  const runId = env.GITHUB_RUN_ID;
  if (runId && !/^[1-9]\d*$/.test(runId)) {
    failures.push("GITHUB_RUN_ID must be a positive GitHub Actions run id");
  }
  if (env.GITHUB_SHA && !FULL_GIT_SHA.test(env.GITHUB_SHA)) {
    failures.push("GITHUB_SHA must be the 40-character candidate commit.");
  }
  return failures;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ name: string, value: string }[]}
 */
export function publicVarBindings(env) {
  const bindings = [...FIXED_PUBLIC_VAR_BINDINGS];
  for (const { name, sourceName } of [
    ...REQUIRED_PUBLIC_VAR_NAMES.map((name) => ({ name, sourceName: name })),
    ...DERIVED_PUBLIC_VAR_BINDINGS,
    ...OPTIONAL_PUBLIC_VAR_NAMES.map((name) => ({ name, sourceName: name }))
  ]) {
    const value = env[sourceName];
    if (typeof value === "string" && value.trim() !== "") {
      bindings.push({ name, value });
    }
  }

  return bindings;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} secretsFilePath
 * @returns {string[]}
 */
export function buildWranglerVersionsUploadArgs(env, secretsFilePath) {
  return buildWranglerVersionsUploadArgsWithConfig(
    env,
    secretsFilePath,
    undefined
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} secretsFilePath
 * @param {string | undefined} wranglerConfigPath
 * @returns {string[]}
 */
export function buildWranglerVersionsUploadArgsWithConfig(
  env,
  secretsFilePath,
  wranglerConfigPath
) {
  return [
    "exec",
    "wrangler",
    "versions",
    "upload",
    ...(wranglerConfigPath ? ["--config", wranglerConfigPath] : []),
    "--env-file",
    "/dev/null",
    "--secrets-file",
    secretsFilePath,
    "--tag",
    env.AGENT_OUTBOX_RELEASE_TAG ?? "",
    "--message",
    serializeWorkerVersionMessage({
      runId: env.GITHUB_RUN_ID ?? "",
      releaseId: env[GITHUB_RELEASE_ID_ENV_NAME] ?? "",
      sha: env.GITHUB_SHA ?? ""
    }),
    ...publicVarBindings(env).flatMap(({ name, value }) => [
      "--var",
      `${name}:${value}`
    ])
  ];
}

/**
 * @param {{ versionId: string, percentage: number }[]} placements
 * @param {string} [message]
 * @returns {string[]}
 */
export function buildWranglerVersionsDeployArgs(placements, message) {
  if (!Array.isArray(placements) || placements.length === 0) {
    throw new Error("Worker version deploy requires at least one placement");
  }
  const specs = placements.map((placement) => {
    if (!isWorkerVersionId(placement.versionId)) {
      throw new Error("Worker version deploy requires a valid version id");
    }
    if (
      !Number.isInteger(placement.percentage) ||
      placement.percentage < 0 ||
      placement.percentage > 100
    ) {
      throw new Error(
        "Worker version deploy percentages must be 0-100 integers"
      );
    }
    return `${placement.versionId}@${placement.percentage}%`;
  });
  const total = placements.reduce(
    (sum, placement) => sum + placement.percentage,
    0
  );
  if (total !== 100) {
    throw new Error("Worker version deploy percentages must sum to 100");
  }
  return [
    "exec",
    "wrangler",
    "versions",
    "deploy",
    ...specs,
    "--name",
    WORKER_NAME,
    "--yes",
    "--env-file",
    "/dev/null",
    ...(message ? ["--message", message] : [])
  ];
}

/**
 * @param {string} priorVersionId
 * @param {string} candidateVersionId
 */
export function buildStagedVersionDeployArgs(
  priorVersionId,
  candidateVersionId
) {
  return buildWranglerVersionsDeployArgs(
    [
      { versionId: priorVersionId, percentage: 100 },
      { versionId: candidateVersionId, percentage: 0 }
    ],
    `Stage candidate ${candidateVersionId} at 0%`
  );
}

/** @param {string} candidateVersionId */
export function buildPromoteCandidateArgs(candidateVersionId) {
  return buildWranglerVersionsDeployArgs(
    [{ versionId: candidateVersionId, percentage: 100 }],
    `Promote candidate ${candidateVersionId} to 100%`
  );
}

/** @param {string} priorVersionId */
export function buildRestorePriorArgs(priorVersionId) {
  return buildWranglerVersionsDeployArgs(
    [{ versionId: priorVersionId, percentage: 100 }],
    `Restore prior ${priorVersionId} to 100%`
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {Record<string, string | undefined>} values
 * @returns {NodeJS.ProcessEnv}
 */
function commandEnvironment(env, values = {}) {
  /** @type {Record<string, string>} */
  const commandEnv = {};
  for (const name of COMMAND_ENV_PASSTHROUGH_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value !== "") {
      commandEnv[name] = value;
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && value !== "") {
      commandEnv[name] = value;
    }
  }
  return /** @type {NodeJS.ProcessEnv} */ (commandEnv);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {NodeJS.ProcessEnv}
 */
export function workerBuildEnvironment(env) {
  return commandEnvironment(env, {
    ...Object.fromEntries(
      publicVarBindings(env).map(({ name, value }) => [name, value])
    ),
    ...Object.fromEntries(
      SENTRY_UPLOAD_BUILD_PASSTHROUGH_NAMES.map((name) => [name, env[name]])
    )
  });
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {NodeJS.ProcessEnv}
 */
export function wranglerDeployEnvironment(env) {
  return commandEnvironment(env, {
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN
  });
}

/**
 * @param {string} wranglerConfigText
 * @param {string} hyperdriveId
 * @returns {string}
 */
export function wranglerConfigWithHyperdrive(wranglerConfigText, hyperdriveId) {
  if (hyperdriveId.trim() === "") {
    throw new Error(`${HYPERDRIVE_ID_ENV_NAME} is required`);
  }

  const config = /** @type {{ hyperdrive?: unknown }} */ (
    parseJsonc(wranglerConfigText)
  );
  if (
    "main" in config &&
    typeof config.main === "string" &&
    !path.isAbsolute(config.main)
  ) {
    config.main = path.join(ROOT, config.main);
  }
  if (
    "assets" in config &&
    config.assets &&
    typeof config.assets === "object" &&
    "directory" in config.assets &&
    typeof config.assets.directory === "string" &&
    !path.isAbsolute(config.assets.directory)
  ) {
    config.assets.directory = path.join(ROOT, config.assets.directory);
  }
  const existingBindings = Array.isArray(config.hyperdrive)
    ? config.hyperdrive.filter(
        /** @param {unknown} binding */
        (binding) =>
          !binding ||
          typeof binding !== "object" ||
          /** @type {{ binding?: unknown }} */ (binding).binding !==
            DATABASE_HYPERDRIVE_BINDING
      )
    : [];

  config.hyperdrive = [
    ...existingBindings,
    {
      binding: DATABASE_HYPERDRIVE_BINDING,
      id: hyperdriveId
    }
  ];

  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function dotenvValue(value) {
  if (/[\r\n]/.test(value)) {
    throw new Error("Worker deploy secret values must be single-line strings");
  }
  if (/[\s"'\\]/.test(value)) {
    throw new Error(
      "Worker deploy secret values must not contain whitespace, quotes, or backslashes"
    );
  }
  return value;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string}
 */
export function secretsDotenvContent(env) {
  return `${REQUIRED_SECRET_NAMES.map((name) => {
    const value = env[name];
    if (typeof value !== "string") {
      throw new Error(`${name} is required for production Worker deploy`);
    }
    return `${name}=${dotenvValue(value)}`;
  }).join("\n")}\n`;
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isOutsideRepo(candidate) {
  const relativePath = path.relative(ROOT, path.resolve(candidate));
  return relativePath.startsWith("..") || path.isAbsolute(relativePath);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string | undefined} tempBase
 * @returns {string}
 */
function selectTempBase(env, tempBase) {
  const candidates = [];
  if (typeof tempBase === "string" && tempBase !== "") {
    candidates.push(tempBase);
  }
  if (typeof env.RUNNER_TEMP === "string" && env.RUNNER_TEMP !== "") {
    candidates.push(env.RUNNER_TEMP);
  }
  candidates.push(os.tmpdir());

  for (const candidate of candidates) {
    if (!isOutsideRepo(candidate)) {
      continue;
    }
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats?.isDirectory()) {
      return path.resolve(candidate);
    }
  }

  throw new Error(
    "Worker deploy needs an existing temp directory outside the repo"
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{ tempBase?: string }} [options]
 * @returns {{ path: string, cleanup: () => void }}
 */
export function writeSecretsFile(env, options = {}) {
  const directory = mkdtempSync(
    path.join(selectTempBase(env, options.tempBase), "agent-outbox-worker-")
  );
  const secretsFilePath = path.join(directory, "worker-secrets.env");

  try {
    writeFileSync(secretsFilePath, secretsDotenvContent(env), {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    path: secretsFilePath,
    cleanup: () => {
      rmSync(directory, { force: true, recursive: true });
    }
  };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{ tempBase?: string }} [options]
 * @returns {{ path: string, cleanup: () => void }}
 */
export function writeWranglerConfigFile(env, options = {}) {
  const hyperdriveId = env[HYPERDRIVE_ID_ENV_NAME];
  if (typeof hyperdriveId !== "string") {
    throw new Error(`${HYPERDRIVE_ID_ENV_NAME} is required`);
  }

  const directory = mkdtempSync(
    path.join(selectTempBase(env, options.tempBase), "agent-outbox-wrangler-")
  );
  const configFilePath = path.join(directory, "wrangler.jsonc");

  try {
    writeFileSync(
      configFilePath,
      wranglerConfigWithHyperdrive(
        readFileSync(WRANGLER_CONFIG_PATH, "utf8"),
        hyperdriveId
      ),
      {
        encoding: "utf8",
        mode: 0o600
      }
    );
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    path: configFilePath,
    cleanup: () => {
      rmSync(directory, { force: true, recursive: true });
    }
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} options
 * @param {SpawnSyncLike} spawnSyncImpl
 * @returns {CommandStatus}
 */
function runCommand(command, args, options, spawnSyncImpl) {
  const result = spawnSyncImpl(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`
    );
  }
  return result;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   spawnSyncImpl?: SpawnSyncLike,
 *   tempBase?: string
 * }} [options]
 * @returns {{ versionId: string }}
 */
export function runWorkerVersionUpload(options = {}) {
  const env = options.env ?? process.env;
  const failures = validateWorkerVersionUploadEnvironment(env);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  const spawnSyncImpl =
    options.spawnSyncImpl ?? /** @type {SpawnSyncLike} */ (spawnSync);
  const buildCommandOptions =
    /** @type {import("node:child_process").SpawnSyncOptions} */ ({
      cwd: ROOT,
      env: workerBuildEnvironment(env),
      stdio: "inherit"
    });
  const uploadCommandOptions =
    /** @type {import("node:child_process").SpawnSyncOptions} */ ({
      cwd: ROOT,
      env: wranglerDeployEnvironment(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

  runCommand(
    "corepack",
    ["pnpm", "run", "worker:build"],
    buildCommandOptions,
    spawnSyncImpl
  );

  const secretsFile = writeSecretsFile(env, { tempBase: options.tempBase });
  /** @type {{ path: string, cleanup: () => void } | null} */
  let wranglerConfigFile = null;
  try {
    wranglerConfigFile = writeWranglerConfigFile(env, {
      tempBase: options.tempBase
    });
    const wranglerUploadArgs = buildWranglerVersionsUploadArgsWithConfig(
      env,
      secretsFile.path,
      wranglerConfigFile.path
    );
    runCommand(
      "corepack",
      ["pnpm", ...wranglerUploadArgs, "--dry-run"],
      uploadCommandOptions,
      spawnSyncImpl
    );
    const uploaded = runCommand(
      "corepack",
      ["pnpm", ...wranglerUploadArgs],
      uploadCommandOptions,
      spawnSyncImpl
    );
    const combinedOutput = `${uploaded.stdout ?? ""}\n${uploaded.stderr ?? ""}`;
    if (combinedOutput.trim() !== "") {
      process.stdout.write(
        combinedOutput.endsWith("\n") ? combinedOutput : `${combinedOutput}\n`
      );
    }
    return { versionId: parseUploadedWorkerVersionId(combinedOutput) };
  } finally {
    secretsFile.cleanup();
    wranglerConfigFile?.cleanup();
  }
}

/**
 * @param {string[]} args
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   spawnSyncImpl?: SpawnSyncLike,
 *   allowedWorkflows?: string[]
 * }} [options]
 */
export function runWranglerVersionsDeploy(args, options = {}) {
  const env = options.env ?? process.env;
  const failures = validateWorkerTrafficEnvironment(
    env,
    options.allowedWorkflows ?? [
      "deploy-production.yml",
      "reconcile-production-release.yml"
    ]
  );
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  const spawnSyncImpl =
    options.spawnSyncImpl ?? /** @type {SpawnSyncLike} */ (spawnSync);
  runCommand(
    "corepack",
    ["pnpm", ...args],
    {
      cwd: ROOT,
      env: wranglerDeployEnvironment(env),
      stdio: "inherit"
    },
    spawnSyncImpl
  );
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   spawnSyncImpl?: SpawnSyncLike
 * }} [options]
 */
export function runStagedVersionDeploy(options = {}) {
  const env = options.env ?? process.env;
  const priorVersionId = env[PRIOR_WORKER_VERSION_ID_ENV_NAME] ?? "";
  const candidateVersionId = env[CANDIDATE_WORKER_VERSION_ID_ENV_NAME] ?? "";
  if (
    !isWorkerVersionId(priorVersionId) ||
    !isWorkerVersionId(candidateVersionId)
  ) {
    throw new Error(
      "staged Worker deploy requires prior and candidate version ids"
    );
  }
  if (priorVersionId === candidateVersionId) {
    throw new Error(
      "staged Worker deploy requires distinct prior and candidate versions"
    );
  }
  runWranglerVersionsDeploy(
    buildStagedVersionDeployArgs(priorVersionId, candidateVersionId),
    { ...options, allowedWorkflows: ["deploy-production.yml"] }
  );
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   spawnSyncImpl?: SpawnSyncLike
 * }} [options]
 */
export function runPromoteCandidate(options = {}) {
  const env = options.env ?? process.env;
  const candidateVersionId = env[CANDIDATE_WORKER_VERSION_ID_ENV_NAME] ?? "";
  if (!isWorkerVersionId(candidateVersionId)) {
    throw new Error("candidate promotion requires a Worker version id");
  }
  runWranglerVersionsDeploy(buildPromoteCandidateArgs(candidateVersionId), {
    ...options,
    allowedWorkflows: ["deploy-production.yml"]
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  throw new Error(
    "Worker mutation commands must run through scripts/production-release.mjs so ownership markers and compensation stay attached. There is no standalone worker-deploy CLI."
  );
}
