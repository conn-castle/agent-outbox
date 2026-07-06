import type { Buffer } from "node:buffer";
import { Client, type QueryResult, type QueryResultRow } from "pg";

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

export async function runProductTransaction<TResult>(
  connectionString: string,
  context: ProductTransactionContext,
  callback: (query: ProductTransactionQuery) => Promise<TResult>
) {
  const client = new Client({
    application_name: "agent-outbox-product-transaction",
    connectionString,
    connectionTimeoutMillis: DATABASE_CANARY_TIMEOUT_MS,
    query_timeout: DATABASE_CANARY_TIMEOUT_MS,
    statement_timeout: DATABASE_CANARY_TIMEOUT_MS
  });

  await client.connect();

  try {
    await client.query("begin");
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.request_id",
      context.requestId
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.auth_surface",
      context.authSurface
    ]);
    if (context.accountId) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.account_id",
        context.accountId
      ]);
    }
    if (context.callerId) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.caller_id",
        context.callerId
      ]);
    }
    if (context.clerkUserId) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.clerk_user_id",
        context.clerkUserId
      ]);
    }
    if (context.userId) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.user_id",
        context.userId
      ]);
    }

    const result = await callback((statement) => {
      return client.query(statement.sql, statement.values);
    });

    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
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

  await client.connect();

  try {
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
