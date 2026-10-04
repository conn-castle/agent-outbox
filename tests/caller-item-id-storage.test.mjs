import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { tsImport } from "tsx/esm/api";

import { generateCallerApiKeyMaterial } from "../src/server/caller-auth.ts";
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
const routes = {
  send: await tsImport("../app/api/input/send/route.ts", import.meta.url),
  replace: await tsImport("../app/api/input/replace/route.ts", import.meta.url),
  delete: await tsImport("../app/api/input/delete/route.ts", import.meta.url),
  read: await tsImport("../app/api/input/read/route.ts", import.meta.url),
  output: await tsImport(
    "../app/api/output/[output_result_id]/read/route.ts",
    import.meta.url
  )
};

/**
 * @typedef {Error & {code?: string, routine?: string, schema?: string, table?: string, constraint?: string, column?: string}} DatabaseError
 * @typedef {{sql: string, completed: boolean, error?: unknown, rowCount?: number | null}} DriverEvent
 * @typedef {{statement?: RegExp, error?: Error, rollbackError?: Error, endError?: Error}} DriverFault
 * @typedef {(this: import("pg").Client, sql: string, values?: unknown[]) => Promise<import("pg").QueryResult>} DriverQuery
 * @typedef {(this: import("pg").Client) => Promise<unknown>} DriverLifecycle
 * @typedef {{owner: import("pg").Client, accountId: string, callerId: string, accountAuditId: string, apiKey: string, events: DriverEvent[], logs: Record<string, unknown>[], inFlight: {lastUsed: boolean, quota: boolean}}} Fixture
 */

const rootInsert = /insert into public\.agent_outbox_input_items\s*\(/i;
const childInsert = /insert into public\.agent_outbox_input_actions\s*\(/i;
const indexMetadata = {
  code: "54000",
  routine: "_bt_check_third_page",
  schema: "public",
  table: "agent_outbox_input_items",
  constraint: "agent_outbox_input_items_caller_id_caller_item_id_key"
};

/** @param {Record<string, string>} metadata */
function databaseError(metadata) {
  return Object.assign(new Error("private database diagnostic"), metadata);
}

/** @param {number} bytes */
function randomId(bytes) {
  assert.equal(bytes % 4, 0);
  const id = randomBytes((bytes * 3) / 4).toString("base64");
  assert.equal(Buffer.byteLength(id, "utf8"), bytes);
  return id;
}

/** @param {string} callerItemId @param {string} [title] */
function submission(callerItemId, title = "Choose a label") {
  return {
    caller_item_id: callerItemId,
    row_type: { display: "Email", icon: "mail" },
    title,
    subtitle: "Sender",
    summary: "Review the proposed label",
    link_buttons: [
      {
        display: "Source",
        icon: "external-link",
        url: "https://example.com/source"
      }
    ],
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

/**
 * Seed committed fixture rows as the migration owner, then restrict only the
 * product connections to the app role. All statements and transaction cleanup
 * still run through the real pg driver and production transaction helper.
 * @param {import("node:test").TestContext} t
 * @param {(fixture: Fixture) => Promise<void>} body
 * @param {DriverFault} [fault]
 */
async function withFixture(t, body, fault = {}) {
  assert.ok(databaseUrl);
  await withProcessEnv(
    {
      DATABASE_APP_ROLE_URL: databaseUrl,
      CALLER_KEY_HASH_SECRET:
        "iteration-58-fixture-only-hash-secret-000000000000",
      NODE_ENV: "test",
      APP_ENV: "test",
      SENTRY_DSN: undefined
    },
    async () => {
      const owner = await connectedDatabaseClient(databaseUrl);
      const accountId = randomUUID();
      const callerId = randomUUID();
      let accountAuditId = "";
      /** @type {unknown} */
      let bodyError;
      try {
        await assertMigrationOwnerCanSetAppRole(owner);
        const account = await owner.query(
          "insert into public.agent_outbox_accounts(account_id, label) values ($1, 'Caller item id regression') returning account_audit_id",
          [accountId]
        );
        accountAuditId = account.rows[0].account_audit_id;
        await owner.query(
          "insert into public.agent_outbox_callers(caller_id, account_id, display_name) values ($1, $2, 'Caller item id fixture')",
          [callerId, accountId]
        );
        const key = generateCallerApiKeyMaterial();
        await owner.query(
          `insert into public.agent_outbox_caller_credentials
            (account_id, caller_id, key_id, key_prefix, key_last_four, secret_hmac_sha256, status, activated_at)
           values ($1, $2, $3, $4, $5, $6, 'active', now())`,
          [
            accountId,
            callerId,
            key.keyId,
            key.keyPrefix,
            key.keyLastCharacters,
            key.secretDigest
          ]
        );
        /** @type {Fixture} */
        const fixture = {
          owner,
          accountId,
          callerId,
          accountAuditId,
          apiKey: key.plaintextApiKey,
          events: [],
          logs: [],
          inFlight: { lastUsed: false, quota: false }
        };
        const originalConnect = /** @type {DriverLifecycle} */ (
          pg.Client.prototype.connect
        );
        const originalQuery = /** @type {DriverQuery} */ (
          pg.Client.prototype.query
        );
        const originalEnd = /** @type {DriverLifecycle} */ (
          pg.Client.prototype.end
        );
        const productClients = new WeakSet();
        t.mock.method(
          pg.Client.prototype,
          "connect",
          /** @this {import("pg").Client} */ async function () {
            await originalConnect.call(this);
            // This wrapper is installed after the owner fixture is connected.
            productClients.add(this);
            await originalQuery.call(this, "set role agent_outbox_app");
          }
        );
        t.mock.method(
          pg.Client.prototype,
          "query",
          /** @this {import("pg").Client} */ async function (
            /** @type {string} */ sql,
            /** @type {unknown[]} */ values
          ) {
            if (!productClients.has(this)) {
              return originalQuery.call(this, sql, values);
            }
            const statement = sql.trim();
            if (rootInsert.test(statement)) {
              const state = await originalQuery.call(
                this,
                `select
                exists (select 1 from public.agent_outbox_caller_credentials where account_id = $1 and last_used_at is not null) as last_used,
                exists (select 1 from public.agent_outbox_account_quota_windows where account_id = $1 and used_units > 0) as quota`,
                [accountId]
              );
              fixture.inFlight.lastUsed = state.rows[0].last_used;
              fixture.inFlight.quota = state.rows[0].quota;
            }
            try {
              if (fault.statement?.test(statement)) {
                assert.ok(fault.error);
                throw fault.error;
              }
              if (
                statement.toLowerCase() === "rollback" &&
                fault.rollbackError
              ) {
                throw fault.rollbackError;
              }
              const result = await originalQuery.call(this, sql, values);
              fixture.events.push({
                sql: statement,
                completed: true,
                rowCount: result.rowCount
              });
              return result;
            } catch (error) {
              fixture.events.push({ sql: statement, completed: false, error });
              throw error;
            }
          }
        );
        t.mock.method(
          pg.Client.prototype,
          "end",
          /** @this {import("pg").Client} */ async function () {
            await originalEnd.call(this);
            if (productClients.has(this)) {
              fixture.events.push({ sql: "end", completed: !fault.endError });
              if (fault.endError) throw fault.endError;
            }
          }
        );
        t.mock.method(console, "error", (/** @type {string} */ line) => {
          fixture.logs.push(JSON.parse(line));
        });
        await body(fixture);
      } catch (error) {
        bodyError = error;
      } finally {
        t.mock.restoreAll();
        await preserveBodyErrorDuringTeardown(
          bodyError,
          async () => {
            /** @type {Error[]} */
            const errors = [];
            const attempt = teardownAttempt(
              errors,
              "Caller item id fixture teardown failed"
            );
            await attempt("audit deletion", async () => {
              await owner.query("begin");
              try {
                // Match the existing migration-owner fixture teardown: this
                // transaction-local setting permits deleting only our ledger.
                await owner.query("select set_config($1, $2, true)", [
                  "agent_outbox.audit_break_glass",
                  "on"
                ]);
                await owner.query(
                  "delete from public.agent_outbox_audit_events where account_audit_id = $1",
                  [accountAuditId || accountId]
                );
                await owner.query("commit");
              } catch (error) {
                await preserveBodyErrorDuringTeardown(
                  error,
                  async () => {
                    await owner.query("rollback");
                  },
                  "Fixture audit deletion and rollback both failed."
                );
              }
            });
            await attempt("account deletion", () =>
              owner.query(
                "delete from public.agent_outbox_accounts where account_id = $1",
                [accountId]
              )
            );
            await attempt("owner connection cleanup", () => owner.end());
            if (errors.length)
              throw new AggregateError(
                errors,
                "Caller item id fixture teardown failed."
              );
          },
          "Caller item id regression and teardown both failed."
        );
      }
    }
  );
}

/**
 * @param {Fixture} fixture
 * @param {keyof typeof routes} operation
 * @param {unknown} body
 * @param {string} [outputId]
 */
async function post(fixture, operation, body, outputId) {
  const requestId = `req-id-storage-${randomUUID()}`;
  const path =
    operation === "output"
      ? `/api/output/${outputId}/read`
      : `/api/input/${operation}`;
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.apiKey}`,
      "content-type": "application/json",
      "x-request-id": requestId
    },
    body: JSON.stringify(body)
  });
  const response =
    operation === "output"
      ? await routes.output.POST(request, {
          params: Promise.resolve({ output_result_id: outputId })
        })
      : await routes[operation].POST(request);
  fixture.events.push({ sql: "response", completed: true });
  const envelope = await response.json();
  assert.equal(envelope.request_id, requestId);
  assert.equal(response.headers.get("x-request-id"), requestId);
  assert.equal(
    response.headers.get("x-correlation-id"),
    envelope.correlation_id
  );
  assert.equal(typeof envelope.correlation_id, "string");
  return { status: response.status, envelope };
}

/** @param {Fixture} fixture */
async function storedState(fixture) {
  const result = await fixture.owner.query(
    `select
      (select count(*)::int from public.agent_outbox_input_items where account_id = $1) as roots,
      (select count(*)::int from public.agent_outbox_input_link_buttons b join public.agent_outbox_input_items i using (input_item_id) where i.account_id = $1) as links,
      (select count(*)::int from public.agent_outbox_input_actions a join public.agent_outbox_input_items i using (input_item_id) where i.account_id = $1) as actions,
      (select count(*)::int from public.agent_outbox_input_action_popup_options p join public.agent_outbox_input_actions a using (input_action_id) join public.agent_outbox_input_items i using (input_item_id) where i.account_id = $1) as options,
      (select count(*)::int from public.agent_outbox_audit_events where account_audit_id = $2) as audits,
      (select coalesce(jsonb_agg(to_jsonb(q) order by metric, window_kind, window_start_utc), '[]'::jsonb) from public.agent_outbox_account_quota_windows q where account_id = $1) as quotas,
      (select coalesce(jsonb_agg(to_jsonb(b) order by operation_kind, limit_name), '[]'::jsonb) from public.agent_outbox_account_limit_blocks b where account_id = $1) as blocks,
      (select last_used_at from public.agent_outbox_caller_credentials where account_id = $1) as last_used_at`,
    [fixture.accountId, fixture.accountAuditId]
  );
  return result.rows[0];
}

/** @param {Fixture} fixture */
function assertCompletedRollback(fixture) {
  const rollback = fixture.events.findIndex(
    (event) => event.sql === "rollback" && event.completed
  );
  const end = fixture.events.findIndex((event) => event.sql === "end");
  const response = fixture.events.findIndex(
    (event) => event.sql === "response"
  );
  assert.ok(rollback >= 0, "public request must complete a real rollback");
  assert.ok(
    end > rollback && response > end,
    "rollback and cleanup must precede the response"
  );
  assert.equal(
    fixture.events.some((event) => event.sql === "commit"),
    false
  );
}

/** @param {Awaited<ReturnType<typeof post>>} result @param {string} id */
function assertWidthValidation(result, id) {
  assert.equal(result.status, 422);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error.code, "validation_failed");
  assert.equal(
    result.envelope.error.message,
    "Input submission failed validation."
  );
  assert.equal(result.envelope.error.fields.length, 1);
  const field = result.envelope.error.fields[0];
  assert.equal(field.path, "caller_item_id");
  assert.equal(field.code, "invalid_string");
  assert.match(field.message, /shorter ID/i);
  assert.equal(JSON.stringify(result.envelope).includes(id), false);
  assert.doesNotMatch(
    JSON.stringify(result.envelope),
    /_bt_check|index_form_tuple|54000|agent_outbox_input_items|private database diagnostic/
  );
}

test(
  "caller item ID storage through authenticated POST routes",
  {
    skip: databaseUrl ? false : DATABASE_POLICY_VERIFICATION_SKIP
  },
  async (t) => {
    for (const [bytes, routine] of [
      [3008, "_bt_check_third_page"],
      [12000, "index_form_tuple_context"]
    ]) {
      await t.test(
        `real PostgreSQL ${bytes}-byte ID failure returns 422 after rollback`,
        async (t) => {
          await withFixture(t, async (fixture) => {
            const before = await storedState(fixture);
            const id = randomId(Number(bytes));
            const result = await post(fixture, "send", submission(id));
            const failedInsert = fixture.events.find(
              (event) => rootInsert.test(event.sql) && !event.completed
            );
            assert.ok(
              failedInsert,
              `failure must come from an actual root INSERT: ${JSON.stringify(result.envelope.error)}`
            );
            const error = /** @type {DatabaseError} */ (failedInsert.error);
            assert.equal(error.code, "54000");
            assert.equal(error.routine, routine);
            if (routine === "_bt_check_third_page") {
              assert.equal(error.schema, "public");
              assert.equal(error.table, "agent_outbox_input_items");
              assert.equal(error.constraint, indexMetadata.constraint);
            } else {
              for (const key of ["schema", "table", "constraint", "column"]) {
                assert.equal(
                  /** @type {Record<string, unknown>} */ (
                    /** @type {unknown} */ (error)
                  )[key],
                  undefined
                );
              }
            }
            assertWidthValidation(result, id);
            assertCompletedRollback(fixture);
            assert.deepEqual(
              fixture.inFlight,
              { lastUsed: true, quota: true },
              "credential and quota writes must have occurred before the failed insert"
            );
            assert.deepEqual(
              await storedState(fixture),
              before,
              "failed sends must leave no root, child, audit, quota, block, or last-used changes"
            );
            assert.deepEqual(
              fixture.logs,
              [],
              "expected validation must not report a runtime failure"
            );
          });
        }
      );
    }

    /** @type {[string, () => string][]} */
    const successCases = [
      ["random 2400-byte", () => randomId(2400)],
      ["compressible 100000-byte", () => `  Opaque:%2F:${"x".repeat(99984)} : `]
    ];
    for (const [name, makeId] of successCases) {
      await t.test(
        `${name} opaque IDs support creation, duplicates, replacements, reads and deletion`,
        async (t) => {
          await withFixture(t, async (fixture) => {
            assert.equal(typeof makeId, "function");
            const id = makeId();
            assert.equal(
              Buffer.byteLength(id),
              name === "random 2400-byte" ? 2400 : 100000
            );
            const input = submission(id);
            const created = await post(fixture, "send", input);
            assert.equal(
              created.status,
              200,
              JSON.stringify(created.envelope.error)
            );
            assert.deepEqual(created.envelope.data, {
              caller_item_id: id,
              status: "pending",
              revision: 1,
              created: true,
              duplicate: false
            });
            const stored = await fixture.owner.query(
              "select caller_item_id, current_revision from public.agent_outbox_input_items where account_id = $1",
              [fixture.accountId]
            );
            assert.deepEqual(stored.rows, [
              { caller_item_id: id, current_revision: 1 }
            ]);
            const duplicate = await post(fixture, "send", input);
            assert.equal(duplicate.status, 200);
            assert.deepEqual(duplicate.envelope.data, {
              ...created.envelope.data,
              created: false,
              duplicate: true
            });
            const unchanged = await post(fixture, "replace", input);
            assert.equal(unchanged.status, 200);
            assert.deepEqual(unchanged.envelope.data, {
              caller_item_id: id,
              status: "pending",
              revision: 1,
              replaced: false,
              changed: false
            });
            const changedInput = submission(id, "Changed label");
            const changed = await post(fixture, "replace", changedInput);
            assert.equal(changed.status, 200);
            assert.deepEqual(changed.envelope.data, {
              ...unchanged.envelope.data,
              revision: 2,
              replaced: true,
              changed: true
            });
            const unchangedRevision = await post(
              fixture,
              "replace",
              changedInput
            );
            assert.equal(unchangedRevision.status, 200);
            assert.deepEqual(unchangedRevision.envelope.data, {
              ...unchanged.envelope.data,
              revision: 2
            });
            const read = await post(fixture, "read", { caller_item_id: id });
            assert.equal(read.status, 200);
            assert.equal(read.envelope.ok, true);
            assert.equal(read.envelope.data.caller_item_id, id);
            assert.equal(read.envelope.data.raw_input.caller_item_id, id);
            assert.equal(
              read.envelope.data.raw_input.title,
              changedInput.title
            );
            assert.deepEqual(
              read.envelope.data.raw_input.actions,
              changedInput.actions
            );
            assert.equal(read.envelope.data.revision, 2);
            const missing = await post(
              fixture,
              "replace",
              submission(`${id}:missing`)
            );
            assert.equal(missing.status, 404);
            assert.equal(missing.envelope.ok, false);
            assert.equal(missing.envelope.error.code, "not_found");

            // Existing DML creates a canonical answered output from the real rows;
            // its POST read must reconstruct the original opaque ID and children.
            const outputId = randomUUID();
            await fixture.owner.query(
              `insert into public.agent_outbox_output_results
            (output_result_id, account_id, caller_id, input_item_id, caller_item_id, action_value, response_kind, expires_at)
           select $2, account_id, caller_id, input_item_id, caller_item_id, 'archive', 'none', now() + interval '1 day'
           from public.agent_outbox_input_items where account_id = $1`,
              [fixture.accountId, outputId]
            );
            await fixture.owner.query(
              "update public.agent_outbox_input_items set status = 'answered', answered_at = now() where account_id = $1",
              [fixture.accountId]
            );
            const output = await post(fixture, "output", {}, outputId);
            assert.equal(output.status, 200);
            assert.equal(output.envelope.ok, true);
            assert.equal(output.envelope.data.caller_item_id, id);
            assert.equal(output.envelope.data.raw_input.caller_item_id, id);
            assert.equal(
              output.envelope.data.raw_input.title,
              changedInput.title
            );
            assert.deepEqual(
              output.envelope.data.raw_input.actions,
              changedInput.actions
            );
            assert.equal(output.envelope.data.action_value, "archive");
            await fixture.owner.query(
              "delete from public.agent_outbox_output_results where output_result_id = $1",
              [outputId]
            );
            await fixture.owner.query(
              "update public.agent_outbox_input_items set status = 'pending', answered_at = null where account_id = $1",
              [fixture.accountId]
            );
            const deleted = await post(fixture, "delete", {
              caller_item_id: id
            });
            assert.equal(deleted.status, 200);
            assert.deepEqual(deleted.envelope.data, {
              caller_item_id: id,
              deleted: true
            });
            const after = await storedState(fixture);
            assert.deepEqual(
              [after.roots, after.links, after.actions, after.options],
              [0, 0, 0, 0]
            );
            const absent = await post(fixture, "read", { caller_item_id: id });
            assert.equal(absent.status, 404);
            assert.equal(absent.envelope.error.code, "not_found");
            assert.deepEqual(fixture.logs, []);
          });
        }
      );
    }

    /** @type {{name: string, fault: DriverFault, largeId?: boolean, partialChildren?: boolean}[]} */
    const failures = [
      ...Object.entries({
        constraint: "unrelated_index",
        schema: "unrelated_schema",
        table: "unrelated_table",
        routine: "unrelated_routine",
        column: "caller_item_id"
      }).map(([key, value]) => ({
        name: `unrelated 54000 with wrong ${key}`,
        fault: {
          statement: rootInsert,
          error: databaseError({ ...indexMetadata, [key]: value })
        }
      })),
      ...["schema", "table", "constraint", "column"].map((key) => ({
        name: `tuple width 54000 with unexpected ${key} metadata`,
        fault: {
          statement: rootInsert,
          error: databaseError({
            code: "54000",
            routine: "index_form_tuple_context",
            [key]: "another_object"
          })
        }
      })),
      {
        name: "known-looking root insert error with wrong SQLSTATE",
        fault: {
          statement: rootInsert,
          error: databaseError({ ...indexMetadata, code: "XX000" })
        }
      },
      {
        name: "generic database failure",
        fault: {
          statement: rootInsert,
          error: databaseError({ code: "XX000" })
        }
      },
      {
        name: "known-looking error from account lock",
        fault: {
          statement: /from public\.agent_outbox_accounts[\s\S]*for update/i,
          error: databaseError(indexMetadata)
        }
      },
      {
        name: "known-looking tuple width error from child insert",
        fault: {
          statement: childInsert,
          error: databaseError({
            code: "54000",
            routine: "index_form_tuple_context"
          })
        },
        partialChildren: true
      },
      {
        name: "known-looking attributed error from child insert",
        fault: { statement: childInsert, error: databaseError(indexMetadata) },
        partialChildren: true
      },
      {
        name: "failed rollback after real width failure",
        fault: { rollbackError: new Error("fixture rollback failed") },
        largeId: true
      },
      {
        name: "failed connection cleanup after real width failure",
        fault: { endError: new Error("fixture cleanup failed") },
        largeId: true
      }
    ];
    for (const scenario of failures) {
      await t.test(`${scenario.name} remains a reported 503`, async (t) => {
        await withFixture(
          t,
          async (fixture) => {
            const before = await storedState(fixture);
            const result = await post(
              fixture,
              "send",
              submission(scenario.largeId ? randomId(3008) : randomId(2400))
            );
            assert.equal(result.status, 503);
            assert.equal(result.envelope.ok, false);
            assert.equal(result.envelope.error.code, "temporary_unavailable");
            assert.equal(result.envelope.error.fields, undefined);
            assert.equal(
              result.envelope.error.error_id,
              result.envelope.correlation_id
            );
            assert.equal(
              fixture.logs.length,
              1,
              "ordinary failures must still be reported once"
            );
            assert.equal(fixture.logs[0].operation, "input_send");
            assert.equal(fixture.logs[0].status_code, 503);
            assert.equal(fixture.logs[0].level, "error");
            assert.equal(
              fixture.logs[0].error_id,
              result.envelope.correlation_id
            );
            assert.equal(
              fixture.logs[0].request_id,
              result.envelope.request_id
            );
            assert.doesNotMatch(
              JSON.stringify(fixture.logs),
              /private database diagnostic|fixture rollback failed|fixture cleanup failed/
            );
            if (scenario.fault.rollbackError) {
              const rollback = fixture.events.findIndex(
                (event) => event.sql === "rollback" && !event.completed
              );
              const end = fixture.events.findIndex(
                (event) => event.sql === "end" && event.completed
              );
              const response = fixture.events.findIndex(
                (event) => event.sql === "response"
              );
              assert.ok(rollback >= 0 && end > rollback && response > end);
            } else {
              assertCompletedRollback(fixture);
            }
            if (scenario.partialChildren) {
              assert.ok(
                fixture.events.some(
                  (event) =>
                    rootInsert.test(event.sql) &&
                    event.completed &&
                    event.rowCount === 1
                )
              );
              assert.ok(
                fixture.events.some(
                  (event) =>
                    /insert into public\.agent_outbox_input_link_buttons/i.test(
                      event.sql
                    ) &&
                    event.completed &&
                    event.rowCount === 1
                ),
                "a child write must complete before the injected child failure"
              );
              assert.deepEqual(fixture.inFlight, {
                lastUsed: true,
                quota: true
              });
            }
            assert.deepEqual(
              await storedState(fixture),
              before,
              "real wrapper must discard partial writes (connection close discards work when rollback fails)"
            );
          },
          scenario.fault
        );
      });
    }
  }
);
