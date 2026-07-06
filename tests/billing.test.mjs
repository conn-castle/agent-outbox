import assert from "node:assert/strict";
import test from "node:test";

import {
  billingRuntimeConfig,
  checkoutIntervalFromRequest,
  createBillingPortalSessionForAccount,
  createCheckoutSessionForAccount,
  handleStripeWebhookRequest,
  processStripeEventInTransaction,
  requiredBillingConfiguration
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

test("billing API session returns a JSON-envelope auth error when signed out", async () => {
  let resolveCalls = 0;
  const result = await billingHumanSessionFromClerkUser({
    requestId: "req-billing-session",
    clerkUserId: null,
    connectionString: "postgresql://billing-test",
    async resolveSession() {
      resolveCalls += 1;
      throw new Error("resolveSession should not run without a Clerk user.");
    }
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
    contexts: /** @type {any[]} */ ([]),
    statements: /** @type {any[]} */ ([]),
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
    connectionString: "postgresql://billing-test",
    accountId,
    userId,
    requestId: "req-billing-checkout",
    interval: "monthly",
    config,
    stripe,
    async runTransaction(connectionString, context, callback) {
      assert.equal(connectionString, "postgresql://billing-test");
      calls.contexts.push(context);
      return callback(
        /** @type {any} */ (
          async (/** @type {any} */ statement) => {
            calls.statements.push(statement);
            return queryResult([
              {
                account_id: accountId,
                tier: "hosted_free",
                billing_status: "not_applicable",
                stripe_customer_id: null
              }
            ]);
          }
        )
      );
    }
  });

  assert.deepEqual(result, {
    ok: true,
    data: { url: "https://checkout.stripe.test/session" }
  });
  assert.deepEqual(calls.contexts, [
    {
      requestId: "req-billing-checkout",
      authSurface: "human",
      accountId,
      userId
    }
  ]);
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

test("yearly checkout uses the yearly Stripe price id", async () => {
  const checkoutInputs = /** @type {any[]} */ ([]);
  const result = await createCheckoutSessionForAccount({
    connectionString: "postgresql://billing-test",
    accountId,
    userId,
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
    }),
    async runTransaction(_connectionString, _context, callback) {
      return callback(
        /** @type {any} */ (
          async () =>
            queryResult([
              {
                account_id: accountId,
                tier: "hosted_free",
                billing_status: "not_applicable",
                stripe_customer_id: null
              }
            ])
        )
      );
    }
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
      connectionString: "postgresql://billing-test",
      accountId,
      userId,
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
      }),
      async runTransaction() {
        throw new Error("account lookup should not run");
      }
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
    connectionString: "postgresql://billing-test",
    accountId,
    userId,
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
    }),
    async runTransaction(_connectionString, _context, callback) {
      return callback(
        /** @type {any} */ (
          async () =>
            queryResult([
              {
                account_id: accountId,
                tier: "hosted_paid",
                billing_status: "active",
                stripe_customer_id: "cus_test"
              }
            ])
        )
      );
    }
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
    connectionString: "postgresql://billing-test",
    accountId,
    userId,
    requestId: "req-billing-portal",
    config,
    stripe: /** @type {any} */ ({
      checkout: { sessions: { async create() {} } },
      billingPortal: { sessions: { async create() {} } },
      webhooks: { constructEvent() {} }
    }),
    async runTransaction(_connectionString, _context, callback) {
      return callback(
        /** @type {any} */ (
          async () =>
            queryResult([
              {
                account_id: accountId,
                tier: "hosted_free",
                billing_status: "not_applicable",
                stripe_customer_id: null
              }
            ])
        )
      );
    }
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
    contexts: /** @type {any[]} */ ([]),
    portalInputs: /** @type {any[]} */ ([])
  };
  const result = await createBillingPortalSessionForAccount({
    connectionString: "postgresql://billing-test",
    accountId,
    userId,
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
    }),
    async runTransaction(connectionString, context, callback) {
      assert.equal(connectionString, "postgresql://billing-test");
      calls.contexts.push(context);
      return callback(
        /** @type {any} */ (
          async () =>
            queryResult([
              {
                account_id: accountId,
                tier: "hosted_paid",
                billing_status: "active",
                stripe_customer_id: "cus_test"
              }
            ])
        )
      );
    }
  });

  assert.deepEqual(result, {
    ok: true,
    data: { url: "https://billing.stripe.test/session" }
  });
  assert.deepEqual(calls.contexts, [
    {
      requestId: "req-billing-portal-success",
      authSurface: "human",
      accountId,
      userId
    }
  ]);
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
      payload: '{"id":"evt_checkout_completed"}',
      signature: "signed",
      secret: "whsec_placeholder"
    }
  ]);
  assert.deepEqual(calls.contexts, [
    { requestId: "req-webhook", authSurface: "control_plane" }
  ]);
  assert.equal(calls.statements.length, 3);
  assert.deepEqual(calls.statements[2].values, [
    "evt_checkout_completed",
    accountId
  ]);
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
  assert.deepEqual(statements.at(-1).values, ["evt_array_subscription", null]);
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
