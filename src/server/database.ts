import { Client } from "pg";

const APP_DATABASE_ROLE = "agent_outbox_app";
const DATABASE_CANARY_TIMEOUT_MS = 5_000;

type TransactionContextStatement = {
  sql: string;
  values?: string[];
};

export function postgresDriverImportProof() {
  return {
    package: "pg",
    client: typeof Client
  };
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
      sql: "select current_user as role_name, r.rolbypassrls, r.rolinherit from pg_catalog.pg_roles r where r.rolname = current_user"
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
      rolbypassrls: boolean;
      rolinherit: boolean;
    }>(readRole.sql, readRole.values);
    await client.query(rollback.sql, rollback.values);
    const role = roleResult.rows[0];

    return {
      transactionContextMatched: result.rows[0]?.request_id === requestId,
      restrictedRoleMatched:
        role?.role_name === APP_DATABASE_ROLE &&
        role?.rolbypassrls === false &&
        role?.rolinherit === false
    };
  } finally {
    await client.end();
  }
}
