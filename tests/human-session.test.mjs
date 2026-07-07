import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";

import {
  bootstrapClerkHumanInTransaction,
  humanAccountContextStatement,
  humanMembershipsStatement,
  requiredHumanSessionConfiguration,
  resolveHumanAccountContextInTransaction,
  resolveHumanAccountSession
} from "../src/server/human-session.ts";

/**
 * @typedef {import("../src/server/database.ts").ProductTransactionQuery} ProductTransactionQuery
 * @typedef {import("../src/server/database.ts").TransactionContextStatement} TransactionContextStatement
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 * @typedef {ProductTransactionQuery & { calls: TransactionContextStatement[] }} MockProductTransactionQuery
 */

const { Client } = pg;
const databaseTestsEnabled =
  process.env.AGENT_OUTBOX_ENABLE_DATABASE_TESTS === "1";
const databaseUrl = databaseTestsEnabled
  ? process.env.DATABASE_MIGRATION_URL
  : undefined;
const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000099";
const userId = "00000000-0000-4000-8000-000000000002";

test("first-time Clerk human provisioning returns a new owner account membership", async () => {
  const bootstrapQuery = fakeQuery([
    [
      {
        user_id: userId,
        account_id: accountId,
        role: "owner",
        provisioned_account: true
      }
    ]
  ]);

  const bootstrap = await bootstrapClerkHumanInTransaction(
    bootstrapQuery,
    "user_clerk_first"
  );

  assert.deepEqual(bootstrap, {
    ok: true,
    userId,
    accountId,
    role: "owner",
    provisionedAccount: true
  });
  assert.deepEqual(bootstrapQuery.calls[0].values, ["user_clerk_first"]);
});

test("repeat sign-in keeps provisioning idempotent for an existing membership", async () => {
  const bootstrapQuery = fakeQuery([
    [
      {
        user_id: userId,
        account_id: accountId,
        role: "owner",
        provisioned_account: false
      }
    ]
  ]);

  const bootstrap = await bootstrapClerkHumanInTransaction(
    bootstrapQuery,
    "user_clerk_repeat"
  );

  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.ok ? bootstrap.provisionedAccount : null, false);
  assert.equal(bootstrap.ok ? bootstrap.accountId : null, accountId);
});

test("existing membership resolution returns human account context", async () => {
  const query = fakeQuery([
    [{ account_id: accountId, user_id: userId, role: "owner" }],
    [
      {
        account_id: accountId,
        label: "Review account",
        tier: "hosted_free",
        billing_status: "not_applicable",
        billing_grace_ends_at: null
      }
    ]
  ]);

  const result = await resolveHumanAccountContextInTransaction(query, {
    accountId,
    userId,
    provisionedAccount: false
  });

  assert.deepEqual(result, {
    ok: true,
    surface: "human",
    accountId,
    userId,
    role: "owner",
    provisionedAccount: false,
    account: {
      accountId,
      label: "Review account",
      tier: "hosted_free",
      billingStatus: "not_applicable",
      billingGraceEndsAt: null
    }
  });
  assert.deepEqual(query.calls[0], humanMembershipsStatement(userId));
  assert.deepEqual(query.calls[1], humanAccountContextStatement(accountId));
});

test("malformed no-membership state fails loud after bootstrap instead of granting access", async () => {
  const query = fakeQuery([[], []]);

  const result = await resolveHumanAccountContextInTransaction(query, {
    accountId,
    userId,
    provisionedAccount: false
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    code: "account_membership_required",
    message: "Human account membership is required to load this account."
  });
});

test("cross-account membership resolution denies the requested account", async () => {
  const query = fakeQuery([
    [{ account_id: otherAccountId, user_id: userId, role: "owner" }]
  ]);

  const result = await resolveHumanAccountContextInTransaction(query, {
    accountId,
    userId,
    provisionedAccount: false
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    code: "cross_account_denied",
    message: "Human account membership is required to load this account."
  });
});

test("missing human session configuration reports exact variable names", () => {
  const previous = {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
    DATABASE_APP_ROLE_URL: process.env.DATABASE_APP_ROLE_URL
  };

  try {
    delete process.env.CLERK_SECRET_KEY;
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test";
    delete process.env.DATABASE_APP_ROLE_URL;

    assert.deepEqual(requiredHumanSessionConfiguration(), [
      "CLERK_SECRET_KEY",
      "DATABASE_APP_ROLE_URL"
    ]);
  } finally {
    restoreEnv(previous);
  }
});

test(
  "database bootstrap provisions and repeats one owner membership per Clerk user",
  {
    skip: databaseUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database bootstrap verification"
  },
  async () => {
    const client = await connectedDatabaseClient();
    const runId = crypto.randomUUID();
    const clerkUserA = `db-bootstrap-a-${runId}`;
    const clerkUserB = `db-bootstrap-b-${runId}`;

    try {
      await ensureCanSetAppRole(client);

      const first = await callBootstrapFunction(client, clerkUserA, {
        authSurface: "human",
        clerkUserId: clerkUserA
      });
      const repeat = await callBootstrapFunction(client, clerkUserA, {
        authSurface: "human",
        clerkUserId: clerkUserA
      });
      const secondUser = await callBootstrapFunction(client, clerkUserB, {
        authSurface: "human",
        clerkUserId: clerkUserB
      });

      assert.equal(first.provisioned_account, true);
      assert.equal(repeat.provisioned_account, false);
      assert.equal(repeat.user_id, first.user_id);
      assert.equal(repeat.account_id, first.account_id);
      assert.equal(secondUser.provisioned_account, true);
      assert.notEqual(secondUser.user_id, first.user_id);
      assert.notEqual(secondUser.account_id, first.account_id);

      const counts = await client.query(
        `
          select
            (select count(*)::int from public.agent_outbox_users where clerk_user_id in ($1, $2)) as user_count,
            (select count(*)::int from public.agent_outbox_account_members where user_id in ($3, $4)) as membership_count,
            (select count(distinct account_id)::int from public.agent_outbox_account_members where user_id in ($3, $4)) as distinct_account_count
        `,
        [clerkUserA, clerkUserB, first.user_id, secondUser.user_id]
      );

      assert.deepEqual(counts.rows[0], {
        user_count: 2,
        membership_count: 2,
        distinct_account_count: 2
      });
    } finally {
      await client.end();
    }
  }
);

test(
  "database bootstrap denies missing mismatched and non-human Clerk context",
  {
    skip: databaseUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database bootstrap verification"
  },
  async () => {
    const client = await connectedDatabaseClient();
    const runId = crypto.randomUUID();
    const clerkUserId = `db-bootstrap-denial-${runId}`;

    try {
      await ensureCanSetAppRole(client);

      await assert.rejects(
        () =>
          callBootstrapFunction(client, clerkUserId, {
            authSurface: "human"
          }),
        sqlState("42501")
      );
      await assert.rejects(
        () =>
          callBootstrapFunction(client, clerkUserId, {
            authSurface: "human",
            clerkUserId: `${clerkUserId}-other`
          }),
        sqlState("42501")
      );
      await assert.rejects(
        () =>
          callBootstrapFunction(client, clerkUserId, {
            authSurface: "caller",
            clerkUserId
          }),
        sqlState("42501")
      );
    } finally {
      await client.end();
    }
  }
);

test(
  "database bootstrap repairs an existing Clerk user with no membership",
  {
    skip: databaseUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database bootstrap verification"
  },
  async () => {
    const client = await connectedDatabaseClient();
    const clerkUserId = `db-bootstrap-repair-${crypto.randomUUID()}`;

    try {
      await ensureCanSetAppRole(client);

      const existingUser = await client.query(
        `
          insert into public.agent_outbox_users(clerk_user_id)
          values ($1)
          returning user_id::text as user_id
        `,
        [clerkUserId]
      );
      const repaired = await callBootstrapFunction(client, clerkUserId, {
        authSurface: "human",
        clerkUserId
      });
      const membership = await client.query(
        `
          select count(*)::int as membership_count
          from public.agent_outbox_account_members
          where user_id = $1
            and account_id = $2
            and role = 'owner'
        `,
        [repaired.user_id, repaired.account_id]
      );

      assert.equal(repaired.user_id, existingUser.rows[0].user_id);
      assert.equal(repaired.provisioned_account, true);
      assert.deepEqual(membership.rows[0], { membership_count: 1 });
    } finally {
      await client.end();
    }
  }
);

test(
  "first-time account provisioning emits a content-safe success log",
  {
    skip: databaseUrl
      ? false
      : "set AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 and DATABASE_MIGRATION_URL to run database bootstrap verification"
  },
  async () => {
    const previousDatabaseUrl = process.env.DATABASE_APP_ROLE_URL;
    const client = await connectedDatabaseClient();
    const clerkUserId = `db-bootstrap-log-${crypto.randomUUID()}`;
    const requestId = "req_db_bootstrap_log";
    /** @type {string[]} */
    const logLines = [];
    const previousLog = console.log;
    const releaseEnvSnapshot = {
      APP_ENV: process.env.APP_ENV,
      GITHUB_SHA: process.env.GITHUB_SHA,
      SENTRY_RELEASE: process.env.SENTRY_RELEASE
    };

    try {
      await ensureCanSetAppRole(client);
      process.env.DATABASE_APP_ROLE_URL = databaseUrl;
      // Pin the observability environment/release inputs so the emitted log
      // shape is deterministic regardless of ambient APP_ENV or the
      // CI-provided GITHUB_SHA (which otherwise injects a release value only in
      // CI). This keeps the assertion an exact, content-safe field allowlist.
      delete process.env.APP_ENV;
      delete process.env.GITHUB_SHA;
      process.env.SENTRY_RELEASE = "agent-outbox-test-release";
      console.log = (line) => {
        logLines.push(String(line));
      };

      const result = await resolveHumanAccountSession({
        clerkUserId,
        requestId
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.provisionedAccount : null, true);

      const parsed = logLines.map((line) => JSON.parse(line));
      assert.deepEqual(parsed, [
        {
          level: "info",
          environment: null,
          release: "agent-outbox-test-release",
          surface: "app",
          operation: "human_account_provisioned",
          message:
            "Provisioned Agent Outbox account for first-time human sign-in.",
          request_id: requestId
        }
      ]);
      assert.doesNotMatch(JSON.stringify(parsed), new RegExp(clerkUserId));
      assert.doesNotMatch(JSON.stringify(parsed), /secret|password|token/i);
    } finally {
      console.log = previousLog;
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_APP_ROLE_URL;
      } else {
        process.env.DATABASE_APP_ROLE_URL = previousDatabaseUrl;
      }
      for (const [name, value] of Object.entries(releaseEnvSnapshot)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await client.end();
    }
  }
);

/**
 * @param {QueryResultRow[][]} rowsByCall
 * @returns {MockProductTransactionQuery}
 */
function fakeQuery(rowsByCall) {
  /** @type {TransactionContextStatement[]} */
  const calls = [];
  /**
   * @param {TransactionContextStatement} statement
   * @returns {Promise<import("pg").QueryResult<QueryResultRow>>}
   */
  const query = async (statement) => {
    calls.push(statement);
    const rows = rowsByCall[calls.length - 1] ?? [];
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  const typed = /** @type {MockProductTransactionQuery} */ (
    /** @type {unknown} */ (query)
  );
  typed.calls = calls;
  return typed;
}

/**
 * @param {Record<string, string | undefined>} previous
 */
function restoreEnv(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function connectedDatabaseClient() {
  assert.ok(databaseUrl);
  const client = new Client({
    application_name: "agent-outbox-human-bootstrap-test",
    connectionString: databaseUrl
  });
  await client.connect();
  return client;
}

/**
 * @param {import("pg").Client} client
 */
async function ensureCanSetAppRole(client) {
  const membership = await client.query(
    "select pg_has_role(current_user, 'agent_outbox_app', 'member') as is_member"
  );
  if (membership.rows[0]?.is_member === true) {
    return;
  }

  await client.query(`
    do $$
    begin
      execute format('grant agent_outbox_app to %I', current_user);
    end
    $$;
  `);
}

/**
 * @param {import("pg").Client} client
 * @param {string} clerkUserId
 * @param {{ authSurface: "human" | "caller", clerkUserId?: string }} context
 */
async function callBootstrapFunction(client, clerkUserId, context) {
  await client.query("begin");
  try {
    await client.query("set role agent_outbox_app");
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.request_id",
      `req-${crypto.randomUUID()}`
    ]);
    await client.query("select set_config($1, $2, true)", [
      "agent_outbox.auth_surface",
      context.authSurface
    ]);
    if (context.clerkUserId) {
      await client.query("select set_config($1, $2, true)", [
        "agent_outbox.clerk_user_id",
        context.clerkUserId
      ]);
    }

    const result = await client.query(
      `
        select
          user_id::text as user_id,
          account_id::text as account_id,
          role,
          provisioned_account
        from public.agent_outbox_bootstrap_clerk_human($1)
      `,
      [clerkUserId]
    );
    await client.query("reset role");
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * @param {string} code
 */
function sqlState(code) {
  return {
    code
  };
}
