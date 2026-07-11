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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_APP_BASE_URL = "https://app.agent-outbox.dev";
const WRANGLER_CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");

export const HYPERDRIVE_ID_ENV_NAME = "CLOUDFLARE_HYPERDRIVE_ID";

/**
 * @typedef {{ error?: Error, status: number | null }} CommandStatus
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => CommandStatus} SpawnSyncLike
 */

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

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function validateWorkerDeployEnvironment(env) {
  const failures = REQUIRED_PROCESS_ENV_NAMES.flatMap((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== ""
      ? []
      : [`${name} is required for production Worker deploy`];
  });

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
  if (env.GITHUB_ACTIONS !== "true") {
    failures.push("Production Worker deploys must run in GitHub Actions.");
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    failures.push("Production Worker deploys must run from refs/heads/main.");
  }
  if (
    !env.GITHUB_WORKFLOW_REF?.includes(
      "/.github/workflows/deploy-production.yml@"
    )
  ) {
    failures.push(
      "Production Worker deploys must run from deploy-production.yml."
    );
  }
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
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      env.AGENT_OUTBOX_RELEASE_TAG
    )
  ) {
    failures.push("AGENT_OUTBOX_RELEASE_TAG must be a stable v<version> tag.");
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
export function buildWranglerDeployArgs(env, secretsFilePath) {
  return buildWranglerDeployArgsWithConfig(env, secretsFilePath, undefined);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} secretsFilePath
 * @param {string | undefined} wranglerConfigPath
 * @returns {string[]}
 */
export function buildWranglerDeployArgsWithConfig(
  env,
  secretsFilePath,
  wranglerConfigPath
) {
  return [
    "exec",
    "wrangler",
    "deploy",
    ...(wranglerConfigPath ? ["--config", wranglerConfigPath] : []),
    "--env-file",
    "/dev/null",
    "--secrets-file",
    secretsFilePath,
    "--tag",
    env.AGENT_OUTBOX_RELEASE_TAG ?? "",
    "--message",
    `Production release ${env.AGENT_OUTBOX_RELEASE_TAG ?? ""}`,
    ...publicVarBindings(env).flatMap(({ name, value }) => [
      "--var",
      `${name}:${value}`
    ])
  ];
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
    JSON.parse(wranglerConfigText)
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
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   spawnSyncImpl?: SpawnSyncLike,
 *   tempBase?: string
 * }} [options]
 */
export function runWorkerDeploy(options = {}) {
  const env = options.env ?? process.env;
  const failures = validateWorkerDeployEnvironment(env);
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
  const deployCommandOptions =
    /** @type {import("node:child_process").SpawnSyncOptions} */ ({
      cwd: ROOT,
      env: wranglerDeployEnvironment(env),
      stdio: "inherit"
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
    const wranglerDeployArgs = buildWranglerDeployArgsWithConfig(
      env,
      secretsFile.path,
      wranglerConfigFile.path
    );
    runCommand(
      "corepack",
      ["pnpm", ...wranglerDeployArgs, "--dry-run"],
      deployCommandOptions,
      spawnSyncImpl
    );
    runCommand(
      "corepack",
      ["pnpm", ...wranglerDeployArgs],
      deployCommandOptions,
      spawnSyncImpl
    );
  } finally {
    secretsFile.cleanup();
    wranglerConfigFile?.cleanup();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runWorkerDeploy();
}
