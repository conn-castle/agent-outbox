import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import Stripe from "stripe";
import { captureStructuredLogs } from "./helpers/structured-logs.mjs";

import {
  createCheckoutSessionForAccount,
  handleStripeWebhookRequest
} from "../src/server/billing.ts";
import { scheduledCleanupStatementsForAccount } from "../src/server/scheduled.ts";
import { runProductTransaction } from "../src/server/database.ts";
import { bootstrapClerkHumanInTransaction } from "../src/server/human-session.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  phase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown
} from "./helpers/database.mjs";

const databaseUrl = phase3DatabaseVerificationUrl();
const config = {
  secretKey: "sk_test_fake",
  webhookSecret: "whsec_fake",
  priceIds: { monthly: "price_month", yearly: "price_year" },
  portalConfigurationId: "bpc_fake",
  publicAppBaseUrl: "https://billing.example.test"
};
const gated = { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP };

function deferred() {
  let resolve = /** @type {(value?: any) => void} */ (() => {});
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeStripe() {
  const calls = /** @type {any[]} */ ([]);
  const sessions = new Map();
  const keys = new Map();
  const subscriptions = new Map();
  const expired = /** @type {string[]} */ ([]);
  const hooks = /** @type {any} */ ({});
  const stripe = {
    calls,
    sessions,
    subscriptionObjects: subscriptions,
    expired,
    hooks,
    checkout: {
      sessions: {
        async create(
          /** @type {any} */ parameters,
          /** @type {any} */ options
        ) {
          calls.push({
            parameters: structuredClone(parameters),
            options: { ...options }
          });
          if (hooks.beforeCreate) await hooks.beforeCreate(parameters, options);
          let session = keys.get(options.idempotencyKey);
          if (!session) {
            session = {
              id: `cs_fake_${crypto.randomUUID()}`,
              status: "open",
              payment_status: "unpaid",
              client_reference_id: parameters.client_reference_id,
              metadata: parameters.metadata,
              subscription: null,
              url: `https://checkout.example.test/${options.idempotencyKey}`
            };
            keys.set(options.idempotencyKey, session);
            sessions.set(session.id, session);
          }
          if (hooks.afterCreate) await hooks.afterCreate(session);
          return structuredClone(session);
        },
        async retrieve(/** @type {string} */ id) {
          if (hooks.retrieve) await hooks.retrieve(id);
          assert.ok(sessions.has(id), "fake session must exist");
          return structuredClone(sessions.get(id));
        },
        async expire(/** @type {string} */ id) {
          expired.push(id);
          if (hooks.expire) await hooks.expire(id);
          const session = sessions.get(id);
          if (session.status !== "open")
            throw new Error("Only open sessions can expire");
          session.status = "expired";
          return structuredClone(session);
        }
      }
    },
    subscriptions: {
      async retrieve(/** @type {string} */ id) {
        if (hooks.subscriptionRetrieve) await hooks.subscriptionRetrieve(id);
        assert.ok(subscriptions.has(id));
        return structuredClone(subscriptions.get(id));
      }
    },
    webhooks: {
      constructEvent(/** @type {Buffer} */ body) {
        return JSON.parse(body.toString());
      }
    }
  };
  return stripe;
}

/** @param {(fixture: any) => Promise<void>} body */
async function fixture(body) {
  assert.ok(databaseUrl);
  const owner = new pg.Client({ connectionString: databaseUrl });
  await owner.connect();
  const eventIds = /** @type {string[]} */ ([]);
  const clerkUserId = `billing-owned-${crypto.randomUUID()}`;
  const restricted = (
    /** @type {any} */ context,
    /** @type {any} */ callback
  ) =>
    runProductTransaction(databaseUrl, context, async (query) => {
      await query({ sql: "set local role agent_outbox_app" });
      const role = await query({ sql: "select current_user as role" });
      assert.equal(role.rows[0].role, "agent_outbox_app");
      return callback(query);
    });
  let identity = /** @type {any} */ (undefined);
  let bodyError;
  try {
    identity = await restricted(
      { requestId: clerkUserId, authSurface: "human", clerkUserId },
      (/** @type {any} */ query) =>
        bootstrapClerkHumanInTransaction(query, clerkUserId)
    );
    assert.equal(identity.ok, true);
    const accountId = identity.accountId;
    const context = {
      requestId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      route: "/api/billing/checkout",
      method: "POST"
    };
    const run = (/** @type {any} */ callback) =>
      restricted(
        {
          ...context,
          authSurface: "human",
          accountId,
          userId: identity.userId
        },
        callback
      );
    const stripe = fakeStripe();
    const account =
      /** @type {import("../src/server/billing.ts").BillingAccount} */ ({
        account_id: accountId,
        tier: "hosted_free",
        billing_status: "not_applicable",
        stripe_customer_id: null
      });
    const checkout = (interval = "monthly", overrides = {}) =>
      createCheckoutSessionForAccount({
        account,
        interval,
        context,
        config,
        stripe: /** @type {any} */ (stripe),
        runCheckoutTransaction: /** @type {any} */ (run),
        ...overrides
      });
    const read = async () => {
      const accounts = await owner.query(
        "select * from public.agent_outbox_accounts where account_id = $1",
        [accountId]
      );
      const attempts = await owner.query(
        "select * from public.agent_outbox_billing_checkout_attempts where account_id = $1",
        [accountId]
      );
      return { account: accounts.rows[0], attempt: attempts.rows[0] };
    };
    const webhook = async (
      /** @type {string} */ type,
      /** @type {any} */ object,
      created = 1791576000,
      id = `evt_fake_${crypto.randomUUID()}`
    ) => {
      eventIds.push(id);
      return handleStripeWebhookRequest(
        new Request("https://billing.example.test/api/billing/webhook", {
          method: "POST",
          headers: { "stripe-signature": "fake" },
          body: JSON.stringify({ id, type, created, data: { object } })
        }),
        { ...context, route: "/api/billing/webhook" },
        {
          connectionString: databaseUrl,
          config,
          stripe: /** @type {any} */ (stripe),
          runTransaction: /** @type {any} */ (
            (
              /** @type {any} */ _url,
              /** @type {any} */ ctx,
              /** @type {any} */ cb
            ) => restricted(ctx, cb)
          )
        }
      );
    };
    const cleanup = async () =>
      restricted(
        {
          requestId: "billing-grace-cleanup",
          authSurface: "cleanup",
          accountId
        },
        async (/** @type {any} */ query) => {
          for (const statement of scheduledCleanupStatementsForAccount({
            tier: "hosted_paid",
            now: new Date("2026-11-22T00:00:00Z"),
            requestId: "billing-grace-cleanup"
          }))
            await query(statement);
        }
      );
    const subscription = (
      id = "sub_fake",
      status = "active",
      metadata = { account_id: accountId }
    ) => ({
      id,
      status,
      customer: "cus_fake",
      metadata,
      items: {
        data: [{ price: { id: "price_month" }, current_period_end: 1794254400 }]
      }
    });
    await body({
      owner,
      accountId,
      userId: identity.userId,
      run,
      restricted,
      stripe,
      checkout,
      read,
      webhook,
      subscription,
      cleanup,
      context
    });
  } catch (error) {
    bodyError = error;
  } finally {
    await preserveBodyErrorDuringTeardown(
      bodyError,
      async () => {
        try {
          await owner.query(
            "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = any($1::text[])",
            [eventIds]
          );
          if (identity?.accountId)
            await owner.query(
              "delete from public.agent_outbox_accounts where account_id = $1",
              [identity.accountId]
            );
          if (identity?.userId)
            await owner.query(
              "delete from public.agent_outbox_users where user_id = $1",
              [identity.userId]
            );
        } finally {
          await owner.end();
        }
      },
      "Billing test and owned fixture cleanup both failed"
    );
  }
}

test(
  "concurrent checkouts share one durable attempt/key and account locks end before Stripe HTTP",
  gated,
  async () =>
    fixture(async (f) => {
      const entered = deferred();
      const release = deferred();
      f.stripe.hooks.beforeCreate = async () => {
        entered.resolve();
        await release.promise;
      };
      const first = f.checkout();
      await entered.promise;
      // An actual competing transaction can take the account lock while HTTP waits.
      await f.run(async (/** @type {any} */ query) =>
        query({
          sql: "select account_id from public.agent_outbox_accounts where account_id = $1 for update",
          values: [f.accountId]
        })
      );
      const others = Array.from({ length: 5 }, () => f.checkout());
      release.resolve();
      const results = await Promise.all([first, ...others]);
      assert.equal(
        results.every((r) => r.ok),
        true
      );
      assert.equal(new Set(results.map((r) => r.data.url)).size, 1);
      assert.equal(
        new Set(
          f.stripe.calls.map((/** @type {any} */ c) => c.options.idempotencyKey)
        ).size,
        1
      );
      assert.equal(f.stripe.sessions.size, 1);
      const stored = await f.read();
      assert.equal(
        stored.attempt.stripe_session_id,
        [...f.stripe.sessions.keys()][0]
      );
    })
);

test(
  "same-key Stripe 409 remains actionable and retryable without rotation",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.beforeCreate = () => {
        throw Object.assign(new Error("same-key request in progress"), {
          statusCode: 409
        });
      };
      assert.equal((await f.checkout()).ok, false);
      const key = (await f.read()).attempt.attempt_id;
      delete f.stripe.hooks.beforeCreate;
      assert.equal((await f.checkout()).ok, true);
      assert.equal(
        f.stripe.calls.every(
          (/** @type {any} */ c) => c.options.idempotencyKey === key
        ),
        true
      );
    })
);

for (const failure of [
  "network timeout",
  "cached Stripe 500",
  "idempotency parameter mismatch"
]) {
  test(
    `${failure} replays immutable parameters/API version with the original key`,
    gated,
    async () =>
      fixture(async (f) => {
        f.stripe.hooks.afterCreate = () => {
          throw new Error(failure);
        };
        assert.equal((await f.checkout()).ok, false);
        const original = structuredClone(f.stripe.calls[0]);
        if (failure === "network timeout") delete f.stripe.hooks.afterCreate;
        const changedConfig = {
          ...config,
          priceIds: { monthly: "changed_month", yearly: "changed_year" },
          publicAppBaseUrl: "https://changed.example.test"
        };
        assert.equal(
          (await f.checkout("monthly", { config: changedConfig })).ok,
          failure === "network timeout"
        );
        assert.deepEqual(f.stripe.calls[1], original);
        if (failure !== "network timeout") {
          assert.equal((await f.checkout("yearly")).ok, false);
          assert.deepEqual(f.stripe.calls[2], original);
          assert.equal(f.stripe.expired.length, 0);
        }
        assert.equal(f.stripe.sessions.size, 1);
      })
  );
}

test(
  "unknown attempt at 24 hours cannot replay or rotate for a changed interval",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.afterCreate = () => {
        throw new Error("lost response");
      };
      await f.checkout();
      const attempt = (await f.read()).attempt;
      const result = await f.checkout("yearly", {
        now: () => new Date(attempt.created_at.getTime() + 86400000)
      });
      assert.equal(result.ok, false);
      assert.match(
        result.error.message,
        /Contact support before starting another purchase/
      );
      assert.equal(f.stripe.calls.length, 1);
      assert.equal((await f.read()).attempt.attempt_id, attempt.attempt_id);
      assert.equal(f.stripe.expired.length, 0);
    })
);

test(
  "unknown creation must resolve with its old key before changing interval",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.afterCreate = () => {
        throw new Error("lost response");
      };
      await f.checkout();
      const original = f.stripe.calls[0];
      delete f.stripe.hooks.afterCreate;
      assert.equal((await f.checkout("yearly")).ok, true);
      assert.deepEqual(f.stripe.calls[1], original);
      assert.equal(f.stripe.expired.length, 1);
      assert.equal(
        [...f.stripe.sessions.values()].filter((s) => s.status === "open")
          .length,
        1
      );
      assert.equal(
        f.stripe.calls.at(-1).parameters.line_items[0].price,
        "price_year"
      );
    })
);

test(
  "same interval reuses live open session; latest interval expires it before replacement",
  gated,
  async () =>
    fixture(async (f) => {
      const first = await f.checkout();
      assert.deepEqual(await f.checkout(), first);
      assert.equal(f.stripe.calls.length, 1);
      const id = (await f.read()).attempt.stripe_session_id;
      const result = await f.checkout("yearly");
      assert.equal(result.ok, true);
      assert.notEqual(result.data.url, first.data.url);
      assert.equal(f.stripe.sessions.get(id).status, "expired");
      assert.equal(f.stripe.expired.length, 1);
      assert.equal(
        [...f.stripe.sessions.values()].filter((s) => s.status === "open")
          .length,
        1
      );
    })
);

for (const completed of [false, true]) {
  test(
    `expiration timeout ${completed ? "completion race blocks" : "requires live expired proof before rotation"}`,
    gated,
    async () =>
      fixture(async (f) => {
        await f.checkout();
        const attempt = (await f.read()).attempt;
        f.stripe.hooks.expire = (/** @type {string} */ id) => {
          f.stripe.sessions.get(id).status = completed ? "complete" : "expired";
          throw new Error("timeout");
        };
        const result = await f.checkout("yearly");
        assert.equal(result.ok, !completed);
        assert.equal(f.stripe.calls.length, completed ? 1 : 2);
        assert.equal(
          (await f.read()).attempt.attempt_id === attempt.attempt_id,
          completed
        );
      })
  );
}

test(
  "completed checkout with pending webhook blocks both intervals",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const id = (await f.read()).attempt.stripe_session_id;
      f.stripe.sessions.get(id).status = "complete";
      for (const interval of ["monthly", "yearly"]) {
        const result = await f.checkout(interval);
        assert.equal(result.ok, false);
        assert.match(result.error.message, /complete/);
      }
      assert.equal(f.stripe.calls.length, 1);
      assert.equal(f.stripe.expired.length, 0);
    })
);

for (const stage of ["reservation", "attachment"]) {
  test(
    `lost ${stage} COMMIT acknowledgement is resolved by reread`,
    gated,
    async () =>
      fixture(async (f) => {
        let lost = false;
        const run = async (/** @type {any} */ callback) => {
          let changed = false;
          const result = await f.run(async (/** @type {any} */ query) =>
            callback(async (/** @type {any} */ statement) => {
              if (
                stage === "reservation"
                  ? /insert into public.agent_outbox_billing_checkout_attempts/.test(
                      statement.sql
                    )
                  : /set stripe_session_id =/.test(statement.sql)
              )
                changed = true;
              return query(statement);
            })
          );
          if (changed && !lost) {
            lost = true;
            throw new Error("COMMIT acknowledgement lost");
          }
          return result;
        };
        const result = await f.checkout("monthly", {
          runCheckoutTransaction: run
        });
        assert.equal(lost, true);
        assert.equal(result.ok, true);
        assert.equal(f.stripe.sessions.size, 1);
        assert.ok((await f.read()).attempt.stripe_session_id);
        assert.equal(f.stripe.expired.length, 0);
      })
  );
}

test(
  "failed attachment never exposes a URL and never expires a shared session",
  gated,
  async () =>
    fixture(async (f) => {
      const run = (/** @type {any} */ callback) =>
        f.run((/** @type {any} */ query) =>
          callback(async (/** @type {any} */ statement) => {
            if (/set stripe_session_id =/.test(statement.sql))
              throw new Error("attachment rolled back");
            return query(statement);
          })
        );
      const failed = await f.checkout("monthly", {
        runCheckoutTransaction: run
      });
      assert.equal(failed.ok, false);
      assert.equal("data" in failed, false);
      assert.equal(f.stripe.expired.length, 0);
      assert.equal((await f.checkout()).ok, true);
      assert.equal(f.stripe.sessions.size, 1);
    })
);

test(
  "delayed same-attempt creation cannot return a superseded URL or expire the returned replacement",
  gated,
  async () =>
    fixture(async (f) => {
      const entered = deferred();
      const release = deferred();
      let delay = true;
      f.stripe.hooks.afterCreate = async () => {
        if (delay) {
          delay = false;
          entered.resolve();
          await release.promise;
        }
      };
      const delayed = f.checkout();
      await entered.promise;
      const shared = await f.checkout();
      assert.equal(shared.ok, true);
      const replacement = await f.checkout("yearly");
      assert.equal(replacement.ok, true);
      const replacementId = (await f.read()).attempt.stripe_session_id;
      release.resolve();
      const result = await delayed;
      assert.equal(result.ok, false);
      assert.equal("data" in result, false);
      assert.equal(f.stripe.sessions.get(replacementId).status, "open");
      assert.deepEqual(f.stripe.expired, [[...f.stripe.sessions.keys()][0]]);
    })
);

for (const cleaned of [false, true]) {
  test(
    `authorized terminal subscription repurchase works ${cleaned ? "after cleanup" : "before cleanup"}`,
    gated,
    async () =>
      fixture(async (f) => {
        await f.checkout();
        let attempt = (await f.read()).attempt;
        const metadata = {
          account_id: f.accountId,
          billing_attempt_id: attempt.attempt_id
        };
        await f.webhook(
          "customer.subscription.created",
          f.subscription("sub_old", "active", metadata)
        );
        await f.webhook(
          "customer.subscription.deleted",
          f.subscription("sub_old", "canceled", metadata),
          1791576001
        );
        if (cleaned) {
          await f.cleanup();
          assert.equal(
            (await f.read()).account.stripe_subscription_status,
            null
          );
          assert.equal((await f.read()).account.tier, "hosted_free");
        }
        assert.equal((await f.checkout("yearly")).ok, true);
        const newAttempt = (await f.read()).attempt;
        assert.notEqual(newAttempt.attempt_id, attempt.attempt_id);
        await f.webhook(
          "checkout.session.completed",
          {
            id: newAttempt.stripe_session_id,
            client_reference_id: f.accountId,
            customer: "cus_fake",
            subscription: "sub_new",
            metadata: {
              account_id: f.accountId,
              billing_attempt_id: newAttempt.attempt_id
            }
          },
          1791576002
        );
        assert.equal(
          (await f.read()).account.stripe_subscription_id,
          "sub_new"
        );
        await f.webhook(
          "customer.subscription.deleted",
          f.subscription("sub_old", "canceled", metadata),
          1791576003
        );
        assert.equal((await f.read()).account.billing_status, "active");
        assert.equal(
          (await f.read()).account.stripe_subscription_id,
          "sub_new"
        );
      })
  );
}

for (const status of [
  "past_due",
  "unpaid",
  "paused",
  "canceled",
  "incomplete_expired"
]) {
  test(
    `cleanup null status requires live terminal proof: ${status}`,
    gated,
    async () =>
      fixture(async (f) => {
        await f.owner.query(
          "update public.agent_outbox_accounts set stripe_customer_id = 'cus_fake', stripe_subscription_id = 'sub_legacy', stripe_subscription_status = null where account_id = $1",
          [f.accountId]
        );
        f.stripe.subscriptionObjects.set("sub_legacy", {
          id: "sub_legacy",
          status
        });
        const result = await f.checkout();
        const terminal = ["canceled", "incomplete_expired"].includes(status);
        assert.equal(result.ok, terminal);
        assert.equal(f.stripe.calls.length, terminal ? 1 : 0);
        if (terminal)
          assert.equal(
            (await f.read()).account.stripe_terminal_subscription_id,
            "sub_legacy"
          );
      })
  );
}

for (const type of [
  "checkout.session.completed",
  "customer.subscription.updated",
  "invoice.payment_failed"
]) {
  test(
    `${type} conflicting subscription cannot change entitlement or ordering; warns and dedupes`,
    gated,
    async () =>
      fixture(async (f) => {
        await f.webhook("customer.subscription.created", f.subscription());
        const before = (await f.read()).account;
        const object =
          type === "checkout.session.completed"
            ? {
                id: "cs_stranger",
                client_reference_id: f.accountId,
                customer: "cus_fake",
                subscription: "sub_stranger"
              }
            : type === "invoice.payment_failed"
              ? { customer: "cus_fake", subscription: "sub_stranger" }
              : f.subscription("sub_stranger", "canceled");
        const logs = /** @type {any[]} */ ([]);
        const warn = console.warn;
        console.warn = (line) => logs.push(JSON.parse(line));
        const id = `evt_conflict_${crypto.randomUUID()}`;
        try {
          assert.equal(
            (await f.webhook(type, object, 1791576001, id)).ok,
            true
          );
          assert.equal(
            (await f.webhook(type, object, 1791576001, id)).data.processed,
            false
          );
        } finally {
          console.warn = warn;
        }
        assert.equal(logs.length, 1);
        assert.equal(logs[0].level, "warn");
        assert.equal(logs[0].drop_reason, "billing_conflict");
        assert.deepEqual((await f.read()).account, before);
      })
  );
}

for (const firstStatus of ["active", "canceled"]) {
  test(
    `same-created-second terminal truth cannot revive (${firstStatus} first)`,
    gated,
    async () =>
      fixture(async (f) => {
        await f.webhook(
          "customer.subscription.created",
          f.subscription(),
          1791575999
        );
        for (const status of [
          firstStatus,
          firstStatus === "active" ? "canceled" : "active"
        ])
          await f.webhook(
            "customer.subscription.updated",
            f.subscription("sub_fake", status)
          );
        await f.webhook(
          "checkout.session.completed",
          {
            client_reference_id: f.accountId,
            customer: "cus_fake",
            subscription: "sub_fake"
          },
          1791576001
        );
        await f.webhook(
          "invoice.payment_failed",
          { customer: "cus_fake", subscription: "sub_fake" },
          1791576002
        );
        const state = (await f.read()).account;
        assert.equal(state.billing_status, "canceled");
        assert.equal(state.stripe_terminal_subscription_id, "sub_fake");
      })
  );
}

test(
  "contradictory checkout account metadata and invoice subscription references fail closed",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook("customer.subscription.created", f.subscription());
      const before = (await f.read()).account;
      await f.webhook("checkout.session.completed", {
        client_reference_id: f.accountId,
        metadata: { account_id: crypto.randomUUID() },
        customer: "cus_fake",
        subscription: "sub_fake"
      });
      await f.webhook("invoice.payment_failed", {
        customer: "cus_fake",
        subscription: "sub_fake",
        parent: { subscription_details: { subscription: "sub_other" } }
      });
      assert.deepEqual((await f.read()).account, before);
    })
);

test(
  "attempt RLS permits member/control plane, denies callers/cleanup/cross-account humans; deletion cascades",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      for (const context of [
        {
          authSurface: "caller",
          accountId: f.accountId,
          callerId: crypto.randomUUID()
        },
        { authSurface: "cleanup" },
        {
          authSurface: "human",
          accountId: crypto.randomUUID(),
          userId: f.userId
        }
      ]) {
        await f.restricted(
          { requestId: "rls-denial", ...context },
          async (/** @type {any} */ query) => {
            assert.equal(
              (
                await query({
                  sql: "select * from public.agent_outbox_billing_checkout_attempts"
                })
              ).rows.length,
              0
            );
            assert.equal(
              (
                await query({
                  sql: "update public.agent_outbox_billing_checkout_attempts set stripe_session_id = 'cs_denied' where account_id = $1 returning *",
                  values: [f.accountId]
                })
              ).rows.length,
              0
            );
          }
        );
        await assert.rejects(
          f.restricted(
            { requestId: "rls-insert-denial", ...context },
            (/** @type {any} */ query) =>
              query({
                sql: "insert into public.agent_outbox_billing_checkout_attempts(account_id, attempt_id, billing_interval, creation_parameters, stripe_api_version) values ($1, $2, 'monthly', '{}', 'test')",
                values: [f.accountId, crypto.randomUUID()]
              })
          ),
          /row-level security/
        );
      }
      await f.restricted(
        { requestId: "rls-control", authSurface: "control_plane" },
        async (/** @type {any} */ query) => {
          assert.equal(
            (
              await query({
                sql: "select * from public.agent_outbox_billing_checkout_attempts where account_id = $1",
                values: [f.accountId]
              })
            ).rows.length,
            1
          );
        }
      );
      await f.owner.query(
        "delete from public.agent_outbox_accounts where account_id = $1",
        [f.accountId]
      );
      assert.equal(
        (
          await f.owner.query(
            "select * from public.agent_outbox_billing_checkout_attempts where account_id = $1",
            [f.accountId]
          )
        ).rows.length,
        0
      );
    })
);

test(
  "concurrent changed-interval requests cannot authorize overlapping open sessions",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const entered = deferred();
      const release = deferred();
      let expirations = 0;
      f.stripe.hooks.expire = async () => {
        if (++expirations === 2) entered.resolve();
        await release.promise;
      };
      const first = f.checkout("yearly");
      const second = f.checkout("yearly");
      await entered.promise;
      release.resolve();
      const results = await Promise.all([first, second]);
      assert.equal(results.filter((r) => r.ok).length >= 1, true);
      assert.equal(
        [...f.stripe.sessions.values()].filter((s) => s.status === "open")
          .length,
        1
      );
      assert.equal(
        new Set(
          f.stripe.calls.map((/** @type {any} */ c) => c.options.idempotencyKey)
        ).size,
        2
      );
    })
);

test(
  "account checkout attempts remain isolated across real memberships",
  gated,
  async () =>
    fixture(async (a) =>
      fixture(async (b) => {
        const results = await Promise.all([a.checkout(), b.checkout()]);
        assert.equal(
          results.every((r) => r.ok),
          true
        );
        assert.notEqual(
          (await a.read()).attempt.attempt_id,
          (await b.read()).attempt.attempt_id
        );
        assert.notEqual(results[0].data.url, results[1].data.url);
        await a.run(async (/** @type {any} */ query) => {
          assert.equal(
            (
              await query({
                sql: "select * from public.agent_outbox_billing_checkout_attempts where account_id = $1",
                values: [b.accountId]
              })
            ).rows.length,
            0
          );
        });
      })
    )
);

test(
  "fresh eligibility under account lock rejects a stale free route snapshot",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook("customer.subscription.created", f.subscription());
      assert.equal((await f.checkout()).ok, false);
      assert.equal(f.stripe.calls.length, 0);
    })
);

test(
  "webhook activation racing provider creation prevents URL authorization",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.afterCreate = async () => {
        const attempt = (await f.read()).attempt;
        await f.webhook(
          "customer.subscription.created",
          f.subscription("sub_race", "active", {
            account_id: f.accountId,
            billing_attempt_id: attempt.attempt_id
          })
        );
      };
      const result = await f.checkout();
      assert.equal(result.ok, false);
      assert.equal("data" in result, false);
      assert.equal((await f.read()).account.stripe_subscription_id, "sub_race");
      assert.equal(f.stripe.expired.length, 0);
    })
);

test(
  "unknown terminal purchase still resolves the old session before rotation",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.afterCreate = () => {
        throw new Error("lost response");
      };
      await f.checkout();
      const attempt = (await f.read()).attempt;
      const metadata = {
        account_id: f.accountId,
        billing_attempt_id: attempt.attempt_id
      };
      const session = [...f.stripe.sessions.values()][0];
      session.status = "complete";
      session.subscription = "sub_old_unknown";
      await f.webhook(
        "customer.subscription.created",
        f.subscription("sub_old_unknown", "active", metadata)
      );
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_old_unknown", "canceled", metadata),
        1791576001
      );
      delete f.stripe.hooks.afterCreate;
      assert.equal((await f.checkout("yearly")).ok, true);
      assert.equal(
        f.stripe.calls[1].options.idempotencyKey,
        attempt.attempt_id
      );
      assert.notEqual(
        f.stripe.calls[2].options.idempotencyKey,
        attempt.attempt_id
      );
    })
);

test(
  "unknown terminal purchase beyond retention still cannot rotate",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.afterCreate = () => {
        throw new Error("lost response");
      };
      await f.checkout();
      const attempt = (await f.read()).attempt;
      const metadata = {
        account_id: f.accountId,
        billing_attempt_id: attempt.attempt_id
      };
      await f.webhook(
        "customer.subscription.created",
        f.subscription("sub_old_unknown", "active", metadata)
      );
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_old_unknown", "canceled", metadata),
        1791576001
      );
      const result = await f.checkout("yearly", {
        now: () => new Date(attempt.created_at.getTime() + 86400000)
      });
      assert.equal(result.ok, false);
      assert.equal((await f.read()).attempt.attempt_id, attempt.attempt_id);
      assert.equal(f.stripe.calls.length, 1);
    })
);

test(
  "zero-row attachment CAS never authorizes an orphan URL",
  gated,
  async () =>
    fixture(async (f) => {
      const run = (/** @type {any} */ callback) =>
        f.run((/** @type {any} */ query) =>
          callback(async (/** @type {any} */ statement) => {
            if (/set stripe_session_id =/.test(statement.sql))
              return query({ sql: "select 1 where false" });
            return query(statement);
          })
        );
      const result = await f.checkout("monthly", {
        runCheckoutTransaction: run
      });
      assert.equal(result.ok, false);
      assert.equal("data" in result, false);
      assert.equal((await f.read()).attempt.stripe_session_id, null);
      assert.equal(f.stripe.expired.length, 0);
    })
);

test(
  "attachment failure after another request returns the same URL preserves that shared session",
  gated,
  async () =>
    fixture(async (f) => {
      const entered = deferred();
      const release = deferred();
      let first = true;
      f.stripe.hooks.afterCreate = async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
      };
      const run = (/** @type {any} */ callback) =>
        f.run((/** @type {any} */ query) =>
          callback(async (/** @type {any} */ statement) => {
            if (/set stripe_session_id =/.test(statement.sql))
              throw new Error("first attachment failed");
            return query(statement);
          })
        );
      const delayed = f.checkout("monthly", { runCheckoutTransaction: run });
      await entered.promise;
      const shared = await f.checkout();
      assert.equal(shared.ok, true);
      release.resolve();
      assert.deepEqual(await delayed, shared);
      assert.equal(f.stripe.expired.length, 0);
    })
);

test(
  "unknown session/failed expiration cannot rotate; live expired session can",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const attempt = (await f.read()).attempt;
      f.stripe.hooks.expire = () => {
        throw new Error("permission denied");
      };
      assert.equal((await f.checkout("yearly")).ok, false);
      assert.equal(f.stripe.calls.length, 1);
      const session = f.stripe.sessions.get(attempt.stripe_session_id);
      session.status = null;
      assert.equal((await f.checkout()).ok, false);
      session.status = "expired";
      assert.equal((await f.checkout()).ok, true);
      assert.equal(f.stripe.calls.length, 2);
    })
);

test(
  "contradictory references to two actual accounts mutate neither account",
  gated,
  async () =>
    fixture(async (a) =>
      fixture(async (b) => {
        await a.webhook(
          "customer.subscription.created",
          a.subscription("sub_a")
        );
        await b.webhook("customer.subscription.created", {
          ...b.subscription("sub_b"),
          customer: "cus_b"
        });
        const first = (await a.read()).account;
        const second = (await b.read()).account;
        await a.webhook("checkout.session.completed", {
          client_reference_id: a.accountId,
          customer: "cus_b",
          subscription: "sub_a"
        });
        await a.webhook("customer.subscription.updated", {
          ...a.subscription("sub_a", "past_due"),
          customer: "cus_b"
        });
        await a.webhook("invoice.payment_failed", {
          subscription: "sub_a",
          customer: "cus_b"
        });
        assert.deepEqual((await a.read()).account, first);
        assert.deepEqual((await b.read()).account, second);
      })
    )
);

test(
  "stranger cancellation cannot initially attach or replace a terminal canonical subscription",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_stranger", "canceled")
      );
      assert.equal((await f.read()).account.stripe_subscription_id, null);
      await f.webhook("customer.subscription.created", f.subscription());
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_fake", "canceled"),
        1791576001
      );
      const before = (await f.read()).account;
      await f.webhook(
        "customer.subscription.created",
        f.subscription("sub_unapproved", "active"),
        1791576002
      );
      assert.deepEqual((await f.read()).account, before);
    })
);

test(
  "cleanup racing terminal proof requires unchanged canonical subscription",
  gated,
  async () =>
    fixture(async (f) => {
      await f.owner.query(
        "update public.agent_outbox_accounts set stripe_subscription_id = 'sub_legacy' where account_id = $1",
        [f.accountId]
      );
      f.stripe.subscriptionObjects.set("sub_legacy", {
        id: "sub_legacy",
        status: "canceled"
      });
      f.stripe.hooks.subscriptionRetrieve = async () => {
        await f.owner.query(
          "update public.agent_outbox_accounts set stripe_subscription_id = 'sub_newer' where account_id = $1",
          [f.accountId]
        );
      };
      assert.equal((await f.checkout()).ok, false);
      assert.equal(f.stripe.calls.length, 0);
      assert.equal(
        (await f.read()).account.stripe_terminal_subscription_id,
        null
      );
    })
);

test(
  "actual grace cleanup retains nonterminal subscription identity and blocks repurchase",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook("customer.subscription.created", f.subscription());
      await f.webhook(
        "customer.subscription.updated",
        f.subscription("sub_fake", "past_due"),
        1791576001
      );
      await f.cleanup();
      const state = (await f.read()).account;
      assert.equal(state.tier, "hosted_free");
      assert.equal(state.stripe_subscription_status, null);
      assert.equal(state.stripe_subscription_id, "sub_fake");
      f.stripe.subscriptionObjects.set("sub_fake", {
        id: "sub_fake",
        status: "past_due"
      });
      assert.equal((await f.checkout()).ok, false);
      assert.equal(f.stripe.calls.length, 0);
    })
);

for (const replaced of [false, true]) {
  test(
    `authorized invoice-first ${replaced ? "terminal replacement" : "initial attachment"} preserves payment failure grace`,
    gated,
    async () =>
      fixture(async (f) => {
        if (replaced) {
          await f.webhook(
            "customer.subscription.created",
            f.subscription("sub_old")
          );
          await f.webhook(
            "customer.subscription.deleted",
            f.subscription("sub_old", "canceled"),
            1791576001
          );
        }
        await f.checkout();
        const attempt = (await f.read()).attempt;
        await f.webhook(
          "invoice.payment_failed",
          {
            customer: "cus_fake",
            parent: {
              subscription_details: {
                subscription: "sub_invoice_first",
                metadata: {
                  account_id: f.accountId,
                  billing_attempt_id: attempt.attempt_id
                }
              }
            }
          },
          1791576002
        );
        const state = (await f.read()).account;
        assert.equal(state.stripe_subscription_id, "sub_invoice_first");
        assert.equal(
          (await f.read()).attempt.stripe_subscription_id,
          "sub_invoice_first"
        );
        assert.equal(state.billing_status, "past_due");
      })
  );
}

test(
  "concurrent monthly/yearly selection keeps the latest interval and rejects superseded URL",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const entered = deferred();
      const release = deferred();
      let first = true;
      f.stripe.hooks.retrieve = async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
      };
      const delayedMonthly = f.checkout();
      await entered.promise;
      const yearly = await f.checkout("yearly");
      release.resolve();
      assert.equal(yearly.ok, true);
      assert.equal((await delayedMonthly).ok, false);
      assert.equal((await f.read()).attempt.billing_interval, "yearly");
      assert.equal(
        [...f.stripe.sessions.values()].filter((s) => s.status === "open")
          .length,
        1
      );
    })
);

test(
  "actual grace cleanup racing expiration retains terminal proof for conditional rotation",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const attempt = (await f.read()).attempt;
      const metadata = {
        account_id: f.accountId,
        billing_attempt_id: attempt.attempt_id
      };
      await f.webhook(
        "customer.subscription.created",
        f.subscription("sub_old", "active", metadata)
      );
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_old", "canceled", metadata),
        1791576001
      );
      f.stripe.hooks.expire = () => f.cleanup();
      assert.equal((await f.checkout("yearly")).ok, true);
      assert.notEqual((await f.read()).attempt.attempt_id, attempt.attempt_id);
      assert.equal(
        (await f.read()).account.stripe_terminal_subscription_id,
        "sub_old"
      );
    })
);

test(
  "late old checkout, active subscription and invoice events cannot downgrade the authorized replacement",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook(
        "customer.subscription.created",
        f.subscription("sub_old")
      );
      await f.webhook(
        "customer.subscription.deleted",
        f.subscription("sub_old", "canceled"),
        1791576001
      );
      await f.checkout();
      const attempt = (await f.read()).attempt;
      const metadata = {
        account_id: f.accountId,
        billing_attempt_id: attempt.attempt_id
      };
      await f.webhook(
        "checkout.session.completed",
        {
          id: attempt.stripe_session_id,
          client_reference_id: f.accountId,
          customer: "cus_fake",
          subscription: "sub_new",
          metadata
        },
        1791576002
      );
      const before = await f.read();
      await f.webhook(
        "checkout.session.completed",
        {
          client_reference_id: f.accountId,
          customer: "cus_fake",
          subscription: "sub_old"
        },
        1791576003
      );
      await f.webhook(
        "customer.subscription.updated",
        f.subscription("sub_old", "active"),
        1791576004
      );
      await f.webhook(
        "invoice.payment_failed",
        { customer: "cus_fake", subscription: "sub_old" },
        1791576005
      );
      assert.deepEqual(await f.read(), before);
    })
);

test(
  "nonterminal subscription can reactivate after real grace cleanup without a new checkout",
  gated,
  async () =>
    fixture(async (f) => {
      await f.webhook("customer.subscription.created", f.subscription());
      await f.webhook(
        "customer.subscription.updated",
        f.subscription("sub_fake", "past_due"),
        1791576001
      );
      await f.cleanup();
      assert.equal((await f.read()).account.tier, "hosted_free");
      await f.webhook(
        "customer.subscription.updated",
        f.subscription("sub_fake", "active"),
        1791576002
      );
      const state = (await f.read()).account;
      assert.equal(state.tier, "hosted_paid");
      assert.equal(state.billing_status, "active");
      assert.equal(state.stripe_subscription_id, "sub_fake");
      assert.equal(f.stripe.calls.length, 0);
    })
);

test(
  "uncommitted reservation never dispatches Stripe creation",
  gated,
  async () =>
    fixture(async (f) => {
      const run = (/** @type {any} */ callback) =>
        f.run((/** @type {any} */ query) =>
          callback(async (/** @type {any} */ statement) => {
            const result = await query(statement);
            if (
              /insert into public.agent_outbox_billing_checkout_attempts/.test(
                statement.sql
              )
            )
              throw Object.assign(new Error("private reservation detail"), {
                code: "23503"
              });
            return result;
          })
        );
      const logs = await captureStructuredLogs(async () => {
        assert.equal(
          (await f.checkout("monthly", { runCheckoutTransaction: run })).ok,
          false
        );
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].checkout_failure_reason, "reservation_unconfirmed");
      assert.equal(logs[0].error_code, "23503");
      assert.equal(logs[0].billing_attempt_id, undefined);
      assert.equal(JSON.stringify(logs).includes("private"), false);
      assert.equal((await f.read()).attempt, undefined);
      assert.equal(f.stripe.calls.length, 0);
    })
);

test(
  "previous subscription retrieval failure identifies the SDK error without suggesting a nonexistent checkout",
  gated,
  async () =>
    fixture(async (f) => {
      await f.owner.query(
        "update public.agent_outbox_accounts set stripe_customer_id = 'cus_fake', stripe_subscription_id = 'sub_legacy', stripe_subscription_status = null where account_id = $1",
        [f.accountId]
      );
      const before = await f.read();
      f.stripe.hooks.subscriptionRetrieve = () => {
        throw new Stripe.errors.StripeConnectionError({
          message: "private previous subscription payload"
        });
      };
      const logs = await captureStructuredLogs(async () => {
        const result = await f.checkout();
        assert.equal(result.ok, false);
        assert.match(result.error.message, /previous subscription/);
        assert.equal(
          /same interval|persisted attempt/.test(result.error.message),
          false
        );
      });
      assert.equal(logs.length, 1);
      assert.equal(
        logs[0].checkout_failure_reason,
        "previous_subscription_retrieve_failed"
      );
      assert.equal(logs[0].error_name, "StripeConnectionError");
      assert.equal(logs[0].error_code, undefined);
      assert.equal(logs[0].billing_attempt_id, undefined);
      assert.equal(JSON.stringify(logs).includes("private"), false);
      assert.deepEqual(await f.read(), before);
      assert.equal(f.stripe.calls.length, 0);
    })
);

for (const status of ["expired", "complete"]) {
  test(
    `failed replacement reservation after ${status} session preserves the original attempt and reports the database failure`,
    gated,
    async () =>
      fixture(async (f) => {
        assert.equal((await f.checkout()).ok, true);
        const attempt = (await f.read()).attempt;
        const session = f.stripe.sessions.get(attempt.stripe_session_id);
        session.status = status;
        if (status === "complete") {
          session.subscription = "sub_old";
          const metadata = {
            account_id: f.accountId,
            billing_attempt_id: attempt.attempt_id
          };
          await f.webhook(
            "customer.subscription.created",
            f.subscription("sub_old", "active", metadata)
          );
          await f.webhook(
            "customer.subscription.deleted",
            f.subscription("sub_old", "canceled", metadata),
            1791576001
          );
        }
        const before = await f.read();
        const run = (/** @type {any} */ callback) =>
          f.run((/** @type {any} */ query) =>
            callback(async (/** @type {any} */ statement) => {
              const result = await query(statement);
              if (
                /insert into public.agent_outbox_billing_checkout_attempts/.test(
                  statement.sql
                )
              )
                throw Object.assign(new Error("private replacement detail"), {
                  code: "23503"
                });
              return result;
            })
          );
        const logs = await captureStructuredLogs(async () => {
          assert.equal(
            (await f.checkout("yearly", { runCheckoutTransaction: run })).ok,
            false
          );
        });
        assert.equal(logs.length, 1);
        assert.equal(
          logs[0].checkout_failure_reason,
          "replacement_reservation_unconfirmed"
        );
        assert.equal(logs[0].error_code, "23503");
        assert.equal(logs[0].billing_attempt_id, attempt.attempt_id);
        assert.equal(
          logs[0].billing_attempt_created_at,
          attempt.created_at.toISOString()
        );
        assert.equal(logs[0].stripe_session_status, status);
        assert.equal(JSON.stringify(logs).includes("private"), false);
        assert.deepEqual(await f.read(), before);
        assert.equal(f.stripe.calls.length, 1);
      })
  );
}

test(
  "lost rotation COMMIT acknowledgement resolves the new identity before creating replacement",
  gated,
  async () =>
    fixture(async (f) => {
      await f.checkout();
      const original = (await f.read()).attempt;
      let lost = false;
      const run = async (/** @type {any} */ callback) => {
        let rotation = false;
        const result = await f.run((/** @type {any} */ query) =>
          callback(async (/** @type {any} */ statement) => {
            if (
              /insert into public.agent_outbox_billing_checkout_attempts/.test(
                statement.sql
              )
            )
              rotation = true;
            return query(statement);
          })
        );
        if (rotation && !lost) {
          lost = true;
          throw new Error("rotation COMMIT acknowledgement lost");
        }
        return result;
      };
      assert.equal(
        (await f.checkout("yearly", { runCheckoutTransaction: run })).ok,
        true
      );
      assert.equal(lost, true);
      assert.notEqual((await f.read()).attempt.attempt_id, original.attempt_id);
      assert.equal(
        f.stripe.sessions.get(original.stripe_session_id).status,
        "expired"
      );
      assert.equal(
        [...f.stripe.sessions.values()].filter((s) => s.status === "open")
          .length,
        1
      );
    })
);

test(
  "unresolved creation and retention failures identify the immutable attempt without leaking Stripe details",
  gated,
  async () =>
    fixture(async (f) => {
      f.stripe.hooks.beforeCreate = () => {
        throw Object.assign(new Error("private customer payload"), {
          code: "ETIMEDOUT"
        });
      };
      const creationLogs = await captureStructuredLogs(async () => {
        const result = await f.checkout();
        assert.equal(result.ok, false);
        assert.equal(result.error.reported, true);
        assert.equal(result.error.errorId, f.context.correlationId);
        assert.equal(JSON.stringify(result).includes("billing_attempt"), false);
      });
      const attempt = (await f.read()).attempt;
      const retentionLogs = await captureStructuredLogs(async () => {
        const result = await f.checkout("yearly", {
          now: () => new Date(attempt.created_at.getTime() + 86400000)
        });
        assert.equal(result.ok, false);
        assert.match(result.error.message, /Contact support/);
      });
      assert.equal(creationLogs.length, 1);
      assert.equal(retentionLogs.length, 1);
      for (const log of [...creationLogs, ...retentionLogs]) {
        assert.equal(log.level, "error");
        assert.equal(log.account_id, f.accountId);
        assert.equal(log.billing_attempt_id, attempt.attempt_id);
        assert.equal(
          log.billing_attempt_created_at,
          attempt.created_at.toISOString()
        );
        assert.equal(log.error_id, f.context.correlationId);
        assert.equal(log.request_id, f.context.requestId);
        assert.equal(JSON.stringify(log).includes("private"), false);
        assert.equal("creation_parameters" in log, false);
      }
      assert.equal(
        creationLogs[0].checkout_failure_reason,
        "creation_unresolved"
      );
      assert.equal(creationLogs[0].error_code, "ETIMEDOUT");
      assert.equal(
        retentionLogs[0].checkout_failure_reason,
        "creation_retention_exceeded"
      );
      assert.equal(f.stripe.calls.length, 1);
      assert.equal((await f.read()).attempt.attempt_id, attempt.attempt_id);
    })
);

for (const retrievalFails of [false, true]) {
  test(
    `expiration permission failure remains visible when live retrieval ${retrievalFails ? "fails" : "shows the session still open"}`,
    gated,
    async () =>
      fixture(async (f) => {
        assert.equal((await f.checkout()).ok, true);
        const attempt = (await f.read()).attempt;
        f.stripe.hooks.expire = () => {
          if (retrievalFails)
            f.stripe.hooks.retrieve = () => {
              throw new Stripe.errors.StripeConnectionError({
                message: "private retrieval payload"
              });
            };
          throw new Stripe.errors.StripePermissionError({
            message: "private key permissions"
          });
        };
        const logs = await captureStructuredLogs(async () => {
          const result = await f.checkout("yearly");
          assert.equal(result.ok, false);
          assert.equal(result.error.reported, true);
          assert.equal(
            JSON.stringify(result).includes("StripePermissionError"),
            false
          );
        });
        assert.equal(logs.length, 2);
        assert.equal(logs[0].operation, "stripe_checkout_session_expire");
        assert.equal(logs[0].error_name, "StripePermissionError");
        assert.equal(logs[0].error_code, undefined);
        assert.equal(logs[0].checkout_failure_reason, "expiration_failed");
        assert.equal(
          logs[1].checkout_failure_reason,
          retrievalFails
            ? "expiration_confirmation_failed"
            : "interval_mismatch"
        );
        if (retrievalFails) {
          assert.equal(logs[1].error_name, "StripeConnectionError");
          assert.equal(logs[1].error_code, undefined);
        }
        for (const log of logs) {
          assert.equal(log.level, "error");
          assert.equal(log.account_id, f.accountId);
          assert.equal(log.billing_attempt_id, attempt.attempt_id);
          assert.equal(
            log.billing_attempt_created_at,
            attempt.created_at.toISOString()
          );
          assert.equal(log.request_id, f.context.requestId);
          assert.equal(log.error_id, f.context.correlationId);
          assert.equal(log.stripe_session_status, "open");
          assert.equal(log.stripe_payment_status, "unpaid");
          assert.equal(JSON.stringify(log).includes("private"), false);
        }
        assert.equal((await f.read()).attempt.attempt_id, attempt.attempt_id);
        assert.equal(f.stripe.calls.length, 1);
      })
  );
}

for (const [change, reason, status, payment] of [
  [{ status: "complete" }, "session_complete", "complete", "unpaid"],
  [
    { status: "private unexpected status" },
    "session_status_unknown",
    "unknown",
    "unpaid"
  ],
  [{ payment_status: "paid" }, "payment_not_unpaid", "open", "paid"],
  [
    { payment_status: "private unexpected payment" },
    "payment_not_unpaid",
    "open",
    "unknown"
  ],
  [{ url: null }, "session_url_missing", "open", "unpaid"],
  [
    { client_reference_id: "private wrong account" },
    "session_identity_mismatch",
    "open",
    "unpaid"
  ]
]) {
  test(
    `live checkout diagnostics distinguish ${reason} (${payment}) without exposing provider values`,
    gated,
    async () =>
      fixture(async (f) => {
        assert.equal((await f.checkout()).ok, true);
        const attempt = (await f.read()).attempt;
        Object.assign(f.stripe.sessions.get(attempt.stripe_session_id), change);
        const logs = await captureStructuredLogs(async () => {
          const result = await f.checkout();
          assert.equal(result.ok, false);
          assert.equal(result.error.reported, true);
          assert.equal(JSON.stringify(result).includes("private"), false);
        });
        assert.equal(logs.length, 1);
        assert.equal(logs[0].checkout_failure_reason, reason);
        assert.equal(logs[0].stripe_session_status, status);
        assert.equal(logs[0].stripe_payment_status, payment);
        assert.equal(logs[0].billing_attempt_id, attempt.attempt_id);
        assert.equal(
          logs[0].billing_attempt_created_at,
          attempt.created_at.toISOString()
        );
        assert.equal(logs[0].level, "error");
        assert.equal(JSON.stringify(logs).includes("private"), false);
        assert.equal(f.stripe.calls.length, 1);
      })
  );
}

test(
  "expiration timeout is logged even when live expired proof allows replacement",
  gated,
  async () =>
    fixture(async (f) => {
      assert.equal((await f.checkout()).ok, true);
      const attempt = (await f.read()).attempt;
      f.stripe.hooks.expire = (/** @type {string} */ id) => {
        f.stripe.sessions.get(id).status = "expired";
        throw new Stripe.errors.StripeConnectionError({
          message: "private timeout detail"
        });
      };
      const logs = await captureStructuredLogs(async () => {
        assert.equal((await f.checkout("yearly")).ok, true);
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].level, "error");
      assert.equal(logs[0].operation, "stripe_checkout_session_expire");
      assert.equal(logs[0].error_name, "StripeConnectionError");
      assert.equal(logs[0].error_code, undefined);
      assert.equal(logs[0].billing_attempt_id, attempt.attempt_id);
      assert.equal(
        logs[0].billing_attempt_created_at,
        attempt.created_at.toISOString()
      );
      assert.equal(logs[0].stripe_session_status, "open");
      assert.equal(logs[0].stripe_payment_status, "unpaid");
      assert.equal(JSON.stringify(logs).includes("private"), false);
      assert.notEqual((await f.read()).attempt.attempt_id, attempt.attempt_id);
      assert.equal(f.stripe.calls.length, 2);
    })
);
