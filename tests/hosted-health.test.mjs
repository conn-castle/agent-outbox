import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exitCodeForHostedHealth,
  hostedHealthSummary,
  readHostedHealthEnv,
  runHostedHealthChecks
} from "../scripts/hosted-health.mjs";

function baseEnv(overrides = {}) {
  return new Map(
    Object.entries({
      APP_BASE_URL: "https://app.agent-outbox.dev",
      SMOKE_OR_CLEANUP_TOKEN: "secret-smoke-token",
      ...overrides
    })
  );
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function textPage(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error("not json");
    }
  };
}

function healthFetch() {
  const seenHeaders = /** @type {Array<Record<string, string>>} */ ([]);
  return {
    seenHeaders,
    /**
     * @param {string | URL} url
     * @param {{ headers?: Record<string, string> }} [init]
     */
    async fetch(url, init = {}) {
      seenHeaders.push(init.headers ?? {});
      const pathname = new URL(url).pathname;
      if (["/sign-in", "/sign-out", "/human"].includes(pathname)) {
        return textPage();
      }
      if (pathname === "/api/runtime/canary") {
        return jsonResponse(200, { ok: true, code: "runtime_canary_ok" });
      }
      if (pathname === "/api/runtime/caller-auth") {
        const authorization = init.headers?.Authorization;
        if (!authorization) {
          return jsonResponse(401, {
            ok: false,
            code: "missing_authorization"
          });
        }
        if (authorization === "Bearer invalid") {
          return jsonResponse(403, {
            ok: false,
            code: "invalid_bearer_token"
          });
        }
        return jsonResponse(200, { ok: true, code: "caller_auth_accepted" });
      }
      if (pathname === "/api/runtime/database") {
        return jsonResponse(200, {
          ok: true,
          code: "database_canary_ok",
          transaction_context_matched: true,
          restricted_role_matched: true
        });
      }
      if (pathname === "/api/runtime/log") {
        return jsonResponse(200, { ok: true, code: "structured_log_ok" });
      }
      if (pathname === "/api/runtime/scheduled") {
        return jsonResponse(200, { ok: true, code: "scheduled_canary_ok" });
      }
      if (pathname === "/api/runtime/sentry") {
        return jsonResponse(200, {
          ok: true,
          code: "sentry_canary_ok",
          sentry_capture_suppressed: true
        });
      }
      return jsonResponse(404, { ok: false, code: "not_found" });
    }
  };
}

test("hosted health fails loud when required env is missing", async () => {
  const checks = await runHostedHealthChecks(new Map());

  assert.deepEqual(checks, [
    {
      name: "configuration",
      status: "fail",
      code: "missing_configuration",
      message: "Missing required values: APP_BASE_URL, SMOKE_OR_CLEANUP_TOKEN"
    }
  ]);
  assert.equal(exitCodeForHostedHealth(checks), 1);
});

test("hosted health reads explicit env file before runtime smoke fallback", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hosted-health-env-"));
  try {
    const hostedPath = path.join(tempDir, "hosted.env");
    const runtimePath = path.join(tempDir, "runtime.env");
    writeFileSync(hostedPath, "APP_BASE_URL=https://hosted.example\n");
    writeFileSync(runtimePath, "APP_BASE_URL=https://runtime.example\n");

    assert.equal(
      readHostedHealthEnv({
        env: {
          AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE: hostedPath,
          AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: runtimePath
        },
        root: tempDir
      }).get("APP_BASE_URL"),
      "https://hosted.example"
    );
    assert.equal(
      readHostedHealthEnv({
        env: {
          AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: runtimePath
        },
        root: tempDir
      }).get("APP_BASE_URL"),
      "https://runtime.example"
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("hosted health returns action_required for unavailable safe evidence", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (fake.fetch)
  });
  const summary = hostedHealthSummary(checks);

  assert.equal(exitCodeForHostedHealth(checks), 2);
  assert.equal(summary.ok, false);
  assert.equal(summary.action_required, true);
  assert.deepEqual(
    checks
      .filter((entry) => entry.status === "action_required")
      .map((entry) => entry.name),
    ["quota", "file_path", "audit_events", "abuse_cost"]
  );
  assert.equal(JSON.stringify(summary).includes("secret-smoke-token"), false);
  assert.ok(
    fake.seenHeaders.some(
      (headers) => headers.Authorization === "Bearer secret-smoke-token"
    )
  );
});

test("hosted health passes when canaries and operator evidence pass", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(
    baseEnv({
      AGENT_OUTBOX_HOSTED_HEALTH_QUOTA_EVIDENCE: "checked",
      AGENT_OUTBOX_HOSTED_HEALTH_FILE_EVIDENCE: "checked",
      AGENT_OUTBOX_HOSTED_HEALTH_AUDIT_EVIDENCE: "checked",
      AGENT_OUTBOX_HOSTED_HEALTH_ABUSE_COST_EVIDENCE: "checked"
    }),
    { fetchImpl: /** @type {any} */ (fake.fetch) }
  );

  assert.equal(exitCodeForHostedHealth(checks), 0);
  assert.equal(hostedHealthSummary(checks).ok, true);
});

test("hosted health reports status when a JSON endpoint returns non-JSON", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {{ headers?: Record<string, string> }} */ init = {}
      ) => {
        if (new URL(url).pathname === "/api/runtime/canary") {
          return textPage(502);
        }
        return fake.fetch(url, init);
      }
    )
  });

  assert.deepEqual(
    checks.find((entry) => entry.name === "runtime"),
    {
      name: "runtime",
      status: "fail",
      code: "invalid_json_response",
      message: "/api/runtime/canary returned a non-JSON response",
      status_code: 502
    }
  );
  assert.equal(exitCodeForHostedHealth(checks), 1);
});
