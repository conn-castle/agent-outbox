import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRuntimeDatabaseCanary,
  assertRuntimeCanaryEnvironment,
  formatWorkerVersionOverrideHeader,
  missingRuntimeSmokeEnvNames,
  readRuntimeSmokeEnv,
  runRuntimeSmokeChecks,
  runtimeSmokeAttemptCount,
  runtimeSmokeRequestHeaders,
  WORKER_VERSION_OVERRIDE_ENV_NAME,
  WORKER_VERSION_OVERRIDE_HEADER
} from "../scripts/runtime-smoke.mjs";

test("runtime smoke loads an explicit operator env file before root .env", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-runtime-smoke-root-")
  );
  const explicitDir = mkdtempSync(
    path.join(os.tmpdir(), "agent-outbox-runtime-smoke-env-")
  );
  const explicitEnvPath = path.join(explicitDir, "production-smoke.env");

  try {
    writeFileSync(path.join(root, ".env"), "APP_BASE_URL=http://localhost\n");
    writeFileSync(
      explicitEnvPath,
      "APP_BASE_URL=https://app.agent-outbox.dev\nSMOKE_OR_CLEANUP_TOKEN=smoke-token\n"
    );

    assert.equal(
      readRuntimeSmokeEnv({ env: {}, root }).get("APP_BASE_URL"),
      "http://localhost"
    );
    const explicitValues = readRuntimeSmokeEnv({
      env: { AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: explicitEnvPath },
      root
    });
    assert.equal(
      explicitValues.get("APP_BASE_URL"),
      "https://app.agent-outbox.dev"
    );
    assert.equal(explicitValues.get("SMOKE_OR_CLEANUP_TOKEN"), "smoke-token");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(explicitDir, { force: true, recursive: true });
  }
});

test("runtime smoke fails loudly when an explicit operator env file is missing", () => {
  const missingEnvPath = path.join(
    os.tmpdir(),
    `agent-outbox-missing-smoke-${process.pid}.env`
  );

  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: { AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: missingEnvPath }
      }),
    {
      message: `Runtime smoke env file does not exist: ${missingEnvPath}`
    }
  );
});

test("runtime smoke process-env mode reads only remote smoke client inputs", () => {
  const values = readRuntimeSmokeEnv({
    env: {
      AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
      AGENT_OUTBOX_EXPECTED_RELEASE: "release-sha",
      APP_BASE_URL: "https://app.agent-outbox.dev",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1",
      STRIPE_SECRET_KEY: "must-not-be-copied"
    }
  });

  assert.deepEqual(Object.fromEntries(values), {
    APP_BASE_URL: "https://app.agent-outbox.dev",
    SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
    AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1",
    AGENT_OUTBOX_EXPECTED_RELEASE: "release-sha"
  });
  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: {
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
          APP_BASE_URL: "https://app.agent-outbox.dev",
          SMOKE_OR_CLEANUP_TOKEN: "smoke-token"
        }
      }),
    /AGENT_OUTBOX_EXPECTED_RELEASE is required in process-env mode/
  );
  assert.throws(
    () =>
      readRuntimeSmokeEnv({
        env: {
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
          AGENT_OUTBOX_EXPECTED_RELEASE: "   ",
          APP_BASE_URL: "https://app.agent-outbox.dev",
          SMOKE_OR_CLEANUP_TOKEN: "smoke-token"
        }
      }),
    /AGENT_OUTBOX_EXPECTED_RELEASE is required in process-env mode/
  );
});

test("runtime smoke rejects a healthy response from the wrong release", () => {
  assert.doesNotThrow(() =>
    assertRuntimeCanaryEnvironment(
      { environment: { configured: true, release: "expected-sha" } },
      "expected-sha"
    )
  );
  assert.throws(
    () =>
      assertRuntimeCanaryEnvironment(
        { environment: { configured: true, release: "previous-sha" } },
        "expected-sha"
      ),
    /did not report the expected deployed release/
  );
  assert.equal(runtimeSmokeAttemptCount({}), 1);
  assert.equal(
    runtimeSmokeAttemptCount({
      AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"
    }),
    6
  );
});

test("runtime smoke override header is exact and applied to every request", async () => {
  const versionId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    formatWorkerVersionOverrideHeader(versionId),
    `agent-outbox="${versionId}"`
  );
  const headers = runtimeSmokeRequestHeaders(
    new Map([[WORKER_VERSION_OVERRIDE_ENV_NAME, versionId]]),
    { Authorization: "Bearer token" }
  );
  assert.equal(
    headers[WORKER_VERSION_OVERRIDE_HEADER],
    `agent-outbox="${versionId}"`
  );
  assert.equal(headers.Authorization, "Bearer token");
  assert.deepEqual(runtimeSmokeRequestHeaders(new Map()), {});

  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const requests = [];
  const canary = {
    ok: true,
    environment: {
      configured: true,
      release: "expected-sha",
      appEnv: "production"
    }
  };
  /**
   * @param {any} body
   * @param {number} [status]
   */
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  await runRuntimeSmokeChecks(
    new Map([
      ["APP_BASE_URL", "https://app.agent-outbox.dev"],
      ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"],
      ["AGENT_OUTBOX_EXPECTED_RELEASE", "expected-sha"],
      [WORKER_VERSION_OVERRIDE_ENV_NAME, versionId],
      ["AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY", "1"]
    ]),
    {
      fetchImpl: async (url, init = {}) => {
        const requestHeaders = /** @type {Record<string, string>} */ (
          init.headers ?? {}
        );
        requests.push({ url: String(url), headers: requestHeaders });
        const pathName = new URL(String(url)).pathname;
        if (
          pathName === "/sign-in" ||
          pathName === "/sign-out" ||
          pathName === "/human"
        ) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (pathName === "/api/runtime/error") {
          return jsonResponse(
            { code: "structured_error_canary", error_id: "err_test" },
            500
          );
        }
        if (
          pathName === "/api/runtime/caller-auth" &&
          !requestHeaders.Authorization
        ) {
          return jsonResponse(
            { ok: false, code: "missing_authorization" },
            401
          );
        }
        if (
          pathName === "/api/runtime/caller-auth" &&
          requestHeaders.Authorization === "Bearer wrong-token"
        ) {
          return jsonResponse({ ok: false, code: "invalid_bearer_token" }, 403);
        }
        if (
          pathName === "/api/runtime/database" &&
          !requestHeaders.Authorization?.includes("smoke-token")
        ) {
          return jsonResponse(
            { ok: false, code: "missing_authorization" },
            401
          );
        }
        if (pathName === "/api/runtime/database") {
          return jsonResponse({
            ok: true,
            transaction_context_matched: true,
            restricted_role_matched: true,
            human_review_query_matched: true
          });
        }
        if (pathName === "/api/runtime/sentry") {
          return jsonResponse({
            ok: true,
            sentry_capture_enabled: false,
            sentry_capture_suppressed: true,
            sentry_capture_configured: true
          });
        }
        return jsonResponse(canary);
      }
    }
  );
  assert.ok(requests.length > 4);
  for (const request of requests) {
    assert.equal(
      request.headers[WORKER_VERSION_OVERRIDE_HEADER],
      `agent-outbox="${versionId}"`
    );
  }
  const canaryRequests = requests.filter((request) =>
    request.url.includes("/api/runtime/canary")
  );
  assert.ok(canaryRequests.length >= 2);
  assert.equal(canaryRequests[0].url.includes("/api/runtime/canary"), true);
  assert.equal(
    requests.at(-1)?.url.includes("/api/runtime/canary"),
    true,
    "override smoke must prove the candidate SHA again after probes"
  );
});

test("runtime smoke requires the production human review query canary", () => {
  assert.deepEqual(
    missingRuntimeSmokeEnvNames(
      new Map([
        ["APP_BASE_URL", "https://app.agent-outbox.dev"],
        ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"]
      ])
    ),
    [],
    "the post-deploy query flag must remain optional for outgoing releases"
  );
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseCanary({
      transaction_context_matched: true,
      restricted_role_matched: true
    })
  );
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseCanary({
      transaction_context_matched: true,
      restricted_role_matched: true,
      human_review_query_matched: true
    })
  );
  assert.throws(
    () =>
      assertRuntimeDatabaseCanary({
        transaction_context_matched: true,
        restricted_role_matched: true,
        human_review_query_matched: false
      }),
    /did not prove the human review query/
  );
  assert.throws(
    () =>
      assertRuntimeDatabaseCanary(
        {
          transaction_context_matched: true,
          restricted_role_matched: true
        },
        { requireHumanReviewQuery: true }
      ),
    /did not prove the human review query/
  );
});
