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

/** @param {Array<[string, string]>} [extra] */
function smokeEnv(extra = []) {
  return new Map([
    ["APP_BASE_URL", "https://app.agent-outbox.dev"],
    ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"],
    ["AGENT_OUTBOX_EXPECTED_RELEASE", "expected-sha"],
    ...extra
  ]);
}

/**
 * @param {any} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

/**
 * A healthy deployment; `override` may replace the response for one path.
 *
 * @param {(pathName: string, headers: Record<string, string>) => any} [override]
 */
function smokeFetch(override = () => undefined) {
  /** @type {{ url: string, headers: Record<string, string>, redirect?: string }[]} */
  const requests = [];
  /** @type {import("../scripts/runtime-smoke.mjs").RuntimeSmokeFetch} */
  const fetchImpl = async (url, init = {}) => {
    const requestHeaders = /** @type {Record<string, string>} */ (
      init.headers ?? {}
    );
    requests.push({
      url: String(url),
      headers: requestHeaders,
      redirect: init.redirect
    });
    const pathName = new URL(String(url)).pathname;
    const overridden = override(pathName, requestHeaders);
    if (overridden) {
      return overridden;
    }
    if (["/sign-in", "/sign-out", "/human"].includes(pathName)) {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        }
      };
    }
    if (pathName === "/api/runtime/error") {
      return jsonResponse(
        { ok: false, code: "structured_error_canary", error_id: "err_test" },
        500
      );
    }
    if (
      pathName === "/api/runtime/caller-auth" ||
      pathName === "/api/runtime/database"
    ) {
      if (!requestHeaders.Authorization) {
        return jsonResponse({ ok: false, code: "missing_authorization" }, 401);
      }
      if (requestHeaders.Authorization !== "Bearer smoke-token") {
        return jsonResponse({ ok: false, code: "invalid_bearer_token" }, 403);
      }
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
    return jsonResponse({
      ok: true,
      environment: {
        configured: true,
        release: "expected-sha",
        appEnv: "production"
      }
    });
  };
  return { requests, fetch: fetchImpl };
}

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

  const fake = smokeFetch();
  const requests = fake.requests;
  await runRuntimeSmokeChecks(
    smokeEnv([
      [WORKER_VERSION_OVERRIDE_ENV_NAME, versionId],
      ["AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY", "1"]
    ]),
    { fetchImpl: fake.fetch }
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
  assert.equal(
    requests[0].url.includes("/api/runtime/canary"),
    true,
    "override smoke must prove the candidate SHA before any probe"
  );
  assert.equal(
    requests.at(-1)?.url.includes("/api/runtime/canary"),
    true,
    "override smoke must prove the candidate SHA again after probes"
  );
  assert.deepEqual(
    requests
      .filter((request) => request.redirect === "manual")
      .map((request) => new URL(request.url).pathname),
    ["/sign-in", "/sign-out", "/human"]
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

const errorCanaryPath = "/api/runtime/error";

test("runtime smoke sends its own invalid bearer and accepts any error canary envelope", async () => {
  for (const ok of [undefined, true, false]) {
    const fake = smokeFetch((pathName) =>
      pathName === errorCanaryPath
        ? jsonResponse(
            { ok, code: "structured_error_canary", error_id: "err_test" },
            500
          )
        : undefined
    );
    assert.deepEqual(
      await runRuntimeSmokeChecks(smokeEnv(), { fetchImpl: fake.fetch }),
      { ok: true },
      `error canary with ok=${String(ok)} must pass smoke`
    );
    assert.deepEqual(
      fake.requests
        .filter((request) => request.url.endsWith("/api/runtime/caller-auth"))
        .map((request) => request.headers.Authorization),
      [undefined, "Bearer wrong-token", "Bearer smoke-token"]
    );
  }
});

for (const { label, env = [], override, rejection } of [
  {
    label: "the error canary returns the wrong status",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === errorCanaryPath
        ? jsonResponse({ code: "structured_error_canary", error_id: "err_x" })
        : undefined,
    rejection: {
      message:
        /^https:\/\/app\.agent-outbox\.dev\/api\/runtime\/error returned 200(?:\n|$)/,
      actual: 200,
      expected: 500,
      operator: "strictEqual"
    }
  },
  {
    label: "the error canary returns the wrong code",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === errorCanaryPath
        ? jsonResponse({ code: "other_code", error_id: "err_x" }, 500)
        : undefined,
    rejection: {
      message:
        /^\/api\/runtime\/error did not return the structured error canary(?:\n|$)/,
      actual: "other_code",
      expected: "structured_error_canary",
      operator: "strictEqual"
    }
  },
  {
    label: "the error canary returns an unsafe error id",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === errorCanaryPath
        ? jsonResponse(
            { code: "structured_error_canary", error_id: "unsafe" },
            500
          )
        : undefined,
    rejection: {
      message: "/api/runtime/error did not return a safe error_id",
      actual: "unsafe",
      operator: "match"
    }
  },
  {
    label: "a page returns a server error",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === "/sign-in" ? jsonResponse({}, 500) : undefined,
    rejection: {
      message: "https://app.agent-outbox.dev/sign-in returned 500",
      actual: false,
      expected: true,
      operator: "=="
    }
  },
  {
    label: "a protected probe accepts a missing bearer",
    /** @param {string} pathName @param {Record<string, string>} headers */
    override: (pathName, headers) =>
      pathName === "/api/runtime/caller-auth" && !headers.Authorization
        ? jsonResponse({ ok: true })
        : undefined,
    rejection: {
      message:
        /^https:\/\/app\.agent-outbox\.dev\/api\/runtime\/caller-auth returned 200(?:\n|$)/,
      actual: 200,
      expected: 401,
      operator: "strictEqual"
    }
  },
  {
    label: "a protected probe returns the wrong rejection code",
    /** @param {string} pathName @param {Record<string, string>} headers */
    override: (pathName, headers) =>
      pathName === "/api/runtime/caller-auth" && !headers.Authorization
        ? jsonResponse({ ok: false, code: "wrong_code" }, 401)
        : undefined,
    rejection: {
      message:
        /^https:\/\/app\.agent-outbox\.dev\/api\/runtime\/caller-auth returned code=wrong_code(?:\n|$)/,
      actual: "wrong_code",
      expected: "missing_authorization",
      operator: "strictEqual"
    }
  },
  {
    label: "the runtime canary reports ok=false",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === "/api/runtime/canary"
        ? jsonResponse({ ok: false, code: "unconfigured" })
        : undefined,
    rejection: {
      message:
        /^https:\/\/app\.agent-outbox\.dev\/api\/runtime\/canary returned ok=false(?:\n|$)/,
      actual: false,
      expected: true,
      operator: "strictEqual"
    }
  },
  {
    label: "the deployment reports a different release",
    /** @param {string} pathName */
    override: (pathName) =>
      pathName === "/api/runtime/canary"
        ? jsonResponse({
            ok: true,
            environment: { configured: true, release: "previous-sha" }
          })
        : undefined,
    rejection: {
      message:
        /^\/api\/runtime\/canary did not report the expected deployed release(?:\n|$)/,
      actual: "previous-sha",
      expected: "expected-sha",
      operator: "strictEqual"
    }
  },
  {
    label: "the required human review query is not proven",
    env: /** @type {Array<[string, string]>} */ ([
      ["AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY", "1"]
    ]),
    /** @param {string} pathName @param {Record<string, string>} headers */
    override: (pathName, headers) =>
      pathName === "/api/runtime/database" && headers.Authorization
        ? jsonResponse({
            ok: true,
            transaction_context_matched: true,
            restricted_role_matched: true
          })
        : undefined,
    rejection: {
      message:
        /^\/api\/runtime\/database did not prove the human review query(?:\n|$)/,
      expected: true,
      operator: "strictEqual"
    }
  }
]) {
  test(`runtime smoke rejects when ${label}`, async () => {
    const fake = smokeFetch(override);
    await assert.rejects(
      runRuntimeSmokeChecks(smokeEnv(env), { fetchImpl: fake.fetch }),
      { name: "AssertionError", code: "ERR_ASSERTION", ...rejection }
    );
  });
}

test("runtime smoke rethrows original network and JSON errors", async () => {
  const network = new TypeError("fetch failed", {
    cause: new Error("getaddrinfo ENOTFOUND app.agent-outbox.dev")
  });
  await assert.rejects(
    runRuntimeSmokeChecks(smokeEnv(), {
      fetchImpl: smokeFetch((pathName) => {
        if (pathName === "/human") {
          throw network;
        }
      }).fetch
    }),
    (error) => error === network
  );

  const syntax = new SyntaxError("Unexpected token < in JSON");
  await assert.rejects(
    runRuntimeSmokeChecks(smokeEnv(), {
      fetchImpl: smokeFetch((pathName) =>
        pathName === "/api/runtime/canary"
          ? {
              ok: true,
              status: 200,
              json: async () => {
                throw syntax;
              }
            }
          : undefined
      ).fetch
    }),
    (error) => error === syntax
  );
});

test("runtime smoke validates the version override before sending requests", async () => {
  const fetchImpl = async () => assert.fail("fetch must not be called");
  await assert.rejects(
    runRuntimeSmokeChecks(
      new Map([
        ["APP_BASE_URL", "https://app.agent-outbox.dev"],
        ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"],
        [WORKER_VERSION_OVERRIDE_ENV_NAME, "not-a-version"]
      ]),
      { fetchImpl }
    ),
    {
      message: `${WORKER_VERSION_OVERRIDE_ENV_NAME} must be a Worker version UUID`
    }
  );
  await assert.rejects(
    runRuntimeSmokeChecks(
      new Map([
        ["APP_BASE_URL", "https://app.agent-outbox.dev"],
        ["SMOKE_OR_CLEANUP_TOKEN", "smoke-token"],
        [
          WORKER_VERSION_OVERRIDE_ENV_NAME,
          "123e4567-e89b-12d3-a456-426614174000"
        ]
      ]),
      { fetchImpl }
    ),
    {
      message: `AGENT_OUTBOX_EXPECTED_RELEASE is required when ${WORKER_VERSION_OVERRIDE_ENV_NAME} is set`
    }
  );
});

test("runtime smoke applies process overrides only to an existing env file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-outbox-smoke-env-"));
  const versionId = "123e4567-e89b-12d3-a456-426614174000";
  const overrides = {
    [WORKER_VERSION_OVERRIDE_ENV_NAME]: versionId,
    AGENT_OUTBOX_EXPECTED_RELEASE: "expected-sha"
  };
  const overrideEntries = {
    [WORKER_VERSION_OVERRIDE_ENV_NAME]: versionId,
    AGENT_OUTBOX_EXPECTED_RELEASE: "expected-sha"
  };
  try {
    assert.deepEqual(
      Object.fromEntries(readRuntimeSmokeEnv({ env: overrides, root })),
      {},
      "an absent default .env must not yield override-only configuration"
    );
    assert.deepEqual(
      Object.fromEntries(
        readRuntimeSmokeEnv({
          env: {
            ...overrides,
            AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
            APP_BASE_URL: "https://app.agent-outbox.dev",
            SMOKE_OR_CLEANUP_TOKEN: "smoke-token"
          },
          root
        })
      ),
      {
        APP_BASE_URL: "https://app.agent-outbox.dev",
        SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
        ...overrideEntries
      },
      "process-env mode does not depend on the default .env"
    );
    assert.throws(
      () =>
        readRuntimeSmokeEnv({
          env: {
            ...overrides,
            AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: path.join(root, "missing.env")
          },
          root
        }),
      {
        message: `Runtime smoke env file does not exist: ${path.join(root, "missing.env")}`
      }
    );

    const explicitEmpty = path.join(root, "explicit-empty.env");
    writeFileSync(explicitEmpty, "");
    assert.deepEqual(
      Object.fromEntries(
        readRuntimeSmokeEnv({
          env: {
            ...overrides,
            AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: explicitEmpty
          },
          root
        })
      ),
      overrideEntries
    );

    writeFileSync(path.join(root, ".env"), "");
    assert.deepEqual(
      Object.fromEntries(readRuntimeSmokeEnv({ env: overrides, root })),
      overrideEntries,
      "an existing empty default .env still receives process overrides"
    );

    writeFileSync(
      path.join(root, ".env"),
      "APP_BASE_URL=https://app.agent-outbox.dev\nAGENT_OUTBOX_EXPECTED_RELEASE=file-sha\n"
    );
    assert.deepEqual(
      Object.fromEntries(readRuntimeSmokeEnv({ env: overrides, root })),
      { APP_BASE_URL: "https://app.agent-outbox.dev", ...overrideEntries }
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runtime smoke sends each probe only the request options it needs", async () => {
  /** @type {Array<{ path: string, init: Record<string, unknown> }>} */
  const calls = [];
  const fake = smokeFetch();
  await runRuntimeSmokeChecks(smokeEnv(), {
    fetchImpl: async (url, init = {}) => {
      calls.push({ path: new URL(String(url)).pathname, init: { ...init } });
      return fake.fetch(url, init);
    }
  });

  const smokeAuth = { Authorization: "Bearer smoke-token" };
  const marked = { "x-agent-outbox-runtime-smoke": "1", ...smokeAuth };
  assert.deepEqual(
    calls.map(({ path: pathName, init }) => {
      assert.ok(init.signal instanceof AbortSignal, pathName);
      const { signal, ...rest } = init;
      return [pathName, Reflect.ownKeys(init), rest];
    }),
    [
      [
        "/sign-in",
        ["redirect", "headers", "signal"],
        { redirect: "manual", headers: {} }
      ],
      [
        "/sign-out",
        ["redirect", "headers", "signal"],
        { redirect: "manual", headers: {} }
      ],
      [
        "/human",
        ["redirect", "headers", "signal"],
        { redirect: "manual", headers: {} }
      ],
      ["/api/runtime/canary", ["headers", "signal"], { headers: smokeAuth }],
      ["/api/runtime/caller-auth", ["headers", "signal"], { headers: {} }],
      [
        "/api/runtime/caller-auth",
        ["headers", "signal"],
        { headers: { Authorization: "Bearer wrong-token" } }
      ],
      [
        "/api/runtime/caller-auth",
        ["headers", "signal"],
        { headers: smokeAuth }
      ],
      ["/api/runtime/database", ["headers", "signal"], { headers: {} }],
      ["/api/runtime/database", ["headers", "signal"], { headers: smokeAuth }],
      ["/api/runtime/log", ["headers", "signal"], { headers: smokeAuth }],
      [
        "/api/runtime/scheduled",
        ["method", "headers", "signal"],
        { method: "POST", headers: smokeAuth }
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
