import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";

import type {
  ApiErrorInput,
  ApiFieldError,
  ApiRequestContext
} from "./api-errors.ts";
import {
  accountLimitProfileForAccount,
  enforceAccountRequestLimits,
  enforceIpRevokeConfirmLimit,
  enforceIpRevokeDevicePollLimit,
  enforceIpRevokeStartLimit,
  enforceIpRotateActivationLimit,
  enforceIpRotateDevicePollLimit,
  enforceIpRotateExchangeLimit,
  enforceIpRotateStartLimit
} from "./caller-api-limits.ts";
import {
  callerCredentialLookupStatement,
  callerApiKeySecretDigest,
  generateCallerApiKeyMaterial,
  parseCallerBearerApiKey,
  type CallerCredentialLookupRow,
  type CallerApiKeyDisplayMetadata,
  type DisplayOnceCallerApiKeyMaterial
} from "./caller-auth.ts";
import { absoluteHttpOrigin } from "./env.ts";
import {
  runProductTransaction,
  type ProductTransactionContext,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { requireCallerKeyHashSecret } from "./env.ts";
import { durationSinceMs } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";
import { trustedClientIpAddress } from "./trusted-client-ip.ts";

const CONTROL_PLANE_CODE_EXPIRES_IN_SECONDS = 10 * 60;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const TOKEN_HASH_ALGORITHM = "sha256";
const SETUP_TOKEN_BYTES = 32;
const DEVICE_TOKEN_BYTES = 32;
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TEXT_LENGTH = 128;
const MAX_CALLBACK_URL_LENGTH = 2048;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type CredentialOperation = "rotate" | "revoke";
type SetupFlow = "browser" | "device";
type SetupRequestStatus =
  "pending" | "approved" | "exchanged" | "expired" | "denied";
type SetupTerminalStatus = Extract<
  SetupRequestStatus,
  "approved" | "exchanged" | "denied"
>;
type NonEmptyTerminalStatusList = readonly [
  SetupTerminalStatus,
  ...SetupTerminalStatus[]
];

type OperationResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

type RequestOptions = {
  now?: Date;
  runProductTransaction?: typeof runProductTransaction;
};

type BrowserStartBody = {
  callerId: string;
  localCallerName: string;
  callbackUrl: string;
};

type DeviceStartBody = {
  callerId: string;
  localCallerName: string;
};

type DevicePollBody = {
  deviceCode: string;
};

type SetupCodeBody = {
  setupCode: string;
};

type SetupRequestIdBody = {
  setupRequestId: string;
};

type SetupRequestIdRow = {
  setup_request_id: string;
};

type ApprovalTargetRow = {
  setup_request_id: string;
  operation: CredentialOperation;
  status: SetupRequestStatus;
  local_caller_name: string;
  callback_url: string | null;
  expires_at: string | Date;
  caller_id: string;
  caller_slug: string | null;
  caller_display_name: string;
  active_credential_id: string | null;
  active_key_id: string | null;
  active_key_last_four: string | null;
};

type DevicePollTargetRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  setup_code_hash: string | null;
  poll_interval_seconds: number;
  expires_at: string | Date;
};

type SetupExchangeContextRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  account_id: string | null;
  approved_by_user_id: string | null;
  expires_at: string | Date;
};

type RotateExchangeTargetRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  account_id: string | null;
  caller_id: string | null;
  expires_at: string | Date;
  caller_slug: string | null;
  caller_display_name: string | null;
  account_label: string | null;
  account_tier: "hosted_free" | "hosted_paid" | "self_hosted" | null;
  active_credential_id: string | null;
  active_key_id: string | null;
  active_key_last_four: string | null;
};

type RevokeConfirmTargetRow = {
  setup_request_id: string;
  status: SetupRequestStatus;
  account_id: string | null;
  caller_id: string | null;
  expires_at: string | Date;
};

type InsertPendingReplacementCredentialRow = {
  caller_credential_id: string;
  key_id: string;
  key_prefix: string;
  key_last_four: string;
  created_at: string | Date;
};

type PendingReplacementCredentialRow = {
  caller_credential_id: string;
  key_id: string;
  secret_hmac_sha256: string;
  status: "active" | "pending_activation" | "revoked" | "expired";
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  account_id: string;
  caller_id: string;
  pending_replacement_for_credential_id: string;
  old_key_id: string;
};

type PendingReplacementCredentialScopeRow = {
  account_id: string;
  caller_id: string;
};

type KeyIdRow = {
  key_id: string;
};

type TerminalSetupStateRow = {
  setup_request_id: string;
  operation: CredentialOperation;
  flow: SetupFlow;
  status: SetupTerminalStatus;
  local_caller_name: string;
  display_name: string;
  caller_id: string | null;
  caller_slug: string | null;
  caller_display_name: string | null;
};

export type CredentialOperationApprovalPreviewData = {
  setup_request_id: string;
  operation: CredentialOperation;
  local_caller_name: string;
  display_name: string;
  callback_url: string | null;
  expires_at: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  };
  current_credential: {
    key_id: string;
    last_chars: string;
  } | null;
};

export type CredentialOperationApprovalData = {
  setup_request_id: string;
  setup_code?: string;
  callback_url?: string;
  operation: CredentialOperation;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  };
};

export type DeviceSetupCodeData = {
  setup_request_id: string;
  setup_code: string;
  expires_at: string;
};

export type RotateExchangeResponseData = {
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
  replacement_credential: {
    api_key: string;
    key_id: string;
    prefix: string;
    last_chars: string;
    created_at: string;
    expires_at: string;
  };
  replaces_credential: {
    key_id: string;
    last_chars: string;
  };
};

export type RotateActivateResponseData = {
  caller_id: string;
  activated_key_id: string;
  revoked_key_id: string;
  activated_at: string;
};

export type RotateAbortResponseData = {
  caller_id: string;
  aborted_key_id: string;
  active_key_id: string;
  aborted_at: string;
};

export type RevokeConfirmResponseData = {
  caller_id: string;
  revoked_key_ids: string[];
  revoked_at: string;
};

export type CredentialOperationTerminalSetupData = {
  setup_request_id: string;
  operation: CredentialOperation;
  flow: SetupFlow;
  status: SetupTerminalStatus;
  local_caller_name: string;
  display_name: string;
  caller: {
    caller_id: string;
    caller_slug: string | null;
    display_name: string;
  } | null;
};

export async function handleRotateBrowserStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationBrowserStartRequest(
    "rotate",
    request,
    context,
    body,
    options
  );
}

export async function handleRotateDeviceStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationDeviceStartRequest(
    "rotate",
    request,
    context,
    body,
    options
  );
}

export async function handleRotateDevicePollRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationDevicePollRequest(
    "rotate",
    request,
    context,
    body,
    options
  );
}

export async function handleRotateExchangeRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
): Promise<OperationResult<RotateExchangeResponseData>> {
  const parsed = parseSetupCodeBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller rotate exchange."
    );
  }

  const setupCodeHash = setupCodeDigest(parsed.data.setupCode);
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller credential operation database configuration is unavailable."
    );
  }

  const contextResult = await withControlPlaneTransaction(
    context,
    "caller_rotate_exchange_lookup",
    async (query) => {
      const limit = await enforceIpRotateExchangeLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return setupExchangeContext(query, {
        operation: "rotate",
        setupCodeHash,
        now: options.now,
        invalidMessage: "Caller rotate code is invalid or expired."
      });
    },
    options
  );

  if (!contextResult.ok) {
    return contextResult;
  }

  return withScopedProductTransaction(
    connectionString,
    context,
    {
      authSurface: "human",
      accountId: contextResult.data.accountId,
      userId: contextResult.data.userId
    },
    "caller_rotate_exchange",
    (query) =>
      exchangeRotateSetupRequest(query, setupCodeHash, {
        requestId: context.requestId,
        now: options.now
      }),
    options
  );
}

export async function handleRotateActivateRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
): Promise<OperationResult<RotateActivateResponseData>> {
  const parsed = parseSetupRequestIdBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingCredentialFromRequest(request);
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller rotate activation."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller credential operation database configuration is unavailable."
    );
  }

  const lookupResult = await withControlPlaneTransaction(
    context,
    "caller_rotate_activate_lookup",
    async (query) => {
      const limit = await enforceIpRotateActivationLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingReplacementCredential(query, pendingCredential.data);
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
    "caller_rotate_activate",
    (query) =>
      activatePendingReplacementCredential(
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

export async function handleRotateAbortRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
): Promise<OperationResult<RotateAbortResponseData>> {
  const parsed = parseSetupRequestIdBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingCredentialFromRequest(request);
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller rotate abort."
    );
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller credential operation database configuration is unavailable."
    );
  }

  const lookupResult = await withControlPlaneTransaction(
    context,
    "caller_rotate_abort_lookup",
    async (query) => {
      const limit = await enforceIpRotateActivationLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingReplacementCredential(query, pendingCredential.data);
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
    "caller_rotate_abort",
    (query) =>
      abortPendingReplacementCredential(
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

export async function handleRevokeBrowserStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationBrowserStartRequest(
    "revoke",
    request,
    context,
    body,
    options
  );
}

export async function handleRevokeDeviceStartRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationDeviceStartRequest(
    "revoke",
    request,
    context,
    body,
    options
  );
}

export async function handleRevokeDevicePollRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
) {
  return handleOperationDevicePollRequest(
    "revoke",
    request,
    context,
    body,
    options
  );
}

export async function handleRevokeConfirmRequest(
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions = {}
): Promise<OperationResult<RevokeConfirmResponseData>> {
  const parsed = parseSetupCodeBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      "Trusted client IP is unavailable for caller revoke confirmation."
    );
  }

  const setupCodeHash = setupCodeDigest(parsed.data.setupCode);
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller credential operation database configuration is unavailable."
    );
  }

  const contextResult = await withControlPlaneTransaction(
    context,
    "caller_revoke_confirm_lookup",
    async (query) => {
      const limit = await enforceIpRevokeConfirmLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      return setupExchangeContext(query, {
        operation: "revoke",
        setupCodeHash,
        now: options.now,
        invalidMessage: "Caller revoke code is invalid or expired."
      });
    },
    options
  );

  if (!contextResult.ok) {
    return contextResult;
  }

  return withScopedProductTransaction(
    connectionString,
    context,
    {
      authSurface: "human",
      accountId: contextResult.data.accountId,
      userId: contextResult.data.userId
    },
    "caller_revoke_confirm",
    (query) =>
      confirmRevokeSetupRequest(query, setupCodeHash, {
        requestId: context.requestId,
        now: options.now
      }),
    options
  );
}

export async function getCredentialOperationBrowserApprovalPreview(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    setupRequestId: string;
    accountId: string;
    now?: Date;
  }
): Promise<OperationResult<CredentialOperationApprovalPreviewData>> {
  const result = await query<ApprovalTargetRow>(
    approvalTargetBySetupRequestIdStatement(input)
  );
  return approvalPreviewFromTarget(query, result.rows[0] ?? null, input.now);
}

export async function getCredentialOperationDeviceApprovalPreview(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    userCode: string;
    accountId: string;
    now?: Date;
  }
): Promise<OperationResult<CredentialOperationApprovalPreviewData>> {
  const result = await query<ApprovalTargetRow>(
    approvalTargetByUserCodeStatement({
      operation: input.operation,
      accountId: input.accountId,
      userCodeHash: setupCodeDigest(normalizeUserCode(input.userCode))
    })
  );
  return approvalPreviewFromTarget(query, result.rows[0] ?? null, input.now);
}

export async function approveCredentialOperationBrowserSetupRequest(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    setupRequestId: string;
    accountId: string;
    userId: string;
    now?: Date;
  }
): Promise<OperationResult<CredentialOperationApprovalData>> {
  const result = await query<ApprovalTargetRow>(
    approvalTargetBySetupRequestIdStatement(input)
  );
  const target = result.rows[0];
  if (!target) {
    return notFoundError(
      `${operationLabel(input.operation)} request was not found.`
    );
  }

  const available = await ensurePendingApprovalTarget(query, target, input.now);
  if (!available.ok) {
    return available;
  }

  if (!target.callback_url) {
    return temporaryUnavailableError(
      `${operationLabel(input.operation)} request is temporarily unavailable.`
    );
  }

  const limit = await enforceApprovalLimit(
    query,
    input.accountId,
    input.operation
  );
  if (!limit.ok) {
    return limit;
  }

  const setupCode = `setup_${randomBytes(SETUP_TOKEN_BYTES).toString(
    "base64url"
  )}`;
  await query(
    approveBrowserSetupRequestStatement({
      setupRequestId: target.setup_request_id,
      accountId: input.accountId,
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
      operation: target.operation,
      caller: approvalCaller(target)
    }
  };
}

export async function approveCredentialOperationDeviceSetupRequest(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    userCode: string;
    accountId: string;
    userId: string;
    now?: Date;
  }
): Promise<OperationResult<CredentialOperationApprovalData>> {
  const result = await query<ApprovalTargetRow>(
    approvalTargetByUserCodeStatement({
      operation: input.operation,
      accountId: input.accountId,
      userCodeHash: setupCodeDigest(normalizeUserCode(input.userCode))
    })
  );
  const target = result.rows[0];
  if (!target) {
    return notFoundError(
      `${operationLabel(input.operation)} request was not found.`
    );
  }

  const available = await ensurePendingApprovalTarget(query, target, input.now);
  if (!available.ok) {
    return available;
  }

  const limit = await enforceApprovalLimit(
    query,
    input.accountId,
    input.operation
  );
  if (!limit.ok) {
    return limit;
  }

  await query(
    approveDeviceSetupRequestStatement({
      setupRequestId: target.setup_request_id,
      accountId: input.accountId,
      userId: input.userId
    })
  );

  return {
    ok: true,
    data: {
      setup_request_id: target.setup_request_id,
      operation: target.operation,
      caller: approvalCaller(target)
    }
  };
}

export async function denyCredentialOperationSetupRequest(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    setupRequestId: string;
    accountId: string;
  }
): Promise<OperationResult<{ setup_request_id: string; denied: true }>> {
  const result = await query<SetupRequestIdRow>(
    denySetupRequestStatement(input)
  );
  if (!result.rows[0]) {
    return notFoundError(
      `${operationLabel(input.operation)} request was not found.`
    );
  }
  return {
    ok: true,
    data: {
      setup_request_id: result.rows[0].setup_request_id,
      denied: true
    }
  };
}

export async function getCredentialOperationTerminalSetupState(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    setupRequestId: string;
    accountId: string;
    statuses: NonEmptyTerminalStatusList;
  }
): Promise<OperationResult<CredentialOperationTerminalSetupData>> {
  const result = await query<TerminalSetupStateRow>(
    terminalSetupStateStatement(input)
  );
  const row = result.rows[0];
  if (!row) {
    return notFoundError(
      `${operationLabel(input.operation)} request was not found.`
    );
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

async function handleOperationBrowserStartRequest(
  operation: CredentialOperation,
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions
): Promise<
  OperationResult<{
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
      `Trusted client IP is unavailable for caller ${operation} start.`
    );
  }

  const expiresAt = operationExpiresAt(options.now ?? new Date());

  return withControlPlaneTransaction(
    context,
    `caller_${operation}_browser_start`,
    async (query) => {
      const limit =
        operation === "rotate"
          ? await enforceIpRotateStartLimit(query, ipAddress)
          : await enforceIpRevokeStartLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      let result: { rows: SetupRequestIdRow[] };
      try {
        result = await query<SetupRequestIdRow>(
          createBrowserSetupRequestStatement(operation, {
            ...parsed.data,
            expiresAt
          })
        );
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return invalidRequestError(
            `Caller ${operation} target was not found.`
          );
        }
        throw error;
      }
      const setup = result.rows[0];

      const approvalUrl = new URL(`/caller/${operation}/approve`, baseUrl.data);
      approvalUrl.searchParams.set("setup_request_id", setup.setup_request_id);

      return {
        ok: true,
        data: {
          approval_url: approvalUrl.toString(),
          setup_request_id: setup.setup_request_id,
          expires_at: expiresAt.toISOString()
        }
      };
    },
    options
  );
}

async function handleOperationDeviceStartRequest(
  operation: CredentialOperation,
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions
): Promise<
  OperationResult<{
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
      `Trusted client IP is unavailable for caller ${operation} start.`
    );
  }

  const deviceCode = `dev_${randomBytes(DEVICE_TOKEN_BYTES).toString(
    "base64url"
  )}`;
  const userCode = generateUserCode();
  const expiresAt = operationExpiresAt(options.now ?? new Date());

  return withControlPlaneTransaction(
    context,
    `caller_${operation}_device_start`,
    async (query) => {
      const limit =
        operation === "rotate"
          ? await enforceIpRotateStartLimit(query, ipAddress)
          : await enforceIpRevokeStartLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      try {
        await query<SetupRequestIdRow>(
          createDeviceSetupRequestStatement(operation, {
            ...parsed.data,
            deviceCodeHash: setupCodeDigest(deviceCode),
            userCodeHash: setupCodeDigest(normalizeUserCode(userCode)),
            expiresAt
          })
        );
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return invalidRequestError(
            `Caller ${operation} target was not found.`
          );
        }
        throw error;
      }
      const verificationUri = new URL(
        `/caller/${operation}/device`,
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

async function handleOperationDevicePollRequest(
  operation: CredentialOperation,
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: RequestOptions
): Promise<OperationResult<DeviceSetupCodeData>> {
  const parsed = parseDevicePollBody(body);
  if (!parsed.ok) {
    return parsed;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return temporaryUnavailableError(
      `Trusted client IP is unavailable for caller ${operation} poll.`
    );
  }
  const deviceCodeHash = setupCodeDigest(parsed.data.deviceCode);

  return withControlPlaneTransaction(
    context,
    `caller_${operation}_device_poll`,
    async (query) => {
      const limit =
        operation === "rotate"
          ? await enforceIpRotateDevicePollLimit(query, ipAddress)
          : await enforceIpRevokeDevicePollLimit(query, ipAddress);
      if (!limit.ok) {
        return limit;
      }

      const lookup = await query<DevicePollTargetRow>(
        devicePollTargetStatement(operation, deviceCodeHash)
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
            message: `Caller ${operation} approval is pending.`,
            retryAfterSeconds: row.poll_interval_seconds
          }
        };
      }

      if (row.status !== "approved" || row.setup_code_hash) {
        return invalidRequestError("Device code is invalid or already used.");
      }

      const setupCode = `setup_${randomBytes(SETUP_TOKEN_BYTES).toString(
        "base64url"
      )}`;
      await query(
        storeSetupCodeStatement({
          setupRequestId: row.setup_request_id,
          setupCodeHash: setupCodeDigest(setupCode)
        })
      );

      return {
        ok: true,
        data: {
          setup_request_id: row.setup_request_id,
          setup_code: setupCode,
          expires_at: new Date(row.expires_at).toISOString()
        }
      };
    },
    options
  );
}

async function exchangeRotateSetupRequest(
  query: ProductTransactionQuery,
  setupCodeHash: string,
  options: { requestId: string; now?: Date }
): Promise<OperationResult<RotateExchangeResponseData>> {
  const now = options.now ?? new Date();
  const targetResult = await query<RotateExchangeTargetRow>(
    rotateExchangeTargetStatement(setupCodeHash)
  );
  const target = targetResult.rows[0];
  if (!target) {
    return invalidRequestError("Caller rotate code is invalid or expired.");
  }

  if (setupRequestExpired(target, now)) {
    await query(markSetupRequestExpiredStatement(target.setup_request_id));
    return invalidRequestError("Caller rotate code is invalid or expired.");
  }

  if (target.status !== "approved") {
    return invalidRequestError(
      "Caller rotate code is invalid or already used."
    );
  }

  if (
    !target.account_id ||
    !target.caller_id ||
    !target.caller_display_name ||
    !target.account_tier ||
    !target.active_credential_id ||
    !target.active_key_id ||
    !target.active_key_last_four
  ) {
    return invalidRequestError("Caller rotate target has no active key.");
  }

  await query(
    callerCredentialLifecycleLockStatement({
      accountId: target.account_id,
      callerId: target.caller_id
    })
  );

  const lockedTargetResult = await query<RotateExchangeTargetRow>(
    rotateExchangeTargetStatement(setupCodeHash)
  );
  const lockedTarget = lockedTargetResult.rows[0];
  if (
    !lockedTarget ||
    setupRequestExpired(lockedTarget, now) ||
    lockedTarget.status !== "approved"
  ) {
    return invalidRequestError(
      "Caller rotate code is invalid or already used."
    );
  }
  if (
    !lockedTarget.account_id ||
    !lockedTarget.caller_id ||
    !lockedTarget.caller_display_name ||
    !lockedTarget.account_tier ||
    !lockedTarget.active_credential_id ||
    !lockedTarget.active_key_id ||
    !lockedTarget.active_key_last_four
  ) {
    return invalidRequestError("Caller rotate target has no active key.");
  }

  const material = generateCallerApiKeyMaterial();
  await query(
    expireExpiredPendingReplacementCredentialsForCallerStatement({
      accountId: lockedTarget.account_id,
      callerId: lockedTarget.caller_id,
      now
    })
  );

  let credential: InsertPendingReplacementCredentialRow;
  try {
    const credentialResult = await query<InsertPendingReplacementCredentialRow>(
      insertPendingReplacementCredentialStatement({
        accountId: lockedTarget.account_id,
        callerId: lockedTarget.caller_id,
        oldCredentialId: lockedTarget.active_credential_id,
        setupRequestId: lockedTarget.setup_request_id,
        expiresAt: new Date(lockedTarget.expires_at),
        material
      })
    );
    credential = credentialResult.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      return invalidRequestError(
        "Caller already has a pending replacement key."
      );
    }
    throw error;
  }

  await query(
    markSetupRequestExchangedStatement(lockedTarget.setup_request_id)
  );

  return {
    ok: true,
    data: {
      caller: {
        caller_id: lockedTarget.caller_id,
        caller_slug: lockedTarget.caller_slug,
        display_name: lockedTarget.caller_display_name
      },
      account: {
        account_id: lockedTarget.account_id,
        label: lockedTarget.account_label,
        effective_tier:
          lockedTarget.account_tier === "hosted_free" ? "free" : "paid"
      },
      replacement_credential: {
        api_key: material.plaintextApiKey,
        key_id: credential.key_id,
        prefix: credential.key_prefix,
        last_chars: credential.key_last_four,
        created_at: new Date(credential.created_at).toISOString(),
        expires_at: new Date(lockedTarget.expires_at).toISOString()
      },
      replaces_credential: {
        key_id: lockedTarget.active_key_id,
        last_chars: lockedTarget.active_key_last_four
      }
    }
  };
}

async function activatePendingReplacementCredential(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    pendingCredential: PendingCredentialBearer;
  },
  options: { requestId: string; now?: Date }
): Promise<OperationResult<RotateActivateResponseData>> {
  await lockPendingReplacementCredentialLifecycle(query, input);

  const credentialResult = await query<PendingReplacementCredentialRow>(
    pendingReplacementCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingReplacementCredential(
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
    revokeOldCredentialStatement(
      credential.pending_replacement_for_credential_id
    )
  );
  await query(
    activatePendingCredentialStatement(credential.caller_credential_id)
  );
  await query(
    insertCallerCredentialAuditStatement({
      accountId: credential.account_id,
      callerId: credential.caller_id,
      requestId: options.requestId,
      eventType: "caller_key_rotated"
    })
  );

  return {
    ok: true,
    data: {
      caller_id: credential.caller_id,
      activated_key_id: credential.key_id,
      revoked_key_id: credential.old_key_id,
      activated_at: activatedAt
    }
  };
}

async function abortPendingReplacementCredential(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    pendingCredential: PendingCredentialBearer;
  },
  options: { requestId: string; now?: Date }
): Promise<OperationResult<RotateAbortResponseData>> {
  await lockPendingReplacementCredentialLifecycle(query, input);

  const credentialResult = await query<PendingReplacementCredentialRow>(
    pendingReplacementCredentialStatement(input)
  );
  const credential = credentialResult.rows[0];
  const verified = await verifyPendingReplacementCredential(
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
    expirePendingCredentialStatement(credential.caller_credential_id)
  );

  return {
    ok: true,
    data: {
      caller_id: credential.caller_id,
      aborted_key_id: credential.key_id,
      active_key_id: credential.old_key_id,
      aborted_at: abortedAt
    }
  };
}

async function lockPendingReplacementCredentialLifecycle(
  query: ProductTransactionQuery,
  input: {
    setupRequestId: string;
    pendingCredential: PendingCredentialBearer;
  }
) {
  const scopeResult = await query<PendingReplacementCredentialScopeRow>(
    pendingReplacementCredentialScopeStatement(input)
  );
  const scope = scopeResult.rows[0];
  if (scope) {
    await query(
      callerCredentialLifecycleLockStatement({
        accountId: scope.account_id,
        callerId: scope.caller_id
      })
    );
  }
}

async function confirmRevokeSetupRequest(
  query: ProductTransactionQuery,
  setupCodeHash: string,
  options: { requestId: string; now?: Date }
): Promise<OperationResult<RevokeConfirmResponseData>> {
  const targetResult = await query<RevokeConfirmTargetRow>(
    revokeConfirmTargetStatement(setupCodeHash)
  );
  const target = targetResult.rows[0];
  if (!target) {
    return invalidRequestError("Caller revoke code is invalid or expired.");
  }

  if (setupRequestExpired(target, options.now ?? new Date())) {
    await query(markSetupRequestExpiredStatement(target.setup_request_id));
    return invalidRequestError("Caller revoke code is invalid or expired.");
  }

  if (target.status !== "approved") {
    return invalidRequestError(
      "Caller revoke code is invalid or already used."
    );
  }

  if (!target.account_id || !target.caller_id) {
    return temporaryUnavailableError(
      "Caller revoke confirmation is temporarily unavailable."
    );
  }

  const revokedAt = (options.now ?? new Date()).toISOString();
  await query(
    callerCredentialLifecycleLockStatement({
      accountId: target.account_id,
      callerId: target.caller_id
    })
  );
  const revoked = await query<KeyIdRow>(
    revokeActiveCredentialsStatement({
      accountId: target.account_id,
      callerId: target.caller_id
    })
  );
  await query(
    expirePendingReplacementCredentialsForCallerStatement({
      accountId: target.account_id,
      callerId: target.caller_id
    })
  );
  await query(markSetupRequestExchangedStatement(target.setup_request_id));
  await query(
    insertCallerCredentialAuditStatement({
      accountId: target.account_id,
      callerId: target.caller_id,
      requestId: options.requestId,
      eventType: "caller_key_revoked"
    })
  );

  return {
    ok: true,
    data: {
      caller_id: target.caller_id,
      revoked_key_ids: revoked.rows.map((row) => row.key_id),
      revoked_at: revokedAt
    }
  };
}

async function withControlPlaneTransaction<TData>(
  context: ApiRequestContext,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<OperationResult<TData>>,
  options: RequestOptions = {}
): Promise<OperationResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return temporaryUnavailableError(
      "Caller credential operation database configuration is unavailable."
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
    reportRuntimeFailure(error, {
      errorId: context.correlationId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 503,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation,
      message: "Caller credential operation failed unexpectedly.",
      request_id: context.requestId
    });
    return temporaryUnavailableError(
      "Caller credential operation is temporarily unavailable.",
      { errorId: context.correlationId, reported: true }
    );
  }
}

async function withScopedProductTransaction<TData>(
  connectionString: string,
  context: ApiRequestContext,
  scopedContext: Omit<ProductTransactionContext, "requestId">,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<OperationResult<TData>>,
  options: RequestOptions = {}
): Promise<OperationResult<TData>> {
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
    reportRuntimeFailure(error, {
      errorId: context.correlationId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 503,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation,
      message: "Caller credential operation failed unexpectedly.",
      request_id: context.requestId,
      account_id: scopedContext.accountId,
      caller_id: scopedContext.callerId
    });
    return temporaryUnavailableError(
      "Caller credential operation is temporarily unavailable.",
      { errorId: context.correlationId, reported: true }
    );
  }
}

async function setupExchangeContext(
  query: ProductTransactionQuery,
  input: {
    operation: CredentialOperation;
    setupCodeHash: string;
    now?: Date;
    invalidMessage: string;
  }
): Promise<OperationResult<{ accountId: string; userId: string }>> {
  const lookup = await query<SetupExchangeContextRow>(
    setupExchangeContextStatement(input.operation, input.setupCodeHash)
  );
  const row = lookup.rows[0];
  if (!row) {
    return invalidRequestError(input.invalidMessage);
  }

  if (setupRequestExpired(row, input.now ?? new Date())) {
    await query(markSetupRequestExpiredStatement(row.setup_request_id));
    return invalidRequestError(input.invalidMessage);
  }

  if (row.status !== "approved") {
    return invalidRequestError(input.invalidMessage);
  }

  if (!row.account_id || !row.approved_by_user_id) {
    return temporaryUnavailableError(
      `Caller ${input.operation} approval is temporarily unavailable.`
    );
  }

  return {
    ok: true,
    data: {
      accountId: row.account_id,
      userId: row.approved_by_user_id
    }
  };
}

async function enforceApprovalLimit(
  query: ProductTransactionQuery,
  accountId: string,
  operation: CredentialOperation
): Promise<OperationResult<null>> {
  const profile = await accountLimitProfileForAccount(query, accountId);
  if (!profile) {
    return temporaryUnavailableError(
      "Caller credential approval is temporarily unavailable."
    );
  }

  const limit = await enforceAccountRequestLimits(
    query,
    { accountId },
    profile,
    operation === "rotate" ? "caller_rotate_approval" : "caller_revoke_approval"
  );
  if (!limit.ok) {
    return limit;
  }

  return { ok: true, data: null };
}

async function approvalPreviewFromTarget(
  query: ProductTransactionQuery,
  target: ApprovalTargetRow | null,
  now: Date = new Date()
): Promise<OperationResult<CredentialOperationApprovalPreviewData>> {
  if (!target) {
    return notFoundError("Caller credential operation request was not found.");
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
      local_caller_name: target.local_caller_name,
      display_name: target.caller_display_name,
      callback_url: target.callback_url,
      expires_at: new Date(target.expires_at).toISOString(),
      caller: approvalCaller(target),
      current_credential:
        target.active_key_id && target.active_key_last_four
          ? {
              key_id: target.active_key_id,
              last_chars: target.active_key_last_four
            }
          : null
    }
  };
}

async function ensurePendingApprovalTarget(
  query: ProductTransactionQuery,
  target: ApprovalTargetRow,
  now: Date = new Date()
): Promise<OperationResult<null>> {
  if (setupRequestExpired(target, now)) {
    await query(markSetupRequestExpiredStatement(target.setup_request_id));
    return invalidRequestError(
      `Caller ${target.operation} setup request is expired.`
    );
  }

  if (target.status !== "pending") {
    return invalidRequestError(
      `Caller ${target.operation} setup request is not pending approval.`
    );
  }

  if (target.operation === "rotate" && !target.active_credential_id) {
    return invalidRequestError("Caller rotate target has no active key.");
  }

  return { ok: true, data: null };
}

function createBrowserSetupRequestStatement(
  operation: CredentialOperation,
  input: BrowserStartBody & { expiresAt: Date }
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_caller_setup_requests (
        operation,
        flow,
        local_caller_name,
        display_name,
        callback_url,
        caller_id,
        expires_at,
        poll_interval_seconds
      )
      values ($1, 'browser', $3, $3, $4, $2, $5::timestamptz, $6)
      returning
        setup_request_id::text as setup_request_id
    `,
    values: [
      operation,
      input.callerId,
      input.localCallerName,
      input.callbackUrl,
      input.expiresAt.toISOString(),
      DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
}

function createDeviceSetupRequestStatement(
  operation: CredentialOperation,
  input: DeviceStartBody & {
    deviceCodeHash: string;
    userCodeHash: string;
    expiresAt: Date;
  }
): TransactionContextStatement {
  return {
    sql: `
      insert into public.agent_outbox_caller_setup_requests (
        operation,
        flow,
        local_caller_name,
        display_name,
        device_code_hash,
        user_code_hash,
        caller_id,
        expires_at,
        poll_interval_seconds
      )
      values ($1, 'device', $3, $3, $4, $5, $2, $6::timestamptz, $7)
      returning
        setup_request_id::text as setup_request_id
    `,
    values: [
      operation,
      input.callerId,
      input.localCallerName,
      input.deviceCodeHash,
      input.userCodeHash,
      input.expiresAt.toISOString(),
      DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
}

function approvalTargetBySetupRequestIdStatement(input: {
  operation: CredentialOperation;
  setupRequestId: string;
  accountId: string;
}): TransactionContextStatement {
  return {
    sql: `
      select
        setup.setup_request_id::text as setup_request_id,
        setup.operation,
        setup.status,
        setup.local_caller_name,
        setup.callback_url,
        setup.expires_at,
        caller.caller_id::text as caller_id,
        caller.caller_slug,
        caller.display_name as caller_display_name,
        credential.caller_credential_id::text as active_credential_id,
        credential.key_id as active_key_id,
        credential.key_last_four as active_key_last_four
      from public.agent_outbox_caller_setup_requests setup
      join public.agent_outbox_callers caller
        on caller.caller_id = setup.caller_id
       and caller.account_id = $2
       and caller.revoked_at is null
      left join lateral (
        select
          caller_credential_id,
          key_id,
          key_last_four
        from public.agent_outbox_caller_credentials
        where account_id = caller.account_id
          and caller_id = caller.caller_id
          and status = 'active'
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc
        limit 1
      ) credential on true
      where setup.setup_request_id = $1
        and setup.flow = 'browser'
        and setup.operation = $3
      for update of setup
    `,
    values: [input.setupRequestId, input.accountId, input.operation]
  };
}

function approvalTargetByUserCodeStatement(input: {
  operation: CredentialOperation;
  userCodeHash: string;
  accountId: string;
}): TransactionContextStatement {
  return {
    sql: `
      select
        setup.setup_request_id::text as setup_request_id,
        setup.operation,
        setup.status,
        setup.local_caller_name,
        setup.callback_url,
        setup.expires_at,
        caller.caller_id::text as caller_id,
        caller.caller_slug,
        caller.display_name as caller_display_name,
        credential.caller_credential_id::text as active_credential_id,
        credential.key_id as active_key_id,
        credential.key_last_four as active_key_last_four
      from public.agent_outbox_caller_setup_requests setup
      join public.agent_outbox_callers caller
        on caller.caller_id = setup.caller_id
       and caller.account_id = $2
       and caller.revoked_at is null
      left join lateral (
        select
          caller_credential_id,
          key_id,
          key_last_four
        from public.agent_outbox_caller_credentials
        where account_id = caller.account_id
          and caller_id = caller.caller_id
          and status = 'active'
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc
        limit 1
      ) credential on true
      where setup.user_code_hash = $1
        and setup.flow = 'device'
        and setup.operation = $3
        and setup.status in ('pending', 'approved')
        and setup.expires_at > now()
      order by setup.expires_at desc, setup.created_at desc
      limit 1
      for update of setup
    `,
    values: [input.userCodeHash, input.accountId, input.operation]
  };
}

function devicePollTargetStatement(
  operation: CredentialOperation,
  deviceCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        status,
        setup_code_hash,
        poll_interval_seconds,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where device_code_hash = $1
        and operation = $2
        and flow = 'device'
      for update
    `,
    values: [deviceCodeHash, operation]
  };
}

function callerCredentialLifecycleLockStatement(input: {
  accountId: string;
  callerId: string;
}): TransactionContextStatement {
  return {
    sql: `
      select pg_advisory_xact_lock(
        ('x' || substr(md5($1 || ':' || $2 || ':caller_credential_lifecycle'), 1, 16))::bit(64)::bigint
      ) as acquired
    `,
    values: [input.accountId, input.callerId]
  };
}

function rotateExchangeTargetStatement(
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
        account.tier as account_tier,
        credential.caller_credential_id::text as active_credential_id,
        credential.key_id as active_key_id,
        credential.key_last_four as active_key_last_four
      from public.agent_outbox_caller_setup_requests setup
      left join public.agent_outbox_callers caller
        on caller.account_id = setup.account_id
       and caller.caller_id = setup.caller_id
      left join public.agent_outbox_accounts account
        on account.account_id = setup.account_id
      left join lateral (
        select
          caller_credential_id,
          key_id,
          key_last_four
        from public.agent_outbox_caller_credentials
        where account_id = setup.account_id
          and caller_id = setup.caller_id
          and status = 'active'
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        order by created_at desc
        limit 1
      ) credential on true
      where setup.setup_code_hash = $1
        and setup.operation = 'rotate'
      for update of setup
    `,
    values: [setupCodeHash]
  };
}

function revokeConfirmTargetStatement(
  setupCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        status,
        account_id::text as account_id,
        caller_id::text as caller_id,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where setup_code_hash = $1
        and operation = 'revoke'
      for update
    `,
    values: [setupCodeHash]
  };
}

function setupExchangeContextStatement(
  operation: CredentialOperation,
  setupCodeHash: string
): TransactionContextStatement {
  return {
    sql: `
      select
        setup_request_id::text as setup_request_id,
        status,
        account_id::text as account_id,
        approved_by_user_id::text as approved_by_user_id,
        expires_at
      from public.agent_outbox_caller_setup_requests
      where setup_code_hash = $1
        and operation = $2
      limit 1
    `,
    values: [setupCodeHash, operation]
  };
}

function pendingReplacementCredentialScopeStatement(input: {
  setupRequestId: string;
  pendingCredential: PendingCredentialBearer;
}): TransactionContextStatement {
  return {
    sql: `
      select
        account_id::text as account_id,
        caller_id::text as caller_id
      from public.agent_outbox_caller_credentials
      where key_id = $1
        and pending_replacement_setup_request_id = $2
      limit 1
    `,
    values: [input.pendingCredential.keyId, input.setupRequestId]
  };
}

function pendingReplacementCredentialStatement(input: {
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
        pending.caller_id::text as caller_id,
        pending.pending_replacement_for_credential_id::text as pending_replacement_for_credential_id,
        old.key_id as old_key_id
      from public.agent_outbox_caller_credentials pending
      join public.agent_outbox_caller_credentials old
        on old.caller_credential_id = pending.pending_replacement_for_credential_id
       and old.account_id = pending.account_id
       and old.caller_id = pending.caller_id
       and old.status = 'active'
       and old.revoked_at is null
      where pending.key_id = $1
        and pending.pending_replacement_setup_request_id = $2
      for update of pending, old
    `,
    values: [input.pendingCredential.keyId, input.setupRequestId]
  };
}

function insertPendingReplacementCredentialStatement(input: {
  accountId: string;
  callerId: string;
  oldCredentialId: string;
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
        pending_replacement_for_credential_id,
        pending_replacement_setup_request_id
      )
      values ($1, $2, $3, $4, $5, $6, 'pending_activation', $7::timestamptz, $8, $9)
      returning
        caller_credential_id::text as caller_credential_id,
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
      input.oldCredentialId,
      input.setupRequestId
    ]
  };
}

function approveBrowserSetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
  userId: string;
  setupCodeHash: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        approved_by_user_id = $3,
        setup_code_hash = $4,
        status = 'approved',
        approved_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and status = 'pending'
    `,
    values: [
      input.setupRequestId,
      input.accountId,
      input.userId,
      input.setupCodeHash
    ]
  };
}

function approveDeviceSetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
  userId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        approved_by_user_id = $3,
        status = 'approved',
        approved_at = now(),
        updated_at = now()
      where setup_request_id = $1
        and status = 'pending'
    `,
    values: [input.setupRequestId, input.accountId, input.userId]
  };
}

function storeSetupCodeStatement(input: {
  setupRequestId: string;
  setupCodeHash: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        setup_code_hash = $2,
        updated_at = now()
      where setup_request_id = $1
        and status = 'approved'
        and setup_code_hash is null
    `,
    values: [input.setupRequestId, input.setupCodeHash]
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

function denySetupRequestStatement(input: {
  operation: CredentialOperation;
  setupRequestId: string;
  accountId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests setup
      set
        account_id = $3,
        status = 'denied',
        denied_at = now(),
        updated_at = now()
      where setup.setup_request_id = $1
        and setup.operation = $2
        and setup.status = 'pending'
        and exists (
          select 1
          from public.agent_outbox_callers caller
          where caller.caller_id = setup.caller_id
            and caller.account_id = $3
            and caller.revoked_at is null
        )
      returning setup_request_id::text as setup_request_id
    `,
    values: [input.setupRequestId, input.operation, input.accountId]
  };
}

function activatePendingCredentialStatement(
  callerCredentialId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'active',
        activated_at = now(),
        expires_at = null,
        pending_replacement_for_credential_id = null,
        pending_replacement_setup_request_id = null
      where caller_credential_id = $1
        and status = 'pending_activation'
    `,
    values: [callerCredentialId]
  };
}

function revokeOldCredentialStatement(
  callerCredentialId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'revoked',
        revoked_at = now()
      where caller_credential_id = $1
        and status = 'active'
        and revoked_at is null
    `,
    values: [callerCredentialId]
  };
}

function expirePendingCredentialStatement(
  callerCredentialId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'expired',
        pending_replacement_for_credential_id = null,
        pending_replacement_setup_request_id = null
      where caller_credential_id = $1
        and status = 'pending_activation'
    `,
    values: [callerCredentialId]
  };
}

function revokeActiveCredentialsStatement(input: {
  accountId: string;
  callerId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'revoked',
        revoked_at = now()
      where account_id = $1
        and caller_id = $2
        and status = 'active'
        and revoked_at is null
      returning key_id
    `,
    values: [input.accountId, input.callerId]
  };
}

function expirePendingReplacementCredentialsForCallerStatement(input: {
  accountId: string;
  callerId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'expired',
        pending_replacement_for_credential_id = null,
        pending_replacement_setup_request_id = null
      where account_id = $1
        and caller_id = $2
        and status = 'pending_activation'
    `,
    values: [input.accountId, input.callerId]
  };
}

function expireExpiredPendingReplacementCredentialsForCallerStatement(input: {
  accountId: string;
  callerId: string;
  now: Date;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set
        status = 'expired',
        pending_replacement_for_credential_id = null,
        pending_replacement_setup_request_id = null
      where account_id = $1
        and caller_id = $2
        and status = 'pending_activation'
        and pending_replacement_for_credential_id is not null
        and expires_at is not null
        and expires_at <= $3::timestamptz
    `,
    values: [input.accountId, input.callerId, input.now.toISOString()]
  };
}

function terminalSetupStateStatement(input: {
  operation: CredentialOperation;
  setupRequestId: string;
  accountId: string;
  statuses: NonEmptyTerminalStatusList;
}): TransactionContextStatement {
  const statusPlaceholders = input.statuses
    .map((_, index) => `$${index + 4}`)
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
        and setup.operation = $3
        and setup.status in (${statusPlaceholders})
      limit 1
    `,
    values: [
      input.setupRequestId,
      input.accountId,
      input.operation,
      ...input.statuses
    ]
  };
}

function insertCallerCredentialAuditStatement(input: {
  accountId: string;
  callerId: string;
  requestId: string;
  eventType: "caller_key_rotated" | "caller_key_revoked";
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
        $3,
        account.account_audit_id,
        caller.caller_audit_id,
        $4
      from public.agent_outbox_accounts account
      join public.agent_outbox_callers caller
        on caller.account_id = account.account_id
       and caller.caller_id = $2
      where account.account_id = $1
    `,
    values: [input.accountId, input.callerId, input.eventType, input.requestId]
  };
}

type PendingCredentialBearer = {
  apiKey: string;
  keyId: string;
  secret: string;
} & CallerApiKeyDisplayMetadata;

function pendingCredentialFromRequest(
  request: Request
): OperationResult<PendingCredentialBearer> {
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
        message: "Pending replacement bearer credential is required."
      }
    };
  }
  return { ok: true, data: parsed };
}

async function lookupPendingReplacementCredential(
  query: ProductTransactionQuery,
  bearer: PendingCredentialBearer
): Promise<OperationResult<{ accountId: string; callerId: string }>> {
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

async function verifyPendingReplacementCredential(
  query: ProductTransactionQuery,
  credential: PendingReplacementCredentialRow | null,
  bearer: PendingCredentialBearer,
  now: Date
): Promise<OperationResult<null>> {
  if (!credential) {
    return invalidCallerCredentialsError();
  }

  const expired =
    !credential.expires_at ||
    new Date(credential.expires_at).getTime() <= now.getTime();
  if (
    credential.status !== "pending_activation" ||
    credential.revoked_at ||
    expired
  ) {
    if (
      credential.status === "pending_activation" &&
      credential.expires_at &&
      expired
    ) {
      await query(
        expirePendingCredentialStatement(credential.caller_credential_id)
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

function parseBrowserStartBody(
  body: unknown
): OperationResult<BrowserStartBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const callerId = requiredUuidText(body, "caller_id", fields);
  const localCallerName = requiredText(
    body,
    "local_caller_name",
    fields,
    MAX_TEXT_LENGTH
  );
  const callbackUrl = requiredCallbackUrl(body, "callback_url", fields);

  if (fields.length > 0) {
    return validationError(fields);
  }

  return { ok: true, data: { callerId, localCallerName, callbackUrl } };
}

function parseDeviceStartBody(body: unknown): OperationResult<DeviceStartBody> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return validationError([
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const callerId = requiredUuidText(body, "caller_id", fields);
  const localCallerName = requiredText(
    body,
    "local_caller_name",
    fields,
    MAX_TEXT_LENGTH
  );

  if (fields.length > 0) {
    return validationError(fields);
  }

  return { ok: true, data: { callerId, localCallerName } };
}

function parseDevicePollBody(body: unknown): OperationResult<DevicePollBody> {
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

function parseSetupCodeBody(body: unknown): OperationResult<SetupCodeBody> {
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
): OperationResult<SetupRequestIdBody> {
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

function requiredText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  maxLength: number
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

function requiredUuidText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[]
) {
  const value = requiredText(record, key, fields, MAX_TEXT_LENGTH);
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

function setupCodeDigest(value: string) {
  return createHmac(TOKEN_HASH_ALGORITHM, requireCallerKeyHashSecret())
    .update(value)
    .digest("hex");
}

function operationExpiresAt(now: Date) {
  return new Date(now.getTime() + CONTROL_PLANE_CODE_EXPIRES_IN_SECONDS * 1000);
}

function setupRequestExpired(row: { expires_at: string | Date }, now: Date) {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

function publicAppBaseUrl(): OperationResult<string> {
  const value = process.env.PUBLIC_APP_BASE_URL;
  if (!value) {
    return temporaryUnavailableError(
      "Public app base URL configuration is unavailable."
    );
  }

  const origin = absoluteHttpOrigin(value);
  if (!origin) {
    return temporaryUnavailableError(
      "Public app base URL configuration is invalid."
    );
  }
  return { ok: true, data: origin };
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

function approvalCaller(target: ApprovalTargetRow) {
  return {
    caller_id: target.caller_id,
    caller_slug: target.caller_slug,
    display_name: target.caller_display_name
  };
}

function operationLabel(operation: CredentialOperation) {
  return `Caller ${operation}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validationError(fields: ApiFieldError[]): OperationResult<never> {
  return {
    ok: false,
    error: {
      status: 422,
      code: "validation_failed",
      message: "Caller credential operation request failed validation.",
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

function invalidRequestError(message: string): OperationResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

function notFoundError(message: string): OperationResult<never> {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message
    }
  };
}

function invalidCallerCredentialsError(): OperationResult<never> {
  return {
    ok: false,
    error: {
      status: 401,
      code: "invalid_caller_credentials",
      message: "Pending replacement credential is invalid or no longer usable."
    }
  };
}

function temporaryUnavailableError(
  message: string,
  options?: { errorId?: string; reported?: boolean }
): OperationResult<never> {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message,
      ...(options?.errorId ? { errorId: options.errorId } : {}),
      ...(options?.reported ? { reported: true } : {})
    }
  };
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23505";
}

function isForeignKeyViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23503";
}
