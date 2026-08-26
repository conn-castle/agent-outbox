import {
  activeLimitBlockMetadata,
  consumesMonthlyCallerApiRequestQuota,
  type ActiveLimitBlockMetadata
} from "./accounting.ts";
import type { ApiErrorInput } from "./api-errors.ts";
import type {
  ProductTransactionQuery,
  TransactionContextStatement
} from "./database.ts";
import {
  accountLimitStatusMetadata,
  limitErrorMetadata,
  limitProfileSelectorForAccountTier,
  type AccountTier,
  type LimitName,
  type LimitOperationKind,
  type LimitProfileSelector,
  type LimitStatusMetadata,
  type LimitWindowKind
} from "./limits.ts";

export type AccountLimitIdentity = {
  accountId: string;
};

export type CallerLimitIdentity = AccountLimitIdentity & {
  callerId: string;
};

export type CallerLimitGuardResult =
  { ok: true } | { ok: false; error: ApiErrorInput };

type AccountTierRow = {
  tier: AccountTier;
};

type ActiveLimitBlockRow = {
  account_id: string;
  operation_kind: LimitOperationKind;
  limit_name: LimitName;
  limit_reason_code: string;
  limit_reason: string;
  limit_resets_at: string | Date | null;
  used_units: string | number | null;
  limit_units: string | number | null;
};

type QuotaWindowRow = {
  used_units: string | number;
};

type FixedWindowLimit = LimitStatusMetadata & {
  windowKind: LimitWindowKind;
  setting: { mode: "enabled"; value: number };
};

type AccountStockUsageRow = {
  queued_input_items: string | number;
  non_file_stored_bytes: string | number;
  overall_stored_bytes: string | number;
};

type AdvisoryLockRow = {
  acquired: boolean;
};

const MONTHLY_CALLER_API_LIMIT: LimitName =
  "authenticated_caller_api_requests_per_calendar_month";

export async function accountLimitProfileForAccount(
  query: ProductTransactionQuery,
  accountId: string
): Promise<LimitProfileSelector | null> {
  const result = await query<AccountTierRow>(accountTierStatement(accountId));
  return limitProfileSelectorForAccountTier(result.rows[0]?.tier);
}

export async function enforceCallerRequestLimits(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind
): Promise<CallerLimitGuardResult> {
  return enforceAccountRequestLimits(query, identity, profile, operationKind);
}

export async function enforceAccountRequestLimits(
  query: ProductTransactionQuery,
  identity: AccountLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind
): Promise<CallerLimitGuardResult> {
  const activeBlock = await activeLimitBlock(
    query,
    identity,
    profile,
    operationKind
  );
  if (activeBlock) {
    return limitBlockedError(
      profile,
      activeBlock,
      callerIdFromIdentity(identity)
    );
  }

  const requestWindows = fixedWindowLimits(profile, operationKind, "requests");
  const shouldSerializeQuotaWindows =
    requestWindows.length > 1 ||
    requestWindows.some(
      (limit) => limit.limitName === MONTHLY_CALLER_API_LIMIT
    );
  if (shouldSerializeQuotaWindows) {
    await query(accountWriteLockStatement(identity));
  }

  return incrementFixedWindowLimits(
    query,
    identity,
    profile,
    operationKind,
    "requests"
  );
}

export async function enforceIpConnectStartLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_connect_start");
}

export async function enforceIpConnectDevicePollLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_connect_poll");
}

export async function enforceIpConnectExchangeLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(
    query,
    ipAddress,
    "caller_connect_exchange"
  );
}

export async function enforceIpConnectActivationLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(
    query,
    ipAddress,
    "caller_connect_activation"
  );
}

export async function enforceIpRotateStartLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_rotate_start");
}

export async function enforceIpRotateDevicePollLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_rotate_poll");
}

export async function enforceIpRotateExchangeLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_rotate_exchange");
}

export async function enforceIpRotateActivationLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(
    query,
    ipAddress,
    "caller_rotate_activation"
  );
}

export async function enforceIpRevokeStartLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_revoke_start");
}

export async function enforceIpRevokeDevicePollLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_revoke_poll");
}

export async function enforceIpRevokeConfirmLimit(
  query: ProductTransactionQuery,
  ipAddress: string
): Promise<CallerLimitGuardResult> {
  return enforceIpControlPlaneLimit(query, ipAddress, "caller_revoke_confirm");
}

async function enforceIpControlPlaneLimit(
  query: ProductTransactionQuery,
  ipAddress: string,
  operationKind: Extract<
    LimitOperationKind,
    | "caller_connect_start"
    | "caller_connect_poll"
    | "caller_connect_exchange"
    | "caller_connect_activation"
    | "caller_rotate_start"
    | "caller_rotate_poll"
    | "caller_rotate_exchange"
    | "caller_rotate_activation"
    | "caller_revoke_start"
    | "caller_revoke_poll"
    | "caller_revoke_confirm"
  >
): Promise<CallerLimitGuardResult> {
  const now = new Date();

  for (const limit of fixedWindowLimits(
    "hosted-free",
    operationKind,
    "requests"
  )) {
    const window = quotaWindow(limit, now);
    const result = await query<QuotaWindowRow>({
      sql: `
        insert into public.agent_outbox_ip_quota_windows (
          ip_address,
          metric,
          window_kind,
          window_start_utc,
          used_units
        )
        values ($1::inet, $2, $3, $4::timestamptz, 1)
        on conflict (ip_address, metric, window_kind, window_start_utc)
        do update set
          used_units = public.agent_outbox_ip_quota_windows.used_units + 1,
          updated_at = now()
        returning used_units
      `,
      values: [
        ipAddress,
        limit.limitName,
        window.windowKind,
        window.windowStartUtc
      ]
    });
    const usedUnits = nonNegativeInteger(result.rows[0].used_units);
    if (usedUnits > limit.setting.value) {
      const limitMetadata = limitErrorMetadata("hosted-free", limit.limitName, {
        usedUnits,
        limitResetsAt: new Date(window.windowEndUtc)
      });
      return {
        ok: false,
        error: {
          status: limitMetadata.status,
          code: limitMetadata.code,
          message: limitMetadata.limitReason,
          limit: limitMetadata
        }
      };
    }
  }

  return { ok: true };
}

export async function enforceAcceptedInputSubmissionLimits(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  input: {
    queuedItemDelta: number;
    nonFilePayloadByteDelta: number;
  }
): Promise<CallerLimitGuardResult> {
  const activeBlock = await activeLimitBlock(
    query,
    identity,
    profile,
    "input_submission"
  );
  if (activeBlock) {
    return limitBlockedError(
      profile,
      activeBlock,
      callerIdFromIdentity(identity)
    );
  }

  const concurrency = await acquireConcurrencySlot(
    query,
    identity,
    profile,
    "input_submission"
  );
  if (!concurrency.ok) {
    return concurrency;
  }

  await query(accountWriteLockStatement(identity));

  const fixedWindowResult = await checkFixedWindowLimits(
    query,
    identity,
    profile,
    "input_submission"
  );
  if (!fixedWindowResult.ok) {
    return fixedWindowResult;
  }

  const stockResult = await checkInputStockLimits(
    query,
    identity,
    profile,
    input
  );
  if (!stockResult.ok) {
    return stockResult;
  }

  return incrementFixedWindowLimits(
    query,
    identity,
    profile,
    "input_submission",
    "submissions"
  );
}

export async function enforceHumanFileUploadLimits(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  fileByteDelta: number
): Promise<CallerLimitGuardResult> {
  if (!Number.isSafeInteger(fileByteDelta) || fileByteDelta <= 0) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "invalid_request",
        message: "Uploaded file must contain at least one byte."
      }
    };
  }

  const activeBlock = await activeLimitBlock(
    query,
    identity,
    profile,
    "file_upload"
  );
  if (activeBlock) {
    return limitBlockedError(
      profile,
      activeBlock,
      callerIdFromIdentity(identity)
    );
  }

  const enabled = limitStatus(profile, "file_upload_enabled");
  if (enabled.setting.mode !== "enabled" || enabled.setting.value !== 1) {
    return limitError(profile, identity, "file_upload", "file_upload_enabled", {
      usedUnits: 1,
      limitResetsAt: null
    });
  }

  const perFile = limitStatus(profile, "uploaded_bytes_per_file");
  if (
    perFile.setting.mode !== "enabled" ||
    fileByteDelta > perFile.setting.value
  ) {
    return limitError(
      profile,
      identity,
      "file_upload",
      "uploaded_bytes_per_file",
      {
        usedUnits: fileByteDelta,
        limitResetsAt: null
      }
    );
  }

  const concurrency = await acquireConcurrencySlot(
    query,
    identity,
    profile,
    "file_upload"
  );
  if (!concurrency.ok) {
    return concurrency;
  }

  await query(accountWriteLockStatement(identity));

  const stock = await query<AccountStockUsageRow>(
    accountStockUsageStatement(identity)
  );
  const storage = limitStatus(profile, "overall_stored_account_data_bytes");
  const usedUnits =
    nonNegativeInteger(stock.rows[0]?.overall_stored_bytes ?? 0) +
    fileByteDelta;

  if (storage.setting.mode === "enabled" && usedUnits > storage.setting.value) {
    return persistAndReturnLimitError(query, identity, profile, "file_upload", {
      limitName: "overall_stored_account_data_bytes",
      usedUnits,
      limitResetsAt: null
    });
  }

  return { ok: true };
}

export function accountTierStatement(
  accountId: string
): TransactionContextStatement {
  return {
    sql: "select tier from public.agent_outbox_accounts where account_id = $1",
    values: [accountId]
  };
}

export function activeLimitBlockStatement(
  identity: AccountLimitIdentity,
  operationKind: LimitOperationKind
): TransactionContextStatement {
  const includeMonthlyCallerApiBlock =
    consumesMonthlyCallerApiRequestQuota(operationKind);

  return {
    sql: `
      select
        account_id::text as account_id,
        operation_kind,
        limit_name,
        limit_reason_code,
        limit_reason,
        limit_resets_at,
        used_units,
        limit_units
      from public.agent_outbox_account_limit_blocks
      where account_id = $1
        and limit_resets_at > now()
        and (
          operation_kind = $2
          or ($3 and operation_kind = 'caller_api_request')
          or ($3 and limit_name = $4)
        )
      order by
        case
          when operation_kind = $2 then 0
          when $3 and limit_name = $4 then 1
          else 2
        end,
        updated_at desc
    `,
    values: [
      identity.accountId,
      operationKind,
      includeMonthlyCallerApiBlock,
      MONTHLY_CALLER_API_LIMIT
    ]
  };
}

export function quotaWindowUsageStatement(input: {
  identity: AccountLimitIdentity;
  limitName: LimitName;
  windowKind: LimitWindowKind;
  windowStartUtc: string;
}): TransactionContextStatement {
  return {
    sql: `
      select used_units
      from public.agent_outbox_account_quota_windows
      where account_id = $1
        and metric = $2
        and window_kind = $3
        and window_start_utc = $4::timestamptz
    `,
    values: [
      input.identity.accountId,
      input.limitName,
      input.windowKind,
      input.windowStartUtc
    ]
  };
}

export function incrementQuotaWindowStatement(input: {
  identity: AccountLimitIdentity;
  limitName: LimitName;
  windowKind: LimitWindowKind;
  windowStartUtc: string;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_account_quota_windows (
        account_id,
        metric,
        window_kind,
        window_start_utc,
        used_units
      )
      values ($1, $2, $3, $4::timestamptz, 1)
      on conflict (account_id, metric, window_kind, window_start_utc)
      do update set
        used_units = public.agent_outbox_account_quota_windows.used_units + 1,
        updated_at = now()
      returning used_units
    `,
    values: [
      input.identity.accountId,
      input.limitName,
      input.windowKind,
      input.windowStartUtc
    ]
  };
}

export function upsertActiveLimitBlockStatement(
  block: ActiveLimitBlockMetadata
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_account_limit_blocks (
        account_id,
        operation_kind,
        limit_name,
        limit_reason_code,
        limit_reason,
        limit_resets_at,
        used_units,
        limit_units
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
      on conflict (account_id, operation_kind, limit_name)
      do update set
        limit_reason_code = excluded.limit_reason_code,
        limit_reason = excluded.limit_reason,
        limit_resets_at = excluded.limit_resets_at,
        used_units = excluded.used_units,
        limit_units = excluded.limit_units,
        updated_at = now()
    `,
    values: [
      block.account_id,
      block.operation_kind,
      block.limit_name,
      block.limit_reason_code,
      block.limit_reason,
      block.limit_resets_at,
      block.used_units,
      block.limit_units
    ]
  };
}

export function accountStockUsageStatement(
  identity: CallerLimitIdentity
): TransactionContextStatement {
  return {
    sql: "select * from public.agent_outbox_account_stock_usage($1)",
    values: [identity.accountId]
  };
}

export function accountWriteLockStatement(
  identity: AccountLimitIdentity
): TransactionContextStatement {
  return {
    sql: "select account_id::text from public.agent_outbox_accounts where account_id = $1 for update",
    values: [identity.accountId]
  };
}

export function concurrencySlotStatement(input: {
  identity: CallerLimitIdentity;
  limitName: LimitName;
  limitUnits: number;
}): TransactionContextStatement {
  return {
    sql: `
      select true as acquired
      from generate_series(1, $2::integer) slot(slot_number)
      where pg_try_advisory_xact_lock(
        ('x' || substr(md5($1 || ':' || $3 || ':' || slot.slot_number::text), 1, 16))::bit(64)::bigint
      )
      limit 1
    `,
    values: [input.identity.accountId, input.limitUnits, input.limitName]
  };
}

async function activeLimitBlock(
  query: ProductTransactionQuery,
  identity: AccountLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind
) {
  const result = await query<ActiveLimitBlockRow>(
    activeLimitBlockStatement(identity, operationKind)
  );
  return (
    result.rows
      .map(activeLimitBlockFromRow)
      .find((block) => activeLimitBlockAppliesToProfile(profile, block)) ?? null
  );
}

async function acquireConcurrencySlot(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind
): Promise<CallerLimitGuardResult> {
  const limit = limitForOperation(
    profile,
    operationKind,
    "concurrent_requests"
  )[0];
  if (!limit || limit.setting.mode !== "enabled") {
    return { ok: true };
  }

  const result = await query<AdvisoryLockRow>(
    concurrencySlotStatement({
      identity,
      limitName: limit.limitName,
      limitUnits: limit.setting.value
    })
  );
  if (result.rows[0]?.acquired) {
    return { ok: true };
  }

  return limitError(profile, identity, operationKind, limit.limitName, {
    usedUnits: limit.setting.value + 1,
    limitResetsAt: null
  });
}

async function checkFixedWindowLimits(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind
): Promise<CallerLimitGuardResult> {
  const now = new Date();
  for (const limit of fixedWindowLimits(
    profile,
    operationKind,
    "submissions"
  )) {
    const window = quotaWindow(limit, now);
    const result = await query<QuotaWindowRow>(
      quotaWindowUsageStatement({
        identity,
        limitName: limit.limitName,
        windowKind: window.windowKind,
        windowStartUtc: window.windowStartUtc
      })
    );
    const usedUnits = nonNegativeInteger(result.rows[0]?.used_units ?? 0);
    if (usedUnits + 1 > limit.setting.value) {
      return persistAndReturnLimitError(
        query,
        identity,
        profile,
        operationKind,
        {
          limitName: limit.limitName,
          usedUnits: usedUnits + 1,
          limitResetsAt: window.windowEndUtc
        }
      );
    }
  }

  return { ok: true };
}

async function incrementFixedWindowLimits(
  query: ProductTransactionQuery,
  identity: AccountLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind,
  unit: "requests" | "submissions"
): Promise<CallerLimitGuardResult> {
  const now = new Date();
  const windows = fixedWindowLimits(profile, operationKind, unit).map(
    (limit) => ({
      limit,
      window: quotaWindow(limit, now)
    })
  );

  if (unit === "requests" && windows.length > 1) {
    for (const { limit, window } of windows) {
      const result = await query<QuotaWindowRow>(
        quotaWindowUsageStatement({
          identity,
          limitName: limit.limitName,
          windowKind: window.windowKind,
          windowStartUtc: window.windowStartUtc
        })
      );
      const usedUnits = nonNegativeInteger(result.rows[0]?.used_units ?? 0);
      if (usedUnits + 1 > limit.setting.value) {
        return persistAndReturnLimitError(
          query,
          identity,
          profile,
          operationKind,
          {
            limitName: limit.limitName,
            usedUnits: usedUnits + 1,
            limitResetsAt: window.windowEndUtc
          }
        );
      }
    }
  }

  for (const { limit, window } of windows) {
    const result = await query<QuotaWindowRow>(
      incrementQuotaWindowStatement({
        identity,
        limitName: limit.limitName,
        windowKind: window.windowKind,
        windowStartUtc: window.windowStartUtc
      })
    );
    const usedUnits = nonNegativeInteger(result.rows[0]?.used_units ?? 0);
    if (usedUnits > limit.setting.value) {
      return persistAndReturnLimitError(
        query,
        identity,
        profile,
        operationKind,
        {
          limitName: limit.limitName,
          usedUnits,
          limitResetsAt: window.windowEndUtc
        }
      );
    }
  }

  return { ok: true };
}

async function checkInputStockLimits(
  query: ProductTransactionQuery,
  identity: CallerLimitIdentity,
  profile: LimitProfileSelector,
  input: {
    queuedItemDelta: number;
    nonFilePayloadByteDelta: number;
  }
): Promise<CallerLimitGuardResult> {
  const result = await query<AccountStockUsageRow>(
    accountStockUsageStatement(identity)
  );
  const stock = result.rows[0];

  const queued = limitStatus(profile, "queued_input_items");
  if (
    queued.setting.mode === "enabled" &&
    nonNegativeInteger(stock.queued_input_items) + input.queuedItemDelta >
      queued.setting.value
  ) {
    return persistAndReturnLimitError(
      query,
      identity,
      profile,
      "input_submission",
      {
        limitName: "queued_input_items",
        usedUnits:
          nonNegativeInteger(stock.queued_input_items) + input.queuedItemDelta,
        limitResetsAt: null
      }
    );
  }

  if (input.nonFilePayloadByteDelta <= 0) {
    return { ok: true };
  }

  const effectiveTier = accountLimitStatusMetadata(profile).effectiveTier;
  const storageLimitName: LimitName =
    effectiveTier === "free"
      ? "stored_non_file_queue_payload_bytes"
      : "overall_stored_account_data_bytes";
  const storage = limitStatus(profile, storageLimitName);
  const currentBytes =
    storageLimitName === "stored_non_file_queue_payload_bytes"
      ? nonNegativeInteger(stock.non_file_stored_bytes)
      : nonNegativeInteger(stock.overall_stored_bytes);
  const usedUnits = currentBytes + input.nonFilePayloadByteDelta;

  if (storage.setting.mode === "enabled" && usedUnits > storage.setting.value) {
    return persistAndReturnLimitError(
      query,
      identity,
      profile,
      "input_submission",
      {
        limitName: storageLimitName,
        usedUnits,
        limitResetsAt: null
      }
    );
  }

  return { ok: true };
}

async function persistAndReturnLimitError(
  query: ProductTransactionQuery,
  identity: AccountLimitIdentity,
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind,
  input: {
    limitName: LimitName;
    usedUnits: number;
    limitResetsAt: string | null;
  }
): Promise<CallerLimitGuardResult> {
  const block = activeLimitBlockMetadata({
    selector: profile,
    accountId: identity.accountId,
    operationKind,
    limitName: input.limitName,
    usedUnits: input.usedUnits,
    limitResetsAt: input.limitResetsAt ? new Date(input.limitResetsAt) : null
  });
  await query(upsertActiveLimitBlockStatement(block));
  return limitBlockedError(profile, block, callerIdFromIdentity(identity));
}

function fixedWindowLimits(
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind,
  unit: "requests" | "submissions"
) {
  return limitForOperation(profile, operationKind, unit).filter(
    (limit) => limit.windowKind && limit.setting.mode === "enabled"
  ) as FixedWindowLimit[];
}

function limitForOperation(
  profile: LimitProfileSelector,
  operationKind: LimitOperationKind,
  unit: LimitStatusMetadata["unit"]
) {
  return accountLimitStatusMetadata(profile).limits.filter((limit) => {
    return (
      limit.unit === unit &&
      limit.operationKinds.includes(operationKind) &&
      limit.setting.mode === "enabled"
    );
  });
}

function limitStatus(profile: LimitProfileSelector, limitName: LimitName) {
  const limit = accountLimitStatusMetadata(profile).limits.find((entry) => {
    return entry.limitName === limitName;
  });
  if (!limit) {
    throw new Error(`Missing limit metadata for ${limitName}`);
  }
  return limit;
}

export function quotaWindow(
  limit: LimitStatusMetadata & { windowKind: LimitWindowKind },
  now: Date
) {
  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  if (limit.windowKind === "day" || limit.windowKind === "calendar_month") {
    start.setUTCHours(0, 0, 0, 0);
  }
  if (limit.windowKind === "calendar_month") {
    start.setUTCDate(1);
  }

  const end = new Date(start.getTime());
  if (limit.windowKind === "minute") {
    end.setUTCMinutes(end.getUTCMinutes() + 1);
  } else if (limit.windowKind === "day") {
    end.setUTCDate(end.getUTCDate() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }

  return {
    windowKind: limit.windowKind,
    windowStartUtc: start.toISOString(),
    windowEndUtc: end.toISOString()
  };
}

function limitBlockedError(
  profile: LimitProfileSelector,
  block: ActiveLimitBlockMetadata,
  callerId?: string
): CallerLimitGuardResult {
  const error = limitErrorMetadata(profile, block.limit_name, {
    usedUnits: block.used_units,
    limitResetsAt: block.limit_resets_at
      ? new Date(block.limit_resets_at)
      : null
  });

  return {
    ok: false,
    error: {
      status: error.status,
      code: error.code,
      message: error.limitReason,
      limit: {
        ...block,
        limit_reason_code: error.limitReasonCode,
        limit_reason: error.limitReason,
        limit_resets_at: error.limitResetsAt,
        used_units: error.usedUnits,
        limit_units: error.limitUnits
      },
      log: callerId ? { callerId } : undefined
    }
  };
}

function limitError(
  profile: LimitProfileSelector,
  identity: AccountLimitIdentity,
  operationKind: LimitOperationKind,
  limitName: LimitName,
  input: {
    usedUnits: number;
    limitResetsAt: string | null;
  }
): CallerLimitGuardResult {
  const block = activeLimitBlockMetadata({
    selector: profile,
    accountId: identity.accountId,
    operationKind,
    limitName,
    usedUnits: input.usedUnits,
    limitResetsAt: input.limitResetsAt ? new Date(input.limitResetsAt) : null
  });
  const error = limitErrorMetadata(profile, limitName, {
    usedUnits: input.usedUnits,
    limitResetsAt: input.limitResetsAt ? new Date(input.limitResetsAt) : null
  });
  const callerId = callerIdFromIdentity(identity);

  return {
    ok: false,
    error: {
      status: error.status,
      code: error.code,
      message: error.limitReason,
      limit: block,
      log: callerId ? { callerId } : undefined
    }
  };
}

function activeLimitBlockFromRow(
  row: ActiveLimitBlockRow
): ActiveLimitBlockMetadata {
  return {
    account_id: row.account_id,
    operation_kind: row.operation_kind,
    limit_name: row.limit_name,
    limit_reason_code: row.limit_reason_code,
    limit_reason: row.limit_reason,
    limit_resets_at: nullableTimestamp(row.limit_resets_at),
    used_units: nullableNonNegativeInteger(row.used_units),
    limit_units: nullableNonNegativeInteger(row.limit_units)
  };
}

function callerIdFromIdentity(identity: AccountLimitIdentity) {
  if ("callerId" in identity && typeof identity.callerId === "string") {
    return identity.callerId;
  }

  return undefined;
}

function activeLimitBlockAppliesToProfile(
  profile: LimitProfileSelector,
  block: ActiveLimitBlockMetadata
) {
  const limit = accountLimitStatusMetadata(profile).limits.find((entry) => {
    return entry.limitName === block.limit_name;
  });

  if (!limit || limit.setting.mode !== "enabled") {
    return false;
  }

  if (!limit.operationKinds.includes(block.operation_kind)) {
    return false;
  }

  if (limit.resetRule !== "fixed_window_end") {
    return false;
  }

  return block.used_units != null && block.used_units > limit.setting.value;
}

function nullableTimestamp(value: string | Date | null) {
  if (!value) {
    return null;
  }
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function nullableNonNegativeInteger(value: string | number | null) {
  if (value == null) {
    return null;
  }
  return nonNegativeInteger(value);
}

function nonNegativeInteger(value: string | number) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RangeError(
      "quota and stock counts must be non-negative integers"
    );
  }
  return numeric;
}
