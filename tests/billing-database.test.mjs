import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

import { processStripeEventInTransaction } from "../src/server/billing.ts";
import { runProductTransaction } from "../src/server/database.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  phase3DatabaseVerificationUrl as resolvePhase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  resetRoleAndRollback,
  teardownAttempt
} from "./helpers/database.mjs";

const { Client } = pg;

const phase3DatabaseVerificationUrl = resolvePhase3DatabaseVerificationUrl();

const stripeWebhookCompletedLedgerMigrationPath = new URL(
  "../db/migrations/V20260711114816__stripe_webhook_completed_ledger.sql",
  import.meta.url
);

const stripeWebhookEventOrderingMigrationPath = new URL(
  "../db/migrations/V20260812194000__stripe_webhook_event_ordering.sql",
  import.meta.url
);

/**
 * Executes one transactional migration file inside the caller's open transaction.
 * @param {import("pg").Client} client
 * @param {URL} migrationPath
 */
async function executeTransactionalMigrationFile(client, migrationPath) {
  if (!migrationPath.pathname.endsWith(".sql")) {
    throw new Error("Transactional migration executor requires a .sql file.");
  }
  const sql = readFileSync(migrationPath, "utf8");
  if (/\bconcurrently\b/i.test(sql)) {
    throw new Error(
      "Transactional migration executor rejects online migrations."
    );
  }
  await client.query(sql);
}

/**
 * @param {import("pg").Client} observer
 * @param {number} backendPid
 */
async function waitForDatabaseLock(observer, backendPid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observer.query(
      `select wait_event_type from pg_catalog.pg_stat_activity where pid = $1`,
      [backendPid]
    );
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Backend ${backendPid} did not enter a database lock wait.`);
}

test("preserveBodyErrorDuringTeardown rethrows the body error after teardown succeeds", async () => {
  const bodyError = new Error("body failed");
  /** @type {string[]} */
  const order = [];
  await assert.rejects(
    preserveBodyErrorDuringTeardown(
      bodyError,
      async () => {
        order.push("teardown");
      },
      "Stripe concurrency test and teardown both failed."
    ),
    bodyError
  );
  assert.deepEqual(order, ["teardown"]);
});

test("preserveBodyErrorDuringTeardown throws teardown error when the body succeeded", async () => {
  const teardownError = new AggregateError(
    [new Error("cleanup")],
    "Stripe concurrency teardown failed."
  );
  await assert.rejects(
    preserveBodyErrorDuringTeardown(
      undefined,
      async () => {
        throw teardownError;
      },
      "Stripe concurrency test and teardown both failed."
    ),
    teardownError
  );
});

test("preserveBodyErrorDuringTeardown prefers the body error in a combined AggregateError", async () => {
  const bodyError = new Error("body failed");
  const teardownError = new AggregateError(
    [new Error("cleanup")],
    "Stripe concurrency teardown failed."
  );
  try {
    await preserveBodyErrorDuringTeardown(
      bodyError,
      async () => {
        throw teardownError;
      },
      "Stripe concurrency test and teardown both failed."
    );
    assert.fail("expected combined teardown error");
  } catch (error) {
    assert.equal(error instanceof AggregateError, true);
    const combined = /** @type {AggregateError} */ (error);
    assert.equal(
      combined.message,
      "Stripe concurrency test and teardown both failed."
    );
    assert.deepEqual(combined.errors, [bodyError, teardownError]);
    assert.equal(combined.cause, bodyError);
  }
});

test(
  "completed Stripe webhook claims serialize duplicates and rollback permits retry",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const connectionString = phase3DatabaseVerificationUrl;
    assert.ok(connectionString);
    const first = new Client({ connectionString });
    const duplicate = new Client({ connectionString });
    const observer = new Client({ connectionString });
    const eventId = `evt_concurrent_${crypto.randomUUID()}`;
    const failedEventId = `evt_rollback_${crypto.randomUUID()}`;
    const rollbackCompatibleEventId = `evt_old_writer_${crypto.randomUUID()}`;
    const event = /** @type {any} */ ({
      id: eventId,
      created: 1783209600,
      type: "test.ignored"
    });

    await Promise.all([
      first.connect(),
      duplicate.connect(),
      observer.connect()
    ]);
    /** @type {Promise<boolean> | null} */
    let duplicateTransaction = null;
    let bodyError;
    try {
      await first.query("begin");
      await first.query("set role agent_outbox_app");
      await first.query(
        "select set_config('agent_outbox.auth_surface', 'control_plane', true)"
      );
      const firstProcessed = await processStripeEventInTransaction(
        /** @type {any} */ (
          (/** @type {any} */ statement) =>
            first.query(statement.sql, statement.values)
        ),
        event
      );
      assert.equal(firstProcessed, true);

      const duplicatePid = await duplicate.query(
        "select pg_catalog.pg_backend_pid() as pid"
      );
      duplicateTransaction = (async () => {
        await duplicate.query("begin");
        await duplicate.query("set role agent_outbox_app");
        await duplicate.query(
          "select set_config('agent_outbox.auth_surface', 'control_plane', true)"
        );
        const processed = await processStripeEventInTransaction(
          /** @type {any} */ (
            (/** @type {any} */ statement) =>
              duplicate.query(statement.sql, statement.values)
          ),
          event
        );
        await duplicate.query("commit");
        return processed;
      })();

      await waitForDatabaseLock(observer, duplicatePid.rows[0].pid);
      await first.query("commit");
      assert.equal(await duplicateTransaction, false);
      const committed = await observer.query(
        `
          select
            count(*)::int as count,
            min(processing_status) as processing_status,
            bool_and(processed_at is not null) as has_completion_time
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [eventId]
      );
      assert.deepEqual(committed.rows, [
        {
          count: 1,
          processing_status: "processed",
          has_completion_time: true
        }
      ]);

      await observer.query("begin");
      const oldWriterClaim = await observer.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            processing_status
          )
          values ($1, 'test.old-writer', 'processing')
          returning processing_status, processed_at is not null as has_completion_time
        `,
        [rollbackCompatibleEventId]
      );
      assert.deepEqual(oldWriterClaim.rows, [
        { processing_status: "processing", has_completion_time: true }
      ]);
      const oldWriterCompletion = await observer.query(
        `
          update public.agent_outbox_stripe_webhook_events
          set processing_status = 'processed', processed_at = now()
          where stripe_event_id = $1
          returning processing_status
        `,
        [rollbackCompatibleEventId]
      );
      assert.deepEqual(oldWriterCompletion.rows, [
        { processing_status: "processed" }
      ]);
      await observer.query("commit");

      await assert.rejects(
        runProductTransaction(
          connectionString,
          {
            requestId: `rollback-${failedEventId}`,
            authSurface: "control_plane"
          },
          async (query) => {
            await processStripeEventInTransaction(
              query,
              /** @type {any} */ ({
                id: failedEventId,
                created: 1783209600,
                type: "test.ignored"
              })
            );
            throw new Error("forced webhook transaction failure");
          }
        ),
        /forced webhook transaction failure/
      );
      const retried = await runProductTransaction(
        connectionString,
        { requestId: `retry-${failedEventId}`, authSurface: "control_plane" },
        (query) =>
          processStripeEventInTransaction(
            query,
            /** @type {any} */ ({
              id: failedEventId,
              created: 1783209600,
              type: "test.ignored"
            })
          )
      );
      assert.equal(retried, true);
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const teardownErrors = [];
          const attempt = teardownAttempt(
            teardownErrors,
            "Stripe concurrency teardown failed"
          );

          await attempt("first transaction reset", () =>
            resetRoleAndRollback(first)
          );
          const pendingDuplicate = duplicateTransaction;
          if (pendingDuplicate) {
            await attempt("duplicate transaction settlement", () =>
              pendingDuplicate.then(() => undefined)
            );
          }
          await attempt("duplicate transaction reset", () =>
            resetRoleAndRollback(duplicate)
          );
          await attempt("cleanup timeout configuration", () =>
            observer.query("set statement_timeout = '5s'")
          );
          await attempt("test row cleanup", () =>
            observer.query(
              "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = any($1::text[])",
              [[eventId, failedEventId, rollbackCompatibleEventId]]
            )
          );
          await attempt("first client close", () => first.end());
          await attempt("duplicate client close", () => duplicate.end());
          await attempt("observer client close", () => observer.end());

          if (teardownErrors.length > 0) {
            throw new AggregateError(
              teardownErrors,
              "Stripe concurrency teardown failed."
            );
          }
        },
        "Stripe concurrency test and teardown both failed."
      );
    }
  }
);
test(
  "Stripe webhook expand migration rejects each contradictory old-row shape without durable mutation",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const client = new Client({
      connectionString: phase3DatabaseVerificationUrl
    });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`
        alter table public.agent_outbox_stripe_webhook_events
          alter column processing_status drop default,
          alter column processing_status set not null,
          alter column processed_at drop not null,
          alter column processed_at drop default;
        insert into public.agent_outbox_stripe_webhook_events(
          stripe_event_id, event_type, processing_status, processed_at
        ) values
          ('evt_guard_missing_completion', 'test.guard', 'processed', null),
          ('evt_guard_incomplete_status', 'test.guard', 'processing', now());
      `);
      await assert.rejects(
        executeTransactionalMigrationFile(
          client,
          stripeWebhookCompletedLedgerMigrationPath
        ),
        (error) => {
          assert.equal(/** @type {{ code?: string }} */ (error).code, "23514");
          return true;
        }
      );
      await client.query("rollback");

      const finalShape = await client.query(`
        select column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent_outbox_stripe_webhook_events'
          and column_name in ('processing_status', 'processed_at')
        order by column_name
      `);
      assert.equal(finalShape.rows.length, 2);
      assert.deepEqual(
        finalShape.rows.map((row) => ({
          column_name: row.column_name,
          is_nullable: row.is_nullable
        })),
        [
          { column_name: "processed_at", is_nullable: "NO" },
          { column_name: "processing_status", is_nullable: "NO" }
        ]
      );
      assert.match(finalShape.rows[0].column_default, /now\(\)/);
      assert.match(finalShape.rows[1].column_default, /processed/);
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  }
);
test(
  "Stripe webhook ordering migration backfills existing account projections",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const client = new Client({
      connectionString: phase3DatabaseVerificationUrl
    });
    const accountId = crypto.randomUUID();
    const preMigrationWriterAccountId = crypto.randomUUID();
    const eventId = `evt_ordering_backfill_${crypto.randomUUID()}`;
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`
        drop trigger agent_outbox_accounts_clear_stripe_order_on_legacy_update
          on public.agent_outbox_accounts;
        drop function public.agent_outbox_clear_stripe_event_order_on_legacy_update();
        alter table public.agent_outbox_accounts
          drop constraint agent_outbox_accounts_stripe_event_order_pair,
          drop column stripe_last_event_created_at,
          drop column stripe_last_event_receipt_order;
        alter table public.agent_outbox_stripe_webhook_events
          drop constraint agent_outbox_stripe_webhook_events_receipt_order_unique,
          drop column stripe_receipt_order;
        drop sequence if exists public.agent_outbox_stripe_webhook_receipt_order_seq;
      `);
      await client.query(
        `
          insert into public.agent_outbox_accounts(
            account_id,
            label,
            stripe_customer_id,
            stripe_subscription_id,
            stripe_subscription_status
          ) values ($1, $2, $3, $4, 'active')
        `,
        [
          accountId,
          `stripe-ordering-backfill-${accountId}`,
          `cus_backfill_${accountId}`,
          `sub_backfill_${accountId}`
        ]
      );
      await client.query(
        `
          insert into public.agent_outbox_stripe_webhook_events(
            stripe_event_id,
            event_type,
            processing_status,
            account_id,
            processed_at
          ) values ($1, 'customer.subscription.updated', 'processed', $2, $3)
        `,
        [eventId, accountId, "2026-07-05T12:34:56.789Z"]
      );
      await client.query(
        "insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)",
        [
          preMigrationWriterAccountId,
          `stripe-pre-ordering-writer-${preMigrationWriterAccountId}`
        ]
      );
      const preMigrationProcessed = await processStripeEventInTransaction(
        /** @type {any} */ (
          (/** @type {any} */ statement) =>
            client.query(statement.sql, statement.values)
        ),
        /** @type {any} */ ({
          id: `evt_pre_ordering_migration_${crypto.randomUUID()}`,
          created: 1783209600,
          type: "checkout.session.completed",
          data: {
            object: { client_reference_id: preMigrationWriterAccountId }
          }
        })
      );
      assert.equal(preMigrationProcessed, true);

      await executeTransactionalMigrationFile(
        client,
        stripeWebhookEventOrderingMigrationPath
      );

      const backfilled = await client.query(
        `
          select
            stripe_last_event_created_at = $2::timestamptz as floor_matches,
            stripe_last_event_receipt_order is not null as has_receipt_order
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-05T12:34:56.000Z"]
      );
      assert.deepEqual(backfilled.rows, [
        { floor_matches: true, has_receipt_order: true }
      ]);

      await client.query(
        `
          update public.agent_outbox_accounts
          set stripe_subscription_status = 'canceled'
          where account_id = $1
        `,
        [accountId]
      );
      const afterLegacyUpdate = await client.query(
        `
          select
            stripe_last_event_created_at is null as created_floor_cleared,
            stripe_last_event_receipt_order is null as receipt_order_cleared
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
      assert.deepEqual(afterLegacyUpdate.rows, [
        { created_floor_cleared: true, receipt_order_cleared: true }
      ]);
    } finally {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
    }
  }
);
test(
  "Stripe webhook projections retain newer account state while recording stale distinct events",
  {
    skip: phase3DatabaseVerificationUrl
      ? false
      : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async () => {
    const connectionString = phase3DatabaseVerificationUrl;
    assert.ok(connectionString);
    const client = new Client({ connectionString });
    const accountId = crypto.randomUUID();
    const subscriptionId = `sub_ordering_${crypto.randomUUID()}`;
    const customerId = `cus_ordering_${crypto.randomUUID()}`;
    const newerEventId = `evt_newer_${crypto.randomUUID()}`;
    const staleEventId = `evt_stale_${crypto.randomUUID()}`;
    const equalEventId = `evt_equal_${crypto.randomUUID()}`;
    const concurrentEarlierEventId = `evt_equal_earlier_${crypto.randomUUID()}`;
    const concurrentLaterEventId = `evt_equal_later_${crypto.randomUUID()}`;
    const newerCreated = 1783296000;
    const now = new Date("2026-07-05T00:00:00.000Z");
    /** @type {() => void} */
    let releaseConcurrentEarlier = () => {};
    /** @type {Promise<boolean> | null} */
    let concurrentEarlierProcessing = null;
    let bodyError;

    await client.connect();
    try {
      await client.query(
        "insert into public.agent_outbox_accounts(account_id, label) values ($1, $2)",
        [accountId, `stripe-ordering-${accountId}`]
      );

      const event = (
        /** @type {string} */ eventId,
        /** @type {number} */ created,
        /** @type {string} */ status
      ) =>
        /** @type {any} */ ({
          id: eventId,
          created,
          type: "customer.subscription.updated",
          data: {
            object: {
              id: subscriptionId,
              customer: customerId,
              status,
              metadata: { account_id: accountId },
              items: { data: [] }
            }
          }
        });
      const process = (/** @type {any} */ stripeEvent) =>
        runProductTransaction(
          connectionString,
          {
            requestId: `stripe-ordering-${stripeEvent.id}`,
            authSurface: "control_plane"
          },
          (query) => processStripeEventInTransaction(query, stripeEvent, now)
        );

      assert.equal(
        await process(event(newerEventId, newerCreated, "active")),
        true
      );
      assert.equal(
        await process(event(staleEventId, newerCreated - 3600, "canceled")),
        true
      );

      const afterStale = await client.query(
        `
          select billing_status, stripe_subscription_status,
            stripe_last_event_created_at = $2::timestamptz as marker_matches
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-06T00:00:00.000Z"]
      );
      assert.deepEqual(afterStale.rows, [
        {
          billing_status: "active",
          stripe_subscription_status: "active",
          marker_matches: true
        }
      ]);
      const staleLedger = await client.query(
        `
          select account_id::text as account_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [staleEventId]
      );
      assert.deepEqual(staleLedger.rows, [{ account_id: null }]);

      assert.equal(
        await process(event(equalEventId, newerCreated, "past_due")),
        true
      );
      const afterEqual = await client.query(
        `
          select billing_status, stripe_subscription_status,
            stripe_last_event_created_at = $2::timestamptz as marker_matches
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId, "2026-07-06T00:00:00.000Z"]
      );
      assert.deepEqual(afterEqual.rows, [
        {
          billing_status: "past_due",
          stripe_subscription_status: "past_due",
          marker_matches: true
        }
      ]);

      /** @type {(value?: void | PromiseLike<void>) => void} */
      let markConcurrentEarlierInserted = () => {};
      /** @type {Promise<void>} */
      const concurrentEarlierInserted = new Promise((resolve) => {
        markConcurrentEarlierInserted = resolve;
      });
      /** @type {Promise<void>} */
      const concurrentEarlierRelease = new Promise((resolve) => {
        releaseConcurrentEarlier = resolve;
      });
      concurrentEarlierProcessing = runProductTransaction(
        connectionString,
        {
          requestId: `stripe-ordering-${concurrentEarlierEventId}`,
          authSurface: "control_plane"
        },
        (query) =>
          processStripeEventInTransaction(
            /** @type {any} */ (
              async (/** @type {any} */ statement) => {
                const result = await query(statement);
                if (
                  /insert into public\.agent_outbox_stripe_webhook_events/.test(
                    statement.sql
                  )
                ) {
                  markConcurrentEarlierInserted();
                  await concurrentEarlierRelease;
                }
                return result;
              }
            ),
            event(concurrentEarlierEventId, newerCreated, "canceled"),
            now
          )
      );
      const earlierProcessing = /** @type {Promise<boolean>} */ (
        concurrentEarlierProcessing
      );
      await Promise.race([
        concurrentEarlierInserted,
        earlierProcessing.then(
          () => {
            throw new Error(
              "Earlier equal-second Stripe event completed before the deliberate interleave."
            );
          },
          (error) => {
            throw error;
          }
        )
      ]);

      assert.equal(
        await process(event(concurrentLaterEventId, newerCreated, "active")),
        true
      );
      releaseConcurrentEarlier();
      assert.equal(await concurrentEarlierProcessing, true);

      const afterConcurrentEqual = await client.query(
        `
          select billing_status, stripe_subscription_status
          from public.agent_outbox_accounts
          where account_id = $1
        `,
        [accountId]
      );
      assert.deepEqual(afterConcurrentEqual.rows, [
        {
          billing_status: "active",
          stripe_subscription_status: "active"
        }
      ]);
      const concurrentEarlierLedger = await client.query(
        `
          select account_id::text as account_id
          from public.agent_outbox_stripe_webhook_events
          where stripe_event_id = $1
        `,
        [concurrentEarlierEventId]
      );
      assert.deepEqual(concurrentEarlierLedger.rows, [{ account_id: null }]);
    } catch (error) {
      bodyError = error;
    } finally {
      await preserveBodyErrorDuringTeardown(
        bodyError,
        async () => {
          /** @type {Error[]} */
          const teardownErrors = [];
          const attempt = teardownAttempt(
            teardownErrors,
            "Stripe ordering teardown failed"
          );
          releaseConcurrentEarlier();
          const pendingConcurrentEarlier = concurrentEarlierProcessing;
          if (pendingConcurrentEarlier) {
            await attempt("concurrent earlier event settlement", () =>
              pendingConcurrentEarlier.then(() => undefined)
            );
          }
          await attempt("Stripe ordering ledger cleanup", () =>
            client.query(
              "delete from public.agent_outbox_stripe_webhook_events where stripe_event_id = any($1::text[])",
              [
                [
                  newerEventId,
                  staleEventId,
                  equalEventId,
                  concurrentEarlierEventId,
                  concurrentLaterEventId
                ]
              ]
            )
          );
          await attempt("Stripe ordering account cleanup", () =>
            client.query(
              "delete from public.agent_outbox_accounts where account_id = $1",
              [accountId]
            )
          );
          await attempt("Stripe ordering client close", () => client.end());

          if (teardownErrors.length > 0) {
            throw new AggregateError(
              teardownErrors,
              "Stripe ordering teardown failed."
            );
          }
        },
        "Stripe ordering test and teardown both failed."
      );
    }
  }
);
