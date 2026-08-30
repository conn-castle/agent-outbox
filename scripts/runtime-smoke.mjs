import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseEnv } from "./dotenv.mjs";
import { WORKER_NAME, WORKER_VERSION_ID } from "./release/identity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_ENV_MODE_NAME = "AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV";
const EXPECTED_RELEASE_ENV_NAME = "AGENT_OUTBOX_EXPECTED_RELEASE";
export const WORKER_VERSION_OVERRIDE_ENV_NAME =
  "AGENT_OUTBOX_WORKER_VERSION_OVERRIDE";
export const WORKER_VERSION_OVERRIDE_HEADER =
  "Cloudflare-Workers-Version-Overrides";
const REQUIRE_HUMAN_REVIEW_QUERY_ENV_NAME =
  "AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY";
const REQUIRED_RUNTIME_SMOKE_CLIENT_ENV_NAMES = [
  "APP_BASE_URL",
  "SMOKE_OR_CLEANUP_TOKEN"
];
const PROCESS_ENV_NAMES = [
  ...REQUIRED_RUNTIME_SMOKE_CLIENT_ENV_NAMES,
  REQUIRE_HUMAN_REVIEW_QUERY_ENV_NAME,
  WORKER_VERSION_OVERRIDE_ENV_NAME
];
const RUNTIME_SMOKE_HEADERS = {
  "x-agent-outbox-runtime-smoke": "1"
};
/**
 * @typedef {(
 *   url: string | URL,
 *   init?: RequestInit
 * ) => Promise<{
 *   ok: boolean,
 *   status: number,
 *   json: () => Promise<any>
 * }>} RuntimeSmokeFetch
 */

const REQUEST_TIMEOUT_MS = 10_000;
const DEPLOY_SMOKE_ATTEMPTS = 6;
const DEPLOY_SMOKE_RETRY_DELAY_MS = 10_000;

/**
 * @param {unknown} versionId
 * @returns {string}
 */
export function formatWorkerVersionOverrideHeader(versionId) {
  if (typeof versionId !== "string" || !WORKER_VERSION_ID.test(versionId)) {
    throw new Error(
      `${WORKER_VERSION_OVERRIDE_ENV_NAME} must be a Worker version UUID`
    );
  }
  return `${WORKER_NAME}="${versionId}"`;
}

/**
 * @param {Map<string, string> | NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function runtimeSmokeRequestHeaders(env, extra = {}) {
  /** @param {string} name */
  const read = (name) =>
    env instanceof Map
      ? env.get(name)
      : /** @type {Record<string, string | undefined>} */ (env)[name];
  const headers = { ...extra };
  const override = read(WORKER_VERSION_OVERRIDE_ENV_NAME);
  if (typeof override === "string" && override !== "") {
    headers[WORKER_VERSION_OVERRIDE_HEADER] =
      formatWorkerVersionOverrideHeader(override);
  }
  return headers;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   root?: string
 * }} [options]
 * @returns {Map<string, string>}
 */
export function readRuntimeSmokeEnv(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? ROOT;
  if (env[PROCESS_ENV_MODE_NAME] === "1") {
    const expectedRelease = env[EXPECTED_RELEASE_ENV_NAME];
    if (typeof expectedRelease !== "string" || expectedRelease.trim() === "") {
      throw new Error(
        `${EXPECTED_RELEASE_ENV_NAME} is required in process-env mode`
      );
    }
    const values = new Map();
    for (const name of [...PROCESS_ENV_NAMES, EXPECTED_RELEASE_ENV_NAME]) {
      const value = env[name];
      if (typeof value === "string" && value !== "") {
        values.set(name, value);
      }
    }
    return values;
  }
  const explicitPath = env.AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE;
  const envPath =
    explicitPath && explicitPath.trim() !== ""
      ? path.resolve(explicitPath)
      : path.join(root, ".env");
  if (!existsSync(envPath)) {
    if (explicitPath) {
      throw new Error(`Runtime smoke env file does not exist: ${envPath}`);
    }
    return new Map();
  }

  const values = parseEnv(readFileSync(envPath, "utf8"));
  const processOverride = env[WORKER_VERSION_OVERRIDE_ENV_NAME];
  if (typeof processOverride === "string" && processOverride !== "") {
    values.set(WORKER_VERSION_OVERRIDE_ENV_NAME, processOverride);
  }
  const processExpected = env[EXPECTED_RELEASE_ENV_NAME];
  if (typeof processExpected === "string" && processExpected !== "") {
    values.set(EXPECTED_RELEASE_ENV_NAME, processExpected);
  }
  return values;
}

/**
 * @param {RuntimeSmokeFetch} fetchImpl
 * @param {Map<string, string>} env
 * @param {URL} url
 * @param {RequestInit} [init]
 */
async function expectCanaryOk(fetchImpl, env, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: runtimeSmokeRequestHeaders(
      env,
      /** @type {Record<string, string>} */ (init.headers ?? {})
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  const body = await response.json();
  assert.equal(body.ok, true, `${url} returned ok=${String(body.ok)}`);
  return body;
}

/**
 * @param {RuntimeSmokeFetch} fetchImpl
 * @param {Map<string, string>} env
 * @param {URL} url
 * @param {number} expectedStatus
 * @param {RequestInit} [init]
 */
async function expectJsonStatus(
  fetchImpl,
  env,
  url,
  expectedStatus,
  init = {}
) {
  const response = await fetchImpl(url, {
    ...init,
    headers: runtimeSmokeRequestHeaders(
      env,
      /** @type {Record<string, string>} */ (init.headers ?? {})
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(
    response.status,
    expectedStatus,
    `${url} returned ${response.status}`
  );
  return response.json();
}

/**
 * @param {RuntimeSmokeFetch} fetchImpl
 * @param {Map<string, string>} env
 * @param {URL} url
 * @param {number} expectedStatus
 * @param {string} expectedCode
 * @param {RequestInit} [init]
 */
async function expectErrorCode(
  fetchImpl,
  env,
  url,
  expectedStatus,
  expectedCode,
  init = {}
) {
  const body = await expectJsonStatus(
    fetchImpl,
    env,
    url,
    expectedStatus,
    init
  );
  assert.equal(body.ok, false, `${url} returned ok=${String(body.ok)}`);
  assert.equal(body.code, expectedCode, `${url} returned code=${body.code}`);
  return body;
}

/**
 * @param {RuntimeSmokeFetch} fetchImpl
 * @param {Map<string, string>} env
 * @param {URL} url
 */
async function expectReachablePage(fetchImpl, env, url) {
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: runtimeSmokeRequestHeaders(env),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.ok(
    response.status >= 200 && response.status < 400,
    `${url} returned ${response.status}`
  );
}

/**
 * @param {Record<string, any>} runtimeCanary
 * @param {string | undefined} expectedRelease
 */
export function assertRuntimeCanaryEnvironment(runtimeCanary, expectedRelease) {
  assert.equal(
    runtimeCanary.environment?.configured,
    true,
    "/api/runtime/canary did not report configured runtime environment"
  );
  if (expectedRelease) {
    assert.equal(
      runtimeCanary.environment?.release,
      expectedRelease,
      "/api/runtime/canary did not report the expected deployed release"
    );
  }
}

/**
 * @param {Record<string, any>} databaseCanary
 * @param {{ requireHumanReviewQuery?: boolean }} [options]
 */
export function assertRuntimeDatabaseCanary(databaseCanary, options = {}) {
  assert.equal(
    databaseCanary.transaction_context_matched,
    true,
    "/api/runtime/database did not prove transaction context"
  );
  assert.equal(
    databaseCanary.restricted_role_matched,
    true,
    "/api/runtime/database did not prove the restricted app role"
  );
  if (
    options.requireHumanReviewQuery === true ||
    databaseCanary.human_review_query_matched !== undefined
  ) {
    assert.equal(
      databaseCanary.human_review_query_matched,
      true,
      "/api/runtime/database did not prove the human review query"
    );
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function runtimeSmokeAttemptCount(env) {
  return env[PROCESS_ENV_MODE_NAME] === "1" ? DEPLOY_SMOKE_ATTEMPTS : 1;
}

/** @param {Map<string, string>} env */
export function missingRuntimeSmokeEnvNames(env) {
  return REQUIRED_RUNTIME_SMOKE_CLIENT_ENV_NAMES.filter(
    (name) => !env.get(name)
  );
}

/**
 * @param {Map<string, string>} env
 * @param {{ fetchImpl?: RuntimeSmokeFetch }} [options]
 */
export async function runRuntimeSmokeChecks(env, options = {}) {
  const fetchImpl =
    options.fetchImpl ?? /** @type {RuntimeSmokeFetch} */ (fetch);
  const missing = missingRuntimeSmokeEnvNames(env);

  if (missing.length > 0) {
    console.error(
      `Runtime smoke blocked by missing required values: ${missing.join(", ")}`
    );
    process.exitCode = 1;
    return { ok: false, missing };
  }

  const baseUrl = env.get("APP_BASE_URL");
  const token = env.get("SMOKE_OR_CLEANUP_TOKEN");
  const expectedRelease = env.get(EXPECTED_RELEASE_ENV_NAME);
  const override = env.get(WORKER_VERSION_OVERRIDE_ENV_NAME);
  if (override) {
    formatWorkerVersionOverrideHeader(override);
    if (!expectedRelease) {
      throw new Error(
        `${EXPECTED_RELEASE_ENV_NAME} is required when ${WORKER_VERSION_OVERRIDE_ENV_NAME} is set`
      );
    }
  }
  const smokeAuth = { Authorization: `Bearer ${token}` };

  /**
   * @param {string} label
   */
  async function proveCandidateRelease(label) {
    const runtimeCanary = await expectCanaryOk(
      fetchImpl,
      env,
      new URL("/api/runtime/canary", baseUrl),
      { headers: smokeAuth }
    );
    assertRuntimeCanaryEnvironment(runtimeCanary, expectedRelease);
    if (!runtimeCanary.environment?.release) {
      throw new Error(
        `runtime canary ${label} did not prove a deployed release SHA`
      );
    }
    return runtimeCanary;
  }

  if (override) {
    await proveCandidateRelease("before probes");
  }

  await expectReachablePage(fetchImpl, env, new URL("/sign-in", baseUrl));
  await expectReachablePage(fetchImpl, env, new URL("/sign-out", baseUrl));
  await expectReachablePage(fetchImpl, env, new URL("/human", baseUrl));
  const runtimeCanary = override
    ? await proveCandidateRelease("during probes")
    : await expectCanaryOk(
        fetchImpl,
        env,
        new URL("/api/runtime/canary", baseUrl),
        { headers: smokeAuth }
      );
  if (!override) {
    assertRuntimeCanaryEnvironment(runtimeCanary, expectedRelease);
  }
  const runtimeAppEnv = runtimeCanary.environment?.appEnv;
  await expectErrorCode(
    fetchImpl,
    env,
    new URL("/api/runtime/caller-auth", baseUrl),
    401,
    "missing_authorization"
  );
  await expectErrorCode(
    fetchImpl,
    env,
    new URL("/api/runtime/caller-auth", baseUrl),
    403,
    "invalid_bearer_token",
    { headers: { Authorization: "Bearer wrong-token" } }
  );
  await expectCanaryOk(
    fetchImpl,
    env,
    new URL("/api/runtime/caller-auth", baseUrl),
    { headers: smokeAuth }
  );
  await expectErrorCode(
    fetchImpl,
    env,
    new URL("/api/runtime/database", baseUrl),
    401,
    "missing_authorization"
  );
  const databaseCanary = await expectCanaryOk(
    fetchImpl,
    env,
    new URL("/api/runtime/database", baseUrl),
    { headers: smokeAuth }
  );
  assertRuntimeDatabaseCanary(databaseCanary, {
    requireHumanReviewQuery:
      env.get(REQUIRE_HUMAN_REVIEW_QUERY_ENV_NAME) === "1"
  });
  await expectCanaryOk(fetchImpl, env, new URL("/api/runtime/log", baseUrl), {
    headers: smokeAuth
  });
  await expectCanaryOk(
    fetchImpl,
    env,
    new URL("/api/runtime/scheduled", baseUrl),
    {
      method: "POST",
      headers: smokeAuth
    }
  );
  const sentryCanary = await expectCanaryOk(
    fetchImpl,
    env,
    new URL("/api/runtime/sentry", baseUrl),
    {
      method: "POST",
      headers: {
        ...RUNTIME_SMOKE_HEADERS,
        ...smokeAuth
      }
    }
  );
  assert.equal(
    sentryCanary.sentry_capture_enabled,
    false,
    "runtime smoke must not emit Sentry events"
  );
  assert.equal(
    sentryCanary.sentry_capture_suppressed,
    true,
    "runtime smoke Sentry suppression header was not honored"
  );
  if (runtimeAppEnv === "production") {
    assert.equal(
      sentryCanary.sentry_capture_configured,
      true,
      "runtime smoke did not prove production Sentry capture readiness"
    );
  }
  const errorCanary = await expectJsonStatus(
    fetchImpl,
    env,
    new URL("/api/runtime/error", baseUrl),
    500,
    {
      headers: {
        ...RUNTIME_SMOKE_HEADERS,
        ...smokeAuth
      }
    }
  );
  assert.equal(errorCanary.code, "structured_error_canary");
  assert.match(errorCanary.error_id, /^err_/);

  if (override) {
    await proveCandidateRelease("after probes");
  }

  console.log("Runtime smoke canaries passed.");
  return { ok: true };
}

async function main() {
  const env = readRuntimeSmokeEnv();
  const attempts = runtimeSmokeAttemptCount(process.env);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runRuntimeSmokeChecks(env);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      console.warn(
        `Runtime smoke attempt ${attempt} of ${attempts} failed; retrying in ${DEPLOY_SMOKE_RETRY_DELAY_MS / 1000}s.`
      );
      await delay(DEPLOY_SMOKE_RETRY_DELAY_MS);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
