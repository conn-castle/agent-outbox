import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnv } from "./foundation.mjs";
import { RUNTIME_SMOKE_ENV_NAMES } from "../src/server/env.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SMOKE_HEADERS = {
  "x-agent-outbox-runtime-smoke": "1"
};
const REQUEST_TIMEOUT_MS = 10_000;

function readLocalEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) {
    return new Map();
  }

  return parseEnv(readFileSync(envPath, "utf8"));
}

/**
 * @param {URL} url
 * @param {RequestInit} [init]
 */
async function expectCanaryOk(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  const body = await response.json();
  assert.equal(body.ok, true, `${url} returned ok=${String(body.ok)}`);
  return body;
}

/**
 * @param {URL} url
 * @param {number} expectedStatus
 * @param {RequestInit} [init]
 */
async function expectJsonStatus(url, expectedStatus, init) {
  const response = await fetch(url, {
    ...init,
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
 * @param {URL} url
 * @param {number} expectedStatus
 * @param {string} expectedCode
 * @param {RequestInit} [init]
 */
async function expectErrorCode(url, expectedStatus, expectedCode, init) {
  const body = await expectJsonStatus(url, expectedStatus, init);
  assert.equal(body.ok, false, `${url} returned ok=${String(body.ok)}`);
  assert.equal(body.code, expectedCode, `${url} returned code=${body.code}`);
  return body;
}

/**
 * @param {URL} url
 */
async function expectReachablePage(url) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.ok(
    response.status >= 200 && response.status < 400,
    `${url} returned ${response.status}`
  );
}

async function main() {
  const env = readLocalEnv();
  const missing = RUNTIME_SMOKE_ENV_NAMES.filter((name) => !env.get(name));

  if (missing.length > 0) {
    console.error(
      `Runtime smoke blocked by missing required values: ${missing.join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl = env.get("APP_BASE_URL");
  const token = env.get("SMOKE_OR_CLEANUP_TOKEN");
  const smokeAuth = { Authorization: `Bearer ${token}` };

  await expectReachablePage(new URL("/sign-in", baseUrl));
  await expectReachablePage(new URL("/sign-out", baseUrl));
  await expectReachablePage(new URL("/human", baseUrl));
  const runtimeCanary = await expectCanaryOk(
    new URL("/api/runtime/canary", baseUrl),
    { headers: smokeAuth }
  );
  assert.equal(
    runtimeCanary.environment?.configured,
    true,
    "/api/runtime/canary did not report configured runtime environment"
  );
  const runtimeAppEnv = runtimeCanary.environment?.appEnv;
  await expectErrorCode(
    new URL("/api/runtime/caller-auth", baseUrl),
    401,
    "missing_authorization"
  );
  await expectErrorCode(
    new URL("/api/runtime/caller-auth", baseUrl),
    403,
    "invalid_bearer_token",
    { headers: { Authorization: "Bearer wrong-token" } }
  );
  await expectCanaryOk(new URL("/api/runtime/caller-auth", baseUrl), {
    headers: smokeAuth
  });
  await expectErrorCode(
    new URL("/api/runtime/database", baseUrl),
    401,
    "missing_authorization"
  );
  const databaseCanary = await expectCanaryOk(
    new URL("/api/runtime/database", baseUrl),
    { headers: smokeAuth }
  );
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
  await expectCanaryOk(new URL("/api/runtime/log", baseUrl), {
    headers: smokeAuth
  });
  await expectCanaryOk(new URL("/api/runtime/scheduled", baseUrl), {
    method: "POST",
    headers: smokeAuth
  });
  const sentryCanary = await expectCanaryOk(
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

  console.log("Runtime smoke canaries passed.");
}

await main();
