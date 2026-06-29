import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{
 *   package?: string | null,
 *   version: string
 * }} ToolPin
 *
 * @typedef {ToolPin & { authCheck: string[] }} ProviderCliPin
 *
 * @typedef {{
 *   node: { version: string, npm: string },
 *   go: { version: string },
 *   packageManager: { name: string, version: string },
 *   phase1Tools: Record<string, ToolPin>,
 *   providerCli: Record<string, ProviderCliPin>
 * }} Toolchain
 *
 * @typedef {{
 *   packageManager?: string,
 *   devEngines?: {
 *     runtime?: { name?: string, version?: string, onFail?: string },
 *     packageManager?: { name?: string, version?: string, onFail?: string }
 *   },
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>
 * }} PackageJson
 *
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   error?: Error & { code?: string },
 *   stdout?: unknown,
 *   stderr?: unknown
 * }} CommandResult
 *
 * @typedef {{ ok: boolean, message: string }} CheckResult
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_FILES = [
  "Makefile",
  "toolchain.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".prettierrc.json",
  ".prettierignore",
  ".markdownlint-cli2.yaml",
  "tsconfig.json",
  "scripts/foundation.mjs",
  "tests/foundation.test.mjs",
  ".env.example",
  "docs/agent-layer/COMMANDS.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release-check.yml"
];

const FORBIDDEN_WORKFLOW_TOKENS = [
  "wrangler deploy",
  "npm publish",
  "pnpm publish",
  "gh release create",
  "stripe trigger",
  "stripe fixtures",
  "supabase db push"
];

const REQUIRED_ENV_NAMES = [
  "APP_ENV",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "SUPABASE_PROJECT_REF",
  "DATABASE_URL",
  "DATABASE_APP_ROLE_URL",
  "DATABASE_MIGRATION_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "SENTRY_DSN",
  "SENTRY_BROWSER_DSN",
  "SENTRY_AUTH_TOKEN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN"
];

const OPTIONAL_LOCAL_ENV_NAMES = [
  "AWS_PROFILE",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_ZONE_NAME",
  "CLOUDFLARE_NAMESERVERS",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_TOKEN_ID"
];

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * @param {string} relativePath
 * @returns {unknown}
 */
function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

/**
 * @param {string} content
 * @returns {Map<string, string>}
 */
export function parseEnv(content) {
  const values = new Map();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
  }

  return values;
}

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function requiredEnvNames(exampleContent) {
  const exampleNames = new Set(parseEnv(exampleContent).keys());
  return REQUIRED_ENV_NAMES.filter((name) => exampleNames.has(name));
}

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function validateRequiredEnvExample(exampleContent) {
  const actualNames = [...parseEnv(exampleContent).keys()];
  const expectedNames = new Set(REQUIRED_ENV_NAMES);
  const allowedNames = new Set([
    ...REQUIRED_ENV_NAMES,
    ...OPTIONAL_LOCAL_ENV_NAMES
  ]);
  const actualNameSet = new Set(actualNames);

  const missing = REQUIRED_ENV_NAMES.filter((name) => !actualNameSet.has(name));
  const extra = actualNames.filter((name) => !allowedNames.has(name));

  return [
    ...missing.map((name) => `.env.example missing required name ${name}`),
    ...extra.map((name) => `.env.example contains unknown name ${name}`)
  ];
}

/**
 * @param {string} exampleContent
 * @param {string} actualContent
 * @returns {string[]}
 */
export function missingEnvNames(exampleContent, actualContent) {
  const actual = parseEnv(actualContent);
  return requiredEnvNames(exampleContent).filter((name) => !actual.get(name));
}

/**
 * @param {string} projectsJson
 * @param {string} expectedProjectRef
 * @returns {boolean}
 */
export function supabaseProjectsIncludeRef(projectsJson, expectedProjectRef) {
  const parsed = JSON.parse(projectsJson);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) {
    return false;
  }

  return projects.some((project) => {
    if (!project || typeof project !== "object") {
      return false;
    }

    const values = Object.values(project);
    return values.some((value) => value === expectedProjectRef);
  });
}

/**
 * @param {CommandResult} result
 * @returns {{ status: number | null, signal: NodeJS.Signals | null, error: string | null }}
 */
export function redactCommandResult(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? result.error?.message ?? null
  };
}

/**
 * @param {Toolchain} toolchain
 * @param {PackageJson} packageJson
 * @returns {string[]}
 */
export function validateToolchainPackage(toolchain, packageJson) {
  const errors = [];

  if (
    packageJson.packageManager !== `pnpm@${toolchain.packageManager.version}`
  ) {
    errors.push("package.json packageManager does not match toolchain.json");
  }

  if (packageJson.devEngines?.runtime?.name !== "node") {
    errors.push("package.json devEngines.runtime must pin node");
  }

  if (packageJson.devEngines?.runtime?.version !== toolchain.node.version) {
    errors.push(
      "package.json devEngines.runtime does not match toolchain.json"
    );
  }

  if (packageJson.devEngines?.runtime?.onFail !== "download") {
    errors.push(
      "package.json devEngines.runtime must download the pinned runtime"
    );
  }

  if (
    packageJson.devEngines?.packageManager?.name !==
    toolchain.packageManager.name
  ) {
    errors.push("package.json devEngines.packageManager must pin pnpm");
  }

  if (
    packageJson.devEngines?.packageManager?.version !==
    toolchain.packageManager.version
  ) {
    errors.push(
      "package.json devEngines.packageManager does not match toolchain.json"
    );
  }

  const expectedDevDependencies = new Map();
  for (const section of /** @type {const} */ (["phase1Tools", "providerCli"])) {
    for (const tool of Object.values(toolchain[section])) {
      if (tool.package) {
        expectedDevDependencies.set(tool.package, tool.version);
      }
    }
  }

  for (const [dependency, version] of expectedDevDependencies) {
    if (packageJson.devDependencies?.[dependency] !== version) {
      errors.push(`devDependency ${dependency} must be pinned to ${version}`);
    }
  }

  const nodeTypesVersion = packageJson.devDependencies?.["@types/node"];
  if (nodeTypesVersion) {
    const runtimeMajor = toolchain.node.version.split(".")[0];
    const typesMajor = nodeTypesVersion.split(".")[0];
    if (typesMajor !== runtimeMajor) {
      errors.push(
        `@types/node major ${typesMajor} must match Node major ${runtimeMajor}`
      );
    }
  }

  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    errors.push(`runtime dependency ${dependency} is out of Phase 1 scope`);
  }

  return errors;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function assertNoForbiddenWorkflowCommands(workflowContentsByPath) {
  const failures = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    for (const token of FORBIDDEN_WORKFLOW_TOKENS) {
      if (content.includes(token)) {
        failures.push(`${workflowPath} contains forbidden command: ${token}`);
      }
    }
  }

  return failures;
}

/**
 * @param {Toolchain} toolchain
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowVersionPins(toolchain, workflowContentsByPath) {
  const errors = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    const nodeVersions = [
      ...content.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)
    ].map((match) => match[1]);
    for (const version of nodeVersions) {
      if (version !== toolchain.node.version) {
        errors.push(
          `${workflowPath} node-version ${version} must match toolchain.json ${toolchain.node.version}`
        );
      }
    }
  }

  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} commandsContent
 * @returns {string[]}
 */
export function validateCommandsVersionPins(toolchain, commandsContent) {
  const errors = [];
  const pinnedNodeVersions = [
    ...commandsContent.matchAll(/(?:CI provisions|pinned) Node `([^`]+)`/g)
  ].map((match) => match[1]);
  const pnpmVersions = [...commandsContent.matchAll(/pnpm `([^`]+)`/g)].map(
    (match) => match[1]
  );

  if (pinnedNodeVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned Node version");
  }
  for (const version of pinnedNodeVersions) {
    if (version !== toolchain.node.version) {
      errors.push(
        `COMMANDS.md pinned Node ${version} must match toolchain.json ${toolchain.node.version}`
      );
    }
  }

  if (pnpmVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned pnpm version");
  }
  for (const version of pnpmVersions) {
    if (version !== toolchain.packageManager.version) {
      errors.push(
        `COMMANDS.md pnpm ${version} must match toolchain.json ${toolchain.packageManager.version}`
      );
    }
  }

  return errors;
}

/**
 * @returns {Record<string, string>}
 */
function readWorkflowContents() {
  /** @type {Record<string, string>} */
  const workflows = {};
  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release-check.yml"
  ]) {
    workflows[relativePath] = readFileSync(
      path.join(ROOT, relativePath),
      "utf8"
    );
  }
  return workflows;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function runQuiet(command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : null;
  }

  return null;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} expected
 * @param {(output: string) => string} parser
 * @returns {CheckResult}
 */
function versionResult(command, args, expected, parser) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} version check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  const output = `${result.stdout}${result.stderr}`.trim();
  const actual = parser(output);
  if (actual !== expected) {
    return {
      ok: false,
      message: `${command} version ${actual || "unknown"} does not match ${expected}`
    };
  }

  return { ok: true, message: `${command} ${expected}` };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {CheckResult}
 */
function providerAuthResult(command, args) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} auth check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  return { ok: true, message: `${command} auth check passed` };
}

/**
 * @param {Map<string, string> | null} envValues
 * @returns {CheckResult}
 */
function supabaseProjectResult(envValues) {
  const projectRef = envValues?.get("SUPABASE_PROJECT_REF");
  if (!projectRef) {
    return {
      ok: false,
      message:
        "SUPABASE_PROJECT_REF is missing; create the dedicated Agent Outbox Supabase project and set it in .env"
    };
  }

  const result = runQuiet("supabase", ["projects", "list", "--output", "json"]);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: "supabase is not installed" };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `supabase project check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  try {
    if (supabaseProjectsIncludeRef(result.stdout, projectRef)) {
      return {
        ok: true,
        message: "supabase authenticated account can see SUPABASE_PROJECT_REF"
      };
    }
  } catch {
    return {
      ok: false,
      message: "supabase project check returned unreadable JSON"
    };
  }

  return {
    ok: false,
    message:
      "supabase authenticated account cannot see SUPABASE_PROJECT_REF; use the dedicated Agent Outbox Supabase account"
  };
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
  const makefile = readFileSync(path.join(ROOT, "Makefile"), "utf8");
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
    "build",
    "smoke",
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
}

function checkLockfileState() {
  const result = runQuiet("corepack", [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--lockfile-only",
    "--ignore-scripts",
    "--no-runtime",
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
  const packageErrors = validateToolchainPackage(toolchain, packageJson);
  assert.deepEqual(packageErrors, [], packageErrors.join("\n"));
  const workflowErrors = validateWorkflowVersionPins(
    toolchain,
    readWorkflowContents()
  );
  assert.deepEqual(workflowErrors, [], workflowErrors.join("\n"));
  const commandsErrors = validateCommandsVersionPins(
    toolchain,
    readFileSync(path.join(ROOT, "docs/agent-layer/COMMANDS.md"), "utf8")
  );
  assert.deepEqual(commandsErrors, [], commandsErrors.join("\n"));

  console.log("Build consistency checks passed.");
}

function smoke() {
  checkRequiredFiles();

  const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const envExampleErrors = validateRequiredEnvExample(envExample);
  assert.deepEqual(envExampleErrors, [], envExampleErrors.join("\n"));
  const requiredNames = requiredEnvNames(envExample);
  assert.ok(requiredNames.includes("DATABASE_URL"));
  assert.ok(requiredNames.includes("CALLER_KEY_HASH_SECRET"));

  const workflowFailures = assertNoForbiddenWorkflowCommands(
    readWorkflowContents()
  );
  assert.deepEqual(workflowFailures, [], workflowFailures.join("\n"));

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
      (output) => output.split(/\s+/)[0]
    )
  );
  checks.push(
    versionResult(
      "npm",
      ["--version"],
      toolchain.node.npm,
      (output) => output.split(/\s+/)[0]
    )
  );
  checks.push(
    versionResult(
      "go",
      ["version"],
      `go${toolchain.go.version}`,
      (output) => output.match(/go\d+\.\d+\.\d+/)?.[0] ?? ""
    )
  );
  checks.push(
    versionResult(
      "pnpm",
      ["--version"],
      toolchain.packageManager.version,
      (output) => output.split(/\s+/)[0]
    )
  );

  for (const [name, cli] of Object.entries(toolchain.providerCli)) {
    if (name === "stripe") {
      checks.push(
        versionResult(
          "stripe",
          ["version"],
          cli.version,
          (output) => output.match(/\d+\.\d+\.\d+/)?.[0] ?? ""
        )
      );
    } else {
      checks.push(
        versionResult(
          cli.authCheck[0],
          ["--version"],
          cli.version,
          (output) => output.match(/\d+\.\d+\.\d+/)?.[0] ?? ""
        )
      );
    }
  }

  const examplePath = path.join(ROOT, ".env.example");
  const envPath = path.join(ROOT, ".env");
  /** @type {Map<string, string> | null} */
  let envValues = null;
  if (!existsSync(envPath)) {
    checks.push({
      ok: false,
      message: ".env is missing; copy .env.example to .env"
    });
  } else {
    const actualEnv = readFileSync(envPath, "utf8");
    envValues = parseEnv(actualEnv);
    const missing = missingEnvNames(
      readFileSync(examplePath, "utf8"),
      actualEnv
    );
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
  const generated = ["coverage", "dist", "build", ".next", ".turbo"];
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
