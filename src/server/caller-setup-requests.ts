/** Setup-request helpers and pending-credential transaction pipeline shared by caller connect and rotate/revoke flows. */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

import {
  apiTemporaryUnavailable,
  apiValidationFailed,
  type ApiErrorInput,
  type ApiFieldError,
  type ApiRequestContext
} from "./api-errors.ts";
import { enforceIpControlPlaneLimit } from "./caller-api-limits.ts";
import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  parseCallerBearerApiKey,
  type CallerApiKeyDisplayMetadata,
  type CallerCredentialLookupRow
} from "./caller-auth.ts";
import {
  runProductTransaction,
  type ProductTransactionContext,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { absoluteHttpOrigin, requireCallerKeyHashSecret } from "./env.ts";
import { isStorableString, unstorableStringError } from "./input-schema.ts";
import { durationSinceMs } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";
import { trustedClientIpAddress } from "./trusted-client-ip.ts";

const SETUP_CODE_EXPIRES_IN_SECONDS =
  SYSTEM_CONTRACT.controlPlaneSetupCodeExpirySeconds;
export const DEVICE_POLL_INTERVAL_SECONDS =
  SYSTEM_CONTRACT.defaultDevicePollIntervalSeconds;
const TOKEN_HASH_ALGORITHM = "sha256";
export const SETUP_TOKEN_BYTES = 32;
export const DEVICE_TOKEN_BYTES = 32;
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_SETUP_TEXT_LENGTH = 128;
const MAX_CALLBACK_URL_LENGTH = 2048;
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type SetupResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

export type SetupRequestStatus =
  "pending" | "approved" | "exchanged" | "expired" | "denied";

export function requiredText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  maxLength = MAX_SETUP_TEXT_LENGTH
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
  if (!isStorableString(trimmed)) {
    fields.push(unstorableStringError(key));
    return "";
  }

  return trimmed;
}

export function requiredUuidText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[]
) {
  const value = requiredText(record, key, fields);
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

export function requiredCallbackUrl(
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

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function fieldError(
  path: string,
  code: string,
  message: string
): ApiFieldError {
  return { path, code, message };
}

// Browser pages and form actions pass setup_request_id unvalidated; a
// malformed id can never match a row and would otherwise fail the uuid cast.
export function invalidSetupRequestError(): SetupResult<never> {
  return invalidRequestError("Invalid setup request.");
}

export function invalidRequestError(message: string): SetupResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

export function notFoundError(message: string): SetupResult<never> {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message
    }
  };
}

export function publicAppBaseUrl(): SetupResult<string> {
  const value = process.env.PUBLIC_APP_BASE_URL;
  if (!value) {
    return apiTemporaryUnavailable(
      "Public app base URL configuration is unavailable."
    );
  }

  const origin = absoluteHttpOrigin(value);
  if (!origin) {
    return apiTemporaryUnavailable(
      "Public app base URL configuration is invalid."
    );
  }
  return { ok: true, data: origin };
}

export function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23505";
}

export function setupRequestExpired(
  row: { expires_at: string | Date },
  now: Date
) {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

export function generateUserCode() {
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

export function normalizeUserCode(userCode: string) {
  return userCode.replace(/[\s-]+/g, "").toUpperCase();
}

export function markSetupRequestExpiredStatement(
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

export function markSetupRequestExchangedStatement(
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

export function setupCodeDigest(value: string) {
  return createHmac(TOKEN_HASH_ALGORITHM, requireCallerKeyHashSecret())
    .update(value)
    .digest("hex");
}

export function setupRequestExpiresAt(now: Date) {
  return new Date(now.getTime() + SETUP_CODE_EXPIRES_IN_SECONDS * 1000);
}

export function callerCredentialLifecycleLockStatement(input: {
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

export type CallerFlowMessages = {
  bearerRequired: string;
  invalidCredential: string;
  validationFailed: string;
  databaseUnavailable: string;
  unexpectedFailure: string;
  temporarilyUnavailable: string;
};

export type CallerFlowRequestOptions = {
  now?: Date;
  runProductTransaction?: typeof runProductTransaction;
};

export type PendingCredentialBearer = {
  apiKey: string;
  keyId: string;
  secret: string;
} & CallerApiKeyDisplayMetadata;

export function parseDevicePollBody(
  messages: CallerFlowMessages,
  body: unknown
): SetupResult<{ deviceCode: string }> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return apiValidationFailed(messages.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const deviceCode = requiredText(body, "device_code", fields, 512);

  if (fields.length > 0) {
    return apiValidationFailed(messages.validationFailed, fields);
  }

  return { ok: true, data: { deviceCode } };
}

export function parseSetupCodeBody(
  messages: CallerFlowMessages,
  body: unknown
): SetupResult<{ setupCode: string }> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return apiValidationFailed(messages.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const setupCode = requiredText(body, "setup_code", fields, 512);

  if (fields.length > 0) {
    return apiValidationFailed(messages.validationFailed, fields);
  }

  return { ok: true, data: { setupCode } };
}

function parseSetupRequestIdBody(
  messages: CallerFlowMessages,
  body: unknown
): SetupResult<{ setupRequestId: string }> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return apiValidationFailed(messages.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const setupRequestId = requiredUuidText(body, "setup_request_id", fields);
  if (fields.length > 0) {
    return apiValidationFailed(messages.validationFailed, fields);
  }
  return { ok: true, data: { setupRequestId } };
}

export async function withControlPlaneTransaction<TData>(
  messages: CallerFlowMessages,
  context: ApiRequestContext,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<SetupResult<TData>>,
  options: CallerFlowRequestOptions = {}
): Promise<SetupResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(messages.databaseUnavailable);
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
      message: messages.unexpectedFailure,
      request_id: context.requestId
    });
    return apiTemporaryUnavailable(messages.temporarilyUnavailable, {
      errorId: context.correlationId,
      reported: true
    });
  }
}

export async function withScopedProductTransaction<TData>(
  messages: CallerFlowMessages,
  connectionString: string,
  context: ApiRequestContext,
  scopedContext: Omit<ProductTransactionContext, "requestId">,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<SetupResult<TData>>,
  options: CallerFlowRequestOptions = {}
): Promise<SetupResult<TData>> {
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
      message: messages.unexpectedFailure,
      request_id: context.requestId,
      account_id: scopedContext.accountId,
      caller_id: scopedContext.callerId
    });
    return apiTemporaryUnavailable(messages.temporarilyUnavailable, {
      errorId: context.correlationId,
      reported: true
    });
  }
}

function pendingCredentialBearerFromRequest(
  messages: CallerFlowMessages,
  request: Request
): SetupResult<PendingCredentialBearer> {
  const parsed = parseCallerBearerApiKey(request.headers.get("authorization"));
  if (!parsed.ok) {
    if (parsed.code !== "missing_authorization") {
      return invalidPendingCredentialError(messages);
    }
    return {
      ok: false,
      error: {
        status: 401,
        code: "authentication_required",
        message: messages.bearerRequired
      }
    };
  }
  return { ok: true, data: parsed };
}

function pendingSecretMatches(secret: string, storedDigest: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(storedDigest)) {
    return false;
  }

  const suppliedDigest = callerApiKeySecretDigest(secret);
  const supplied = Buffer.from(suppliedDigest, "hex");
  const stored = Buffer.from(storedDigest, "hex");
  return timingSafeEqual(supplied, stored);
}

async function lookupPendingCredential(
  query: ProductTransactionQuery,
  messages: CallerFlowMessages,
  bearer: PendingCredentialBearer
): Promise<SetupResult<{ accountId: string; callerId: string }>> {
  const result = await query<CallerCredentialLookupRow>(
    callerCredentialLookupStatement(bearer.keyId)
  );
  const row = result.rows[0];
  if (!row || row.status !== "pending_activation" || row.revoked_at) {
    return invalidPendingCredentialError(messages);
  }

  if (!pendingSecretMatches(bearer.secret, row.secret_hmac_sha256)) {
    return invalidPendingCredentialError(messages);
  }

  return {
    ok: true,
    data: {
      accountId: row.account_id,
      callerId: row.caller_id
    }
  };
}

export async function verifyPendingCredential(
  query: ProductTransactionQuery,
  messages: CallerFlowMessages,
  credential:
    | {
        caller_credential_id: string;
        secret_hmac_sha256: string;
        status: string;
        expires_at: string | Date | null;
        revoked_at: string | Date | null;
      }
    | null
    | undefined,
  bearer: PendingCredentialBearer,
  now: Date,
  expireStatement: (callerCredentialId: string) => TransactionContextStatement
): Promise<SetupResult<null>> {
  if (!credential) {
    return invalidPendingCredentialError(messages);
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
      await query(expireStatement(credential.caller_credential_id));
    }
    return invalidPendingCredentialError(messages);
  }

  if (!pendingSecretMatches(bearer.secret, credential.secret_hmac_sha256)) {
    return invalidPendingCredentialError(messages);
  }

  return { ok: true, data: null };
}

function invalidPendingCredentialError(
  messages: CallerFlowMessages
): SetupResult<never> {
  return {
    ok: false,
    error: {
      status: 401,
      code: "invalid_caller_credentials",
      message: messages.invalidCredential
    }
  };
}

export async function handlePendingCredentialFinalizeRequest<TData>(input: {
  request: Request;
  context: ApiRequestContext;
  body: unknown;
  options: CallerFlowRequestOptions;
  messages: CallerFlowMessages;
  ipUnavailableMessage: string;
  limitKind: Parameters<typeof enforceIpControlPlaneLimit>[2];
  lookupOperation: string;
  finalizeOperation: string;
  finalize: (
    query: ProductTransactionQuery,
    input: {
      accountId: string;
      callerId: string;
      setupRequestId: string;
      pendingCredential: PendingCredentialBearer;
    }
  ) => Promise<SetupResult<TData>>;
}): Promise<SetupResult<TData>> {
  const { request, context, body, options, messages } = input;
  const parsed = parseSetupRequestIdBody(messages, body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingCredentialBearerFromRequest(
    messages,
    request
  );
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return apiTemporaryUnavailable(input.ipUnavailableMessage);
  }

  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(messages.databaseUnavailable);
  }

  const lookupResult = await withControlPlaneTransaction(
    messages,
    context,
    input.lookupOperation,
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        input.limitKind
      );
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingCredential(query, messages, pendingCredential.data);
    },
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withScopedProductTransaction(
    messages,
    connectionString,
    context,
    {
      authSurface: "caller",
      accountId: lookupResult.data.accountId,
      callerId: lookupResult.data.callerId
    },
    input.finalizeOperation,
    (query) =>
      input.finalize(query, {
        ...lookupResult.data,
        setupRequestId: parsed.data.setupRequestId,
        pendingCredential: pendingCredential.data
      }),
    options
  );
}
