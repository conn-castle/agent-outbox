import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  billingSmokeSummary,
  exitCodeForBillingSmoke,
  readBillingSmokeEnv,
  runBillingSmokeChecks
} from "../scripts/billing-smoke.mjs";

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
  assert.equal(exitCodeForBillingSmoke(checks), 1);
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
  const summary = billingSmokeSummary(checks);

  assert.equal(calls, 0);
  assert.equal(exitCodeForBillingSmoke(checks), 2);
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
  const summary = billingSmokeSummary(checks);

  assert.equal(exitCodeForBillingSmoke(checks), 2);
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

  assert.equal(exitCodeForBillingSmoke(checks), 1);
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
  assert.equal(exitCodeForBillingSmoke(checks), 1);
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
  assert.equal(exitCodeForBillingSmoke(checks), 2);
});
