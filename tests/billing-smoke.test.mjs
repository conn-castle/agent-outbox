import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readBillingSmokeEnv,
  runBillingSmokeChecks
} from "../scripts/billing-smoke.mjs";
import { checksSummary, exitCodeForChecks } from "../scripts/hosted-checks.mjs";

function baseEnv(overrides = {}) {
  return new Map(
    Object.entries({
      APP_BASE_URL: "https://app.agent-outbox.dev",
      PUBLIC_APP_BASE_URL: "https://app.agent-outbox.dev",
      STRIPE_PAID_MONTHLY_PRICE_ID: "price_monthly",
      STRIPE_PAID_YEARLY_PRICE_ID: "price_yearly",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_portal",
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

test("billing smoke session checks report request failures", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({ AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=smoke-session" }),
    {
      fetchImpl: async () => {
        throw new Error("boom");
      }
    }
  );
  for (const name of [
    "checkout_monthly",
    "checkout_yearly",
    "billing_portal_session"
  ]) {
    const actual = checks.find((entry) => entry.name === name);
    const expected = {
      name,
      status: "fail",
      code: "request_failed",
      message: "boom"
    };
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected));
  }
});

test("billing smoke session checks fall back to unexpected-response codes", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({ AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=smoke-session" }),
    { fetchImpl: /** @type {any} */ (async () => jsonResponse(500, {})) }
  );
  for (const [name, code, message] of [
    [
      "checkout_monthly",
      "checkout_unexpected_response",
      "monthly Checkout session was not created."
    ],
    [
      "checkout_yearly",
      "checkout_unexpected_response",
      "yearly Checkout session was not created."
    ],
    [
      "billing_portal_session",
      "portal_unexpected_response",
      "Billing Portal session was not created."
    ]
  ]) {
    const actual = checks.find((entry) => entry.name === name);
    const expected = { name, status: "fail", code, message, status_code: 500 };
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected));
  }
});

test("billing smoke catches invalid base URLs in session checks", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({
      APP_BASE_URL: "not a url",
      PUBLIC_APP_BASE_URL: "not a url",
      AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=smoke-session"
    }),
    { fetchImpl: async () => assert.fail("fetch must not be called") }
  );
  for (const name of [
    "checkout_monthly",
    "checkout_yearly",
    "billing_portal_session"
  ]) {
    const actual = checks.find((entry) => entry.name === name);
    assert.equal(actual?.status, "fail");
    assert.equal(actual?.code, "request_failed");
  }
});

test("billing smoke CLI reports env-file failures, summaries, and exit codes", async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "billing-smoke-cli-"));
  try {
    const missingPath = path.join(tempDir, "missing.env");
    const emptyPath = path.join(tempDir, "empty.env");
    writeFileSync(emptyPath, "");
    const configuredPath = path.join(tempDir, "configured.env");
    writeFileSync(
      configuredPath,
      [...baseEnv()].map(([name, value]) => `${name}=${value}`).join("\n")
    );
    const missingConfiguration = {
      ok: false,
      action_required: false,
      checks: [
        {
          name: "configuration",
          status: "fail",
          code: "missing_configuration",
          message:
            "Missing required values: APP_BASE_URL, PUBLIC_APP_BASE_URL, STRIPE_PAID_MONTHLY_PRICE_ID, STRIPE_PAID_YEARLY_PRICE_ID, STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
        }
      ]
    };
    const cookieRequired = checksSummary(
      await runBillingSmokeChecks(baseEnv())
    );
    assert.equal(cookieRequired.action_required, true);
    for (const { label, envPath, status, stdout, stderr } of [
      {
        label: "missing explicit file",
        envPath: missingPath,
        status: 1,
        stdout: "",
        stderr: `Billing smoke env file does not exist: ${missingPath}\n`
      },
      {
        label: "empty explicit file",
        envPath: emptyPath,
        status: 1,
        stdout: JSON.stringify(missingConfiguration, null, 2) + "\n",
        stderr: ""
      },
      {
        label: "configured file without a session cookie",
        envPath: configuredPath,
        status: 2,
        stdout: JSON.stringify(cookieRequired, null, 2) + "\n",
        stderr: ""
      }
    ]) {
      await t.test(label, () => {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../scripts/billing-smoke.mjs", import.meta.url)
            )
          ],
          {
            env: {
              NODE_ENV: "test",
              AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE: envPath
            },
            encoding: "utf8"
          }
        );
        assert.equal(result.status, status);
        assert.equal(result.stdout, stdout);
        assert.equal(result.stderr, stderr);
      });
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("billing smoke fails loud when required env is missing", async () => {
  const checks = await runBillingSmokeChecks(new Map());

  assert.deepEqual(checks, [
    {
      name: "configuration",
      status: "fail",
      code: "missing_configuration",
      message:
        "Missing required values: APP_BASE_URL, PUBLIC_APP_BASE_URL, STRIPE_PAID_MONTHLY_PRICE_ID, STRIPE_PAID_YEARLY_PRICE_ID, STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
    }
  ]);
  assert.equal(exitCodeForChecks(checks), 1);
});

test("billing smoke reads explicit env file before runtime smoke fallback", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "billing-smoke-env-"));
  try {
    const billingPath = path.join(tempDir, "billing.env");
    const runtimePath = path.join(tempDir, "runtime.env");
    writeFileSync(billingPath, "APP_BASE_URL=https://billing.example\n");
    writeFileSync(runtimePath, "APP_BASE_URL=https://runtime.example\n");

    assert.equal(
      readBillingSmokeEnv({
        env: {
          AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE: billingPath,
          AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE: runtimePath
        },
        root: tempDir
      }).get("APP_BASE_URL"),
      "https://billing.example"
    );
    assert.equal(
      readBillingSmokeEnv({
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

test("billing smoke requires a Clerk session before creating hosted sessions", async () => {
  let calls = 0;
  const checks = await runBillingSmokeChecks(baseEnv(), {
    fetchImpl: /** @type {any} */ (
      async () => {
        calls += 1;
        return jsonResponse(500, { ok: false, code: "unexpected" });
      }
    )
  });
  const summary = checksSummary(checks);

  assert.equal(calls, 0);
  assert.equal(exitCodeForChecks(checks), 2);
  assert.equal(summary.action_required, true);
  assert.deepEqual(
    checks
      .filter((entry) => entry.status === "action_required")
      .map((entry) => entry.name),
    ["checkout_sessions", "billing_portal_session"]
  );
});

test("billing smoke creates no-charge session checks without leaking cookie", async () => {
  const requests = /** @type {Array<{ url: string, init: any }>} */ ([]);
  const checks = await runBillingSmokeChecks(
    baseEnv({
      AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=super-secret-cookie"
    }),
    {
      fetchImpl: /** @type {any} */ (
        async (
          /** @type {string | URL} */ url,
          /** @type {any} */ init = {}
        ) => {
          requests.push({ url: String(url), init });
          const pathname = new URL(url).pathname;
          if (pathname === "/api/billing/checkout") {
            return jsonResponse(200, {
              ok: true,
              data: { url: "https://checkout.stripe.com/c/session" }
            });
          }
          if (pathname === "/api/billing/portal") {
            return jsonResponse(200, {
              ok: true,
              data: { url: "https://billing.stripe.com/session" }
            });
          }
          return jsonResponse(404, { ok: false, code: "not_found" });
        }
      )
    }
  );
  const summary = checksSummary(checks);

  assert.equal(exitCodeForChecks(checks), 2);
  assert.equal(summary.action_required, true);
  assert.equal(JSON.stringify(summary).includes("super-secret-cookie"), false);
  assert.deepEqual(
    checks
      .filter((entry) => entry.status === "pass")
      .map((entry) => entry.name),
    [
      "public_urls",
      "price_config",
      "portal_config",
      "checkout_monthly",
      "checkout_yearly",
      "billing_portal_session"
    ]
  );
  assert.equal(requests.length, 3);
  assert.ok(
    requests.every(
      (request) =>
        request.init.headers?.cookie === "session=super-secret-cookie"
    )
  );
});

test("billing smoke fails invalid hosted redirect configuration", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({
      PUBLIC_APP_BASE_URL: "http://localhost:38000"
    })
  );

  assert.equal(exitCodeForChecks(checks), 1);
  assert.equal(
    checks.find((entry) => entry.name === "public_urls")?.code,
    "public_urls_mismatch"
  );
});

test("billing smoke preserves status for non-JSON endpoint responses", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({
      AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=smoke-session"
    }),
    {
      fetchImpl: /** @type {any} */ (
        async (
          /** @type {string | URL} */ url,
          /** @type {any} */ init = {}
        ) => {
          if (new URL(url).pathname === "/api/billing/checkout") {
            return {
              ok: false,
              status: 502,
              async json() {
                throw new Error("not json");
              }
            };
          }
          return jsonResponse(200, {
            ok: true,
            data: { url: "https://billing.stripe.com/session" }
          });
        }
      )
    }
  );

  assert.deepEqual(
    checks.find((entry) => entry.name === "checkout_monthly"),
    {
      name: "checkout_monthly",
      status: "fail",
      code: "invalid_json_response",
      message: "monthly Checkout endpoint returned a non-JSON response.",
      status_code: 502
    }
  );
  assert.equal(exitCodeForChecks(checks), 1);
});

test("billing smoke treats missing Stripe customer as portal action_required", async () => {
  const checks = await runBillingSmokeChecks(
    baseEnv({
      AGENT_OUTBOX_BILLING_SMOKE_COOKIE: "session=smoke-session"
    }),
    {
      fetchImpl: /** @type {any} */ (
        async (
          /** @type {string | URL} */ url,
          /** @type {any} */ init = {}
        ) => {
          if (new URL(url).pathname === "/api/billing/checkout") {
            return jsonResponse(200, {
              ok: true,
              data: { url: "https://checkout.stripe.com/c/session" }
            });
          }
          return jsonResponse(400, {
            ok: false,
            error: { code: "invalid_request" }
          });
        }
      )
    }
  );

  assert.deepEqual(
    checks.find((entry) => entry.name === "billing_portal_session"),
    {
      name: "billing_portal_session",
      status: "action_required",
      code: "active_stripe_customer_required",
      message:
        "Billing Portal smoke requires an account with an existing Stripe customer."
    }
  );
  assert.equal(exitCodeForChecks(checks), 2);
});
