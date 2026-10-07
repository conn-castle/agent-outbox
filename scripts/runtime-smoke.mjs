import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { readOptionalEnvFile } from "./dotenv.mjs";
import { WORKER_NAME, WORKER_VERSION_ID } from "./release/identity.mjs";
import { ROOT } from "./repo-root.mjs";

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
export const RUNTIME_SMOKE_HEADERS = {
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
  // An absent default .env means no operator inputs, so process overrides
  // alone must not produce a partial configuration.
  if (!explicitPath && !existsSync(path.join(root, ".env"))) {
    return new Map();
  }
  const values = readOptionalEnvFile(explicitPath, root, "Runtime smoke");
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
 * @param {Record<string, any>} sentryCanary
 * @param {unknown} runtimeAppEnv
 */
export function assertRuntimeSentryCanary(sentryCanary, runtimeAppEnv) {
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
}

/**
 * @param {Record<string, any>} errorCanary
 */
export function assertRuntimeErrorCanary(errorCanary) {
  assert.equal(
    errorCanary.code,
    "structured_error_canary",
    "/api/runtime/error did not return the structured error canary"
  );
  assert.match(
    errorCanary.error_id,
    /^err_/,
    "/api/runtime/error did not return a safe error_id"
  );
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
 * @typedef {{
 *   name: string,
 *   path: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   expect: "page" | "ok" | { status: number, code?: string },
 *   validate?: (body: Record<string, any>) => void
 * }} RuntimeProbe
 */

/**
 * The ordered live probes shared by runtime smoke and hosted health. An
 * `expect.code` requires the `{ ok: false, code }` error envelope; without it
 * only the status is required before `validate` runs.
 *
 * @param {{
 *   token: string,
 *   invalidToken: string,
 *   expectedRelease?: string,
 *   requireHumanReviewQuery?: boolean,
 *   requireErrorCanaryEnvelope?: boolean
 * }} options
 * @returns {RuntimeProbe[]}
 */
export function runtimeProbes({
  token,
  invalidToken,
  expectedRelease,
  requireHumanReviewQuery = false,
  requireErrorCanaryEnvelope = false
}) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const smokeAuthHeaders = { ...RUNTIME_SMOKE_HEADERS, ...authHeaders };
  /** @type {unknown} */
  let runtimeAppEnv;
  return [
    { name: "app", path: "/sign-in", expect: "page" },
    { name: "auth", path: "/sign-out", expect: "page" },
    { name: "human_queue", path: "/human", expect: "page" },
    {
      name: "runtime",
      path: "/api/runtime/canary",
      headers: authHeaders,
      expect: "ok",
      validate: (body) => {
        runtimeAppEnv = body.environment?.appEnv;
        assertRuntimeCanaryEnvironment(body, expectedRelease);
      }
    },
    {
      name: "caller_api_rejects_missing_auth",
      path: "/api/runtime/caller-auth",
      expect: { status: 401, code: "missing_authorization" }
    },
    {
      name: "caller_api_rejects_invalid_auth",
      path: "/api/runtime/caller-auth",
      headers: { Authorization: `Bearer ${invalidToken}` },
      expect: { status: 403, code: "invalid_bearer_token" }
    },
    {
      name: "caller_api_accepts_smoke_auth",
      path: "/api/runtime/caller-auth",
      headers: authHeaders,
      expect: "ok"
    },
    {
      name: "database_rejects_missing_auth",
      path: "/api/runtime/database",
      expect: { status: 401, code: "missing_authorization" }
    },
    {
      name: "database",
      path: "/api/runtime/database",
      headers: authHeaders,
      expect: "ok",
      validate: (body) =>
        assertRuntimeDatabaseCanary(body, { requireHumanReviewQuery })
    },
    {
      name: "logs",
      path: "/api/runtime/log",
      headers: authHeaders,
      expect: "ok"
    },
    {
      name: "cleanup",
      path: "/api/runtime/scheduled",
      method: "POST",
      headers: authHeaders,
      expect: "ok"
    },
    {
      name: "sentry",
      path: "/api/runtime/sentry",
      method: "POST",
      headers: smokeAuthHeaders,
      expect: "ok",
      validate: (body) => assertRuntimeSentryCanary(body, runtimeAppEnv)
    },
    {
      name: "error_correlation",
      path: "/api/runtime/error",
      headers: smokeAuthHeaders,
      expect: requireErrorCanaryEnvelope
        ? { status: 500, code: "structured_error_canary" }
        : { status: 500 },
      validate: assertRuntimeErrorCanary
    }
  ];
}

/**
 * Sends one probe and throws the first failed request, parse, or assertion.
 *
 * @param {RuntimeSmokeFetch} fetchImpl
 * @param {Map<string, string>} env
 * @param {string} baseUrl
 * @param {RuntimeProbe} probe
 */
async function assertRuntimeProbe(fetchImpl, env, baseUrl, probe) {
  const url = new URL(probe.path, baseUrl);
  const { expect } = probe;
  const headers = runtimeSmokeRequestHeaders(env, probe.headers);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(
    url,
    expect === "page"
      ? { redirect: "manual", headers, signal }
      : { ...(probe.method ? { method: probe.method } : {}), headers, signal }
  );
  if (expect === "page") {
    assert.ok(
      response.status >= 200 && response.status < 400,
      `${url} returned ${response.status}`
    );
    return;
  }
  if (expect === "ok") {
    assert.equal(response.ok, true, `${url} returned ${response.status}`);
  } else {
    assert.equal(
      response.status,
      expect.status,
      `${url} returned ${response.status}`
    );
  }
  const body = await response.json();
  if (expect === "ok") {
    assert.equal(body.ok, true, `${url} returned ok=${String(body.ok)}`);
  } else if (expect.code !== undefined) {
    assert.equal(body.ok, false, `${url} returned ok=${String(body.ok)}`);
    assert.equal(body.code, expect.code, `${url} returned code=${body.code}`);
  }
  probe.validate?.(body);
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

  const baseUrl = /** @type {string} */ (env.get("APP_BASE_URL"));
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
  const probes = runtimeProbes({
    token: /** @type {string} */ (env.get("SMOKE_OR_CLEANUP_TOKEN")),
    invalidToken: "wrong-token",
    expectedRelease,
    requireHumanReviewQuery:
      env.get(REQUIRE_HUMAN_REVIEW_QUERY_ENV_NAME) === "1"
  });
  // A version override must prove the candidate release before and after the
  // probes so no probe result can come from a different Worker version.
  const runtimeCanary = /** @type {RuntimeProbe} */ (
    probes.find((probe) => probe.name === "runtime")
  );
  const sequence = override
    ? [runtimeCanary, ...probes, runtimeCanary]
    : probes;

  for (const probe of sequence) {
    await assertRuntimeProbe(fetchImpl, env, baseUrl, probe);
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
