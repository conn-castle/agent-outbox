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
    await client.query(`select ${contextSetters.join(", ")}`, contextValues);

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
