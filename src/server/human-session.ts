import {
  authorizeAccountMembership,
  type AccountMembership,
  type AuthorizedHumanAccountContext
} from "./authorization.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { emitRuntimeLog } from "./logging.ts";

export type HumanSessionInput = {
  clerkUserId: string | null | undefined;
  requestId: string;
};

export type HumanAccountMetadata = {
  accountId: string;
  label: string | null;
  tier: string;
  billingStatus: string;
  billingGraceEndsAt: string | null;
};

export type HumanAccountSession = AuthorizedHumanAccountContext & {
  account: HumanAccountMetadata;
  provisionedAccount: boolean;
};

export type HumanAccountSessionFailure = {
  ok: false;
  status: 401 | 403 | 503;
  code:
    | "authentication_required"
    | "account_bootstrap_denied"
    | "account_membership_required"
    | "cross_account_denied"
    | "database_configuration_missing"
    | "temporary_unavailable";
  message: string;
};

export type HumanAccountSessionResult =
  ({ ok: true } & HumanAccountSession) | HumanAccountSessionFailure;

export type BootstrapClerkHumanRow = {
  user_id: string;
  account_id: string;
  role: "owner";
  provisioned_account: boolean;
};

type AccountRow = {
  account_id: string;
  label: string | null;
  tier: string;
  billing_status: string;
  billing_grace_ends_at: string | Date | null;
};

type MembershipRow = {
  account_id: string;
  user_id: string;
  role: "owner";
};

export function requiredHumanSessionConfiguration() {
  return [
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "DATABASE_APP_ROLE_URL"
  ].filter((name) => !process.env[name]);
}

export async function resolveHumanAccountSession(
  input: HumanSessionInput
): Promise<HumanAccountSessionResult> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return failure(
      503,
      "database_configuration_missing",
      "Human account database configuration is unavailable."
    );
  }

  if (!input.clerkUserId) {
    return failure(
      401,
      "authentication_required",
      "A Clerk user is required to load the human review queue."
    );
  }
  const clerkUserId = input.clerkUserId;

  try {
    const bootstrap = await runProductTransaction(
      connectionString,
      {
        requestId: input.requestId,
        authSurface: "human",
        clerkUserId
      },
      (query) => bootstrapClerkHumanInTransaction(query, clerkUserId)
    );

    if (!bootstrap.ok) {
      return bootstrap;
    }

    if (bootstrap.provisionedAccount) {
      emitRuntimeLog({
        level: "info",
        surface: "app",
        operation: "human_account_provisioned",
        message:
          "Provisioned Agent Outbox account for first-time human sign-in.",
        request_id: input.requestId
      });
    }

    return await runProductTransaction(
      connectionString,
      {
        requestId: input.requestId,
        authSurface: "human",
        accountId: bootstrap.accountId,
        userId: bootstrap.userId
      },
      (query) =>
        resolveHumanAccountContextInTransaction(query, {
          accountId: bootstrap.accountId,
          userId: bootstrap.userId,
          provisionedAccount: bootstrap.provisionedAccount
        })
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "app",
      operation: "human_account_session",
      message: "Human account session resolution failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: input.requestId
    });
    return failure(
      503,
      "temporary_unavailable",
      "Human account session is temporarily unavailable."
    );
  }
}

export async function bootstrapClerkHumanInTransaction(
  query: ProductTransactionQuery,
  clerkUserId: string
): Promise<
  | {
      ok: true;
      userId: string;
      accountId: string;
      role: "owner";
      provisionedAccount: boolean;
    }
  | HumanAccountSessionFailure
> {
  const result = await query<BootstrapClerkHumanRow>(
    bootstrapClerkHumanStatement(clerkUserId)
  );
  const row = result.rows[0];
  if (!row) {
    return failure(
      503,
      "account_bootstrap_denied",
      "Human account bootstrap did not return an account membership."
    );
  }

  return {
    ok: true,
    userId: row.user_id,
    accountId: row.account_id,
    role: row.role,
    provisionedAccount: row.provisioned_account
  };
}

export async function resolveHumanAccountContextInTransaction(
  query: ProductTransactionQuery,
  input: {
    accountId: string;
    userId: string;
    provisionedAccount: boolean;
  }
): Promise<HumanAccountSessionResult> {
  const membershipsResult = await query<MembershipRow>(
    humanMembershipsStatement(input.userId)
  );
  const memberships: AccountMembership[] = membershipsResult.rows.map(
    (row) => ({
      accountId: row.account_id,
      userId: row.user_id,
      role: row.role
    })
  );
  const authorization = authorizeAccountMembership(
    { surface: "human", userId: input.userId, memberships },
    input.accountId
  );

  if (!authorization.ok) {
    return failure(
      403,
      authorization.code,
      "Human account membership is required to load this account."
    );
  }

  const accountResult = await query<AccountRow>(
    humanAccountContextStatement(input.accountId)
  );
  const account = accountResult.rows[0];
  if (!account) {
    return failure(
      503,
      "temporary_unavailable",
      "Human account context is temporarily unavailable."
    );
  }

  const { ok: _ok, ...authorizedContext } = authorization;

  return {
    ok: true,
    ...authorizedContext,
    provisionedAccount: input.provisionedAccount,
    account: {
      accountId: account.account_id,
      label: account.label,
      tier: account.tier,
      billingStatus: account.billing_status,
      billingGraceEndsAt: nullableTimestampValue(account.billing_grace_ends_at)
    }
  };
}

export function bootstrapClerkHumanStatement(
  clerkUserId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        user_id::text as user_id,
        account_id::text as account_id,
        role,
        provisioned_account
      from public.agent_outbox_bootstrap_clerk_human($1)
    `,
    values: [clerkUserId]
  };
}

export function humanMembershipsStatement(
  userId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        account_id::text as account_id,
        user_id::text as user_id,
        role
      from public.agent_outbox_account_members
      where user_id = $1
      order by created_at, account_id
    `,
    values: [userId]
  };
}

export function humanAccountContextStatement(
  accountId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        account_id::text as account_id,
        label,
        tier,
        billing_status,
        billing_grace_ends_at
      from public.agent_outbox_accounts
      where account_id = $1
        and deleted_at is null
    `,
    values: [accountId]
  };
}

function nullableTimestampValue(value: string | Date | null): string | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function failure(
  status: HumanAccountSessionFailure["status"],
  code: HumanAccountSessionFailure["code"],
  message: string
): HumanAccountSessionFailure {
  return { ok: false, status, code, message };
}
