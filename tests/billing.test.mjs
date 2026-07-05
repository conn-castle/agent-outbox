import assert from "node:assert/strict";
import test from "node:test";

import {
  billingRuntimeConfig,
  createBillingPortalSessionForAccount,
  createCheckoutSessionForAccount,
  handleStripeWebhookRequest,
  processStripeEventInTransaction,
  requiredBillingConfiguration
} from "../src/server/billing.ts";

const config = {
  secretKey: "sk_test_placeholder",
  webhookSecret: "whsec_placeholder",
  priceId: "price_test_paid_monthly",
  portalConfigurationId: "bpc_test",
  publicAppBaseUrl: "https://app.example.test"
};

const accountId = "00000000-0000-4000-8000-000000000701";
const userId = "00000000-0000-4000-8000-000000000702";
const billingEnvironmentNames = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
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

test("checkout creates an account-scoped subscription session without exposing Stripe ids", async () => {
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
    "2026-07-09T00:00:00.000Z"
  ]);
  assert.deepEqual(updateStatements[1].values, [
    "sub_test",
    "cus_test",
    null,
    "payment_failed",
    "past_due",
    "2026-07-12T00:00:00.000Z",
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
