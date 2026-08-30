import assert from "node:assert/strict";
import test from "node:test";

import {
  accountQuotaWindowMaintenanceStatement,
  activeLimitMaintenanceStatement,
  callerSetupCleanupCutoff,
  duplicateAcknowledgementLookupStatement,
  downgradeGraceExpiryStatement,
  expiredBillingGraceDowngradeStatement,
  globalQuotaWindowMaintenanceStatements,
  neverActivatedCallerPruningStatement,
  outputTimeoutCleanupStatement,
  pendingInputRetentionStatement,
  preReadUndoStatement,
  quotaWindowMaintenanceStatements,
  quotaWindowPruningCutoff,
  quotaWindowPruningStatement,
  terminalOutputDeletionStatement
} from "../src/server/cleanup.ts";
import {
  cleanupAccountTargetsStatement,
  runScheduledCanary,
  runScheduledCleanup,
  scheduledCleanupStatementsForAccount
} from "../src/server/scheduled.ts";

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
  assert.deepEqual(
    downgradeGraceExpiryStatement(
      32_000_000,
      new Date("2026-06-30T00:00:00.000Z")
    ),
    {
      sql: "select * from public.agent_outbox_cleanup_downgrade_grace_expiry($1, $2)",
      values: [32_000_000, "2026-06-30T00:00:00.000Z"]
    }
  );
  assert.throws(
    () =>
      downgradeGraceExpiryStatement(-1, new Date("2026-06-30T00:00:00.000Z")),
    /nonFilePayloadLimitBytes must be a non-negative safe integer/
  );
  const expiredGraceDowngrade = expiredBillingGraceDowngradeStatement(
    32_000_000,
    new Date("2026-06-30T00:00:00.000Z")
  );
  assert.match(
    expiredGraceDowngrade.sql,
    /agent_outbox_cleanup_downgrade_grace_expiry\(\$1, \$2\)/
  );
  assert.match(expiredGraceDowngrade.sql, /tier = 'hosted_free'/);
  assert.match(expiredGraceDowngrade.sql, /billing_status = 'not_applicable'/);
  assert.deepEqual(expiredGraceDowngrade.values, [
    32_000_000,
    "2026-06-30T00:00:00.000Z"
  ]);
  assert.throws(
    () =>
      expiredBillingGraceDowngradeStatement(
        Number.MAX_SAFE_INTEGER + 1,
        new Date("2026-06-30T00:00:00.000Z")
      ),
    /nonFilePayloadLimitBytes must be a non-negative safe integer/
  );
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
  assert.deepEqual(quotaWindowMaintenanceStatements(quotaMaintenanceNow), [
    {
      sql: "select public.agent_outbox_prune_quota_windows($1) as deleted_count",
      values: ["2026-07-01T00:00:00.000Z"]
    },
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
  ]);
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
  /**
   * @param {import("pg").QueryResultRow[]} rows
   * @returns {import("pg").QueryResult<import("pg").QueryResultRow>}
   */
  function cleanupQueryResult(rows) {
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }

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
          return cleanupQueryResult([
            { account_id: "account-free", tier: "hosted_free" },
            { account_id: "account-paid", tier: "hosted_paid" }
          ]);
        }

        return cleanupQueryResult([{ deleted_count: 1 }]);
      };

      return await callback(
        /** @type {import("../src/server/database.ts").ProductTransactionQuery} */ (
          query
        )
      );
    }
  });

  assert.deepEqual(contexts, [
    { requestId: "cleanup-test-request", authSurface: "cleanup" },
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
  assert.deepEqual(statementsByContext[0], [
    cleanupAccountTargetsStatement(),
    ...globalQuotaWindowMaintenanceStatements(now)
  ]);
  assert.deepEqual(
    statementsByContext[1],
    scheduledCleanupStatementsForAccount({
      tier: "hosted_free",
      now,
      requestId: "cleanup-test-request"
    })
  );
  assert.deepEqual(
    statementsByContext[2],
    scheduledCleanupStatementsForAccount({
      tier: "hosted_paid",
      now,
      requestId: "cleanup-test-request"
    })
  );
  assert.deepEqual(result, {
    ok: true,
    code: "scheduled_cleanup_completed",
    request_id: "cleanup-test-request",
    recorded_at: result.recorded_at,
    accounts_seen: 2,
    accounts_cleaned: 2,
    statements_run: 13,
    rows_affected: 13
  });
  assert.match(result.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    statementsByContext[1].filter((statement) =>
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
    statementsByContext[1].filter((statement) =>
      statement.sql.includes("agent_outbox_delete_expired_outputs")
    ),
    [outputTimeoutCleanupStatement(now)]
  );
  assert.deepEqual(
    statementsByContext[2].filter((statement) =>
      statement.sql.includes("agent_outbox_delete_retained_pending_inputs")
    ),
    []
  );
  assert.deepEqual(
    statementsByContext[2].filter((statement) =>
      statement.sql.includes("agent_outbox_cleanup_downgrade_grace_expiry")
    ),
    [expiredBillingGraceDowngradeStatement(32_000_000, now)]
  );
});
test("scheduled cleanup continues account maintenance after one account fails", async () => {
  /** @type {import("../src/server/database.ts").ProductTransactionContext[]} */
  const contexts = [];
  const now = new Date("2026-07-15T12:34:56.000Z");
  const accountFailure = new Error("lock timeout");
  /**
   * @param {import("pg").QueryResultRow[]} rows
   * @returns {import("pg").QueryResult<import("pg").QueryResultRow>}
   */
  function cleanupQueryResult(rows) {
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }

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
            return cleanupQueryResult([
              { account_id: "account-free", tier: "hosted_free" },
              { account_id: "account-paid", tier: "hosted_paid" }
            ]);
          }

          return cleanupQueryResult([{ deleted_count: 1 }]);
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
  assert.deepEqual(contexts, [
    { requestId: "cleanup-test-request", authSurface: "cleanup" },
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
