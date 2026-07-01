import type { ApiErrorInput, ApiRequestContext } from "./api-errors.ts";
import { emitRuntimeLog } from "./logging.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import {
  accountLimitProfileForAccount,
  enforceCallerRequestLimits
} from "./caller-api-limits.ts";
import { authenticateCallerApiRequestWithDatabase } from "./input-queue.ts";
import {
  accountLimitStatusMetadata,
  limitProfileSelectorForAccountTier,
  limitStatusMetadata,
  type AccountTier,
  type LimitName,
  type LimitProfileSelector
} from "./limits.ts";

export type AccountStatusData = {
  account_id: string;
  label: string | null;
  tier: AccountTier;
  effective_tier: "free" | "paid";
  billing_status: AccountBillingStatus;
  grace_ends_at: string | null;
  file_upload_enabled: boolean;
  storage: {
    stored_bytes: number;
    limit_name: LimitName;
    limit_bytes: number | null;
  };
  active_limit_blocks: ActiveLimitBlockData[];
};

export type CallerStatusData = {
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
    status: CallerStatus;
    key: {
      key_id: string;
      prefix: string;
      last_chars: string;
      created_at: string;
      last_used_at: string | null;
    };
  };
  account: AccountStatusData;
};

export type StatusResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

type CallerIdentity = {
  accountId: string;
  callerId: string;
};

type AccountBillingStatus =
  "not_applicable" | "active" | "grace" | "past_due" | "canceled";

type CallerStatus = "pending_activation" | "active" | "revoked" | "expired";

type AccountStatusRow = {
  account_id: string;
  label: string | null;
  tier: AccountTier;
  billing_status: AccountBillingStatus;
  billing_grace_ends_at: string | Date | null;
};

type CallerStatusRow = {
  caller_id: string;
  caller_slug: string | null;
  display_name: string;
  status: CallerStatus;
  key_id: string;
  key_prefix: string;
  key_last_four: string;
  created_at: string | Date;
  last_used_at: string | Date | null;
};

type StorageStatusRow = {
  non_file_stored_bytes: string | number;
  overall_stored_bytes: string | number;
};

type ActiveLimitBlockRow = {
  operation_kind: string;
  limit_name: LimitName;
  limit_reason_code: string;
  limit_reason: string;
  limit_resets_at: string | Date | null;
  used_units: string | number | null;
  limit_units: string | number | null;
};

type ActiveLimitBlockData = {
  operation_kind: string;
  limit_name: LimitName;
  limit_reason_code: string;
  limit_reason: string;
  limit_resets_at: string | null;
  used_units: number | null;
  limit_units: number | null;
};

export async function handleCallerStatusRequest(
  request: Request,
  context: ApiRequestContext
): Promise<StatusResult<CallerStatusData>> {
  return withAuthenticatedCallerStatusTransaction(
    request,
    context,
    "Caller status is temporarily unavailable.",
    async (query, identity, keyId) => {
      return callerStatusInTransaction(query, identity, keyId);
    }
  );
}

export async function handleAccountStatusRequest(
  request: Request,
  context: ApiRequestContext
): Promise<StatusResult<AccountStatusData>> {
  return withAuthenticatedCallerStatusTransaction(
    request,
    context,
    "Account status is temporarily unavailable.",
    async (query, identity) => accountStatusInTransaction(query, identity)
  );
}

export async function callerStatusInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity,
  keyId: string
): Promise<StatusResult<CallerStatusData>> {
  const callerResult = await query<CallerStatusRow>(
    callerStatusStatement(identity, keyId)
  );
  const callerRow = callerResult.rows[0];
  if (!callerRow) {
    return temporaryUnavailableError(
      "Caller status is temporarily unavailable."
    );
  }

  const account = await accountStatusInTransaction(query, identity);
  if (!account.ok) {
    return account;
  }

  return {
    ok: true,
    data: {
      caller: {
        caller_id: callerRow.caller_id,
        caller_slug: callerRow.caller_slug,
        display_name: callerRow.display_name,
        status: callerRow.status,
        key: {
          key_id: callerRow.key_id,
          prefix: callerRow.key_prefix,
          last_chars: callerRow.key_last_four,
          created_at: timestampValue(callerRow.created_at),
          last_used_at: nullableTimestampValue(callerRow.last_used_at)
        }
      },
      account: account.data
    }
  };
}

export async function accountStatusInTransaction(
  query: ProductTransactionQuery,
  identity: CallerIdentity
): Promise<StatusResult<AccountStatusData>> {
  const accountResult = await query<AccountStatusRow>(
    accountStatusStatement(identity)
  );
  const accountRow = accountResult.rows[0];
  const profile = limitProfileSelectorForAccountTier(accountRow?.tier);
  if (!accountRow || !profile) {
    return temporaryUnavailableError(
      "Account status is temporarily unavailable."
    );
  }

  const storageResult = await query<StorageStatusRow>(
    storageStatusStatement(identity)
  );
  const storageRow = storageResult.rows[0];
  if (!storageRow) {
    return temporaryUnavailableError(
      "Account status is temporarily unavailable."
    );
  }

  const storage = accountStorageStatus(profile, storageRow);
  if (!storage) {
    return temporaryUnavailableError(
      "Account status is temporarily unavailable."
    );
  }

  const blocksResult = await query<ActiveLimitBlockRow>(
    activeLimitBlocksStatement(identity)
  );

  return {
    ok: true,
    data: {
      account_id: accountRow.account_id,
      label: accountRow.label,
      tier: accountRow.tier,
      effective_tier: accountLimitStatusMetadata(profile).effectiveTier,
      billing_status: accountRow.billing_status,
      grace_ends_at: nullableTimestampValue(accountRow.billing_grace_ends_at),
      file_upload_enabled:
        accountLimitStatusMetadata(profile).fileUploadEnabled,
      storage,
      active_limit_blocks: blocksResult.rows.map(activeLimitBlockFromRow)
    }
  };
}

export function callerStatusStatement(
  identity: CallerIdentity,
  keyId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        caller.caller_id::text as caller_id,
        caller.caller_slug,
        caller.display_name,
        case
          when caller.revoked_at is not null then 'revoked'
          else credential.status
        end as status,
        credential.key_id,
        credential.key_prefix,
        credential.key_last_four,
        credential.created_at,
        credential.last_used_at
      from public.agent_outbox_callers caller
      join public.agent_outbox_caller_credentials credential
        on credential.account_id = caller.account_id
       and credential.caller_id = caller.caller_id
      where caller.account_id = $1
        and caller.caller_id = $2
        and credential.key_id = $3
    `,
    values: [identity.accountId, identity.callerId, keyId]
  };
}

export function accountStatusStatement(
  identity: CallerIdentity
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
    `,
    values: [identity.accountId]
  };
}

export function storageStatusStatement(
  identity: CallerIdentity
): TransactionContextStatement {
  return {
    sql: `
      with input_bytes as (
        select coalesce(sum(non_file_payload_bytes), 0) as bytes
        from public.agent_outbox_input_items
        where account_id = $1
      ),
      output_bytes as (
        select coalesce(sum(response_payload_bytes), 0) as bytes
        from public.agent_outbox_output_results
        where account_id = $1
      ),
      file_bytes as (
        select coalesce(sum(size_bytes), 0) as bytes
        from public.agent_outbox_output_files
        where account_id = $1
      )
      select
        input_bytes.bytes + output_bytes.bytes as non_file_stored_bytes,
        input_bytes.bytes + output_bytes.bytes + file_bytes.bytes as overall_stored_bytes
      from input_bytes, output_bytes, file_bytes
    `,
    values: [identity.accountId]
  };
}

export function activeLimitBlocksStatement(
  identity: CallerIdentity
): TransactionContextStatement {
  return {
    sql: `
      select
        operation_kind,
        limit_name,
        limit_reason_code,
        limit_reason,
        limit_resets_at,
        used_units,
        limit_units
      from public.agent_outbox_account_limit_blocks
      where account_id = $1
        and (limit_resets_at is null or limit_resets_at > now())
      order by operation_kind, limit_name
    `,
    values: [identity.accountId]
  };
}

async function withAuthenticatedCallerStatusTransaction<TData>(
  request: Request,
  context: ApiRequestContext,
  unavailableMessage: string,
  callback: (
    query: ProductTransactionQuery,
    identity: CallerIdentity,
    keyId: string
  ) => Promise<StatusResult<TData>>
): Promise<StatusResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller API database configuration is unavailable."
    );
  }

  try {
    const auth = await authenticateCallerApiRequestWithDatabase(
      request,
      context,
      connectionString
    );
    if (!auth.ok) {
      return { ok: false, error: auth.clientError };
    }

    return await runProductTransaction(
      connectionString,
      {
        requestId: context.requestId,
        authSurface: "caller",
        accountId: auth.accountId,
        callerId: auth.callerId
      },
      async (query) => {
        const profile = await accountLimitProfileForAccount(
          query,
          auth.accountId
        );
        if (!profile) {
          return temporaryUnavailableError(unavailableMessage);
        }

        const limit = await enforceCallerRequestLimits(
          query,
          auth,
          profile,
          "status"
        );
        if (!limit.ok) {
          return { ok: false, error: limit.error };
        }

        return callback(query, auth, auth.keyId);
      }
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "api",
      operation: "caller_status_request",
      message: "Caller status request failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: context.requestId
    });
    return temporaryUnavailableError(unavailableMessage);
  }
}

function accountStorageStatus(
  profile: LimitProfileSelector,
  row: StorageStatusRow
): AccountStatusData["storage"] | null {
  const metadata = accountLimitStatusMetadata(profile);
  const limitName: LimitName =
    metadata.effectiveTier === "free"
      ? "stored_non_file_queue_payload_bytes"
      : "overall_stored_account_data_bytes";
  const storedBytes =
    limitName === "stored_non_file_queue_payload_bytes"
      ? databaseNonNegativeInteger(row.non_file_stored_bytes)
      : databaseNonNegativeInteger(row.overall_stored_bytes);
  const limit = limitStatusMetadata(profile, limitName);

  if (storedBytes == null) {
    return null;
  }

  return {
    stored_bytes: storedBytes,
    limit_name: limitName,
    limit_bytes: limit.setting.mode === "enabled" ? limit.setting.value : null
  };
}

function activeLimitBlockFromRow(
  row: ActiveLimitBlockRow
): ActiveLimitBlockData {
  return {
    operation_kind: row.operation_kind,
    limit_name: row.limit_name,
    limit_reason_code: row.limit_reason_code,
    limit_reason: row.limit_reason,
    limit_resets_at: nullableTimestampValue(row.limit_resets_at),
    used_units: databaseNullableNonNegativeInteger(row.used_units),
    limit_units: databaseNullableNonNegativeInteger(row.limit_units)
  };
}

function databaseNullableNonNegativeInteger(value: string | number | null) {
  if (value == null) {
    return null;
  }
  return databaseNonNegativeInteger(value);
}

function databaseNonNegativeInteger(value: string | number) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

function nullableTimestampValue(value: string | Date | null): string | null {
  if (value == null) {
    return null;
  }
  return timestampValue(value);
}

function timestampValue(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function temporaryUnavailableError<TData>(
  message: string
): StatusResult<TData> {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message
    }
  };
}
