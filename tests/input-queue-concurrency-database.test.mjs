// @ts-nocheck -- database fixture wiring intentionally uses runtime pg clients.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import pg from "pg";
import { tsImport } from "tsx/esm/api";

import { generateCallerApiKeyMaterial } from "../src/server/caller-auth.ts";
import { runProductTransaction } from "../src/server/database.ts";
import { safeErrorCode } from "../src/server/logging.ts";
import {
  DATABASE_POLICY_VERIFICATION_SKIP,
  assertMigrationOwnerCanSetAppRole,
  connectedDatabaseClient,
  phase3DatabaseVerificationUrl,
  preserveBodyErrorDuringTeardown,
  teardownAttempt
} from "./helpers/database.mjs";
import { withProcessEnv } from "./helpers/process-env.mjs";

const databaseUrl = phase3DatabaseVerificationUrl();
const sendRoute = await tsImport(
  "../app/api/input/send/route.ts",
  import.meta.url
);
const replaceRoute = await tsImport(
  "../app/api/input/replace/route.ts",
  import.meta.url
);

function input(callerItemId, title = "Choose a label") {
  return {
    caller_item_id: callerItemId,
    row_type: { display: "Email", icon: "mail" },
    title,
    subtitle: "Sender",
    summary: "Review the proposed label",
    link_buttons: [],
    actions: [
      {
        display: "Archive",
        icon: "archive",
        value: "archive",
        overflow: false,
        popup: { kind: "none" }
      }
    ]
  };
}

function inputWithFile(callerItemId) {
  return {
    ...input(callerItemId),
    actions: [
      {
        display: "Attach",
        icon: "paperclip",
        value: "attach",
        overflow: false,
        popup: {
          kind: "file_upload",
          label: "Attach file",
          accept_mime_types: ["application/pdf"]
        }
      }
    ]
  };
}

async function withFixture(t, body, { tier = "hosted_free" } = {}) {
  assert.ok(databaseUrl);
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: databaseUrl,
      CALLER_KEY_HASH_SECRET:
        "account-lock-concurrency-fixture-hash-secret-000000000000",
      NODE_ENV: "test",
      APP_ENV: "test",
      SENTRY_DSN: undefined
    },
    async () => {
      const owner = await connectedDatabaseClient(databaseUrl);
      const accountId = randomUUID();
      const callerId = randomUUID();
      const credential = generateCallerApiKeyMaterial();
      let accountAuditId;
      let bodyError;
      try {
        await assertMigrationOwnerCanSetAppRole(owner);
        const account = await owner.query(
          "insert into public.agent_outbox_accounts(account_id, label, tier) values ($1, 'Input lock concurrency fixture', $2) returning account_audit_id",
          [accountId, tier]
        );
        accountAuditId = account.rows[0].account_audit_id;
        await owner.query(
          "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Input lock caller')",
          [callerId, accountId]
        );
        await owner.query(
          `insert into public.agent_outbox_caller_credentials
            (account_id, caller_id, key_id, key_prefix, key_last_four, secret_hmac_sha256, status, activated_at)
           values ($1, $2, $3, $4, $5, $6, 'active', now())`,
          [
            accountId,
            callerId,
            credential.keyId,
            credential.keyPrefix,
            credential.keyLastCharacters,
            credential.secretDigest
          ]
        );

        const originalConnect = pg.Client.prototype.connect;
        t.mock.method(pg.Client.prototype, "connect", async function () {
          await originalConnect.call(this);
          await this.query("set role agent_outbox_app");
        });
        await body({ owner, accountId, callerId, credential });
      } catch (error) {
        bodyError = error;
      } finally {
        t.mock.restoreAll();
        await preserveBodyErrorDuringTeardown(
          bodyError,
          async () => {
            const errors = [];
            const attempt = teardownAttempt(
              errors,
              "Input concurrency fixture teardown failed"
            );
            await attempt("audit deletion", async () => {
              await owner.query("begin");
              await owner.query("select set_config($1, $2, true)", [
                "agent_outbox.audit_break_glass",
                "on"
              ]);
              await owner.query(
                "delete from public.agent_outbox_audit_events where account_audit_id = $1",
                [accountAuditId]
              );
              await owner.query("commit");
            });
            await attempt("account deletion", () =>
              owner.query(
                "delete from public.agent_outbox_accounts where account_id = $1",
                [accountId]
              )
            );
            await attempt("owner cleanup", () => owner.end());
            if (errors.length) {
              throw new AggregateError(
                errors,
                "Input concurrency fixture teardown failed."
              );
            }
          },
          "Input concurrency test and teardown both failed."
        );
      }
    }
  );
}

async function post(fixture, operation, body) {
  const request = new Request(`http://localhost/api/input/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.credential.plaintextApiKey}`,
      "content-type": "application/json",
      "x-request-id": `req-account-lock-${randomUUID()}`
    },
    body: JSON.stringify(body)
  });
  const response = await (operation === "send"
    ? sendRoute.POST(request)
    : replaceRoute.POST(request));
  return { status: response.status, body: await response.json() };
}

async function accountState(fixture) {
  const result = await fixture.owner.query(
    `select
      (select count(*)::int from public.agent_outbox_input_items where account_id = $1) as inputs,
      (select coalesce(max(current_revision), 0)::int from public.agent_outbox_input_items where account_id = $1) as revision,
      (select coalesce(sum(used_units), 0)::int from public.agent_outbox_account_quota_windows where account_id = $1 and metric in ('input_submissions_per_day', 'input_submissions_per_calendar_month')) as submissions`,
    [fixture.accountId]
  );
  return result.rows[0];
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test(
  "public input handlers bound account/input waits and preserve admitted replay effects",
  { skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP },
  async (t) => {
    await t.test(
      "held account returns 503 before the client deadline, rolls back, then retries idempotently",
      async (t) => {
        await withFixture(t, async (fixture) => {
          await fixture.owner.query("begin");
          await fixture.owner.query(
            "select account_id from public.agent_outbox_accounts where account_id = $1 for update",
            [fixture.accountId]
          );
          const started = performance.now();
          const blocked = await post(fixture, "send", input("held-account"));
          const elapsed = performance.now() - started;
          assert.equal(blocked.status, 503);
          assert.equal(blocked.body.error.code, "temporary_unavailable");
          assert.ok(
            elapsed >= 1_500 && elapsed < 4_500,
            `elapsed ${elapsed}ms`
          );
          assert.deepEqual(await accountState(fixture), {
            inputs: 0,
            revision: 0,
            submissions: 0
          });
          await fixture.owner.query("rollback");
          const accepted = await post(fixture, "send", input("held-account"));
          const replay = await post(fixture, "send", input("held-account"));
          assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
          assert.equal(replay.status, 200);
          assert.equal(replay.body.data.duplicate, true);
          assert.deepEqual(await accountState(fixture), {
            inputs: 1,
            revision: 1,
            submissions: 2
          });
        });
      }
    );

    await t.test(
      "a burst creates one card per distinct id and stops at the seeded quota edge",
      async (t) => {
        await withFixture(t, async (fixture) => {
          const burst = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
              post(fixture, "send", input(`burst-${index}`))
            )
          );
          assert.deepEqual(
            burst.map((result) => result.status),
            [200, 200, 200, 200, 200]
          );
          assert.deepEqual(await accountState(fixture), {
            inputs: 5,
            revision: 1,
            submissions: 10
          });
          await fixture.owner.query(
            `insert into public.agent_outbox_account_quota_windows
              (account_id, metric, window_kind, window_start_utc, used_units)
             values
              ($1, 'input_submissions_per_day', 'day', date_trunc('day', now()), 999),
              ($1, 'input_submissions_per_calendar_month', 'calendar_month', date_trunc('month', now()), 4999)
             on conflict (account_id, metric, window_kind, window_start_utc)
             do update set used_units = excluded.used_units`,
            [fixture.accountId]
          );
          const edge = await Promise.all([
            post(fixture, "send", input("quota-edge-a")),
            post(fixture, "send", input("quota-edge-b"))
          ]);
          assert.deepEqual(
            edge.map((result) => result.status).sort(),
            [200, 429]
          );
          assert.equal(
            edge.find((result) => result.status === 429)?.body.error.code,
            "quota_limit_exceeded"
          );
          const persisted = await fixture.owner.query(
            "select caller_item_id from public.agent_outbox_input_items where account_id = $1 order by caller_item_id",
            [fixture.accountId]
          );
          assert.deepEqual(
            persisted.rows.map((row) => row.caller_item_id),
            [
              "burst-0",
              "burst-1",
              "burst-2",
              "burst-3",
              "burst-4",
              edge.find((result) => result.status === 200)?.body.data
                .caller_item_id
            ]
          );
          const quotaWindows = await fixture.owner.query(
            `select metric, used_units
             from public.agent_outbox_account_quota_windows
             where account_id = $1
               and metric in ('input_submissions_per_day', 'input_submissions_per_calendar_month')
             order by metric`,
            [fixture.accountId]
          );
          assert.deepEqual(quotaWindows.rows, [
            {
              metric: "input_submissions_per_calendar_month",
              used_units: "5000"
            },
            { metric: "input_submissions_per_day", used_units: "1000" }
          ]);
        });
      }
    );

    await t.test(
      "held input bounds replace and never applies the changed replay",
      async (t) => {
        await withFixture(t, async (fixture) => {
          assert.equal(
            (await post(fixture, "send", input("held-input"))).status,
            200
          );
          await fixture.owner.query("begin");
          await fixture.owner.query(
            "select input_item_id from public.agent_outbox_input_items where account_id = $1 and caller_item_id = $2 for update",
            [fixture.accountId, "held-input"]
          );
          const started = performance.now();
          const blocked = await post(
            fixture,
            "replace",
            input("held-input", "Changed while held")
          );
          const elapsed = performance.now() - started;
          assert.equal(blocked.status, 503);
          assert.ok(
            elapsed >= 1_500 && elapsed < 4_500,
            `elapsed ${elapsed}ms`
          );
          assert.deepEqual(await accountState(fixture), {
            inputs: 1,
            revision: 1,
            submissions: 2
          });
          await fixture.owner.query("rollback");
          const replaced = await post(
            fixture,
            "replace",
            input("held-input", "Changed while held")
          );
          assert.equal(replaced.status, 200);
          assert.equal(replaced.body.data.revision, 2);
          assert.deepEqual(await accountState(fixture), {
            inputs: 1,
            revision: 2,
            submissions: 4
          });
          const beforeReplay = await accountState(fixture);
          const unchanged = await post(
            fixture,
            "replace",
            input("held-input", "Changed while held")
          );
          const changedSend = await post(
            fixture,
            "send",
            input("held-input", "Conflicting send replay")
          );
          assert.equal(unchanged.status, 200);
          assert.equal(unchanged.body.data.changed, false);
          assert.equal(changedSend.status, 409);
          assert.equal(changedSend.body.error.code, "pending_content_conflict");
          assert.deepEqual(await accountState(fixture), beforeReplay);
          const mixed = await Promise.all([
            post(fixture, "send", input("mixed-send")),
            post(fixture, "replace", input("held-input", "Mixed replace"))
          ]);
          assert.deepEqual(
            mixed.map((result) => result.status).sort(),
            [200, 200]
          );
        });
      }
    );

    await t.test(
      "more than twenty public writers use admission before the held account wait",
      async (t) => {
        await withFixture(t, async (fixture) => {
          await fixture.owner.query("begin");
          await fixture.owner.query(
            "select account_id from public.agent_outbox_accounts where account_id = $1 for update",
            [fixture.accountId]
          );
          // Synchronize the burst at the admission boundary: park each
          // admitted writer before its account-lock wait until all 25
          // writers have finished admission. Admission is nonblocking, so
          // while parked no lock deadline ticks and no transaction-scoped
          // advisory slot can be released early by a timeout rollback.
          const writerCount = 25;
          let admissionAttempts = 0;
          let releaseAdmissionGate;
          const admissionGate = new Promise((resolve) => {
            releaseAdmissionGate = resolve;
          });
          const originalQuery = pg.Client.prototype.query;
          t.mock.method(
            pg.Client.prototype,
            "query",
            async function (text, values) {
              const statementText =
                typeof text === "string" ? text : text?.text;
              const statementValues =
                values ?? (typeof text === "object" ? text?.values : undefined);
              if (
                typeof statementText === "string" &&
                statementText.includes("pg_try_advisory_xact_lock")
              ) {
                try {
                  return await originalQuery.call(this, text, values);
                } finally {
                  if (
                    statementValues?.[0] === fixture.accountId &&
                    ++admissionAttempts >= writerCount
                  ) {
                    releaseAdmissionGate();
                  }
                }
              }
              if (
                statementText ===
                  "select account_id::text from public.agent_outbox_accounts where account_id = $1 for update" &&
                statementValues?.[0] === fixture.accountId
              ) {
                await Promise.race([
                  admissionGate,
                  new Promise((_, reject) => {
                    const timer = setTimeout(
                      () =>
                        reject(
                          new Error(
                            "admission gate timed out waiting for all writers to finish admission"
                          )
                        ),
                      30_000
                    );
                    timer.unref?.();
                  })
                ]);
              }
              return originalQuery.call(this, text, values);
            }
          );
          let earlyRejections = 0;
          const requests = Array.from({ length: writerCount }, (_, index) =>
            post(fixture, "send", input(`admission-${index}`)).then(
              (result) => {
                if (result.status === 429) earlyRejections++;
                return result;
              }
            )
          );
          // Do not release on the first waiter: all twenty admitted requests
          // must hold slots before the remaining five can reject deterministically.
          // The gate above already bounds setup skew; keep a generous ceiling
          // so slow CI waits for the rejections instead of failing early.
          await waitFor(
            async () => earlyRejections === 5,
            "five excess requests must reject while the account remains held",
            30_000
          );
          await fixture.owner.query("rollback");
          const results = await Promise.all(requests);
          assert.equal(
            results.filter((result) => result.status === 429).length,
            5
          );
          const acceptedCount = results.filter(
            (result) => result.status === 200
          ).length;
          const waitBackpressure = results.filter(
            (result) => result.status === 503
          );
          assert.equal(acceptedCount + waitBackpressure.length, 20);
          for (const result of waitBackpressure) {
            assert.equal(result.body.error.code, "temporary_unavailable");
          }
          assert.deepEqual(await accountState(fixture), {
            inputs: acceptedCount,
            revision: acceptedCount ? 1 : 0,
            submissions: acceptedCount * 2
          });
          // Admitted requests may hit the documented short lock deadline.
          // Sequential retries must create exactly one card for every id,
          // while replaying already accepted ids must charge no submission quota.
          for (let index = 0; index < results.length; index++) {
            const retried = await post(
              fixture,
              "send",
              input(`admission-${index}`)
            );
            assert.equal(retried.status, 200);
            assert.equal(
              retried.body.data.duplicate,
              results[index].status === 200
            );
          }
          assert.deepEqual(await accountState(fixture), {
            inputs: 25,
            revision: 1,
            submissions: 50
          });
        });
      }
    );

    await t.test(
      "same credential first use skips advisory bookkeeping instead of blocking",
      async (t) => {
        await withFixture(t, async (fixture) => {
          await fixture.owner.query("begin");
          await fixture.owner.query(
            "select key_id from public.agent_outbox_caller_credentials where account_id = $1 for update",
            [fixture.accountId]
          );
          const started = performance.now();
          const result = await post(fixture, "send", input("held-credential"));
          assert.equal(result.status, 200);
          assert.ok(performance.now() - started < 1_500);
          await fixture.owner.query("rollback");
        });
      }
    );

    await t.test(
      "saturated admission returns 429 before validation or quota accounting",
      async (t) => {
        await withFixture(t, async (fixture) => {
          await fixture.owner.query("begin");
          await fixture.owner.query(
            `select pg_advisory_xact_lock(
            ('x' || substr(md5($1 || ':' || $2 || ':' || slot.slot_number::text), 1, 16))::bit(64)::bigint
          ) from generate_series(1, 20) slot(slot_number)`,
            [fixture.accountId, "concurrent_write_requests_per_account"]
          );
          const saturated = await post(fixture, "send", input("saturated"));
          assert.equal(saturated.status, 429);
          assert.equal(saturated.body.error.code, "rate_limit_exceeded");
          assert.equal(
            saturated.body.error.limit.limit_name,
            "concurrent_write_requests_per_account"
          );
          assert.deepEqual(await accountState(fixture), {
            inputs: 0,
            revision: 0,
            submissions: 0
          });
          await fixture.owner.query("rollback");
          assert.equal(
            (await post(fixture, "send", input("saturated"))).status,
            200
          );
        });
      }
    );

    await t.test(
      "a committed downgrade is reread after the account lock",
      async (t) => {
        await withFixture(
          t,
          async (fixture) => {
            await fixture.owner.query("begin");
            await fixture.owner.query(
              "update public.agent_outbox_accounts set tier = 'hosted_free' where account_id = $1",
              [fixture.accountId]
            );
            const request = post(
              fixture,
              "send",
              inputWithFile("downgraded-file")
            );
            const holder = await fixture.owner.query(
              "select pg_backend_pid() as pid"
            );
            await waitFor(async () => {
              await fixture.owner.query("select pg_stat_clear_snapshot()");
              const blocked = await fixture.owner.query(
                "select exists(select 1 from pg_catalog.pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting",
                [holder.rows[0].pid]
              );
              return blocked.rows[0].waiting;
            }, "send must wait on the downgrade account lock before its tier changes");
            await fixture.owner.query("commit");
            const result = await request;
            assert.equal(result.status, 402);
            assert.equal(result.body.error.code, "upgrade_required");
            assert.deepEqual(await accountState(fixture), {
              inputs: 0,
              revision: 0,
              submissions: 0
            });
          },
          { tier: "hosted_paid" }
        );
      }
    );

    await t.test(
      "real client read timeout closes the backend, and falsy callback failures roll back",
      async (t) => {
        await withFixture(t, async (fixture) => {
          for (const catchTimeout of [false, true]) {
            let backendPid;
            const started = performance.now();
            await assert.rejects(
              runProductTransaction(
                databaseUrl,
                {
                  requestId: `req-timeout-${randomUUID()}`,
                  authSurface: "caller",
                  accountId: fixture.accountId,
                  callerId: fixture.callerId
                },
                async (query) => {
                  const pid = await query({
                    sql: "select pg_backend_pid() as pid"
                  });
                  backendPid = pid.rows[0].pid;
                  await query({ sql: "set local statement_timeout = 0" });
                  try {
                    await query({
                      sql: "set local client_connection_check_interval = '100ms'"
                    });
                    await query({ sql: "select pg_sleep(30)" });
                  } catch (error) {
                    if (!catchTimeout) throw error;
                    // A callback catching a transport timeout cannot turn the
                    // transaction into success or enqueue a follow-up query.
                    await query({ sql: "select 1" });
                  }
                }
              ),
              (error) => safeErrorCode(error) === "QUERY_READ_TIMEOUT"
            );
            const elapsed = performance.now() - started;
            assert.ok(
              elapsed >= 4_500 && elapsed < 5_500,
              `elapsed ${elapsed}ms`
            );
            await waitFor(
              async () => {
                const active = await fixture.owner.query(
                  "select count(*)::int as count from pg_catalog.pg_stat_activity where pid = $1",
                  [backendPid]
                );
                return active.rows[0]?.count === 0;
              },
              "timed-out product backend must disappear after connection cleanup",
              2_500
            );
          }
          const probe = createServer();
          await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
          const unusedPort = probe.address().port;
          await new Promise((resolve, reject) =>
            probe.close((error) => (error ? reject(error) : resolve()))
          );
          const connectStarted = performance.now();
          await assert.rejects(
            runProductTransaction(
              `postgresql://postgres@127.0.0.1:${unusedPort}/agent_outbox_ci`,
              { requestId: "req-refused-local-connect", authSurface: "caller" },
              () => assert.fail("callback cannot run after failed connect")
            ),
            (error) => error.code === "ECONNREFUSED"
          );
          assert.ok(performance.now() - connectStarted < 1_500);

          for (const thrown of [undefined, null, 0]) {
            const windowStart = "2099-01-01T00:00:00.000Z";
            await assert.rejects(
              runProductTransaction(
                databaseUrl,
                {
                  requestId: `req-falsy-${randomUUID()}`,
                  authSurface: "caller",
                  accountId: fixture.accountId,
                  callerId: fixture.callerId
                },
                async (query) => {
                  await query({
                    sql: `insert into public.agent_outbox_account_quota_windows
                      (account_id, metric, window_kind, window_start_utc, used_units)
                     values ($1, 'input_submissions_per_day', 'day', $2::timestamptz, 1)`,
                    values: [fixture.accountId, windowStart]
                  });
                  throw thrown;
                }
              ),
              (error) => error === thrown
            );
            const persisted = await fixture.owner.query(
              "select count(*)::int as count from public.agent_outbox_account_quota_windows where account_id = $1 and window_start_utc = $2::timestamptz",
              [fixture.accountId, windowStart]
            );
            assert.equal(persisted.rows[0]?.count, 0);
          }
        });
      }
    );
  }
);
