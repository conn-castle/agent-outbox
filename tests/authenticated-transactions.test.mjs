import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  formatCallerApiKey,
  generateCallerApiKeyMaterial,
  parseCallerApiKey
} from "../src/server/caller-auth.ts";
import {
  assertMigrationOwnerCanSetAppRole,
  preserveBodyErrorDuringTeardown,
  teardownAttempt
} from "./helpers/database.mjs";

const { Client } = pg;

const accountId = "00000000-0000-4000-8000-000000000901";
const userId = "00000000-0000-4000-8000-000000000902";
const callerId = "00000000-0000-4000-8000-000000000903";
const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";

const databaseTestsEnabled =
  process.env.AGENT_OUTBOX_ENABLE_DATABASE_TESTS === "1";
const callerDatabaseVerificationUrl = databaseTestsEnabled
  ? process.env.DATABASE_MIGRATION_URL
  : undefined;

if (databaseTestsEnabled) {
  assert.ok(
    callerDatabaseVerificationUrl,
    "DATABASE_MIGRATION_URL is required when AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1"
  );
}

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionContext} ProductTransactionContext
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 */

test("human authentication, authorization, and work share one transaction", async () => {
  const { runHumanAccountTransaction } =
    await import("../src/server/human-session.ts");
  assert.equal(typeof runHumanAccountTransaction, "function");

  const previousDatabaseUrl = process.env.DATABASE_APP_ROLE_URL;
  process.env.DATABASE_APP_ROLE_URL = "postgresql://human-transaction-test";
  const runner = fakeTransactionRunner((statement) => {
    if (/agent_outbox_bootstrap_clerk_human/.test(statement.sql)) {
      return [
        {
          user_id: userId,
          account_id: accountId,
          role: "owner",
          provisioned_account: false
        }
      ];
    }
    if (/agent_outbox_account_members/.test(statement.sql)) {
      return [{ account_id: accountId, user_id: userId, role: "owner" }];
    }
    if (/agent_outbox_accounts/.test(statement.sql)) {
      return [
        {
          account_id: accountId,
          label: "Transaction test",
          tier: "hosted_free",
          billing_status: "not_applicable",
          billing_grace_ends_at: null
        }
      ];
    }
    if (/select 'operation' as value/.test(statement.sql)) {
      return [{ value: "operation" }];
    }
    return [];
  });

  try {
    const result = await runHumanAccountTransaction(
      {
        clerkUserId: "user_clerk_transaction",
        requestId: "req-human-transaction"
      },
      async (query, session) => {
        assert.equal(session.accountId, accountId);
        const operation = await query({
          sql: "select 'operation' as value"
        });
        return operation.rows[0]?.value;
      },
      { runTransaction: runner.runTransaction }
    );

    assert.equal(runner.calls, 1);
    assert.deepEqual(runner.contexts, [
      {
        requestId: "req-human-transaction",
        authSurface: "human",
        clerkUserId: "user_clerk_transaction"
      }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.data : null, "operation");
    assert.deepEqual(
      identityContextValues(runner.statements),
      [
        "agent_outbox.account_id",
        accountId,
        "agent_outbox.caller_id",
        "",
        "agent_outbox.user_id",
        userId
      ],
      "human identity elevation must clear any caller identity"
    );
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_APP_ROLE_URL;
    } else {
      process.env.DATABASE_APP_ROLE_URL = previousDatabaseUrl;
    }
  }
});

test("caller authentication, last-used accounting, and work share one transaction", async () => {
  const { runAuthenticatedCallerTransaction } =
    await import("../src/server/caller-api-auth.ts");
  assert.equal(typeof runAuthenticatedCallerTransaction, "function");

  const previousHashSecret = process.env.CALLER_KEY_HASH_SECRET;
  process.env.CALLER_KEY_HASH_SECRET = HASH_SECRET_FIXTURE;
  const material = generateCallerApiKeyMaterial();
  const parsed = parseCallerApiKey(material.plaintextApiKey);
  assert.equal(parsed.ok, true);
  const runner = fakeTransactionRunner((statement) => {
    if (/agent_outbox_lookup_caller_credential/.test(statement.sql)) {
      return [
        {
          account_id: accountId,
          caller_id: callerId,
          key_id: material.keyId,
          secret_hmac_sha256: material.secretDigest,
          status: "active",
          revoked_at: null,
          expires_at: null
        }
      ];
    }
    if (/select 'operation' as value/.test(statement.sql)) {
      return [{ value: "operation" }];
    }
    return [];
  });

  try {
    const result = await runAuthenticatedCallerTransaction(
      new Request("https://app.agent-outbox.dev/api/input/send", {
        headers: {
          authorization: `Bearer ${formatCallerApiKey({
            keyId: material.keyId,
            secret: parsed.ok ? parsed.secret : ""
          })}`
        }
      }),
      {
        requestId: "req-caller-transaction",
        correlationId: "corr-caller-transaction",
        route: "/api/input/send",
        method: "POST",
        startedAtMs: Date.now()
      },
      "postgresql://caller-transaction-test",
      async (query, identity) => {
        assert.equal(identity.accountId, accountId);
        assert.equal(identity.callerId, callerId);
        const operation = await query({
          sql: "select 'operation' as value"
        });
        return operation.rows[0]?.value;
      },
      { runTransaction: runner.runTransaction }
    );

    assert.equal(runner.calls, 1);
    assert.deepEqual(runner.contexts, [
      {
        requestId: "req-caller-transaction",
        authSurface: "caller"
      }
    ]);
    assert.equal(result.authenticated, true);
    assert.equal(result.authenticated ? result.data : null, "operation");
    assert.deepEqual(
      identityContextValues(runner.statements),
      [
        "agent_outbox.account_id",
        accountId,
        "agent_outbox.caller_id",
        callerId,
        "agent_outbox.user_id",
        ""
      ],
      "caller identity elevation must clear any human identity"
    );
    assert.equal(
      runner.statements.filter((statement) =>
        /last_used_at/.test(statement.sql)
      ).length,
      1
    );

    // Identity elevation must run before last-used accounting and the caller's
    // work so every scoped write executes under the caller identity. Moving the
    // set_config after the last-used update or the operation would flip these.
    const identityIndex = runner.statements.findIndex(
      (statement) =>
        /set_config/.test(statement.sql) &&
        statement.values?.includes("agent_outbox.account_id")
    );
    const lastUsedIndex = runner.statements.findIndex((statement) =>
      /last_used_at/.test(statement.sql)
    );
    const operationIndex = runner.statements.findIndex((statement) =>
      /select 'operation' as value/.test(statement.sql)
    );
    assert.ok(identityIndex >= 0, "expected an identity set_config statement");
    assert.ok(
      identityIndex < lastUsedIndex,
      "identity elevation must precede the last-used accounting statement"
    );
    assert.ok(
      identityIndex < operationIndex,
      "identity elevation must precede the caller operation statement"
    );
  } finally {
    if (previousHashSecret === undefined) {
      delete process.env.CALLER_KEY_HASH_SECRET;
    } else {
      process.env.CALLER_KEY_HASH_SECRET = previousHashSecret;
    }
  }
});

test("caller authentication failure never installs scoped identity or runs work", async () => {
  const { runAuthenticatedCallerTransaction } =
    await import("../src/server/caller-api-auth.ts");
  const previousHashSecret = process.env.CALLER_KEY_HASH_SECRET;
  process.env.CALLER_KEY_HASH_SECRET = HASH_SECRET_FIXTURE;
  const material = generateCallerApiKeyMaterial();
  const otherMaterial = generateCallerApiKeyMaterial();
  let operationCalls = 0;
  const runner = fakeTransactionRunner((statement) => {
    if (/agent_outbox_lookup_caller_credential/.test(statement.sql)) {
      return [
        {
          account_id: accountId,
          caller_id: callerId,
          key_id: material.keyId,
          secret_hmac_sha256: otherMaterial.secretDigest,
          status: "active",
          revoked_at: null,
          expires_at: null
        }
      ];
    }
    return [];
  });

  try {
    const result = await runAuthenticatedCallerTransaction(
      new Request("https://app.agent-outbox.dev/api/input/send", {
        headers: { authorization: `Bearer ${material.plaintextApiKey}` }
      }),
      {
        requestId: "req-caller-denied",
        correlationId: "corr-caller-denied",
        route: "/api/input/send",
        method: "POST",
        startedAtMs: Date.now()
      },
      "postgresql://caller-transaction-test",
      async () => {
        operationCalls += 1;
      },
      { runTransaction: runner.runTransaction }
    );

    assert.equal(result.authenticated, false);
    assert.equal(operationCalls, 0);
    assert.equal(
      runner.statements.some((statement) => /set_config/.test(statement.sql)),
      false
    );
    assert.equal(
      runner.statements.some((statement) => /last_used_at/.test(statement.sql)),
      false
    );
  } finally {
    if (previousHashSecret === undefined) {
      delete process.env.CALLER_KEY_HASH_SECRET;
    } else {
      process.env.CALLER_KEY_HASH_SECRET = previousHashSecret;
    }
  }
});

test("caller last-used failure rolls back its savepoint and still runs work", async () => {
  const { runAuthenticatedCallerTransaction } =
    await import("../src/server/caller-api-auth.ts");
  const previousHashSecret = process.env.CALLER_KEY_HASH_SECRET;
  process.env.CALLER_KEY_HASH_SECRET = HASH_SECRET_FIXTURE;
  const material = generateCallerApiKeyMaterial();
  /** @type {string[]} */
  const statements = [];
  let operationCalls = 0;
  /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
  const runTransaction = async (_connectionString, _context, callback) => {
    const rawQuery = async (
      /** @type {TransactionContextStatement} */ statement
    ) => {
      statements.push(statement.sql.trim());
      if (/agent_outbox_lookup_caller_credential/.test(statement.sql)) {
        return queryResult([
          {
            account_id: accountId,
            caller_id: callerId,
            key_id: material.keyId,
            secret_hmac_sha256: material.secretDigest,
            status: "active",
            revoked_at: null,
            expires_at: null
          }
        ]);
      }
      if (/last_used_at/.test(statement.sql)) {
        throw new Error("last-used write failed");
      }
      return queryResult([]);
    };
    return callback(
      /** @type {ProductTransactionQuery} */ (/** @type {unknown} */ (rawQuery))
    );
  };

  try {
    const result = await runAuthenticatedCallerTransaction(
      new Request("https://app.agent-outbox.dev/api/input/send", {
        headers: { authorization: `Bearer ${material.plaintextApiKey}` }
      }),
      {
        requestId: "req-caller-last-used",
        correlationId: "corr-caller-last-used",
        route: "/api/input/send",
        method: "POST",
        startedAtMs: Date.now()
      },
      "postgresql://caller-transaction-test",
      async () => {
        operationCalls += 1;
        return "operation";
      },
      { runTransaction }
    );

    assert.equal(result.authenticated, true);
    assert.equal(operationCalls, 1);
    assert.equal(
      statements.includes("rollback to savepoint caller_last_used"),
      true
    );
    assert.equal(
      statements.includes("release savepoint caller_last_used"),
      true
    );
  } finally {
    if (previousHashSecret === undefined) {
      delete process.env.CALLER_KEY_HASH_SECRET;
    } else {
      process.env.CALLER_KEY_HASH_SECRET = previousHashSecret;
    }
  }
});

test(
  "caller last-used failure commits the callback write against a live database",
  {
    skip: callerDatabaseVerificationUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run the caller savepoint database test"
  },
  async () => {
    const databaseUrl = callerDatabaseVerificationUrl;
    assert.ok(databaseUrl);
    const { runAuthenticatedCallerTransaction } =
      await import("../src/server/caller-api-auth.ts");

    const previousHashSecret = process.env.CALLER_KEY_HASH_SECRET;
    process.env.CALLER_KEY_HASH_SECRET = HASH_SECRET_FIXTURE;

    const client = new Client({
      application_name: "agent-outbox-caller-savepoint-verification",
      connectionString: databaseUrl
    });
    const runId = crypto.randomUUID();
    const triggerName = `agent_outbox_test_block_last_used_${runId.replace(/-/g, "")}`;
    const sentinelSlug = `savepoint-sentinel-${runId}`;
    /** @type {{ accountId?: string, callerId?: string }} */
    const ids = {};
    /** @type {unknown} */
    let bodyError;

    await client.connect();

    try {
      const material = generateCallerApiKeyMaterial();
      ids.accountId = crypto.randomUUID();
      await assertMigrationOwnerCanSetAppRole(client);
      await client.query("set role agent_outbox_app");
      await client.query("begin");
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.auth_surface",
        "cleanup"
      ]);
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        ids.accountId
      ]);

      const accountRows = await client.query(
        `
          insert into public.agent_outbox_accounts(account_id, label)
          values ($1, $2)
          returning account_id
        `,
        [ids.accountId, `caller-savepoint-${runId}`]
      );
      /** @type {string} */
      const seedAccountId = accountRows.rows[0].account_id;
      ids.accountId = seedAccountId;

      const callerRows = await client.query(
        `
          insert into public.agent_outbox_callers(
            account_id, display_name, caller_slug
          )
          values ($1, 'Savepoint Caller', $2)
          returning caller_id
        `,
        [ids.accountId, `caller-${runId}`]
      );
      ids.callerId = callerRows.rows[0].caller_id;

      await client.query(
        `
          insert into public.agent_outbox_caller_credentials(
            account_id,
            caller_id,
            key_id,
            key_prefix,
            key_last_four,
            secret_hmac_sha256,
            status
          )
          values ($1, $2, $3, $4, $5, $6, 'active')
        `,
        [
          ids.accountId,
          ids.callerId,
          material.keyId,
          material.keyPrefix,
          material.keyLastCharacters,
          material.secretDigest
        ]
      );
      await client.query("commit");
      await client.query("reset role");

      // Force the last_used_at UPDATE that runs inside the caller transaction to
      // raise, so the caller savepoint must roll back exactly that statement
      // while the surrounding transaction still commits the callback's work.
      await client.query(
        `
          create or replace function public.${triggerName}()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.last_used_at is distinct from old.last_used_at then
              raise exception 'forced last-used failure for savepoint verification';
            end if;
            return new;
          end;
          $$
        `
      );
      await client.query(
        `
          create trigger ${triggerName}
          before update on public.agent_outbox_caller_credentials
          for each row execute function public.${triggerName}()
        `
      );

      let operationCalls = 0;
      const result = await runAuthenticatedCallerTransaction(
        new Request("https://app.agent-outbox.dev/api/input/send", {
          headers: {
            authorization: `Bearer ${material.plaintextApiKey}`
          }
        }),
        {
          requestId: "req-caller-savepoint-db",
          correlationId: "corr-caller-savepoint-db",
          route: "/api/input/send",
          method: "POST",
          startedAtMs: Date.now()
        },
        databaseUrl,
        async (query, identity) => {
          operationCalls += 1;
          assert.equal(identity.accountId, ids.accountId);
          assert.equal(identity.callerId, ids.callerId);
          await query({
            sql: `
              insert into public.agent_outbox_callers(
                account_id, display_name, caller_slug
              )
              values ($1, 'Savepoint Sentinel', $2)
            `,
            values: [seedAccountId, sentinelSlug]
          });
          return "operation";
        }
      );

      assert.equal(result.authenticated, true);
      assert.equal(result.authenticated ? result.data : null, "operation");
      assert.equal(operationCalls, 1);

      // (a) The caller's real work must be committed and visible on a fresh read
      // even though the last-used accounting failed inside the same transaction.
      const sentinelRows = await client.query(
        `
          select 1
          from public.agent_outbox_callers
          where account_id = $1
            and caller_slug = $2
        `,
        [ids.accountId, sentinelSlug]
      );
      assert.equal(
        sentinelRows.rowCount,
        1,
        "callback insert must be committed and visible after the transaction"
      );

      // (b) The last-used update must have rolled back to its savepoint, so the
      // credential timestamp was never bumped.
      const credentialRows = await client.query(
        `
          select last_used_at
          from public.agent_outbox_caller_credentials
          where key_id = $1
        `,
        [material.keyId]
      );
      assert.equal(
        credentialRows.rows[0].last_used_at,
        null,
        "last_used_at must not be bumped when the savepoint rolls back"
      );
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
            "Caller transaction database teardown failed"
          );
          await attempt("test trigger cleanup", () =>
            client.query(
              `drop trigger if exists ${triggerName} on public.agent_outbox_caller_credentials`
            )
          );
          await attempt("test function cleanup", () =>
            client.query(`drop function if exists public.${triggerName}()`)
          );
          if (ids.accountId) {
            await attempt("test account cleanup", async () => {
              await client.query("set role agent_outbox_app");
              await client.query("begin");
              try {
                await client.query("select set_config($1, $2, true)", [
                  "agent_outbox.auth_surface",
                  "cleanup"
                ]);
                await client.query("select set_config($1, $2, true)", [
                  "agent_outbox.account_id",
                  ids.accountId
                ]);
                await client.query(
                  `delete from public.agent_outbox_accounts where account_id = $1`,
                  [ids.accountId]
                );
                await client.query("commit");
              } catch (error) {
                await client.query("rollback");
                throw error;
              } finally {
                await client.query("reset role");
              }
            });
          }
          await attempt("client close", () => client.end());
          if (previousHashSecret === undefined) {
            delete process.env.CALLER_KEY_HASH_SECRET;
          } else {
            process.env.CALLER_KEY_HASH_SECRET = previousHashSecret;
          }
          if (teardownErrors.length > 0) {
            throw new AggregateError(
              teardownErrors,
              "Caller transaction database teardown failed."
            );
          }
        },
        "Caller transaction database test and teardown both failed."
      );
    }
  }
);

/**
 * @param {(statement: TransactionContextStatement) => QueryResultRow[]} rowsForStatement
 */
function fakeTransactionRunner(rowsForStatement) {
  /** @type {ProductTransactionContext[]} */
  const contexts = [];
  /** @type {TransactionContextStatement[]} */
  const statements = [];
  let calls = 0;

  /** @type {typeof import("../src/server/database.ts").runProductTransaction} */
  const runTransaction = async (_connectionString, context, callback) => {
    calls += 1;
    contexts.push(context);
    const rawQuery = async (
      /** @type {TransactionContextStatement} */ statement
    ) => {
      statements.push(statement);
      const rows = rowsForStatement(statement);
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    };
    const query = /** @type {ProductTransactionQuery} */ (
      /** @type {unknown} */ (rawQuery)
    );
    return callback(query);
  };

  return {
    get calls() {
      return calls;
    },
    contexts,
    statements,
    runTransaction
  };
}

/**
 * @param {TransactionContextStatement[]} statements
 */
function identityContextValues(statements) {
  return statements.find(
    (statement) =>
      /set_config/.test(statement.sql) &&
      statement.values?.includes("agent_outbox.account_id")
  )?.values;
}

/** @param {QueryResultRow[]} rows */
function queryResult(rows) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}
