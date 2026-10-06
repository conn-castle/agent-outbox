import { randomBytes } from "node:crypto";

import {
  apiTemporaryUnavailable,
  apiValidationFailed,
  type ApiFieldError,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  enforceAccountOperationLimits,
  enforceIpControlPlaneLimit
} from "./caller-api-limits.ts";
import {
  generateCallerApiKeyMaterial,
  type DisplayOnceCallerApiKeyMaterial
} from "./caller-auth.ts";
import {
  runProductTransaction,
  withSavepoint,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_TOKEN_BYTES,
  SETUP_TOKEN_BYTES,
  UUID_PATTERN,
  callerCredentialLifecycleLockStatement,
  fieldError,
  generateUserCode,
  handlePendingCredentialFinalizeRequest,
  invalidRequestError,
  invalidSetupRequestError,
  isPlainRecord,
  isUniqueViolation,
  markSetupRequestExchangedStatement,
  markSetupRequestExpiredStatement,
  normalizeUserCode,
  notFoundError,
  parseDevicePollBody,
  parseSetupCodeBody,
  publicAppBaseUrl,
  requiredCallbackUrl,
  requiredText,
  setupCodeDigest,
  setupRequestExpired,
  setupRequestExpiresAt,
  verifyPendingCredential,
  withControlPlaneTransaction,
  type CallerFlowMessages,
  type CallerFlowRequestOptions as ConnectRequestOptions,
  type PendingCredentialBearer,
  type SetupRequestStatus,
  type SetupResult
} from "./caller-setup-requests.ts";
import { durationSinceMs } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";
import { trustedClientIpAddress } from "./trusted-client-ip.ts";

const MESSAGES: CallerFlowMessages = {
  bearerRequired: "Pending connect bearer credential is required.",
  invalidCredential:
    "Pending connect credential is invalid or no longer usable.",
  validationFailed: "Caller connect request failed validation.",
  databaseUnavailable: "Caller connect database configuration is unavailable.",
  unexpectedFailure: "Caller connect request failed unexpectedly.",
  temporarilyUnavailable: "Caller connect is temporarily unavailable."
};

type ConnectResult<TData> = SetupResult<TData>;

type BrowserStartBody = {
  localCallerName: string;
  displayName: string;
  callbackUrl: string;
};

type DeviceStartBody = {
  localCallerName: string;
  displayName: string;
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

type DeviceSetupApprovalTargetRow = SetupApprovalTargetRow & {
  account_id: string | null;
  caller_id: string | null;
  caller_slug: string | null;
  caller_display_name: string | null;
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
    return apiTemporaryUnavailable(
      "Trusted client IP is unavailable for caller connect start."
    );
  }

  const expiresAt = setupRequestExpiresAt(options.now ?? new Date());

  return withControlPlaneTransaction(
    MESSAGES,
    context,
    "caller_connect_browser_start",
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        "caller_connect_start"
      );
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
    return apiTemporaryUnavailable(
      "Trusted client IP is unavailable for caller connect start."
    );
  }

  const deviceCode = `dev_${randomBytes(DEVICE_TOKEN_BYTES).toString("base64url")}`;
  const userCode = generateUserCode();
  const expiresAt = setupRequestExpiresAt(options.now ?? new Date());

  return withControlPlaneTransaction(
    MESSAGES,
    context,
    "caller_connect_device_start",
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        "caller_connect_start"
      );
      if (!limit.ok) {
        return limit;
      }

      await query(
        createDeviceSetupRequestStatement({
          ...parsed.data,
          deviceCodeHash: setupCodeDigest(deviceCode),
          userCodeHash: setupCodeDigest(normalizeUserCode(userCode)),
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
          poll_interval_seconds: DEVICE_POLL_INTERVAL_SECONDS
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
  const parsed = parseDevicePollBody(MESSAGES, body);
  if (!parsed.ok) {
    return parsed;
  }

  const deviceCodeHash = setupCodeDigest(parsed.data.deviceCode);
  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return apiTemporaryUnavailable(
      "Trusted client IP is unavailable for caller connect poll."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(MESSAGES.databaseUnavailable);
  }

  const contextResult = await withControlPlaneTransaction(
    MESSAGES,
    context,
    "caller_connect_device_poll",
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        "caller_connect_poll"
      );
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
        return apiTemporaryUnavailable(
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
  const parsed = parseSetupCodeBody(MESSAGES, body);
  if (!parsed.ok) {
    return parsed;
  }

  const setupCodeHash = setupCodeDigest(parsed.data.setupCode);
  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return apiTemporaryUnavailable(
      "Trusted client IP is unavailable for caller connect exchange."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(MESSAGES.databaseUnavailable);
  }

  const contextResult = await withControlPlaneTransaction(
    MESSAGES,
    context,
    "caller_connect_exchange_lookup",
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        "caller_connect_exchange"
      );
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
        return apiTemporaryUnavailable(
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
  return handlePendingCredentialFinalizeRequest({
    request,
    context,
    body,
    options,
    messages: MESSAGES,
    ipUnavailableMessage:
      "Trusted client IP is unavailable for caller connect activation.",
    limitKind: "caller_connect_activation",
    lookupOperation: "caller_connect_activate_lookup",
    finalizeOperation: "caller_connect_activate",
    finalize: (query, input) =>
      activateConnectPendingCredential(query, input, {
        requestId: context.requestId,
        now: options.now
      })
  });
}

export async function handleConnectAbortRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ConnectRequestOptions = {}
): Promise<ConnectResult<ConnectAbortResponseData>> {
  return handlePendingCredentialFinalizeRequest({
    request,
    context,
    body,
    options,
    messages: MESSAGES,
    ipUnavailableMessage:
      "Trusted client IP is unavailable for caller connect abort.",
    limitKind: "caller_connect_activation",
    lookupOperation: "caller_connect_abort_lookup",
    finalizeOperation: "caller_connect_abort",
    finalize: (query, input) =>
      abortConnectPendingCredential(query, input, { now: options.now })
  });
}

export async function getConnectBrowserApprovalPreview(
  query: ProductTransactionQuery,
  input: { setupRequestId: string; now?: Date }
): Promise<ConnectResult<ConnectApprovalPreviewData>> {
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

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
  input: { userCode: string; accountId: string; now?: Date }
): Promise<ConnectResult<ConnectApprovalPreviewData>> {
  const targetResult = await query<DeviceSetupApprovalTargetRow>(
    deviceApprovalTargetStatement(
      setupCodeDigest(normalizeUserCode(input.userCode))
    )
  );

  const target = targetResult.rows[0] ?? null;
  if (
    target &&
    (target.status === "approved" || target.status === "exchanged")
  ) {
    if (target.account_id !== input.accountId) {
      return invalidRequestError(
        "Caller connect setup request is not pending approval."
      );
    }
    return connectApprovalPreviewData(target);
  }

  return connectApprovalPreviewFromTarget(query, target, input.now);
}

export async function getConnectTerminalSetupState(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    accountId: string;
    statuses: readonly SetupTerminalStatus[];
  }
): Promise<ConnectResult<ConnectTerminalSetupData>> {
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

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
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

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
    return apiTemporaryUnavailable(
      "Caller connect setup request is temporarily unavailable."
    );
  }

  const limit = await enforceAccountOperationLimits(
    query,
    { accountId: input.accountId },
    "caller_connect_approval",
    "Caller connect approval is temporarily unavailable."
  );
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
      setupCodeHash: setupCodeDigest(setupCode)
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
  const targetResult = await query<DeviceSetupApprovalTargetRow>(
    deviceApprovalTargetStatement(
      setupCodeDigest(normalizeUserCode(input.userCode))
    )
  );
  const target = targetResult.rows[0];
  if (!target) {
    return notFoundError("Caller connect setup request was not found.");
  }

  if (target.status === "approved" || target.status === "exchanged") {
    if (target.account_id !== input.accountId) {
      return invalidRequestError(
        "Caller connect setup request is not pending approval."
      );
    }
    if (!target.caller_id || !target.caller_display_name) {
      throw new Error(
        "Completed caller connect setup request is missing its caller."
      );
    }
    return {
      ok: true,
      data: {
        setup_request_id: target.setup_request_id,
        caller: {
          caller_id: target.caller_id,
          caller_slug: target.caller_slug,
          display_name: target.caller_display_name
        }
      }
    };
  }

  const available = await ensurePendingApprovalTarget(query, target, input.now);
  if (!available.ok) {
    return available;
  }

  const limit = await enforceAccountOperationLimits(
    query,
    { accountId: input.accountId },
    "caller_connect_approval",
    "Caller connect approval is temporarily unavailable."
  );
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
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

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
      DEVICE_POLL_INTERVAL_SECONDS
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
      DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
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
    reportRuntimeFailure(error, {
      errorId: context.correlationId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 503,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation: "caller_connect_exchange",
      message: "Caller connect exchange failed unexpectedly.",
      request_id: context.requestId,
      account_id: input.accountId
    });
    return apiTemporaryUnavailable(
      "Caller connect exchange is temporarily unavailable.",
      { errorId: context.correlationId, reported: true }
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

  return connectApprovalPreviewData(target);
}

function connectApprovalPreviewData(
  target: SetupApprovalTargetRow
): ConnectResult<ConnectApprovalPreviewData> {
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
    return apiTemporaryUnavailable(
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
    accountId: string;
    callerId: string;
    setupRequestId: string;
    pendingCredential: PendingCredentialBearer;
  },
  options: { requestId: string; now?: Date }
): Promise<ConnectResult<ConnectActivateResponseData>> {
  // Serialize with revoke and rotate before locking the credential row, in the
  // same advisory-lock-then-row-lock order they use.
  await query(callerCredentialLifecycleLockStatement(input));
  const credentialResult = await query<PendingConnectCredentialRow>(
    connectPendingCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingCredential(
    query,
    MESSAGES,
    credential,
    input.pendingCredential,
    options.now ?? new Date(),
    expireConnectPendingCredentialStatement
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
    accountId: string;
    callerId: string;
    setupRequestId: string;
    pendingCredential: PendingCredentialBearer;
  },
  options: { now?: Date }
): Promise<ConnectResult<ConnectAbortResponseData>> {
  await query(callerCredentialLifecycleLockStatement(input));
  const credentialResult = await query<PendingConnectCredentialRow>(
    connectPendingCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingCredential(
    query,
    MESSAGES,
    credential,
    input.pendingCredential,
    options.now ?? new Date(),
    expireConnectPendingCredentialStatement
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
    const result = await withSavepoint(query, "caller_connect_caller", () =>
      query<CallerRow>(
        insertConnectCallerStatement({
          accountId,
          localCallerName: target.local_caller_name,
          displayName: target.display_name
        })
      )
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
        setup.setup_request_id::text as setup_request_id,
        setup.operation,
        setup.flow,
        setup.status,
        setup.local_caller_name,
        setup.display_name,
        setup.callback_url,
        setup.expires_at,
        setup.account_id::text as account_id,
        setup.caller_id::text as caller_id,
        caller.caller_slug,
        caller.display_name as caller_display_name
      from public.agent_outbox_caller_setup_requests setup
      left join public.agent_outbox_callers caller
        on caller.account_id = setup.account_id
       and caller.caller_id = setup.caller_id
      where setup.user_code_hash = $1
        and setup.operation = 'connect'
        and setup.flow = 'device'
        and setup.status in ('pending', 'approved', 'exchanged')
        and setup.expires_at > now()
      order by setup.expires_at desc, setup.created_at desc
      limit 1
      for update of setup
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
  pendingCredential: PendingCredentialBearer;
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
    return apiValidationFailed(MESSAGES.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const localCallerName = requiredText(body, "local_caller_name", fields);
  const displayName = requiredText(body, "display_name", fields);
  const callbackUrl = requiredCallbackUrl(body, "callback_url", fields);

  if (fields.length > 0) {
    return apiValidationFailed(MESSAGES.validationFailed, fields);
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
    return apiValidationFailed(MESSAGES.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const localCallerName = requiredText(body, "local_caller_name", fields);
  const displayName = requiredText(body, "display_name", fields);

  if (fields.length > 0) {
    return apiValidationFailed(MESSAGES.validationFailed, fields);
  }

  return {
    ok: true,
    data: {
      localCallerName,
      displayName
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
