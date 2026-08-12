import assert from "node:assert/strict";
import test from "node:test";

import {
  billingRuntimeConfig,
  checkoutIntervalFromRequest,
  createBillingPortalSessionForAccount,
  createCheckoutSessionForAccount,
  handleStripeWebhookRequest,
  processStripeEventInTransaction,
  requiredBillingConfiguration,
  STRIPE_WEBHOOK_BODY_BYTE_LIMIT
} from "../src/server/billing.ts";
import { billingHumanSessionFromClerkUser } from "../src/server/billing-session.ts";
import { INPUT_REQUEST_BODY_BYTE_LIMIT } from "../src/server/input-schema.ts";

const config = {
  secretKey: "sk_test_placeholder",
  webhookSecret: "whsec_placeholder",
  priceIds: {
    monthly: "price_test_paid_monthly",
    yearly: "price_test_paid_yearly"
  },
  portalConfigurationId: "bpc_test",
  publicAppBaseUrl: "https://app.example.test"
};

const accountId = "00000000-0000-4000-8000-000000000701";
const userId = "00000000-0000-4000-8000-000000000702";
const billingEnvironmentNames = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "PUBLIC_APP_BASE_URL"
];

/**
 * @param {import("pg").QueryResultRow[]} rows
 * @returns {import("pg").QueryResult<import("pg").QueryResultRow>}
 */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

test("portal billing configuration requires the explicit Stripe portal configuration", () => {
  const previous = Object.fromEntries(
    billingEnvironmentNames.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of billingEnvironmentNames) {
      delete process.env[name];
    }
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.PUBLIC_APP_BASE_URL = "https://app.example.test";

    assert.deepEqual(requiredBillingConfiguration("portal"), [
      "STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
    ]);
    assert.deepEqual(billingRuntimeConfig("portal"), {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message:
          "Billing configuration is missing required variable names: STRIPE_BILLING_PORTAL_CONFIGURATION_ID."
      }
    });

    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_test";
    assert.equal(billingRuntimeConfig("portal").ok, true);
  } finally {
    for (const name of billingEnvironmentNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
});

test("checkout billing configuration requires both paid price ids", () => {
  const previous = Object.fromEntries(
    billingEnvironmentNames.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of billingEnvironmentNames) {
      delete process.env[name];
    }
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
    process.env.STRIPE_PAID_MONTHLY_PRICE_ID = "price_test_paid_monthly";
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_test";
    process.env.PUBLIC_APP_BASE_URL = "https://app.example.test";

    assert.deepEqual(requiredBillingConfiguration("checkout"), [
      "STRIPE_PAID_YEARLY_PRICE_ID"
    ]);
    assert.deepEqual(billingRuntimeConfig("all"), {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message:
          "Billing configuration is missing required variable names: STRIPE_PAID_YEARLY_PRICE_ID."
      }
    });

    process.env.STRIPE_PAID_YEARLY_PRICE_ID = "price_test_paid_yearly";
    assert.deepEqual(billingRuntimeConfig("checkout"), {
      ok: true,
      data: config
    });
  } finally {
    for (const name of billingEnvironmentNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
});

test("webhook billing configuration does not require the public app base URL", () => {
  const previous = Object.fromEntries(
    billingEnvironmentNames.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of billingEnvironmentNames) {
      delete process.env[name];
    }
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
    process.env.PUBLIC_APP_BASE_URL = "file:///stale-irrelevant-value";

    assert.deepEqual(billingRuntimeConfig("webhook"), {
      ok: true,
      data: {
        secretKey: "sk_test_placeholder",
        webhookSecret: "whsec_placeholder",
        priceIds: { monthly: "", yearly: "" },
        portalConfigurationId: "",
        publicAppBaseUrl: ""
      }
    });
  } finally {
    for (const name of billingEnvironmentNames) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
});

test("billing configuration rejects a non-origin public app URL", () => {
  const previous = Object.fromEntries(
    billingEnvironmentNames.map((name) => [name, process.env[name]])
  );
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_PAID_MONTHLY_PRICE_ID = "price_test_paid_monthly";
    process.env.STRIPE_PAID_YEARLY_PRICE_ID = "price_test_paid_yearly";
    process.env.PUBLIC_APP_BASE_URL = "file:///tmp/agent-outbox";

    assert.deepEqual(billingRuntimeConfig("checkout"), {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message:
          "Billing configuration has invalid PUBLIC_APP_BASE_URL; expected an absolute HTTP(S) origin."
      }
    });
  } finally {
    for (const name of billingEnvironmentNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("billing API session returns a JSON-envelope auth error when signed out", async () => {
  let resolveCalls = 0;
  const result = await billingHumanSessionFromClerkUser({
    context: {
      requestId: "req-billing-session",
      correlationId: "corr-billing-session",
      route: "/api/billing/checkout",
      method: "POST",
      startedAtMs: Date.now()
    },
    flow: "checkout",
    clerkUserId: null,
    runHumanTransaction: /** @type {any} */ (
      async () => {
        resolveCalls += 1;
        throw new Error(
          "runHumanTransaction should not run without a Clerk user."
        );
      }
    )
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 401,
      code: "authentication_required",
      message: "Authentication is required to manage billing."
    }
  });
  assert.equal(resolveCalls, 0);
});

test("billing API session forwards route context and preserves reported errors", async () => {
  const startedAtMs = Date.now();
  const result = await billingHumanSessionFromClerkUser({
    context: {
      requestId: "req-billing-session",
      correlationId: "corr-billing-session",
      route: "/api/billing/portal",
      method: "POST",
      startedAtMs
    },
    flow: "portal",
    clerkUserId: "user_billing_session",
    runHumanTransaction: /** @type {any} */ (
      async (/** @type {any} */ input) => {
        assert.deepEqual(input, {
          clerkUserId: "user_billing_session",
          requestId: "req-billing-session",
          errorId: "corr-billing-session",
          route: "/api/billing/portal",
          method: "POST",
          startedAtMs
        });
        return {
          ok: false,
          status: 503,
          code: "temporary_unavailable",
          message: "Human account session is temporarily unavailable.",
          errorId: "corr-billing-session",
          reported: true
        };
      }
    )
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Human account session is temporarily unavailable.",
      errorId: "corr-billing-session",
      reported: true
    }
  });
});

test("billing API session returns the account row resolved inside the transaction", async () => {
  const account = {
    account_id: accountId,
    tier: "hosted_free",
    billing_status: "not_applicable",
    stripe_customer_id: null
  };
  /** @type {any[]} */
  const lookupStatements = [];
  const result = await billingHumanSessionFromClerkUser({
    context: {
      requestId: "req-billing-account",
      correlationId: "corr-billing-account",
      route: "/api/billing/checkout",
      method: "POST",
      startedAtMs: Date.now()
    },
    flow: "checkout",
    clerkUserId: "user_billing_account",
    runHumanTransaction: /** @type {any} */ (
      async (/** @type {any} */ _input, /** @type {any} */ callback) => {
        const data = await callback(
          async (/** @type {any} */ statement) => {
            lookupStatements.push(statement);
            return queryResult([account]);
          },
          { accountId }
        );
        return { ok: true, session: {}, data };
      }
    )
  });

  assert.deepEqual(result, { ok: true, data: { account } });
  // The callback must actually run the account lookup keyed by the session's
  // account id, not synthesize the account from outside the transaction.
  assert.equal(lookupStatements.length, 1);
  assert.match(lookupStatements[0].sql, /from public\.agent_outbox_accounts/);
  assert.deepEqual(lookupStatements[0].values, [accountId]);
});

test("billing API session reports an unavailable account when the lookup returns no row", async () => {
  const result = await billingHumanSessionFromClerkUser({
    context: {
      requestId: "req-billing-account-missing",
      correlationId: "corr-billing-account-missing",
      route: "/api/billing/checkout",
      method: "POST",
      startedAtMs: Date.now()
    },
    flow: "checkout",
    clerkUserId: "user_billing_account_missing",
    runHumanTransaction: /** @type {any} */ (
      async (/** @type {any} */ _input, /** @type {any} */ callback) => {
        const data = await callback(async () => queryResult([]), { accountId });
        return { ok: true, session: {}, data };
      }
    )
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message: "Billing account is unavailable."
    }
  });
});

test("checkout interval request parsing rejects malformed or unsupported bodies", async () => {
  const invalidRequests = [
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST"
      }),
      status: 400,
      code: "invalid_json"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: "{"
      }),
      status: 400,
      code: "invalid_json"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: "null"
      }),
      status: 400,
      code: "invalid_request"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: "[]"
      }),
      status: 400,
      code: "invalid_request"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify("monthly")
      }),
      status: 400,
      code: "invalid_request"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ interval: "weekly" })
      }),
      status: 400,
      code: "invalid_request"
    },
    {
      request: new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          padding: "x".repeat(INPUT_REQUEST_BODY_BYTE_LIMIT)
        })
      }),
      status: 413,
      code: "request_too_large"
    }
  ];

  for (const { request, status, code } of invalidRequests) {
    const result = await checkoutIntervalFromRequest(request);
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("expected checkout interval validation failure");
    }
    assert.equal(result.error.status, status);
    assert.equal(result.error.code, code);
    assert.doesNotMatch(JSON.stringify(result), /price_test|sk_test|whsec/);
  }

  assert.deepEqual(
    await checkoutIntervalFromRequest(
      new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ interval: "monthly" })
      })
    ),
    { ok: true, data: "monthly" }
  );
  assert.deepEqual(
    await checkoutIntervalFromRequest(
      new Request("https://app.example.test/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ interval: "yearly" })
      })
    ),
    { ok: true, data: "yearly" }
  );
});

test("monthly checkout creates an account-scoped subscription session without exposing Stripe ids", async () => {
  const calls = {
    checkoutInputs: /** @type {any[]} */ ([])
  };
  const stripe = /** @type {any} */ ({
    checkout: {
      sessions: {
        /** @param {any} input */
        async create(input) {
          calls.checkoutInputs.push(input);
          return { url: "https://checkout.stripe.test/session" };
        }
      }
    },
    billingPortal: { sessions: { async create() {} } },
    webhooks: { constructEvent() {} }
  });

  const result = await createCheckoutSessionForAccount({
    account: {
      account_id: accountId,
      tier: "hosted_free",
      billing_status: "not_applicable",
      stripe_customer_id: null
    },
    requestId: "req-billing-checkout",
    interval: "monthly",
    config,
    stripe
  });

  assert.deepEqual(result, {
    ok: true,
    data: { url: "https://checkout.stripe.test/session" }
  });
  assert.equal(calls.checkoutInputs.length, 1);
  assert.deepEqual(calls.checkoutInputs[0], {
    mode: "subscription",
    customer: undefined,
    client_reference_id: accountId,
    line_items: [{ price: "price_test_paid_monthly", quantity: 1 }],
    success_url: "https://app.example.test/upgrade?checkout=success",
    cancel_url: "https://app.example.test/upgrade?checkout=cancelled",
    metadata: { account_id: accountId },
    subscription_data: { metadata: { account_id: accountId } }
  });
  assert.doesNotMatch(JSON.stringify(result), /cus_|sub_|sk_test|whsec/);
});

test("default Stripe checkout client uses fetch transport for Worker compatibility", async () => {
  const previousFetch = globalThis.fetch;
  const fetchCalls = /** @type {{ url: string; init?: RequestInit }[]} */ ([]);
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: "cs_test_worker_transport",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/pay/cs_test_worker_transport"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "req_worker_transport"
          }
        }
      );
    }
  );

  try {
    const result = await createCheckoutSessionForAccount({
      account: {
        account_id: accountId,
        tier: "hosted_free",
        billing_status: "not_applicable",
        stripe_customer_id: null
      },
      requestId: "req-billing-worker-transport",
      interval: "monthly",
      config
    });

    assert.deepEqual(result, {
      ok: true,
      data: {
        url: "https://checkout.stripe.com/c/pay/cs_test_worker_transport"
      }
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      "https://api.stripe.com/v1/checkout/sessions"
    );
    assert.equal(fetchCalls[0].init?.method, "POST");
    assert.equal(
      new URLSearchParams(String(fetchCalls[0].init?.body)).get(
        "line_items[0][price]"
      ),
      "price_test_paid_monthly"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("yearly checkout uses the yearly Stripe price id", async () => {
  const checkoutInputs = /** @type {any[]} */ ([]);
  const result = await createCheckoutSessionForAccount({
    account: {
      account_id: accountId,
      tier: "hosted_free",
      billing_status: "not_applicable",
      stripe_customer_id: null
    },
    requestId: "req-billing-checkout-yearly",
    interval: "yearly",
    config,
    stripe: /** @type {any} */ ({
      checkout: {
        sessions: {
          /** @param {any} input */
          async create(input) {
            checkoutInputs.push(input);
            return { url: "https://checkout.stripe.test/yearly-session" };
          }
        }
      },
      billingPortal: { sessions: { async create() {} } },
      webhooks: { constructEvent() {} }
    })
  });

  assert.deepEqual(result, {
    ok: true,
    data: { url: "https://checkout.stripe.test/yearly-session" }
  });
  assert.equal(checkoutInputs.length, 1);
  assert.deepEqual(checkoutInputs[0].line_items, [
    { price: "price_test_paid_yearly", quantity: 1 }
  ]);
});

test("checkout rejects missing or unsupported intervals before billing work", async () => {
  const invalidIntervals = [undefined, null, "", "weekly"];

  for (const interval of invalidIntervals) {
    const result = await createCheckoutSessionForAccount({
      account: {
        account_id: accountId,
        tier: "hosted_free",
        billing_status: "not_applicable",
        stripe_customer_id: null
      },
      requestId: "req-billing-checkout-invalid-interval",
      interval,
      config,
      stripe: /** @type {any} */ ({
        checkout: {
          sessions: {
            async create() {
              throw new Error("checkout should not be created");
            }
          }
        },
        billingPortal: { sessions: { async create() {} } },
        webhooks: { constructEvent() {} }
      })
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("expected checkout interval validation failure");
    }
    assert.equal(result.error.status, 400);
    assert.equal(result.error.code, "invalid_request");
  }
});

test("checkout rejects live billing accounts before creating another subscription", async () => {
  const checkoutInputs = /** @type {any[]} */ ([]);
  const result = await createCheckoutSessionForAccount({
    account: {
      account_id: accountId,
      tier: "hosted_paid",
      billing_status: "active",
      stripe_customer_id: "cus_test"
    },
    requestId: "req-billing-checkout-live",
    interval: "monthly",
    config,
    stripe: /** @type {any} */ ({
      checkout: {
        sessions: {
          /** @param {any} input */
          async create(input) {
            checkoutInputs.push(input);
            return { url: "https://checkout.stripe.test/session" };
          }
        }
      },
      billingPortal: { sessions: { async create() {} } },
      webhooks: { constructEvent() {} }
    })
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected live billing checkout rejection");
  }
  assert.equal(result.error.status, 400);
  assert.equal(
    result.error.message,
    "Active billing accounts must use the billing portal."
  );
  assert.equal(checkoutInputs.length, 0);
});

test("billing portal requires an existing Stripe customer", async () => {
  const result = await createBillingPortalSessionForAccount({
    account: {
      account_id: accountId,
      tier: "hosted_free",
      billing_status: "not_applicable",
      stripe_customer_id: null
    },
    requestId: "req-billing-portal",
    config,
    stripe: /** @type {any} */ ({
      checkout: { sessions: { async create() {} } },
      billingPortal: { sessions: { async create() {} } },
      webhooks: { constructEvent() {} }
    })
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected portal precondition failure");
  }
  assert.equal(result.error.status, 400);
  assert.equal(result.error.code, "invalid_request");
});

test("billing portal creates an account-scoped session with configured portal policy", async () => {
  const calls = {
    portalInputs: /** @type {any[]} */ ([])
  };
  const result = await createBillingPortalSessionForAccount({
    account: {
      account_id: accountId,
      tier: "hosted_paid",
      billing_status: "active",
      stripe_customer_id: "cus_test"
    },
    requestId: "req-billing-portal-success",
    config,
    stripe: /** @type {any} */ ({
      checkout: { sessions: { async create() {} } },
      billingPortal: {
        sessions: {
          /** @param {any} input */
          async create(input) {
            calls.portalInputs.push(input);
            return { url: "https://billing.stripe.test/session" };
          }
        }
      },
      webhooks: { constructEvent() {} }
    })
  });

  assert.deepEqual(result, {
    ok: true,
    data: { url: "https://billing.stripe.test/session" }
  });
  assert.deepEqual(calls.portalInputs, [
    {
      customer: "cus_test",
      return_url: "https://app.example.test/upgrade",
      configuration: "bpc_test"
    }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /cus_|bpc_|sk_test|whsec/);
});

test("webhook verifies the raw Stripe signature and records idempotent processing", async () => {
  const event = {
    id: "evt_checkout_completed",
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: accountId,
        customer: "cus_test",
        subscription: "sub_test",
        metadata: { account_id: accountId }
      }
    }
  };
  const calls = {
    construct: /** @type {any[]} */ ([]),
    contexts: /** @type {any[]} */ ([]),
    statements: /** @type {any[]} */ ([])
  };
  const stripe = /** @type {any} */ ({
    checkout: { sessions: { async create() {} } },
    billingPortal: { sessions: { async create() {} } },
    webhooks: {
      /**
       * @param {any} payload
       * @param {any} signature
       * @param {any} secret
       */
      constructEvent(payload, signature, secret) {
        calls.construct.push({ payload, signature, secret });
        return event;
      }
    }
  });
  const request = new Request("https://app.example.test/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": "signed" },
    body: '{"id":"evt_checkout_completed"}'
  });

  const result = await handleStripeWebhookRequest(
    request,
    { requestId: "req-webhook", correlationId: "corr-webhook" },
    {
      connectionString: "postgresql://billing-test",
      config,
      stripe,
      now: new Date("2026-07-05T00:00:00.000Z"),
      async runTransaction(connectionString, context, callback) {
        assert.equal(connectionString, "postgresql://billing-test");
        calls.contexts.push(context);
        return callback(
          /** @type {any} */ (
            async (/** @type {any} */ statement) => {
              calls.statements.push(statement);
              if (
                /insert into public\.agent_outbox_stripe_webhook_events/.test(
                  statement.sql
                )
              ) {
                return queryResult([
                  { stripe_event_id: "evt_checkout_completed" }
                ]);
              }
              if (
                /returning account_id::text as account_id/.test(statement.sql)
              ) {
                return queryResult([{ account_id: accountId }]);
              }
              return queryResult([]);
            }
          )
        );
      }
    }
  );

  assert.deepEqual(result, { ok: true, data: { processed: true } });
  assert.deepEqual(calls.construct, [
    {
      payload: Buffer.from('{"id":"evt_checkout_completed"}'),
      signature: "signed",
      secret: "whsec_placeholder"
    }
  ]);
  assert.deepEqual(calls.contexts, [
    { requestId: "req-webhook", authSurface: "control_plane" }
  ]);
  assert.equal(calls.statements.length, 3);
  assert.match(
    calls.statements[0].sql,
    /insert into public\.agent_outbox_stripe_webhook_events/
  );
  // Rollout tolerance: the insert must stay valid on the pre-default schema by
  // explicitly writing the completed state (see insertStripeWebhookEventStatement).
  assert.match(
    calls.statements[0].sql,
    /values \(\$1, \$2, 'processed', now\(\)\)/
  );
  assert.match(calls.statements[1].sql, /update public\.agent_outbox_accounts/);
  assert.match(
    calls.statements[2].sql,
    /update public\.agent_outbox_stripe_webhook_events[\s\S]*set account_id = \$2/
  );
  assert.deepEqual(calls.statements[2].values, [
    "evt_checkout_completed",
    accountId
  ]);
});

test("webhook rejects declared and streamed bodies over the raw-byte cap", async () => {
  let constructCalls = 0;
  const stripe = /** @type {any} */ ({
    checkout: { sessions: { async create() {} } },
    billingPortal: { sessions: { async create() {} } },
    webhooks: {
      constructEvent() {
        constructCalls += 1;
      }
    }
  });
  const context = {
    requestId: "req-webhook-large",
    correlationId: "corr-webhook-large"
  };
  const expected = {
    ok: false,
    error: {
      status: 413,
      code: "request_too_large",
      message: "Stripe webhook request body exceeds the 1048576-byte cap."
    }
  };

  const declared = new Request("https://app.example.test/api/billing/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "signed",
      "content-length": String(STRIPE_WEBHOOK_BODY_BYTE_LIMIT + 1)
    },
    body: "{}"
  });
  assert.deepEqual(
    await handleStripeWebhookRequest(declared, context, {
      connectionString: "postgresql://billing-test",
      config,
      stripe
    }),
    expected
  );

  const chunk = new Uint8Array(STRIPE_WEBHOOK_BODY_BYTE_LIMIT / 2 + 1);
  const streamedInit = {
    method: "POST",
    headers: { "stripe-signature": "signed" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      }
    }),
    duplex: "half"
  };
  const streamed = new Request(
    "https://app.example.test/api/billing/webhook",
    streamedInit
  );
  assert.deepEqual(
    await handleStripeWebhookRequest(streamed, context, {
      connectionString: "postgresql://billing-test",
      config,
      stripe
    }),
    expected
  );
  assert.equal(constructCalls, 0);
});

test("webhook replay stops before applying the event a second time", async () => {
  const statements = /** @type {any[]} */ ([]);
  const processed = await processStripeEventInTransaction(
    /** @type {any} */ (
      async (/** @type {any} */ statement) => {
        statements.push(statement);
        return queryResult([]);
      }
    ),
    /** @type {any} */ ({
      id: "evt_replayed",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: accountId } }
    })
  );

  assert.equal(processed, false);
  assert.equal(statements.length, 1);
});

test("webhook processing rejects array-shaped Stripe event objects", async () => {
  const statements = /** @type {any[]} */ ([]);
  const arrayLikeSubscription = Object.assign([], {
    id: "sub_array",
    customer: "cus_array",
    status: "active",
    items: { data: [{ price: { id: "price_test_paid_monthly" } }] }
  });
  const processed = await processStripeEventInTransaction(
    fakeTransitionQuery(statements),
    /** @type {any} */ ({
      id: "evt_array_subscription",
      type: "customer.subscription.updated",
      data: { object: arrayLikeSubscription }
    }),
    new Date("2026-07-05T00:00:00.000Z")
  );

  assert.equal(processed, true);
  assert.equal(
    statements.some((statement) =>
      /update public\.agent_outbox_accounts/.test(statement.sql)
    ),
    false
  );
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].values, [
    "evt_array_subscription",
    "customer.subscription.updated"
  ]);
});

test("subscription webhooks can update an account from Stripe metadata before checkout completion", async () => {
  const statements = /** @type {any[]} */ ([]);
  const event = {
    id: "evt_subscription_before_checkout",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_before_checkout",
        customer: "cus_before_checkout",
        status: "active",
        current_period_end: 1783555200,
        metadata: { account_id: accountId },
        items: {
          data: [{ price: { id: "price_test_paid_monthly" } }]
        }
      }
    }
  };

  await processStripeEventInTransaction(
    /** @type {any} */ (
      async (/** @type {any} */ statement) => {
        statements.push(statement);
        if (
          /insert into public\.agent_outbox_stripe_webhook_events/.test(
            statement.sql
          )
        ) {
          return queryResult([{ stripe_event_id: statement.values[0] }]);
        }
        if (/update public\.agent_outbox_accounts/.test(statement.sql)) {
          assert.match(statement.sql, /account_id = \$8/);
          assert.equal(statement.values[7], accountId);
          return queryResult([{ account_id: accountId }]);
        }
        return queryResult([]);
      }
    ),
    /** @type {any} */ (event),
    new Date("2026-07-05T00:00:00.000Z")
  );

  const update = statements.find((statement) =>
    /update public\.agent_outbox_accounts/.test(statement.sql)
  );
  assert.deepEqual(update.values, [
    "sub_before_checkout",
    "cus_before_checkout",
    "price_test_paid_monthly",
    "active",
    "active",
    null,
    "2026-07-09T00:00:00.000Z",
    accountId
  ]);
  assert.deepEqual(statements.at(-1).values, [
    "evt_subscription_before_checkout",
    accountId
  ]);
});

test("subscription and failed-payment events update grace state without raw payload storage", async () => {
  const statements = /** @type {any[]} */ ([]);
  const now = new Date("2026-07-05T00:00:00.000Z");
  const subscriptionEvent = {
    id: "evt_subscription_updated",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_test",
        customer: "cus_test",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: 1783555200,
        items: {
          data: [{ price: { id: "price_test_paid_monthly" } }]
        }
      }
    }
  };
  const failedPaymentEvent = {
    id: "evt_invoice_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        subscription: "sub_test",
        customer: "cus_test"
      }
    }
  };

  await processStripeEventInTransaction(
    fakeTransitionQuery(statements),
    /** @type {any} */ (subscriptionEvent),
    now
  );
  await processStripeEventInTransaction(
    fakeTransitionQuery(statements),
    /** @type {any} */ (failedPaymentEvent),
    now
  );

  const updateStatements = statements.filter((statement) =>
    /update public\.agent_outbox_accounts/.test(statement.sql)
  );
  assert.deepEqual(updateStatements[0].values, [
    "sub_test",
    "cus_test",
    "price_test_paid_monthly",
    "active",
    "grace",
    "2026-07-09T00:00:00.000Z",
    "2026-07-09T00:00:00.000Z",
    null
  ]);
  assert.deepEqual(updateStatements[1].values, [
    "sub_test",
    "cus_test",
    null,
    "payment_failed",
    "past_due",
    "2026-07-12T00:00:00.000Z",
    null,
    null
  ]);
  assert.doesNotMatch(
    JSON.stringify(statements),
    /request_body|raw|card|email|cus_test@example/i
  );
});

/**
 * @param {any[]} statements
 * @returns {any}
 */
function fakeTransitionQuery(statements) {
  return async (/** @type {any} */ statement) => {
    statements.push(statement);
    if (
      /insert into public\.agent_outbox_stripe_webhook_events/.test(
        statement.sql
      )
    ) {
      return queryResult([{ stripe_event_id: statement.values[0] }]);
    }
    if (/returning account_id::text as account_id/.test(statement.sql)) {
      return queryResult([{ account_id: accountId }]);
    }
    return queryResult([]);
  };
}
