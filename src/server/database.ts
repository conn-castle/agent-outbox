import type { Buffer } from "node:buffer";
import { Client, type QueryResult, type QueryResultRow } from "pg";

import type { DatabaseOperationStage } from "./logging.ts";

const APP_DATABASE_ROLE = "agent_outbox_app";
const DATABASE_CANARY_TIMEOUT_MS = 5_000;

export type TransactionContextStatement = {
  sql: string;
  values?: (string | number | boolean | Buffer | Uint8Array | null)[];
};

export type TransactionContextAuthSurface =
  "human" | "caller" | "cleanup" | "control_plane";

export type ProductTransactionContext = {
  requestId: string;
  authSurface: TransactionContextAuthSurface;
  accountId?: string;
  callerId?: string;
  clerkUserId?: string;
  userId?: string;
};

export type ProductTransactionIdentityContext =
  | {
      authSurface: "human";
      accountId: string;
      userId: string;
    }
  | {
      authSurface: "caller";
      accountId: string;
      callerId: string;
    };

export function postgresDriverImportProof() {
  return {
    package: "pg",
    client: typeof Client
  };
}

export type ProductTransactionQuery = <
  TResult extends QueryResultRow = QueryResultRow
>(
  statement: TransactionContextStatement
) => Promise<QueryResult<TResult>>;

const PRODUCT_TRANSACTION_BEGIN_SQL = {
  "read committed": "begin",
  "repeatable read": "begin isolation level repeatable read"
} as const;

export type ProductTransactionIsolationLevel =
  keyof typeof PRODUCT_TRANSACTION_BEGIN_SQL;

export type ProductTransactionOptions = {
  isolationLevel?: ProductTransactionIsolationLevel;
};

export function productTransactionBeginSql(
  isolationLevel: ProductTransactionIsolationLevel = "read committed"
) {
  const sql = PRODUCT_TRANSACTION_BEGIN_SQL[isolationLevel];
  if (!sql) {
    throw new Error("Unsupported product transaction isolation level.");
  }
  return sql;
}

/**
 * Runs `callback` in one owned Postgres transaction and resolves with the
 * callback's return value; the callback signals failure by throwing.
 * A remembered client-side read timeout ("Query read timeout") rejects later
 * queries and the commit, so timed-out work cannot silently succeed.
 * Connection cleanup (`client.end()`) is attempted even when connecting
 * fails, while rollback is attempted only after a successful connect without
 * a remembered timeout. Transaction and rollback/connection-cleanup failures
 * are retained together in `AggregateError`s whose cause preserves the
 * preceding failure and which carry the cleanup terminal stage. Cleanup can
 * fail after a successful commit, so a rejection does not prove the writes
 * were uncommitted.
 */
export async function runProductTransaction<TResult>(
  connectionString: string,
  context: ProductTransactionContext,
  callback: (query: ProductTransactionQuery) => Promise<TResult>,
  options: ProductTransactionOptions = {}
) {
  const client = new Client({
    application_name: "agent-outbox-product-transaction",
    connectionString,
    connectionTimeoutMillis: DATABASE_CANARY_TIMEOUT_MS,
    query_timeout: DATABASE_CANARY_TIMEOUT_MS,
    statement_timeout: DATABASE_CANARY_TIMEOUT_MS
  });

  let connected = false;
  let result: TResult | undefined;
  let failure: unknown;
  let failed = false;
  let clientReadTimeout: unknown;
  let clientReadTimedOut = false;
  let stage: DatabaseOperationStage = "database_connect";
  const query: ProductTransactionQuery = async (statement) => {
    if (clientReadTimedOut) throw clientReadTimeout;
    try {
      return await client.query(statement.sql, statement.values);
    } catch (error) {
      if (isClientQueryReadTimeout(error)) {
        clientReadTimeout = error;
        clientReadTimedOut = true;
      }
      throw error;
    }
  };
  try {
    await client.connect();
    connected = true;
    stage = "database_begin";
    await query({ sql: productTransactionBeginSql(options.isolationLevel) });
    const contextEntries = [
      ["agent_outbox.request_id", context.requestId],
      ["agent_outbox.auth_surface", context.authSurface],
      ["agent_outbox.account_id", context.accountId],
      ["agent_outbox.caller_id", context.callerId],
      ["agent_outbox.clerk_user_id", context.clerkUserId],
      ["agent_outbox.user_id", context.userId]
    ].filter((entry): entry is [string, string] => entry[1] !== undefined);
    const contextValues = contextEntries.flatMap(([name, value]) => [
      name,
      value
    ]);
    const contextSetters = contextEntries.map(
      (_, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, true)`
    );
    stage = "database_context";
    await query({
      sql: `select ${contextSetters.join(", ")}`,
      values: contextValues
    });

    stage = "database_callback";
    result = await callback(query);
    if (clientReadTimedOut) {
      throw clientReadTimeout;
    }

    // Postgres answers `commit` on an aborted transaction with a ROLLBACK tag
    // instead of an error, so a callback that caught a statement error would
    // otherwise report success for writes that were discarded.
    stage = "database_commit";
    const commitResult = await query({ sql: "commit" });
    if (commitResult.command === "ROLLBACK") {
      throw new Error(
        "Product transaction was aborted by a caught statement error; commit rolled back."
      );
    }
  } catch (error) {
    failed = true;
    failure = withTransactionStage(error, stage);
    // node-postgres's client-side read timeout leaves its query active. Do not
    // queue another five-second rollback behind it; end() force-closes the
    // owned connection and preserves the original timeout for classification.
    if (connected && !clientReadTimedOut) {
      try {
        stage = "database_rollback";
        await client.query("rollback");
      } catch (rollbackError) {
        failure = withTransactionStage(
          new AggregateError(
            [failure, withTransactionStage(rollbackError, stage)],
            "Product transaction and rollback both failed.",
            { cause: failure }
          ),
          stage
        );
      }
    }
  }

  try {
    stage = "database_end";
    // pg 8.23 retains its active query after a read timeout. end() uses
    // the driver's forced-close path for that query; do not enqueue rollback.
    await client.end();
  } catch (endError) {
    const stagedEndError = withTransactionStage(endError, stage);
    failure = failed
      ? withTransactionStage(
          new AggregateError(
            [failure, stagedEndError],
            "Product transaction and connection cleanup both failed.",
            { cause: failure }
          ),
          stage
        )
      : stagedEndError;
    failed = true;
  }
  if (failed) throw failure;
  return result as TResult;
}

function isClientQueryReadTimeout(error: unknown) {
  return error instanceof Error && error.message === "Query read timeout";
}

function withTransactionStage(error: unknown, stage: DatabaseOperationStage) {
  if (
    error instanceof Error &&
    Object.isExtensible(error) &&
    !("agentOutboxOperationStage" in error)
  ) {
    Object.defineProperty(error, "agentOutboxOperationStage", {
      value: stage,
      enumerable: false
    });
  }
  return error;
}

/**
 * Runs `callback` inside a savepoint. A statement error otherwise aborts the
 * whole transaction, and the later `commit` silently rolls back earlier work
 * (such as rate-limit increments) even when the caller catches the error.
 * `name` must be a constant SQL identifier.
 */
export async function withSavepoint<TResult>(
  query: ProductTransactionQuery,
  name: string,
  callback: () => Promise<TResult>
): Promise<TResult> {
  await query({ sql: `savepoint ${name}` });
  try {
    const result = await callback();
    await query({ sql: `release savepoint ${name}` });
    return result;
  } catch (error) {
    try {
      await query({ sql: `rollback to savepoint ${name}` });
      await query({ sql: `release savepoint ${name}` });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Savepoint work and cleanup both failed.",
        { cause: error }
      );
    }
    throw error;
  }
}

export async function setProductTransactionIdentityContext(
  query: ProductTransactionQuery,
  identity: ProductTransactionIdentityContext
) {
  const callerId = identity.authSurface === "caller" ? identity.callerId : "";
  const userId = identity.authSurface === "human" ? identity.userId : "";
  await query({
    sql: `
      select
        set_config($1, $2, true),
        set_config($3, $4, true),
        set_config($5, $6, true)
    `,
    values: [
      "agent_outbox.account_id",
      identity.accountId,
      "agent_outbox.caller_id",
      callerId,
      "agent_outbox.user_id",
      userId
    ]
  });
}

export function transactionContextCanaryStatements(
  requestId: string
): TransactionContextStatement[] {
  return [
    { sql: "begin" },
    {
      sql: "select set_config($1, $2, true)",
      values: ["agent_outbox.request_id", requestId]
    },
    {
      sql: "select current_setting($1, true) as request_id",
      values: ["agent_outbox.request_id"]
    },
    {
      sql: "select current_user as role_name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit from pg_catalog.pg_roles r where r.rolname = current_user"
    },
    { sql: "rollback" }
  ];
}

export async function runTransactionContextCanary(connectionString: string) {
  const requestId = crypto.randomUUID();
  const [begin, setContext, readContext, readRole, rollback] =
    transactionContextCanaryStatements(requestId);
  const client = new Client({
    application_name: "agent-outbox-runtime-canary",
    connectionString,
    connectionTimeoutMillis: DATABASE_CANARY_TIMEOUT_MS,
    query_timeout: DATABASE_CANARY_TIMEOUT_MS,
    statement_timeout: DATABASE_CANARY_TIMEOUT_MS
  });

  try {
    await client.connect();
    await client.query(begin.sql, begin.values);
    await client.query(setContext.sql, setContext.values);
    const result = await client.query<{ request_id: string }>(
      readContext.sql,
      readContext.values
    );
    const roleResult = await client.query<{
      role_name: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
    }>(readRole.sql, readRole.values);
    await client.query(rollback.sql, rollback.values);
    const role = roleResult.rows[0];
    const transactionContextMatched = result.rows[0]?.request_id === requestId;
    const restrictedRoleMatched =
      role?.role_name === APP_DATABASE_ROLE &&
      role?.rolsuper === false &&
      role?.rolcreatedb === false &&
      role?.rolcreaterole === false &&
      role?.rolreplication === false &&
      role?.rolbypassrls === false &&
      role?.rolinherit === false;

    return {
      transactionContextMatched,
      restrictedRoleMatched
    };
  } finally {
    await client.end();
  }
}
