import { createCorrelationId } from "./correlation.ts";
import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";
import {
  accountQuotaWindowMaintenanceStatement,
  activeLimitMaintenanceStatement,
  callerSetupCleanupCutoff,
  expiredBillingGraceDowngradeStatement,
  globalQuotaWindowMaintenanceStatements,
  neverActivatedCallerPruningStatement,
  outputTimeoutCleanupStatement,
  pendingInputRetentionStatement
} from "./cleanup.ts";
import {
  type ProductTransactionContext,
  type ProductTransactionQuery,
  runProductTransaction,
  type TransactionContextStatement
} from "./database.ts";
import {
  accountLimitStatusMetadata,
  type AccountTier,
  limitProfileSelectorForAccountTier,
  type LimitProfileSelector
} from "./limits.ts";
import { durationSinceMs, emitRuntimeLog } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";

export const RUNTIME_CRON_SCHEDULE = SYSTEM_CONTRACT.scheduledCleanupCron;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULED_CLEANUP_OPERATION = "maintenance.scheduled_cleanup";

type ScheduledCanaryTrigger = "cron" | "route";

type ScheduledCanaryInput = {
  trigger: ScheduledCanaryTrigger;
  cron?: string | null;
  scheduledTime?: number | null;
};

type ScheduledCleanupAccountTarget = {
  accountId: string;
  tier: AccountTier;
};

type ScheduledCleanupAccountTargetRow = {
  account_id: unknown;
  tier: unknown;
};

type CleanupStatementResultRow = {
  deleted_count?: unknown;
};

type CleanupStatementTotals = {
  statementsRun: number;
  rowsAffected: number;
};

type ScheduledCleanupTransactionRunner = <TResult>(
  connectionString: string,
  context: ProductTransactionContext,
  callback: (query: ProductTransactionQuery) => Promise<TResult>
) => Promise<TResult>;

export type ScheduledCleanupInput = {
  connectionString?: string | null;
  now?: Date;
  requestId?: string;
  runTransaction?: ScheduledCleanupTransactionRunner;
};

export type ScheduledCleanupResult = {
  ok: true;
  code: "scheduled_cleanup_completed";
  request_id: string;
  recorded_at: string;
  accounts_seen: number;
  accounts_cleaned: number;
  statements_run: number;
  rows_affected: number;
};

export function runScheduledCanary(input: ScheduledCanaryInput) {
  const startedAtMs = Date.now();
  const errorId = createCorrelationId("sched");
  const recordedAt = new Date().toISOString();
  const scheduledTime =
    typeof input.scheduledTime === "number" &&
    Number.isFinite(input.scheduledTime)
      ? new Date(input.scheduledTime).toISOString()
      : null;
  const log = emitRuntimeLog({
    level: "info",
    error_id: errorId,
    environment: process.env.APP_ENV ?? null,
    surface: "scheduled",
    duration_ms: durationSinceMs(startedAtMs),
    operation: "runtime.scheduled.canary",
    message: "scheduled runtime canary executed"
  });

  return {
    ok: true,
    code: "scheduled_canary_ok",
    trigger: input.trigger,
    cron: input.cron ?? null,
    configured_cron: RUNTIME_CRON_SCHEDULE,
    error_id: errorId,
    recorded_at: recordedAt,
    scheduled_time: scheduledTime,
    log
  };
}

export function cleanupAccountTargetsStatement(): TransactionContextStatement {
  return {
    sql: "select account_id::text as account_id, tier from public.agent_outbox_cleanup_account_targets()"
  };
}

export function scheduledCleanupStatementsForAccount(input: {
  tier: AccountTier;
  now: Date;
  requestId: string;
}): TransactionContextStatement[] {
  const profile = limitProfileSelectorForAccountTier(input.tier);
  if (!profile) {
    throw new Error(
      `Unknown account tier for scheduled cleanup: ${input.tier}`
    );
  }

  const statements = [
    accountQuotaWindowMaintenanceStatement(input.now),
    activeLimitMaintenanceStatement(input.now),
    neverActivatedCallerPruningStatement(callerSetupCleanupCutoff(input.now)),
    outputTimeoutCleanupStatement(input.now)
  ];
  const pendingRetentionCutoff = pendingInputRetentionCutoff(
    input.now,
    profile
  );

  if (pendingRetentionCutoff) {
    statements.push(
      pendingInputRetentionStatement(pendingRetentionCutoff, input.requestId)
    );
  }
  if (input.tier === "hosted_paid") {
    statements.push(
      expiredBillingGraceDowngradeStatement(
        freeTierNonFilePayloadLimitBytes(),
        input.now
      )
    );
  }

  return statements;
}

export async function runScheduledCleanup(
  input: ScheduledCleanupInput = {}
): Promise<ScheduledCleanupResult> {
  const startedAtMs = Date.now();
  const connectionString =
    input.connectionString ?? process.env.DATABASE_APP_ROLE_URL;
  const requestId = input.requestId ?? createCorrelationId("cleanup");
  const now = input.now ?? new Date();
  const recordedAt = new Date().toISOString();
  const runTransaction = input.runTransaction ?? runProductTransaction;

  if (!connectionString) {
    const error = new Error(
      "DATABASE_APP_ROLE_URL is required for scheduled cleanup."
    );
    emitScheduledCleanupFailure({ requestId, error, startedAtMs });
    throw error;
  }

  try {
    const globalResult = await runTransaction(
      connectionString,
      { requestId, authSurface: "cleanup" },
      async (query) => {
        const accountTargetsResult =
          await query<ScheduledCleanupAccountTargetRow>(
            cleanupAccountTargetsStatement()
          );
        const totals = await runCleanupStatements(
          query,
          globalQuotaWindowMaintenanceStatements(now)
        );

        return {
          accounts: accountTargetsResult.rows.map(cleanupAccountTargetFromRow),
          ...totals
        };
      }
    );

    let statementsRun = globalResult.statementsRun;
    let rowsAffected = globalResult.rowsAffected;
    let accountsCleaned = 0;
    const accountFailures: { accountId: string; error: unknown }[] = [];

    for (const account of globalResult.accounts) {
      try {
        const accountResult = await runTransaction(
          connectionString,
          {
            requestId,
            authSurface: "cleanup",
            accountId: account.accountId
          },
          (query) =>
            runCleanupStatements(
              query,
              scheduledCleanupStatementsForAccount({
                tier: account.tier,
                now,
                requestId
              })
            )
        );

        statementsRun += accountResult.statementsRun;
        rowsAffected += accountResult.rowsAffected;
        accountsCleaned += 1;
      } catch (error) {
        emitScheduledCleanupFailure({
          requestId,
          error,
          accountId: account.accountId,
          startedAtMs
        });
        accountFailures.push({ accountId: account.accountId, error });
      }
    }

    if (accountFailures.length > 0) {
      const failedAccountIds = accountFailures
        .map((failure) => failure.accountId)
        .join(", ");
      throw new AggregateError(
        accountFailures.map((failure) => failure.error),
        `Scheduled cleanup failed for ${accountFailures.length} account(s): ${failedAccountIds}`
      );
    }

    emitRuntimeLog({
      level: "info",
      request_id: requestId,
      environment: process.env.APP_ENV ?? null,
      surface: "scheduled",
      duration_ms: durationSinceMs(startedAtMs),
      operation: SCHEDULED_CLEANUP_OPERATION,
      message: "scheduled cleanup completed"
    });

    return {
      ok: true,
      code: "scheduled_cleanup_completed",
      request_id: requestId,
      recorded_at: recordedAt,
      accounts_seen: globalResult.accounts.length,
      accounts_cleaned: accountsCleaned,
      statements_run: statementsRun,
      rows_affected: rowsAffected
    };
  } catch (error) {
    emitScheduledCleanupFailure({ requestId, error, startedAtMs });
    throw error;
  }
}

async function runCleanupStatements(
  query: ProductTransactionQuery,
  statements: readonly TransactionContextStatement[]
): Promise<CleanupStatementTotals> {
  let statementsRun = 0;
  let rowsAffected = 0;

  for (const statement of statements) {
    const result = await query<CleanupStatementResultRow>(statement);
    statementsRun += 1;
    rowsAffected += deletedCountFromRow(result.rows[0]);
  }

  return { statementsRun, rowsAffected };
}

function pendingInputRetentionCutoff(
  now: Date,
  profile: LimitProfileSelector
): Date | null {
  const retentionLimit = accountLimitStatusMetadata(profile).limits.find(
    (limit) => limit.limitName === "input_retention_days"
  );

  if (!retentionLimit) {
    throw new Error("Missing input_retention_days limit metadata.");
  }
  if (retentionLimit.setting.mode !== "enabled") {
    return null;
  }

  return new Date(now.getTime() - retentionLimit.setting.value * ONE_DAY_MS);
}

function freeTierNonFilePayloadLimitBytes(): number {
  const freeProfile = accountLimitStatusMetadata("hosted-free");
  const limit = freeProfile.limits.find(
    (entry) => entry.limitName === "stored_non_file_queue_payload_bytes"
  );

  if (!limit || limit.setting.mode !== "enabled") {
    throw new Error(
      "Missing enabled stored_non_file_queue_payload_bytes limit for hosted-free profile."
    );
  }

  return limit.setting.value;
}

function cleanupAccountTargetFromRow(
  row: ScheduledCleanupAccountTargetRow
): ScheduledCleanupAccountTarget {
  if (typeof row.account_id !== "string" || !isAccountTier(row.tier)) {
    throw new Error("Scheduled cleanup account target row is invalid.");
  }

  return {
    accountId: row.account_id,
    tier: row.tier
  };
}

function isAccountTier(value: unknown): value is AccountTier {
  return (
    value === "hosted_free" ||
    value === "hosted_paid" ||
    value === "self_hosted"
  );
}

function deletedCountFromRow(row: CleanupStatementResultRow | undefined) {
  const count = row?.deleted_count;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
    return count;
  }
  if (typeof count === "string" && /^\d+$/.test(count)) {
    const parsed = Number(count);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error("Scheduled cleanup statement did not return deleted_count.");
}

function emitScheduledCleanupFailure(input: {
  requestId: string;
  error?: unknown;
  accountId?: string;
  startedAtMs?: number;
}) {
  reportRuntimeFailure(input.error, {
    errorId: createCorrelationId("cleanup"),
    request_id: input.requestId,
    environment: process.env.APP_ENV ?? null,
    surface: "scheduled",
    duration_ms: durationSinceMs(input.startedAtMs),
    operation: SCHEDULED_CLEANUP_OPERATION,
    account_id: input.accountId,
    message: "scheduled cleanup failed"
  });
}
