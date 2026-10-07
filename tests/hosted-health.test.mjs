import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readHostedHealthEnv,
  runHostedHealthChecks
} from "../scripts/hosted-health.mjs";
import { checksSummary, exitCodeForChecks } from "../scripts/hosted-checks.mjs";

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

for (const { label, respond, expected } of [
  {
    label: "a request failure",
    /** @param {string} pathname */
    respond: async (pathname) => {
      if (pathname === "/api/runtime/log") {
        throw new Error("boom");
      }
    },
    expected: {
      name: "logs",
      status: "fail",
      code: "request_failed",
      message: "boom"
    }
  },
  {
    label: "an unexpected JSON response",
    /** @param {string} pathname */
    respond: async (pathname) =>
      pathname === "/api/runtime/log" ? jsonResponse(500, {}) : undefined,
    expected: {
      name: "logs",
      status: "fail",
      code: "unexpected_response",
      message: "/api/runtime/log returned an unexpected response",
      status_code: 500
    }
  },
  {
    label: "a wrong nested error code",
    /**
     * @param {string} pathname
     * @param {{ headers?: Record<string, string> }} init
     */
    respond: async (pathname, init) =>
      pathname === "/api/runtime/caller-auth" && !init.headers?.Authorization
        ? jsonResponse(401, { ok: false, error: { code: "other_code" } })
        : undefined,
    expected: {
      name: "caller_api_rejects_missing_auth",
      status: "fail",
      code: "other_code",
      message: "/api/runtime/caller-auth did not return missing_authorization",
      status_code: 401
    }
  }
]) {
  test(`hosted health reports ${label}`, async () => {
    const fake = healthFetch();
    const checks = await runHostedHealthChecks(baseEnv(), {
      fetchImpl: /** @type {any} */ (
        async (
          /** @type {string | URL} */ url,
          /** @type {{ headers?: Record<string, string> }} */ init = {}
        ) =>
          (await respond(new URL(url).pathname, init)) ?? fake.fetch(url, init)
      )
    });
    const actual = checks.find((entry) => entry.name === expected.name);
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected));
  });
}

test("hosted health rejects an invalid base URL", async () => {
  await assert.rejects(
    runHostedHealthChecks(baseEnv({ APP_BASE_URL: "not a url" }), {
      fetchImpl: async () => assert.fail("fetch must not be called")
    }),
    { code: "ERR_INVALID_URL" }
  );
});

test("hosted health CLI preserves env-file failures and summary output", async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hosted-health-cli-"));
  try {
    const emptyPath = path.join(tempDir, "empty.env");
    writeFileSync(emptyPath, "");
    const summary = {
      ok: false,
      action_required: false,
      checks: [
        {
          name: "configuration",
          status: "fail",
          code: "missing_configuration",
          message:
            "Missing required values: APP_BASE_URL, SMOKE_OR_CLEANUP_TOKEN"
        }
      ]
    };
    for (const [label, envPath, stdout, stderr] of [
      [
        "missing explicit file",
        path.join(tempDir, "missing.env"),
        "",
        `Hosted health env file does not exist: ${path.join(tempDir, "missing.env")}\n`
      ],
      [
        "empty explicit file",
        emptyPath,
        JSON.stringify(summary, null, 2) + "\n",
        ""
      ]
    ]) {
      await t.test(label, () => {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../scripts/hosted-health.mjs", import.meta.url)
            )
          ],
          {
            env: {
              NODE_ENV: "test",
              AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE: envPath
            },
            encoding: "utf8"
          }
        );
        assert.equal(result.status, 1);
        assert.equal(result.stdout, stdout);
        assert.equal(result.stderr, stderr);
      });
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function healthFetch() {
  const seenRequests =
    /** @type {Array<{ pathname: string, headers: Record<string, string> }>} */ ([]);
  return {
    seenRequests,
    /**
     * @param {string | URL} url
     * @param {{ headers?: Record<string, string> }} [init]
     */
    async fetch(url, init = {}) {
      const pathname = new URL(url).pathname;
      seenRequests.push({ pathname, headers: init.headers ?? {} });
      if (["/sign-in", "/sign-out", "/human"].includes(pathname)) {
        return textPage();
      }
      if (pathname === "/api/runtime/canary") {
        return jsonResponse(200, {
          ok: true,
          code: "runtime_canary_ok",
          environment: {
            configured: true,
            appEnv: "production",
            release: "release-sha"
          }
        });
      }
      if (
        pathname === "/api/runtime/caller-auth" ||
        pathname === "/api/runtime/database"
      ) {
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
      }
      if (pathname === "/api/runtime/caller-auth") {
        return jsonResponse(200, { ok: true, code: "caller_auth_accepted" });
      }
      if (pathname === "/api/runtime/database") {
        return jsonResponse(200, {
          ok: true,
          code: "database_canary_ok",
          transaction_context_matched: true,
          restricted_role_matched: true,
          human_review_query_matched: true
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
          error_id: "sentry_test",
          sentry_capture_enabled: false,
          sentry_capture_configured: true,
          sentry_capture_suppressed: true
        });
      }
      if (pathname === "/api/runtime/error") {
        return jsonResponse(500, {
          ok: false,
          error_id: "err_test",
          code: "structured_error_canary"
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
  assert.equal(exitCodeForChecks(checks), 1);
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
  const summary = checksSummary(checks);

  assert.equal(exitCodeForChecks(checks), 2);
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
    fake.seenRequests.some(
      (request) => request.headers.Authorization === "Bearer secret-smoke-token"
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

  assert.equal(exitCodeForChecks(checks), 0);
  assert.equal(checksSummary(checks).ok, true);
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
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health fails when the human review database query is not proven", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {{ headers?: Record<string, string> }} */ init = {}
      ) => {
        if (new URL(url).pathname === "/api/runtime/database") {
          return jsonResponse(200, {
            ok: true,
            code: "database_canary_ok",
            transaction_context_matched: true,
            restricted_role_matched: true,
            human_review_query_matched: false
          });
        }
        return fake.fetch(url, init);
      }
    )
  });

  assert.equal(
    checks.find((entry) => entry.name === "database")?.status,
    "fail"
  );
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health accepts the outgoing database canary contract during rollout", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {{ headers?: Record<string, string> }} */ init = {}
      ) => {
        if (new URL(url).pathname === "/api/runtime/database") {
          return jsonResponse(200, {
            ok: true,
            code: "database_canary_ok",
            transaction_context_matched: true,
            restricted_role_matched: true
          });
        }
        return fake.fetch(url, init);
      }
    )
  });

  assert.equal(
    checks.find((entry) => entry.name === "database")?.status,
    "pass"
  );
});

/**
 * @param {string} pathname
 * @param {{ status: number, body: Record<string, unknown> }} response
 */
function healthFetchOverriding(pathname, response) {
  const fake = healthFetch();
  return /** @type {any} */ (
    async (
      /** @type {string | URL} */ url,
      /** @type {{ headers?: Record<string, string> }} */ init = {}
    ) => {
      if (new URL(url).pathname === pathname && init.headers?.Authorization) {
        return jsonResponse(response.status, response.body);
      }
      return fake.fetch(url, init);
    }
  );
}

test("hosted health fails when the runtime environment is not configured", async () => {
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: healthFetchOverriding("/api/runtime/canary", {
      status: 200,
      body: {
        ok: true,
        code: "runtime_canary_ok",
        environment: { configured: false, appEnv: "production" }
      }
    })
  });

  assert.equal(
    checks.find((entry) => entry.name === "runtime")?.status,
    "fail"
  );
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health fails when the runtime canary omits authenticated environment posture", async () => {
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: healthFetchOverriding("/api/runtime/canary", {
      status: 200,
      body: { ok: true, code: "runtime_canary_ok" }
    })
  });

  assert.equal(
    checks.find((entry) => entry.name === "runtime")?.status,
    "fail"
  );
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health requires production Sentry capture readiness", async () => {
  const unconfiguredSentry = {
    status: 200,
    body: {
      ok: true,
      error_id: "sentry_test",
      sentry_capture_enabled: false,
      sentry_capture_configured: false,
      sentry_capture_suppressed: true
    }
  };
  const production = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: healthFetchOverriding("/api/runtime/sentry", unconfiguredSentry)
  });
  assert.equal(
    production.find((entry) => entry.name === "sentry")?.status,
    "fail"
  );
  assert.equal(exitCodeForChecks(production), 1);

  const fake = healthFetch();
  const development = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {{ headers?: Record<string, string> }} */ init = {}
      ) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/runtime/canary") {
          return jsonResponse(200, {
            ok: true,
            code: "runtime_canary_ok",
            environment: { configured: true, appEnv: "development" }
          });
        }
        if (pathname === "/api/runtime/sentry") {
          return jsonResponse(
            unconfiguredSentry.status,
            unconfiguredSentry.body
          );
        }
        return fake.fetch(url, init);
      }
    )
  });
  assert.equal(
    development.find((entry) => entry.name === "sentry")?.status,
    "pass"
  );
});

test("hosted health fails when the Sentry canary would emit a real event", async () => {
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: healthFetchOverriding("/api/runtime/sentry", {
      status: 200,
      body: {
        ok: true,
        error_id: "sentry_test",
        sentry_capture_enabled: true,
        sentry_capture_configured: true,
        sentry_capture_suppressed: true
      }
    })
  });

  assert.equal(checks.find((entry) => entry.name === "sentry")?.status, "fail");
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health proves structured error correlation without capturing to Sentry", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (fake.fetch)
  });

  assert.deepEqual(
    checks.find((entry) => entry.name === "error_correlation"),
    {
      name: "error_correlation",
      status: "pass",
      code: "structured_error_canary",
      message: "/api/runtime/error rejected as expected",
      status_code: 500
    }
  );
  const errorRequests = fake.seenRequests.filter(
    (request) => request.pathname === "/api/runtime/error"
  );
  assert.equal(errorRequests.length, 1);
  assert.equal(errorRequests[0].headers["x-agent-outbox-runtime-smoke"], "1");
  assert.equal(
    errorRequests[0].headers.Authorization,
    "Bearer secret-smoke-token"
  );
});

for (const [label, response] of /** @type {const} */ ([
  [
    "returns a generic internal error",
    { status: 500, body: { ok: false, code: "internal_error" } }
  ],
  [
    "omits a safe error_id",
    {
      status: 500,
      body: { ok: false, code: "structured_error_canary", error_id: "req_x" }
    }
  ],
  ["is not deployed", { status: 404, body: { ok: false, code: "not_found" } }],
  [
    "omits ok=false",
    {
      status: 500,
      body: { code: "structured_error_canary", error_id: "err_test" }
    }
  ],
  [
    "reports ok=true",
    {
      status: 500,
      body: { ok: true, code: "structured_error_canary", error_id: "err_test" }
    }
  ]
])) {
  test(`hosted health fails when the error correlation canary ${label}`, async () => {
    const checks = await runHostedHealthChecks(baseEnv(), {
      fetchImpl: healthFetchOverriding("/api/runtime/error", response)
    });

    assert.equal(
      checks.find((entry) => entry.name === "error_correlation")?.status,
      "fail"
    );
    assert.equal(exitCodeForChecks(checks), 1);
  });
}

test("hosted health fails when the database canary accepts a missing bearer", async () => {
  const fake = healthFetch();
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {{ headers?: Record<string, string> }} */ init = {}
      ) => {
        if (new URL(url).pathname === "/api/runtime/database") {
          return jsonResponse(200, {
            ok: true,
            code: "database_canary_ok",
            transaction_context_matched: true,
            restricted_role_matched: true,
            human_review_query_matched: true
          });
        }
        return fake.fetch(url, init);
      }
    )
  });

  assert.equal(
    checks.find((entry) => entry.name === "database_rejects_missing_auth")
      ?.status,
    "fail"
  );
  assert.equal(exitCodeForChecks(checks), 1);
});

test("hosted health sends its own invalid bearer to the caller API", async () => {
  const fake = healthFetch();
  await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (fake.fetch)
  });

  assert.deepEqual(
    fake.seenRequests
      .filter((request) => request.pathname === "/api/runtime/caller-auth")
      .map((request) => request.headers.Authorization),
    [undefined, "Bearer invalid", "Bearer secret-smoke-token"]
  );
});

/**
 * Responds like the healthy fake after `delayMs`, unless the request aborts.
 *
 * @param {number} delayMs
 */
function delayedHealthFetch(delayMs) {
  const fake = healthFetch();
  return /** @type {any} */ (
    (
      /** @type {string | URL} */ url,
      /** @type {{ headers?: Record<string, string>, signal?: AbortSignal }} */ init = {}
    ) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(fake.fetch(url, init)), delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      })
  );
}

test("hosted health applies a custom request timeout to every live probe", async () => {
  const checks = await runHostedHealthChecks(baseEnv(), {
    fetchImpl: delayedHealthFetch(1_000),
    timeoutMs: 1
  });
  const liveChecks = checks.slice(0, 13);

  assert.equal(liveChecks.length, 13);
  for (const entry of liveChecks) {
    assert.deepEqual(
      { status: entry.status, code: entry.code },
      { status: "fail", code: "request_failed" },
      entry.name
    );
    assert.match(String(entry.message), /aborted due to timeout/);
  }
});

for (const timeoutMs of [undefined, null]) {
  test(`hosted health defaults the request timeout when timeoutMs is ${timeoutMs}`, async () => {
    const checks = await runHostedHealthChecks(baseEnv(), {
      fetchImpl: delayedHealthFetch(50),
      timeoutMs: /** @type {any} */ (timeoutMs)
    });

    assert.deepEqual(
      checks.slice(0, 13).filter((entry) => entry.status !== "pass"),
      []
    );
  });
}

test("hosted health sends each probe its baseline request options", async () => {
  /** @type {Array<{ pathname: string, init: Record<string, unknown> }>} */
  const calls = [];
  const fake = healthFetch();
  await runHostedHealthChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async (
        /** @type {string | URL} */ url,
        /** @type {Record<string, any>} */ init = {}
      ) => {
        calls.push({ pathname: new URL(url).pathname, init: { ...init } });
        return fake.fetch(url, init);
      }
    )
  });

  const auth = { Authorization: "Bearer secret-smoke-token" };
  const marked = { "x-agent-outbox-runtime-smoke": "1", ...auth };
  assert.deepEqual(
    calls.map(({ pathname, init }) => {
      assert.ok(init.signal instanceof AbortSignal, pathname);
      const { signal, ...rest } = init;
      return [pathname, Reflect.ownKeys(init), rest];
    }),
    [
      ["/sign-in", ["redirect", "signal"], { redirect: "manual" }],
      ["/sign-out", ["redirect", "signal"], { redirect: "manual" }],
      ["/human", ["redirect", "signal"], { redirect: "manual" }],
      [
        "/api/runtime/canary",
        ["method", "headers", "signal"],
        { method: undefined, headers: auth }
      ],
      [
        "/api/runtime/caller-auth",
        ["headers", "signal"],
        { headers: undefined }
      ],
      [
        "/api/runtime/caller-auth",
        ["headers", "signal"],
        { headers: { Authorization: "Bearer invalid" } }
      ],
      [
        "/api/runtime/caller-auth",
        ["method", "headers", "signal"],
        { method: undefined, headers: auth }
      ],
      ["/api/runtime/database", ["headers", "signal"], { headers: undefined }],
      [
        "/api/runtime/database",
        ["method", "headers", "signal"],
        { method: undefined, headers: auth }
      ],
      [
        "/api/runtime/log",
        ["method", "headers", "signal"],
        { method: undefined, headers: auth }
      ],
      [
        "/api/runtime/scheduled",
        ["method", "headers", "signal"],
        { method: "POST", headers: auth }
      ],
      [
        "/api/runtime/sentry",
        ["method", "headers", "signal"],
        { method: "POST", headers: marked }
      ],
      ["/api/runtime/error", ["headers", "signal"], { headers: marked }]
    ]
  );
});
