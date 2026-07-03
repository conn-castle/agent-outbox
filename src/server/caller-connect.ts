import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";
import { isIP } from "node:net";

import type {
  ApiErrorInput,
  ApiFieldError,
  ApiRequestContext
} from "./api-errors.ts";
import {
  accountLimitProfileForAccount,
  enforceAccountRequestLimits,
  enforceIpConnectActivationLimit,
  enforceIpConnectDevicePollLimit,
  enforceIpConnectExchangeLimit,
  enforceIpConnectStartLimit
} from "./caller-api-limits.ts";
import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  generateCallerApiKeyMaterial,
  parseCallerBearerApiKey,
  type CallerApiKeyDisplayMetadata,
  type CallerCredentialLookupRow,
  type DisplayOnceCallerApiKeyMaterial
} from "./caller-auth.ts";
import {
  runProductTransaction,
  type ProductTransactionContext,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { requireCallerKeyHashSecret } from "./env.ts";
import { emitRuntimeLog } from "./logging.ts";

export const CONNECT_BROWSER_SETUP_CODE_EXPIRES_IN_SECONDS = 10 * 60;
export const CONNECT_DEVICE_CODE_EXPIRES_IN_SECONDS = 10 * 60;
export const CONNECT_DEVICE_POLL_INTERVAL_SECONDS = 5;

type ConnectResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

type BrowserStartBody = {
  localCallerName: string;
  displayName: string;
  callbackUrl: string;
};

type DeviceStartBody = {
  localCallerName: string;
  displayName: string;
};

type DevicePollBody = {
  deviceCode: string;
};

type ExchangeBody = {
  setupCode: string;
};

type ConnectRequestOptions = {
  now?: Date;
  runProductTransaction?: typeof runProductTransaction;
};

type SetupRequestIdRow = {
  setup_request_id: string;
};

type SetupApprovalTargetRow = {
  setup_request_id: string;
  operation: "connect";
  flow: "browser" | "device";
  status: SetupRequestStatus;
  local_caller_name: string;
  display_name: string;
  callback_url: string | null;
  expires_at: string | Date;
};

type SetupExchangeContextRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  account_id: string | null;
  approved_by_user_id: string | null;
  poll_interval_seconds: number;
  expires_at: string | Date;
};

type SetupExchangeTargetRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  account_id: string | null;
  caller_id: string | null;
  expires_at: string | Date;
  caller_slug: string | null;
  caller_display_name: string | null;
  account_label: string | null;
  account_tier: "hosted_free" | "hosted_paid" | "self_hosted" | null;
};

type SetupTerminalStateRow = {
  setup_request_id: string;
  operation: "connect";
  flow: "browser" | "device";
  status: SetupTerminalStatus;
  local_caller_name: string;
  display_name: string;
  caller_id: string | null;
  caller_slug: string | null;
  caller_display_name: string | null;
};

type CallerRow = {
  caller_id: string;
  caller_slug: string | null;
  display_name: string;
};

type ExistingCallerSlugRow = {
  caller_id: string;
};

type CredentialRow = {
  key_id: string;
  key_prefix: string;
  key_last_four: string;
  created_at: string | Date;
};

type SetupRequestIdBody = {
  setupRequestId: string;
};

type PendingConnectCredentialBearer = {
  apiKey: string;
  keyId: string;
  secret: string;
} & CallerApiKeyDisplayMetadata;

type PendingConnectCredentialRow = {
  caller_credential_id: string;
  key_id: string;
  secret_hmac_sha256: string;
  status: "active" | "pending_activation" | "revoked" | "expired";
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  account_id: string;
  caller_id: string;
};

type SetupRequestStatus =
  "pending" | "approved" | "exchanged" | "expired" | "denied";

type SetupTerminalStatus = Extract<
  SetupRequestStatus,
  "approved" | "exchanged" | "denied"
>;

export type ConnectCredentialResponseData = {
  setup_request_id: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  };
  account: {
    account_id: string;
    label: string | null;
    effective_tier: "free" | "paid";
  };
  credential: {
    api_key: string;
    key_id: string;
    prefix: string;
    last_chars: string;
    created_at: string;
    expires_at: string;
  };
};

export type ConnectActivateResponseData = {
  caller_id: string;
  activated_key_id: string;
  activated_at: string;
};

export type ConnectAbortResponseData = {
  caller_id: string;
  aborted_key_id: string;
  aborted_at: string;
};

export type ConnectBrowserApprovalData = {
  setup_request_id: string;
  setup_code: string;
  callback_url: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  };
};

export type ConnectDeviceApprovalData = {
  setup_request_id: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  };
};

export type ConnectApprovalPreviewData = {
  setup_request_id: string;
  operation: "connect";
  flow: "browser" | "device";
  status: SetupRequestStatus;
  local_caller_name: string;
  display_name: string;
  callback_url: string | null;
  expires_at: string;
};

export type ConnectTerminalSetupData = {
  setup_request_id: string;
  operation: "connect";
  flow: "browser" | "device";
  status: SetupTerminalStatus;
  local_caller_name: string;
  display_name: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  } | null;
};

const TOKEN_HASH_ALGORITHM = "sha256";
const SETUP_TOKEN_BYTES = 32;
const DEVICE_TOKEN_BYTES = 32;
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_CONNECT_TEXT_LENGTH = 128;
const MAX_CALLBACK_URL_LENGTH = 2048;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CALLER_ALREADY_EXISTS_MESSAGE =
  "A caller with this name already exists for this account. Use caller rotate or choose a different name.";
const CALLER_ALREADY_EXISTS_FIELD_MESSAGE =
  "A caller with this name already exists for this account.";

export async function handleConnectBrowserStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<
  ConnectResult<{
    approval_url: string;
    setup_request_id: string;
    expires_at: string;
  }>
> {
  const parsed = parseBrowserStartBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const baseUrl = publicAppBaseUrl();
  if (!baseUrl.ok) {
    return baseUrl;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect start."
    );
  }

  const expiresAt = new Date(
    (options.now ?? new Date()).getTime() +
      CONNECT_BROWSER_SETUP_CODE_EXPIRES_IN_SECONDS * 1000
  );

  return withControlPlaneTransaction(
    context,
    "caller_connect_browser_start",
    async (query) => {
      const limit = await enforceIpConnectStartLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      const result = await query<SetupRequestIdRow>(
        createBrowserSetupRequestStatement({
          ...parsed.data,
          expiresAt
        })
      );
      const setupRequestId = result.rows[0].setup_request_id;
      const approvalUrl = new URL("/caller/connect/approve", baseUrl.data);
      approvalUrl.searchParams.set("setup_request_id", setupRequestId);

      return {
        ok: true,
        data: {
          approval_url: approvalUrl.toString(),
          setup_request_id: setupRequestId,
          expires_at: expiresAt.toISOString()
        }
      };
    },
    options
  );
}

export async function handleConnectDeviceStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<
  ConnectResult<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_at: string;
    poll_interval_seconds: number;
  }>
> {
  const parsed = parseDeviceStartBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const baseUrl = publicAppBaseUrl();
  if (!baseUrl.ok) {
    return baseUrl;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect start."
    );
  }

  const deviceCode = `dev_${randomBytes(DEVICE_TOKEN_BYTES).toString("base64url")}`;
  const userCode = generateUserCode();
  const expiresAt = new Date(
    (options.now ?? new Date()).getTime() +
      CONNECT_DEVICE_CODE_EXPIRES_IN_SECONDS * 1000
  );

  return withControlPlaneTransaction(
    context,
    "caller_connect_device_start",
    async (query) => {
      const limit = await enforceIpConnectStartLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      await query(
        createDeviceSetupRequestStatement({
          ...parsed.data,
          deviceCodeHash: callerSetupCodeDigest(deviceCode),
          userCodeHash: callerSetupCodeDigest(normalizeUserCode(userCode)),
          expiresAt
        })
      );

      const verificationUri = new URL(
        "/caller/connect/device",
        baseUrl.data
      ).toString();
      return {
        ok: true,
        data: {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(
            userCode
          )}`,
          expires_at: expiresAt.toISOString(),
          poll_interval_seconds: CONNECT_DEVICE_POLL_INTERVAL_SECONDS
        }
      };
    },
    options
  );
}

export async function handleConnectDevicePollRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectCredentialResponseData>> {
  const parsed = parseDevicePollBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const deviceCodeHash = callerSetupCodeDigest(parsed.data.deviceCode);
  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect poll."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller connect database configuration is unavailable."
    );
  }

  const contextResult = await withControlPlaneTransaction(
    context,
    "caller_connect_device_poll",
    async (query) => {
      const limit = await enforceIpConnectDevicePollLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      const lookup = await query<SetupExchangeContextRow>(
        setupExchangeContextByDeviceCodeHashStatement(deviceCodeHash)
      );
      const row = lookup.rows[0];
      if (!row) {
        return invalidRequestError("Device code is invalid or expired.");
      }

      if (setupRequestExpired(row, options.now ?? new Date())) {
        await query(markSetupRequestExpiredStatement(row.setup_request_id));
        return invalidRequestError("Device code is invalid or expired.");
      }

      if (row.status === "pending") {
        return {
          ok: false,
          error: {
            status: 202,
            code: "authorization_pending",
            message: "Caller connect approval is pending.",
            retryAfterSeconds: row.poll_interval_seconds
          }
        };
      }

      if (row.status !== "approved") {
        return invalidRequestError("Device code is invalid or already used.");
      }

      if (!row.account_id || !row.approved_by_user_id) {
        return temporaryUnavailableError(
          "Caller connect approval is temporarily unavailable."
        );
      }

      return {
        ok: true,
        data: {
          accountId: row.account_id,
          userId: row.approved_by_user_id
        }
      };
    },
    options
  );

  if (!contextResult.ok) {
    return contextResult;
  }

  return exchangeConnectSetupWithHumanContext(
    connectionString,
    context,
    {
      accountId: contextResult.data.accountId,
      userId: contextResult.data.userId,
      flow: "device",
      codeHash: deviceCodeHash
    },
    options
  );
}

export async function handleConnectExchangeRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectCredentialResponseData>> {
  const parsed = parseExchangeBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const setupCodeHash = callerSetupCodeDigest(parsed.data.setupCode);
  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect exchange."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller connect database configuration is unavailable."
    );
  }

  const contextResult = await withControlPlaneTransaction(
    context,
    "caller_connect_exchange_lookup",
    async (query) => {
      const limit = await enforceIpConnectExchangeLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      const lookup = await query<SetupExchangeContextRow>(
        setupExchangeContextBySetupCodeHashStatement(setupCodeHash)
      );
      const row = lookup.rows[0];
      if (!row) {
        return invalidRequestError("Setup code is invalid or expired.");
      }
      if (setupRequestExpired(row, options.now ?? new Date())) {
        await query(markSetupRequestExpiredStatement(row.setup_request_id));
        return invalidRequestError("Setup code is invalid or expired.");
      }
      if (row.status !== "approved") {
        return invalidRequestError("Setup code is invalid or already used.");
      }
      if (!row.account_id || !row.approved_by_user_id) {
        return temporaryUnavailableError(
          "Caller connect approval is temporarily unavailable."
        );
      }

      return {
        ok: true,
        data: {
          accountId: row.account_id,
          userId: row.approved_by_user_id
        }
      };
    },
    options
  );

  if (!contextResult.ok) {
    return contextResult;
  }

  return exchangeConnectSetupWithHumanContext(
    connectionString,
    context,
    {
      accountId: contextResult.data.accountId,
      userId: contextResult.data.userId,
      flow: "browser",
      codeHash: setupCodeHash
    },
    options
  );
}

export async function handleConnectActivateRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectActivateResponseData>> {
  const parsed = parseSetupRequestIdBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingConnectCredentialFromRequest(request);
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect activation."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller connect database configuration is unavailable."
    );
  }

  const lookupResult = await withControlPlaneTransaction(
    context,
    "caller_connect_activate_lookup",
    async (query) => {
      const limit = await enforceIpConnectActivationLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingConnectCredential(query, pendingCredential.data);
    },
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withScopedProductTransaction(
    connectionString,
    context,
    {
      authSurface: "caller",
      accountId: lookupResult.data.accountId,
      callerId: lookupResult.data.callerId
    },
    "caller_connect_activate",
    (query) =>
      activateConnectPendingCredential(
        query,
        {
          setupRequestId: parsed.data.setupRequestId,
          pendingCredential: pendingCredential.data
        },
        {
          requestId: context.requestId,
          now: options.now
        }
      ),
    options
  );
}

export async function handleConnectAbortRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectAbortResponseData>> {
  const parsed = parseSetupRequestIdBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingConnectCredentialFromRequest(request);
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller connect abort."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller connect database configuration is unavailable."
    );
  }

  const lookupResult = await withControlPlaneTransaction(
    context,
    "caller_connect_abort_lookup",
    async (query) => {
      const limit = await enforceIpConnectActivationLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingConnectCredential(query, pendingCredential.data);
    },
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withScopedProductTransaction(
    connectionString,
    context,
    {
      authSurface: "caller",
      accountId: lookupResult.data.accountId,
      callerId: lookupResult.data.callerId
    },
    "caller_connect_abort",
    (query) =>
      abortConnectPendingCredential(
        query,
        {
          setupRequestId: parsed.data.setupRequestId,
          pendingCredential: pendingCredential.data
        },
        {
          now: options.now
        }
      ),
    options
  );
}

export async function getConnectBrowserApprovalPreview(
  query: ProductTransactionQuery,
  input: { setupRequestId: string; now?: Date }
): Promise<ConnectResult<ConnectApprovalPreviewData>> {
  const targetResult = await query<SetupApprovalTargetRow>(
    browserApprovalTargetStatement(input.setupRequestId)
  );

  return connectApprovalPreviewFromTarget(
    query,
    targetResult.rows[0] ?? null,
    input.now
  );
}

export async function getConnectDeviceApprovalPreview(
  query: ProductTransactionQuery,
  input: { userCode: string; now?: Date }
): Promise<ConnectResult<ConnectApprovalPreviewData>> {
  const targetResult = await query<SetupApprovalTargetRow>(
    deviceApprovalTargetStatement(
      callerSetupCodeDigest(normalizeUserCode(input.userCode))
    )
  );

  return connectApprovalPreviewFromTarget(
    query,
    targetResult.rows[0] ?? null,
    input.now
  );
}

export async function getConnectTerminalSetupState(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    accountId: string;
    statuses: readonly SetupTerminalStatus[];
  }
): Promise<ConnectResult<ConnectTerminalSetupData>> {
  const result = await query<SetupTerminalStateRow>(
    terminalSetupStateStatement(input)
  );
  const row = result.rows[0];
  if (!row) {
    return notFoundError("Caller connect setup request was not found.");
  }

  return {
    ok: true,
    data: {
      setup_request_id: row.setup_request_id,
      operation: row.operation,
      flow: row.flow,
      status: row.status,
      local_caller_name: row.local_caller_name,
      display_name: row.display_name,
      caller:
        row.caller_id && row.caller_display_name
          ? {
              caller_id: row.caller_id,
              caller_slug: row.caller_slug,
              display_name: row.caller_display_name
            }
          : null
    }
  };
}

export async function approveConnectBrowserSetupRequest(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    accountId: string;
    userId: string;
    now?: Date;
  }
): Promise<ConnectResult<ConnectBrowserApprovalData>> {
  const targetResult = await query<SetupApprovalTargetRow>(
    browserApprovalTargetStatement(input.setupRequestId)
  );
  const target = targetResult.rows[0];
  if (!target) {
    return notFoundError("Caller connect setup request was not found.");
  }

  const available = await ensurePendingApprovalTarget(query, target, input.now);
  if (!available.ok) {
    return available;
  }

  if (!target.callback_url) {
    return temporaryUnavailableError(
      "Caller connect setup request is temporarily unavailable."
    );
  }

  const limit = await enforceConnectApprovalLimit(query, input.accountId);
  if (!limit.ok) {
    return limit;
  }

  const availableCallerSlug = await ensureConnectCallerSlugAvailable(
    query,
    input.accountId,
    target
  );
  if (!availableCallerSlug.ok) {
    return availableCallerSlug;
  }

  const callerResult = await createConnectCaller(
    query,
    input.accountId,
    target
  );
  if (!callerResult.ok) {
    return callerResult;
  }
  const caller = callerResult.data;

  const setupCode = `setup_${randomBytes(SETUP_TOKEN_BYTES).toString("base64url")}`;
  await query(
    approveBrowserSetupRequestStatement({
      setupRequestId: target.setup_request_id,
      accountId: input.accountId,
      callerId: caller.caller_id,
      userId: input.userId,
      setupCodeHash: callerSetupCodeDigest(setupCode)
    })
  );

  return {
    ok: true,
    data: {
      setup_request_id: target.setup_request_id,
      setup_code: setupCode,
      callback_url: target.callback_url,
      caller: {
        caller_id: caller.caller_id,
        caller_slug: caller.caller_slug,
        display_name: caller.display_name
      }
    }
  };
}

export async function approveConnectDeviceSetupRequest(
  query: ProductTransactionQuery,
  input: {
    userCode: string;
    accountId: string;
    userId: string;
    now?: Date;
  }
): Promise<ConnectResult<ConnectDeviceApprovalData>> {
  const targetResult = await query<SetupApprovalTargetRow>(
    deviceApprovalTargetStatement(
      callerSetupCodeDigest(normalizeUserCode(input.userCode))
    )
  );
  const target = targetResult.rows[0];
  if (!target) {
    return notFoundError("Caller connect setup request was not found.");
  }

  const available = await ensurePendingApprovalTarget(query, target, input.now);
  if (!available.ok) {
    return available;
  }

  const limit = await enforceConnectApprovalLimit(query, input.accountId);
  if (!limit.ok) {
    return limit;
  }

  const availableCallerSlug = await ensureConnectCallerSlugAvailable(
    query,
    input.accountId,
    target
  );
  if (!availableCallerSlug.ok) {
    return availableCallerSlug;
  }

  const callerResult = await createConnectCaller(
    query,
    input.accountId,
    target
  );
  if (!callerResult.ok) {
    return callerResult;
  }
  const caller = callerResult.data;

  await query(
    approveDeviceSetupRequestStatement({
      setupRequestId: target.setup_request_id,
      accountId: input.accountId,
      callerId: caller.caller_id,
      userId: input.userId
    })
  );

  return {
    ok: true,
    data: {
      setup_request_id: target.setup_request_id,
      caller: {
        caller_id: caller.caller_id,
        caller_slug: caller.caller_slug,
        display_name: caller.display_name
      }
    }
  };
}

export async function denyConnectSetupRequest(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    accountId: string;
  }
): Promise<ConnectResult<{ setup_request_id: string; denied: true }>> {
  const result = await query<SetupRequestIdRow>(
    denySetupRequestStatement(input)
  );
  if (!result.rows[0]) {
    return notFoundError("Caller connect setup request was not found.");
  }
  return {
    ok: true,
    data: {
      setup_request_id: result.rows[0].setup_request_id,
      denied: true
    }
  };
}

function createBrowserSetupRequestStatement(input: {
  localCallerName: string;
  displayName: string;
  callbackUrl: string;
  expiresAt: Date;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_caller_setup_requests (
        operation,
        flow,
        local_caller_name,
        display_name,
        callback_url,
        expires_at,
        poll_interval_seconds
      )
      values ('connect', 'browser', $1, $2, $3, $4::timestamptz, $5)
      returning setup_request_id::text as setup_request_id
    `,
    values: [
      input.localCallerName,
      input.displayName,
      input.callbackUrl,
      input.expiresAt.toISOString(),
      CONNECT_DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
}

function createDeviceSetupRequestStatement(input: {
  localCallerName: string;
  displayName: string;
  deviceCodeHash: string;
  userCodeHash: string;
  expiresAt: Date;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_caller_setup_requests (
        operation,
        flow,
        local_caller_name,
        display_name,
        device_code_hash,
        user_code_hash,
        expires_at,
        poll_interval_seconds
      )
      values ('connect', 'device', $1, $2, $3, $4, $5::timestamptz, $6)
    `,
    values: [
      input.localCallerName,
      input.displayName,
      input.deviceCodeHash,
      input.userCodeHash,
      input.expiresAt.toISOString(),
      CONNECT_DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
}

export function callerSetupCodeDigest(value: string) {
  return createHmac(TOKEN_HASH_ALGORITHM, requireCallerKeyHashSecret())
    .update(value)
    .digest("hex");
}

function trustedClientIpAddress(request: Request) {
  const candidates = [
    request.headers.get("cf-connecting-ip")?.trim(),
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  ];

  for (const candidate of candidates) {
    if (candidate && isIP(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function exchangeConnectSetupWithHumanContext(
  connectionString: string,
  context: ApiRequestContext,
  input: {
    accountId: string;
    userId: string;
    flow: "browser" | "device";
    codeHash: string;
  },
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectCredentialResponseData>> {
  const runTransaction = options.runProductTransaction ?? runProductTransaction;
  try {
    return await runTransaction(
      connectionString,
      {
        requestId: context.requestId,
        authSurface: "human",
        accountId: input.accountId,
        userId: input.userId
      },
      async (query) => {
        return exchangeApprovedConnectSetupRequest(
          query,
          {
            flow: input.flow,
            codeHash: input.codeHash
          },
          {
            requestId: context.requestId,
            now: options.now
          }
        );
      }
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "api",
      operation: "caller_connect_exchange",
      message: "Caller connect exchange failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: context.requestId
    });
    return temporaryUnavailableError(
      "Caller connect exchange is temporarily unavailable."
    );
  }
}

async function connectApprovalPreviewFromTarget(
  query: ProductTransactionQuery,
  target: SetupApprovalTargetRow | null,
  now: Date = new Date()
): Promise<ConnectResult<ConnectApprovalPreviewData>> {
  if (!target) {
    return notFoundError("Caller connect setup request was not found.");
  }

  const available = await ensurePendingApprovalTarget(query, target, now);
  if (!available.ok) {
    return available;
  }

  return {
    ok: true,
    data: {
      setup_request_id: target.setup_request_id,
      operation: target.operation,
      flow: target.flow,
      status: target.status,
      local_caller_name: target.local_caller_name,
      display_name: target.display_name,
      callback_url: target.callback_url,
      expires_at: new Date(target.expires_at).toISOString()
    }
  };
}

export async function exchangeApprovedConnectSetupRequest(
  query: ProductTransactionQuery,
  input: {
    flow: "browser" | "device";
    codeHash: string;
  },
  options: { requestId: string; now?: Date }
): Promise<ConnectResult<ConnectCredentialResponseData>> {
  const targetResult = await query<SetupExchangeTargetRow>(
    input.flow === "browser"
      ? browserExchangeTargetStatement(input.codeHash)
      : deviceExchangeTargetStatement(input.codeHash)
  );
  const target = targetResult.rows[0];
  if (!target) {
    return invalidRequestError("Caller connect code is invalid or expired.");
  }

  if (setupRequestExpired(target, options.now ?? new Date())) {
    await query(markSetupRequestExpiredStatement(target.setup_request_id));
    return invalidRequestError("Caller connect code is invalid or expired.");
  }

  if (target.status !== "approved") {
    return invalidRequestError(
      "Caller connect code is invalid or already used."
    );
  }

  if (
    !target.account_id ||
    !target.caller_id ||
    !target.caller_display_name ||
    !target.account_tier
  ) {
    return temporaryUnavailableError(
      "Caller connect exchange is temporarily unavailable."
    );
  }

  const expiresAt = new Date(target.expires_at);
  const material = generateCallerApiKeyMaterial();
  const credentialResult = await query<CredentialRow>(
    insertConnectCredentialStatement({
      accountId: target.account_id,
      callerId: target.caller_id,
      setupRequestId: target.setup_request_id,
      expiresAt,
      material
    })
  );
  const credential = credentialResult.rows[0];

  await query(markSetupRequestExchangedStatement(target.setup_request_id));

  return {
    ok: true,
    data: {
      setup_request_id: target.setup_request_id,
      caller: {
        caller_id: target.caller_id,
        caller_slug: target.caller_slug,
        display_name: target.caller_display_name
      },
      account: {
        account_id: target.account_id,
        label: target.account_label,
        effective_tier: target.account_tier === "hosted_free" ? "free" : "paid"
      },
      credential: {
        api_key: material.plaintextApiKey,
        key_id: credential.key_id,
        prefix: credential.key_prefix,
        last_chars: credential.key_last_four,
        created_at: new Date(credential.created_at).toISOString(),
        expires_at: expiresAt.toISOString()
      }
    }
  };
}

async function activateConnectPendingCredential(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    pendingCredential: PendingConnectCredentialBearer;
  },
  options: { requestId: string; now?: Date }
): Promise<ConnectResult<ConnectActivateResponseData>> {
  const credentialResult = await query<PendingConnectCredentialRow>(
    connectPendingCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingConnectCredential(
    query,
    credential ?? null,
    input.pendingCredential,
    options.now ?? new Date()
  );
  if (!verified.ok) {
    return verified;
  }

  const activatedAt = (options.now ?? new Date()).toISOString();
  await query(
    activateConnectPendingCredentialStatement(credential.caller_credential_id)
  );
  await query(
    insertCallerRegisteredAuditStatement({
      accountId: credential.account_id,
      callerId: credential.caller_id,
      requestId: options.requestId
    })
  );

  return {
    ok: true,
    data: {
      caller_id: credential.caller_id,
      activated_key_id: credential.key_id,
      activated_at: activatedAt
    }
  };
}

async function abortConnectPendingCredential(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    pendingCredential: PendingConnectCredentialBearer;
  },
  options: { now?: Date }
): Promise<ConnectResult<ConnectAbortResponseData>> {
  const credentialResult = await query<PendingConnectCredentialRow>(
    connectPendingCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingConnectCredential(
    query,
    credential ?? null,
    input.pendingCredential,
    options.now ?? new Date()
  );
  if (!verified.ok) {
    return verified;
  }

  const abortedAt = (options.now ?? new Date()).toISOString();
  await query(
    expireConnectPendingCredentialStatement(credential.caller_credential_id)
  );

  return {
    ok: true,
    data: {
      caller_id: credential.caller_id,
      aborted_key_id: credential.key_id,
      aborted_at: abortedAt
    }
  };
}

async function withControlPlaneTransaction<TData>(
  context: ApiRequestContext,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<ConnectResult<TData>>,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller connect database configuration is unavailable."
    );
  }

  const runTransaction = options.runProductTransaction ?? runProductTransaction;
  try {
    return await runTransaction(
      connectionString,
      {
        requestId: context.requestId,
        authSurface: "control_plane"
      },
      callback
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "api",
      operation,
      message: "Caller connect request failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: context.requestId
    });
    return temporaryUnavailableError(
      "Caller connect is temporarily unavailable."
    );
  }
}

async function withScopedProductTransaction<TData>(
  connectionString: string,
  context: ApiRequestContext,
  scopedContext: Omit<ProductTransactionContext, "requestId">,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<ConnectResult<TData>>,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<TData>> {
  const runTransaction = options.runProductTransaction ?? runProductTransaction;
  try {
    return await runTransaction(
      connectionString,
      {
        requestId: context.requestId,
        ...scopedContext
      },
      callback
    );
  } catch (error) {
    emitRuntimeLog({
      level: "error",
      surface: "api",
      operation,
      message: "Caller connect request failed unexpectedly.",
      error_name: error instanceof Error ? error.name : "UnknownError",
      request_id: context.requestId
    });
    return temporaryUnavailableError(
      "Caller connect is temporarily unavailable."
    );
  }
}

function pendingConnectCredentialFromRequest(
  request: Request
): ConnectResult<PendingConnectCredentialBearer> {
  const parsed = parseCallerBearerApiKey(request.headers.get("authorization"));
  if (!parsed.ok) {
    if (parsed.code !== "missing_authorization") {
      return invalidCallerCredentialsError();
    }
    return {
      ok: false,
      error: {
        status: 401,
        code: "authentication_required",
        message: "Pending connect bearer credential is required."
      }
    };
  }
  return { ok: true, data: parsed };
}

async function lookupPendingConnectCredential(
  query: ProductTransactionQuery,
  bearer: PendingConnectCredentialBearer
): Promise<ConnectResult<{ accountId: string; callerId: string }>> {
  const result = await query<CallerCredentialLookupRow>(
    callerCredentialLookupStatement(bearer.keyId)
  );
  const row = result.rows[0];
  if (!row || row.status !== "pending_activation" || row.revoked_at) {
    return invalidCallerCredentialsError();
  }

  if (!/^[a-fA-F0-9]{64}$/.test(row.secret_hmac_sha256)) {
    return invalidCallerCredentialsError();
  }

  const suppliedDigest = callerApiKeySecretDigest(bearer.secret);
  const supplied = Buffer.from(suppliedDigest, "hex");
  const stored = Buffer.from(row.secret_hmac_sha256, "hex");
  if (!timingSafeEqual(supplied, stored)) {
    return invalidCallerCredentialsError();
  }

  return {
    ok: true,
    data: {
      accountId: row.account_id,
      callerId: row.caller_id
    }
  };
}

async function verifyPendingConnectCredential(
  query: ProductTransactionQuery,
  credential: PendingConnectCredentialRow | null,
  bearer: PendingConnectCredentialBearer,
  now: Date
): Promise<ConnectResult<null>> {
  if (!credential) {
    return invalidCallerCredentialsError();
  }

  if (
    credential.status !== "pending_activation" ||
    credential.revoked_at ||
    !credential.expires_at ||
    new Date(credential.expires_at).getTime() <= now.getTime()
  ) {
    if (
      credential.status === "pending_activation" &&
      credential.expires_at &&
      new Date(credential.expires_at).getTime() <= now.getTime()
    ) {
      await query(
        expireConnectPendingCredentialStatement(credential.caller_credential_id)
      );
    }
    return invalidCallerCredentialsError();
  }

  if (!/^[a-fA-F0-9]{64}$/.test(credential.secret_hmac_sha256)) {
    return invalidCallerCredentialsError();
  }

  const suppliedDigest = callerApiKeySecretDigest(bearer.secret);
  const supplied = Buffer.from(suppliedDigest, "hex");
  const stored = Buffer.from(credential.secret_hmac_sha256, "hex");
  if (!timingSafeEqual(supplied, stored)) {
    return invalidCallerCredentialsError();
  }

  return { ok: true, data: null };
}

async function enforceConnectApprovalLimit(
  query: ProductTransactionQuery,
  accountId: string
): Promise<ConnectResult<null>> {
  const profile = await accountLimitProfileForAccount(query, accountId);
  if (!profile) {
    return temporaryUnavailableError(
      "Caller connect approval is temporarily unavailable."
    );
  }

  const limit = await enforceAccountRequestLimits(
    query,
    { accountId },
    profile,
    "caller_connect_approval"
  );
  if (!limit.ok) {
    return limit;
  }

  return { ok: true, data: null };
}

async function ensurePendingApprovalTarget(
  query: ProductTransactionQuery,
  target: SetupApprovalTargetRow,
  now: Date = new Date()
): Promise<ConnectResult<null>> {
  if (setupRequestExpired(target, now)) {
    await query(markSetupRequestExpiredStatement(target.setup_request_id));
    return invalidRequestError("Caller connect setup request is expired.");
  }

  if (target.status !== "pending") {
    return invalidRequestError(
      "Caller connect setup request is not pending approval."
    );
  }

  return { ok: true, data: null };
}

async function ensureConnectCallerSlugAvailable(
  query: ProductTransactionQuery,
  accountId: string,
  target: SetupApprovalTargetRow
): Promise<ConnectResult<null>> {
  const result = await query<ExistingCallerSlugRow>(
    existingConnectCallerSlugStatement({
      accountId,
      localCallerName: target.local_caller_name
    })
  );
  if (result.rows[0]) {
    return callerAlreadyExistsError();
  }

  return { ok: true, data: null };
}

async function createConnectCaller(
  query: ProductTransactionQuery,
  accountId: string,
  target: SetupApprovalTargetRow
): Promise<ConnectResult<CallerRow>> {
  try {
    const result = await query<CallerRow>(
      insertConnectCallerStatement({
        accountId,
        localCallerName: target.local_caller_name,
        displayName: target.display_name
      })
    );
    return { ok: true, data: result.rows[0] };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return callerAlreadyExistsError();
    }
    throw error;
  }
}

function existingConnectCallerSlugStatement(input: {
  accountId: string;
  localCallerName: string;
}): TransactionContextStatement {
  return {
    sql: `
      select caller_id::text as caller_id
      from public.agent_outbox_callers
      where account_id = $1
        and caller_slug = $2
      limit 1
    `,
    values: [input.accountId, input.localCallerName]
  };
}

function browserApprovalTargetStatement(
  setupRequestId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        operation,
        flow,
        status,
        local_caller_name,
        display_name,
        callback_url,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where setup_request_id = $1
        and operation = 'connect'
        and flow = 'browser'
      for update
    `,
    values: [setupRequestId]
  };
}

function deviceApprovalTargetStatement(
  userCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        operation,
        flow,
        status,
        local_caller_name,
        display_name,
        callback_url,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where user_code_hash = $1
        and operation = 'connect'
        and flow = 'device'
      for update
    `,
    values: [userCodeHash]
  };
}

function terminalSetupStateStatement(input: {
  setupRequestId: string;
  accountId: string;
  statuses: readonly SetupTerminalStatus[];
}): TransactionContextStatement {
  const statusPlaceholders = input.statuses
    .map((_, index) => `$${index + 3}`)
    .join(", ");

  return {
    sql: `
      select
        setup.setup_request_id::text as setup_request_id,
        setup.operation,
        setup.flow,
        setup.status,
        setup.local_caller_name,
        setup.display_name,
        caller.caller_id::text as caller_id,
        caller.caller_slug,
        caller.display_name as caller_display_name
      from public.agent_outbox_caller_setup_requests setup
      left join public.agent_outbox_callers caller
        on caller.account_id = setup.account_id
       and caller.caller_id = setup.caller_id
      where setup.setup_request_id = $1
        and setup.account_id = $2
        and setup.operation = 'connect'
        and setup.status in (${statusPlaceholders})
      limit 1
    `,
    values: [input.setupRequestId, input.accountId, ...input.statuses]
  };
}

function setupExchangeContextBySetupCodeHashStatement(
  setupCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        status,
        account_id::text as account_id,
        approved_by_user_id::text as approved_by_user_id,
        poll_interval_seconds,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where setup_code_hash = $1
        and operation = 'connect'
        and flow = 'browser'
      limit 1
    `,
    values: [setupCodeHash]
  };
}

function setupExchangeContextByDeviceCodeHashStatement(
  deviceCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        status,
        account_id::text as account_id,
        approved_by_user_id::text as approved_by_user_id,
        poll_interval_seconds,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where device_code_hash = $1
        and operation = 'connect'
        and flow = 'device'
      limit 1
    `,
    values: [deviceCodeHash]
  };
}

function browserExchangeTargetStatement(
  setupCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup.setup_request_id::text as setup_request_id,
        setup.status,
        setup.account_id::text as account_id,
        setup.caller_id::text as caller_id,
        setup.expires_at,
        caller.caller_slug,
        caller.display_name as caller_display_name,
        account.label as account_label,
        account.tier as account_tier
      from public.agent_outbox_caller_setup_requests setup
      left join public.agent_outbox_callers caller
        on caller.account_id = setup.account_id
       and caller.caller_id = setup.caller_id
      left join public.agent_outbox_accounts account
        on account.account_id = setup.account_id
      where setup.setup_code_hash = $1
        and setup.operation = 'connect'
        and setup.flow = 'browser'
      for update of setup
    `,
    values: [setupCodeHash]
  };
}

function deviceExchangeTargetStatement(
  deviceCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup.setup_request_id::text as setup_request_id,
        setup.status,
        setup.account_id::text as account_id,
        setup.caller_id::text as caller_id,
        setup.expires_at,
        caller.caller_slug,
        caller.display_name as caller_display_name,
        account.label as account_label,
        account.tier as account_tier
      from public.agent_outbox_caller_setup_requests setup
      left join public.agent_outbox_callers caller
        on caller.account_id = setup.account_id
       and caller.caller_id = setup.caller_id
      left join public.agent_outbox_accounts account
        on account.account_id = setup.account_id
      where setup.device_code_hash = $1
        and setup.operation = 'connect'
        and setup.flow = 'device'
      for update of setup
    `,
    values: [deviceCodeHash]
  };
}

function insertConnectCallerStatement(input: {
  accountId: string;
  localCallerName: string;
  displayName: string;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_callers (
        account_id,
        display_name,
        caller_slug
      )
      values ($1, $2, $3)
      returning
        caller_id::text as caller_id,
        caller_slug,
        display_name
    `,
    values: [input.accountId, input.displayName, input.localCallerName]
  };
}

function approveBrowserSetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
  callerId: string;
  userId: string;
  setupCodeHash: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        caller_id = $3,
        approved_by_user_id = $4,
        setup_code_hash = $5,
        status = 'approved',
        approved_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and status = 'pending'
    `,
    values: [
      input.setupRequestId,
      input.accountId,
      input.callerId,
      input.userId,
      input.setupCodeHash
    ]
  };
}

function approveDeviceSetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
  callerId: string;
  userId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        caller_id = $3,
        approved_by_user_id = $4,
        status = 'approved',
        approved_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and status = 'pending'
    `,
    values: [
      input.setupRequestId,
      input.accountId,
      input.callerId,
      input.userId
    ]
  };
}

function denySetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        status = 'denied',
        denied_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and operation = 'connect'
        and status = 'pending'
      returning setup_request_id::text as setup_request_id
    `,
    values: [input.setupRequestId, input.accountId]
  };
}

function markSetupRequestExpiredStatement(
  setupRequestId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        status = 'expired',
        updated_at = now()
      where setup_request_id = $1
        and status in ('pending', 'approved')
    `,
    values: [setupRequestId]
  };
}

function markSetupRequestExchangedStatement(
  setupRequestId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        status = 'exchanged',
        exchanged_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and status = 'approved'
    `,
    values: [setupRequestId]
  };
}

function insertConnectCredentialStatement(input: {
  accountId: string;
  callerId: string;
  setupRequestId: string;
  expiresAt: Date;
  material: DisplayOnceCallerApiKeyMaterial;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_caller_credentials (
        account_id,
        caller_id,
        key_id,
        key_prefix,
        key_last_four,
        secret_hmac_sha256,
        status,
        expires_at,
        pending_replacement_setup_request_id
      )
      values ($1, $2, $3, $4, $5, $6, 'pending_activation', $7::timestamptz, $8)
      returning
        key_id,
        key_prefix,
        key_last_four,
        created_at
    `,
    values: [
      input.accountId,
      input.callerId,
      input.material.keyId,
      input.material.keyPrefix,
      input.material.keyLastCharacters,
      input.material.secretDigest,
      input.expiresAt.toISOString(),
      input.setupRequestId
    ]
  };
}

function connectPendingCredentialStatement(input: {
  setupRequestId: string;
  pendingCredential: PendingConnectCredentialBearer;
}): TransactionContextStatement {
  return {
    sql: `
      select
        pending.caller_credential_id::text as caller_credential_id,
        pending.key_id,
        pending.secret_hmac_sha256,
        pending.status,
        pending.expires_at,
        pending.revoked_at,
        pending.account_id::text as account_id,
        pending.caller_id::text as caller_id
      from public.agent_outbox_caller_credentials pending
      where pending.key_id = $1
        and pending.pending_replacement_setup_request_id = $2
        and pending.pending_replacement_for_credential_id is null
      for update of pending
    `,
    values: [input.pendingCredential.keyId, input.setupRequestId]
  };
}

function activateConnectPendingCredentialStatement(
  callerCredentialId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'active',
        activated_at = now(),
        expires_at = null,
        pending_replacement_setup_request_id = null
      where caller_credential_id = $1
        and status = 'pending_activation'
    `,
    values: [callerCredentialId]
  };
}

function expireConnectPendingCredentialStatement(
  callerCredentialId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'expired',
        pending_replacement_setup_request_id = null
      where caller_credential_id = $1
        and status = 'pending_activation'
    `,
    values: [callerCredentialId]
  };
}

function insertCallerRegisteredAuditStatement(input: {
  accountId: string;
  callerId: string;
  requestId: string;
}): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_audit_events (
        event_type,
        account_audit_id,
        caller_audit_id,
        request_id
      )
      select
        'caller_registered',
        account.account_audit_id,
        caller.caller_audit_id,
        $3
      from public.agent_outbox_accounts account
      join public.agent_outbox_callers caller
        on caller.account_id = account.account_id
       and caller.caller_id = $2
      where account.account_id = $1
    `,
    values: [input.accountId, input.callerId, input.requestId]
  };
}

function parseBrowserStartBody(body: unknown): ConnectResult<BrowserStartBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const localCallerName = requiredText(body, "local_caller_name", fields);
  const displayName = requiredText(body, "display_name", fields);
  const callbackUrl = requiredCallbackUrl(body, "callback_url", fields);

  if (fields.length > 0) {
    return validationError(fields);
  }

  return {
    ok: true,
    data: {
      localCallerName,
      displayName,
      callbackUrl
    }
  };
}

function parseDeviceStartBody(body: unknown): ConnectResult<DeviceStartBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const localCallerName = requiredText(body, "local_caller_name", fields);
  const displayName = requiredText(body, "display_name", fields);

  if (fields.length > 0) {
    return validationError(fields);
  }

  return {
    ok: true,
    data: {
      localCallerName,
      displayName
    }
  };
}

function parseDevicePollBody(body: unknown): ConnectResult<DevicePollBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const deviceCode = requiredText(body, "device_code", fields, 512);

  if (fields.length > 0) {
    return validationError(fields);
  }

  return { ok: true, data: { deviceCode } };
}

function parseExchangeBody(body: unknown): ConnectResult<ExchangeBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const setupCode = requiredText(body, "setup_code", fields, 512);

  if (fields.length > 0) {
    return validationError(fields);
  }

  return { ok: true, data: { setupCode } };
}

function parseSetupRequestIdBody(
  body: unknown
): ConnectResult<SetupRequestIdBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const setupRequestId = requiredUuidText(body, "setup_request_id", fields);
  if (fields.length > 0) {
    return validationError(fields);
  }
  return { ok: true, data: { setupRequestId } };
}

function requiredUuidText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[]
) {
  const value = requiredText(record, key, fields, MAX_CONNECT_TEXT_LENGTH);
  if (!value) {
    return "";
  }

  if (!UUID_PATTERN.test(value)) {
    fields.push(
      fieldError(key, "invalid_uuid", `${key} must be a UUID-formatted string.`)
    );
    return "";
  }

  return value;
}

function requiredText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  maxLength = MAX_CONNECT_TEXT_LENGTH
) {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    fields.push(fieldError(key, "required", `${key} is required.`));
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    fields.push(
      fieldError(
        key,
        "too_long",
        `${key} must be at most ${maxLength} characters.`
      )
    );
    return "";
  }

  return trimmed;
}

function requiredCallbackUrl(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[]
) {
  const raw = requiredText(record, key, fields, MAX_CALLBACK_URL_LENGTH);
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    const localhost =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";
    if (url.protocol !== "http:" || !localhost) {
      fields.push(
        fieldError(
          key,
          "invalid_callback_url",
          "callback_url must be an http localhost callback URL."
        )
      );
      return "";
    }
  } catch {
    fields.push(
      fieldError(
        key,
        "invalid_callback_url",
        "callback_url must be a valid URL."
      )
    );
    return "";
  }

  return raw;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validationError(fields: ApiFieldError[]): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 422,
      code: "validation_failed",
      message: "Caller connect request failed validation.",
      fields
    }
  };
}

function fieldError(
  path: string,
  code: string,
  message: string
): ApiFieldError {
  return { path, code, message };
}

function invalidRequestError(message: string): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

function notFoundError(message: string): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message
    }
  };
}

function callerAlreadyExistsError(): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 409,
      code: "caller_already_exists",
      message: CALLER_ALREADY_EXISTS_MESSAGE,
      fields: [
        {
          path: "local_caller_name",
          code: "duplicate",
          message: CALLER_ALREADY_EXISTS_FIELD_MESSAGE
        }
      ]
    }
  };
}

function invalidCallerCredentialsError(): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 401,
      code: "invalid_caller_credentials",
      message: "Pending connect credential is invalid or no longer usable."
    }
  };
}

function temporaryUnavailableError(message: string): ConnectResult<never> {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message
    }
  };
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23505";
}

function publicAppBaseUrl(): ConnectResult<string> {
  const value = process.env.PUBLIC_APP_BASE_URL;
  if (!value) {
    return temporaryUnavailableError(
      "Public app base URL configuration is unavailable."
    );
  }

  try {
    return { ok: true, data: new URL(value).origin };
  } catch {
    return temporaryUnavailableError(
      "Public app base URL configuration is invalid."
    );
  }
}

function generateUserCode() {
  const characters = [];
  for (
    let index = 0;
    index < USER_CODE_GROUP_LENGTH * USER_CODE_GROUPS;
    index += 1
  ) {
    characters.push(USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]);
  }

  return `${characters.slice(0, USER_CODE_GROUP_LENGTH).join("")}-${characters
    .slice(USER_CODE_GROUP_LENGTH)
    .join("")}`;
}

function normalizeUserCode(userCode: string) {
  return userCode.replace(/[\s-]+/g, "").toUpperCase();
}

function setupRequestExpired(row: { expires_at: string | Date }, now: Date) {
  return new Date(row.expires_at).getTime() <= now.getTime();
}
