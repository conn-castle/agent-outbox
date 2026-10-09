import assert from "node:assert/strict";
import test from "node:test";

import {
  accountQuotaWindowMaintenanceStatement,
  activeLimitMaintenanceStatement,
  callerSetupCleanupCutoff,
  duplicateAcknowledgementLookupStatement,
  expiredBillingGraceCleanupStatement,
  expiredBillingGraceDowngradeStatement,
  globalQuotaWindowMaintenanceStatements,
  neverActivatedCallerPruningStatement,
  outputTimeoutCleanupStatement,
  pendingInputRetentionStatement,
  preReadUndoStatement,
  quotaWindowPruningCutoff,
  quotaWindowPruningStatement,
  terminalOutputDeletionStatement
} from "../src/server/cleanup.ts";
import {
  cleanupAccountTargetsStatement,
  cleanupAccountTierLockStatement,
  runScheduledCanary,
  runScheduledCleanup,
  scheduledCleanupStatementsForAccount
} from "../src/server/scheduled.ts";
import { queryResult } from "./helpers/fake-query.mjs";

test("cleanup statement builders target lifecycle database functions", () => {
  const duplicateAck = duplicateAcknowledgementLookupStatement(
    { accountId: "account-123", callerId: "caller-123" },
    "output-123"
  );
  assert.match(duplicateAck.sql, /agent_outbox_audit_events/);
  assert.match(duplicateAck.sql, /agent_outbox_callers/);
  assert.match(duplicateAck.sql, /event\.output_result_id = \$3::uuid/);
  assert.match(duplicateAck.sql, /caller\.account_id = \$1::uuid/);
  assert.match(duplicateAck.sql, /caller\.caller_id = \$2::uuid/);
  assert.match(duplicateAck.sql, /agent_outbox_context_account_id/);
  assert.match(duplicateAck.sql, /agent_outbox_context_allows_caller/);
  assert.deepEqual(duplicateAck.values, [
    "account-123",
    "caller-123",
    "output-123"
  ]);
  assert.deepEqual(
    terminalOutputDeletionStatement("output-123", "acknowledgement", "req-1"),
    {
      sql: "select * from public.agent_outbox_delete_output_result($1, $2, $3)",
      values: ["output-123", "acknowledgement", "req-1"]
    }
  );
  assert.deepEqual(preReadUndoStatement("output-123", "req-1"), {
    sql: "select * from public.agent_outbox_restore_unread_output($1, $2)",
    values: ["output-123", "req-1"]
  });
  assert.deepEqual(
    pendingInputRetentionStatement(
      new Date("2026-06-30T00:00:00.000Z"),
      "req-1"
    ),
    {
      sql: "select public.agent_outbox_delete_retained_pending_inputs($1, $2) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z", "req-1"]
    }
  );
  assert.deepEqual(
    outputTimeoutCleanupStatement(new Date("2026-06-30T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_delete_expired_outputs($1) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z"]
    }
  );
  for (const builder of [
    expiredBillingGraceCleanupStatement,
    expiredBillingGraceDowngradeStatement
  ]) {
    assert.deepEqual(
      builder(32_000_000, new Date("2026-06-30T00:00:00.000Z")).values,
      [32_000_000, "2026-06-30T00:00:00.000Z"]
    );
    for (const invalidLimit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => builder(invalidLimit, new Date("2026-06-30T00:00:00.000Z")),
        /nonFilePayloadLimitBytes must be a non-negative safe integer/
      );
    }
  }
  const quotaPruneBefore = new Date("2026-06-01T00:00:00.000Z");
  const accountQuotaPruning = {
    sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
    values: ["2026-06-01T00:00:00.000Z"]
  };
  assert.deepEqual(
    quotaWindowPruningStatement(quotaPruneBefore),
    accountQuotaPruning
  );
  const quotaMaintenanceNow = new Date("2026-07-15T12:34:56.000Z");
  assert.equal(
    callerSetupCleanupCutoff(quotaMaintenanceNow).toISOString(),
    "2026-07-08T12:34:56.000Z"
  );
  assert.deepEqual(
    neverActivatedCallerPruningStatement(
      callerSetupCleanupCutoff(quotaMaintenanceNow)
    ),
    {
      sql: "select public.agent_outbox_prune_never_activated_callers($1) as deleted_count",
      values: ["2026-07-08T12:34:56.000Z"]
    }
  );
  assert.equal(
    quotaWindowPruningCutoff(quotaMaintenanceNow).toISOString(),
    "2026-07-01T00:00:00.000Z"
  );
  // IP quota rows are minute-only, so their prune uses a minute-anchored cutoff
  // (start of the current minute) rather than the account month-anchored cutoff.
  assert.equal(
    quotaWindowPruningCutoff(quotaMaintenanceNow, ["minute"]).toISOString(),
    "2026-07-15T12:34:00.000Z"
  );
  assert.deepEqual(
    accountQuotaWindowMaintenanceStatement(quotaMaintenanceNow),
    {
      sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
      values: ["2026-07-01T00:00:00.000Z"]
    }
  );
  assert.deepEqual(
    globalQuotaWindowMaintenanceStatements(quotaMaintenanceNow),
    [
      {
        sql: "select public.agent_outbox_prune_ip_quota_windows($1) as deleted_count",
        values: ["2026-07-15T12:34:00.000Z"]
      },
      {
        sql: "select public.agent_outbox_prune_caller_setup_requests($1) as deleted_count",
        values: ["2026-07-08T12:34:56.000Z"]
      },
      {
        sql: "select public.agent_outbox_prune_stripe_webhook_events($1) as deleted_count",
        values: ["2026-04-16T12:34:56.000Z"]
      }
    ]
  );
  assert.deepEqual(
    activeLimitMaintenanceStatement(new Date("2026-06-30T00:00:00.000Z")),
    {
      sql: "select public.agent_outbox_prune_expired_limit_blocks($1) as deleted_count",
      values: ["2026-06-30T00:00:00.000Z"]
    }
  );
});
test("scheduled cleanup runs global and account-scoped maintenance under cleanup context", async () => {
  /** @type {import("../src/server/database.ts").ProductTransactionContext[]} */
  const contexts = [];
  /** @type {import("../src/server/database.ts").TransactionContextStatement[][]} */
  const statementsByContext = [];
  const now = new Date("2026-07-15T12:34:56.000Z");
  const result = await runScheduledCleanup({
    connectionString: "postgresql://cleanup-test",
    now,
    requestId: "cleanup-test-request",
    async runTransaction(connectionString, context, callback) {
      assert.equal(connectionString, "postgresql://cleanup-test");
      contexts.push(context);
      /** @type {import("../src/server/database.ts").TransactionContextStatement[]} */
      const statements = [];
      statementsByContext.push(statements);

      /**
       * @param {import("../src/server/database.ts").TransactionContextStatement} statement
       * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
       */
      const query = async (statement) => {
        statements.push(statement);
        if (statement.sql.includes("agent_outbox_cleanup_account_targets")) {
          return queryResult([
            { account_id: "account-free" },
            { account_id: "account-paid" }
          ]);
        }
        if (statement.sql === cleanupAccountTierLockStatement("").sql) {
          return queryResult([
            {
              tier:
                context.accountId === "account-paid"
                  ? "hosted_paid"
                  : "hosted_free"
            }
          ]);
        }

        return queryResult([{ deleted_count: 1 }]);
      };

      return await callback(
        /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
          query
        )
      );
    }
  });

  const globalContext = {
    requestId: "cleanup-test-request",
    authSurface: "cleanup"
  };
  assert.deepEqual(contexts, [
    globalContext,
    globalContext,
    globalContext,
    globalContext,
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-free"
    },
    {
      requestId: "cleanup-test-request",
      authSurface: "cleanup",
      accountId: "account-paid"
    }
  ]);
  assert.deepEqual(
    statementsByContext.slice(0, 3),
    globalQuotaWindowMaintenanceStatements(now).map((statement) => [statement])
  );
  assert.deepEqual(statementsByContext[3], [cleanupAccountTargetsStatement()]);
  const [, , , , freeAccountStatements, paidAccountStatements] =
    statementsByContext;
  assert.deepEqual(freeAccountStatements, [
    cleanupAccountTierLockStatement("account-free"),
    ...scheduledCleanupStatementsForAccount({
      tier: "hosted_free",
      now,
      requestId: "cleanup-test-request"
    })
  ]);
  assert.deepEqual(paidAccountStatements, [
    cleanupAccountTierLockStatement("account-paid"),
    ...scheduledCleanupStatementsForAccount({
      tier: "hosted_paid",
      now,
      requestId: "cleanup-test-request"
    })
  ]);
  assert.deepEqual(result, {
    ok: true,
    code: "scheduled_cleanup_completed",
    request_id: "cleanup-test-request",
    recorded_at: result.recorded_at,
    accounts_seen: 2,
    accounts_cleaned: 2,
    statements_run: 14,
    rows_affected: 14
  });
  assert.match(result.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    freeAccountStatements.filter((statement) =>
      statement.sql.includes("agent_outbox_delete_retained_pending_inputs")
    ),
    [
      pendingInputRetentionStatement(
        new Date("2026-05-16T12:34:56.000Z"),
        "cleanup-test-request"
      )
    ]
  );
  assert.deepEqual(
    freeAccountStatements.filter((statement) =>
      statement.sql.includes("agent_outbox_delete_expired_outputs")
    ),
    [outputTimeoutCleanupStatement(now)]
  );
  assert.deepEqual(
    paidAccountStatements.filter((statement) =>
      statement.sql.includes("agent_outbox_delete_retained_pending_inputs")
    ),
    []
  );
  assert.deepEqual(paidAccountStatements.slice(-2), [
    expiredBillingGraceCleanupStatement(32_000_000, now),
    expiredBillingGraceDowngradeStatement(32_000_000, now)
  ]);
});
test("scheduled cleanup continues account maintenance after one account fails", async () => {
  /** @type {import("../src/server/database.ts").ProductTransactionContext[]} */
  const contexts = [];
  const now = new Date("2026-07-15T12:34:56.000Z");
  const accountFailure = new Error("lock timeout");
  /** @type {unknown} */
  let thrown;
  try {
    await runScheduledCleanup({
      connectionString: "postgresql://cleanup-test",
      now,
      requestId: "cleanup-test-request",
      async runTransaction(connectionString, context, callback) {
        assert.equal(connectionString, "postgresql://cleanup-test");
        contexts.push(context);

        if (context.accountId === "account-free") {
          throw accountFailure;
        }

        /**
         * @param {import("../src/server/database.ts").TransactionContextStatement} statement
         * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
         */
        const query = async (statement) => {
          if (statement.sql.includes("agent_outbox_cleanup_account_targets")) {
            return queryResult([
              { account_id: "account-free" },
              { account_id: "account-paid" }
            ]);
          }
          if (statement.sql === cleanupAccountTierLockStatement("").sql) {
            return queryResult([{ tier: "hosted_paid" }]);
          }

          return queryResult([{ deleted_count: 1 }]);
        };

        return await callback(
          /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
            query
          )
        );
      }
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof AggregateError);
  assert.match(
    thrown.message,
    /^Scheduled cleanup failed for 1 account\(s\): account-free$/
  );
  assert.deepEqual(thrown.errors, [accountFailure]);
  assert.deepEqual(
    contexts.filter((context) => context.accountId),
    [
      {
        requestId: "cleanup-test-request",
        authSurface: "cleanup",
        accountId: "account-free"
      },
      {
        requestId: "cleanup-test-request",
        authSurface: "cleanup",
        accountId: "account-paid"
      }
    ]
  );
});

/**
 * Runs scheduled cleanup against a fake database that lists two accounts and
 * fails a statement when `failureFor` returns an error for it.
 *
 * @param {(sql: string, context: import("../src/server/database.ts").ProductTransactionContext) => Error | undefined} failureFor
 */
async function runCleanupWithFailures(failureFor) {
  /** @type {string[]} */
  const executedSql = [];
  /** @type {string[]} */
  const cleanedAccounts = [];
  /** @type {unknown} */
  let thrown;
  try {
    await runScheduledCleanup({
      connectionString: "postgresql://cleanup-test",
      now: new Date("2026-07-15T12:34:56.000Z"),
      requestId: "cleanup-test-request",
      async runTransaction(_connectionString, context, callback) {
        const result = await callback(
          /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
            /** @param {import("../src/server/database.ts").TransactionContextStatement} statement */
            async (statement) => {
              const failure = failureFor(statement.sql, context);
              if (failure) {
                throw failure;
              }
              executedSql.push(statement.sql);
              const rows = statement.sql.includes(
                "agent_outbox_cleanup_account_targets"
              )
                ? [{ account_id: "account-a" }, { account_id: "account-b" }]
                : statement.sql === cleanupAccountTierLockStatement("").sql
                  ? [{ tier: "hosted_free" }]
                  : [{ deleted_count: 1 }];
              return queryResult(rows);
            }
          )
        );
        if (context.accountId) {
          cleanedAccounts.push(context.accountId);
        }
        return result;
      }
    });
  } catch (error) {
    thrown = error;
  }

  return { executedSql, cleanedAccounts, thrown };
}

test("scheduled cleanup still runs other prunes and account maintenance after a global prune fails", async () => {
  const pruneFailure = new Error('column "processing_status" does not exist');
  const { executedSql, cleanedAccounts, thrown } = await runCleanupWithFailures(
    (sql) =>
      sql.includes("agent_outbox_prune_ip_quota_windows")
        ? pruneFailure
        : undefined
  );

  assert(thrown instanceof AggregateError);
  assert.equal(
    thrown.message,
    "Scheduled cleanup failed for 1 global maintenance statement(s)"
  );
  assert.deepEqual(thrown.errors, [pruneFailure]);
  assert(
    executedSql.some((sql) =>
      sql.includes("agent_outbox_prune_caller_setup_requests")
    )
  );
  assert(
    executedSql.some((sql) =>
      sql.includes("agent_outbox_prune_stripe_webhook_events")
    )
  );
  assert.deepEqual(cleanedAccounts, ["account-a", "account-b"]);
});

test("scheduled cleanup reports global and account failures together", async () => {
  const pruneFailure = new Error("function does not exist");
  const accountFailure = new Error("lock timeout");
  const { cleanedAccounts, thrown } = await runCleanupWithFailures(
    (sql, context) => {
      if (sql.includes("agent_outbox_prune_stripe_webhook_events")) {
        return pruneFailure;
      }
      return context.accountId === "account-a" ? accountFailure : undefined;
    }
  );

  assert(thrown instanceof AggregateError);
  assert.equal(
    thrown.message,
    "Scheduled cleanup failed for 1 global maintenance statement(s) and 1 account(s): account-a"
  );
  assert.deepEqual(thrown.errors, [pruneFailure, accountFailure]);
  assert.deepEqual(cleanedAccounts, ["account-b"]);
});

test("scheduled cleanup fails without account maintenance when accounts cannot be listed", async () => {
  const listingFailure = new Error("connection reset");
  const { executedSql, cleanedAccounts, thrown } = await runCleanupWithFailures(
    (sql) =>
      sql.includes("agent_outbox_cleanup_account_targets")
        ? listingFailure
        : undefined
  );

  assert.equal(thrown, listingFailure);
  assert.equal(executedSql.length, 3);
  assert.deepEqual(cleanedAccounts, []);
});

test("scheduled cleanup reports an account whose locked row cannot be read", async () => {
  const now = new Date("2026-07-15T12:34:56.000Z");
  /** @type {string[]} */
  const cleanedAccounts = [];
  /** @type {unknown} */
  let thrown;
  try {
    await runScheduledCleanup({
      connectionString: "postgresql://cleanup-test",
      now,
      requestId: "cleanup-test-request",
      async runTransaction(_connectionString, context, callback) {
        /**
         * @param {import("../src/server/database.ts").TransactionContextStatement} statement
         * @returns {Promise<import("pg").QueryResult<import("pg").QueryResultRow>>}
         */
        const query = async (statement) => {
          if (statement.sql.includes("agent_outbox_cleanup_account_targets")) {
            return queryResult([
              { account_id: "account-missing" },
              { account_id: "account-paid" }
            ]);
          }
          if (statement.sql === cleanupAccountTierLockStatement("").sql) {
            return queryResult(
              context.accountId === "account-missing"
                ? []
                : [{ tier: "hosted_paid" }]
            );
          }
          if (context.accountId) {
            cleanedAccounts.push(context.accountId);
          }

          return queryResult([{ deleted_count: 0 }]);
        };

        return await callback(
          /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
            query
          )
        );
      }
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof AggregateError);
  assert.match(
    thrown.message,
    /^Scheduled cleanup failed for 1 account\(s\): account-missing$/
  );
  assert.match(
    String(thrown.errors[0]?.message),
    /locked account row is invalid/
  );
  assert.equal(new Set(cleanedAccounts).size, 1);
  assert.ok(cleanedAccounts.includes("account-paid"));
});

test("scheduled canary ignores invalid scheduled timestamps", () => {
  const originalLog = console.log;
  console.log = () => {};

  try {
    const canary = runScheduledCanary({
      trigger: "cron",
      cron: "17 * * * *",
      scheduledTime: Number.NaN
    });

    assert.equal(canary.scheduled_time, null);
  } finally {
    console.log = originalLog;
  }
});
