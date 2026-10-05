import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

import {
  apiTemporaryUnavailable,
  apiValidationFailed,
  type ApiErrorInput,
  type ApiFieldError,
  type ApiRequestContext
} from "./api-errors.ts";
import {
  enforceIpControlPlaneLimit,
  type ControlPlaneIpLimitKind
} from "./caller-api-limits.ts";
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

export type ControlPlaneResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

export type ControlPlaneRequestOptions = {
  now?: Date;
  runProductTransaction?: typeof runProductTransaction;
};

export type ControlPlaneSurface = {
  validationFailedMessage: string;
  databaseUnavailableMessage: string;
  unexpectedFailureMessage: string;
  temporarilyUnavailableMessage: string;
  bearerRequiredMessage: string;
  invalidCredentialMessage: string;
};

export type PendingCredentialBearer = {
  apiKey: string;
  keyId: string;
  secret: string;
} & CallerApiKeyDisplayMetadata;

type PendingCredentialRow = {
  caller_credential_id: string;
  status: string;
  revoked_at: string | Date | null;
  expires_at: string | Date | null;
  secret_hmac_sha256: string;
};

export const CONTROL_PLANE_CODE_EXPIRES_IN_SECONDS =
  SYSTEM_CONTRACT.controlPlaneSetupCodeExpirySeconds;
export const DEVICE_POLL_INTERVAL_SECONDS =
  SYSTEM_CONTRACT.defaultDevicePollIntervalSeconds;
const TOKEN_HASH_ALGORITHM = "sha256";
export const SETUP_TOKEN_BYTES = 32;
export const DEVICE_TOKEN_BYTES = 32;
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TEXT_LENGTH = 128;
const MAX_CALLBACK_URL_LENGTH = 2048;
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parseObjectBody<TData>(
  surface: ControlPlaneSurface,
  body: unknown,
  read: (record: Record<string, unknown>, fields: ApiFieldError[]) => TData
): ControlPlaneResult<TData> {
  if (!isPlainRecord(body)) {
    return validationError(surface, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const fields: ApiFieldError[] = [];
  const data = read(body, fields);
  if (fields.length > 0) {
    return validationError(surface, fields);
  }

  return { ok: true, data };
}

export function parseDevicePollBody(
  surface: ControlPlaneSurface,
  body: unknown
): ControlPlaneResult<{ deviceCode: string }> {
  return parseObjectBody(surface, body, (record, fields) => ({
    deviceCode: requiredText(record, "device_code", fields, 512)
  }));
}

export function parseSetupCodeBody(
  surface: ControlPlaneSurface,
  body: unknown
): ControlPlaneResult<{ setupCode: string }> {
  return parseObjectBody(surface, body, (record, fields) => ({
    setupCode: requiredText(record, "setup_code", fields, 512)
  }));
}

function parseSetupRequestIdBody(
  surface: ControlPlaneSurface,
  body: unknown
): ControlPlaneResult<{ setupRequestId: string }> {
  return parseObjectBody(surface, body, (record, fields) => ({
    setupRequestId: requiredUuidText(record, "setup_request_id", fields)
  }));
}

export function requiredText(
  record: Record<string, unknown>,
  key: string,
  fields: ApiFieldError[],
  maxLength = MAX_TEXT_LENGTH
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

function fieldError(
  path: string,
  code: string,
  message: string
): ApiFieldError {
  return { path, code, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validationError(
  surface: ControlPlaneSurface,
  fields: ApiFieldError[]
): ControlPlaneResult<never> {
  return apiValidationFailed(surface.validationFailedMessage, fields);
}

// Browser pages and form actions pass setup_request_id unvalidated; a
// malformed id can never match a row and would otherwise fail the uuid cast.
export function invalidSetupRequestError(): ControlPlaneResult<never> {
  return invalidRequestError("Invalid setup request.");
}

export function invalidRequestError(
  message: string
): ControlPlaneResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

export function notFoundError(message: string): ControlPlaneResult<never> {
  return {
    ok: false,
    error: {
      status: 404,
      code: "not_found",
      message
    }
  };
}

function invalidCallerCredentialsError(
  surface: ControlPlaneSurface
): ControlPlaneResult<never> {
  return {
    ok: false,
    error: {
      status: 401,
      code: "invalid_caller_credentials",
      message: surface.invalidCredentialMessage
    }
  };
}

export function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23505";
}

export function callerSetupCodeDigest(value: string) {
  return createHmac(TOKEN_HASH_ALGORITHM, requireCallerKeyHashSecret())
    .update(value)
    .digest("hex");
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

export function setupRequestExpired(
  row: { expires_at: string | Date },
  now: Date
) {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

export function publicAppBaseUrl(): ControlPlaneResult<string> {
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

export async function withControlPlaneTransaction<TData>(
  surface: ControlPlaneSurface,
  context: ApiRequestContext,
  operation: string,
  callback: (
    query: ProductTransactionQuery
  ) => Promise<ControlPlaneResult<TData>>,
  options: ControlPlaneRequestOptions = {}
): Promise<ControlPlaneResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(surface.databaseUnavailableMessage);
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
      message: surface.unexpectedFailureMessage,
      request_id: context.requestId
    });
    return apiTemporaryUnavailable(surface.temporarilyUnavailableMessage, {
      errorId: context.correlationId,
      reported: true
    });
  }
}

export async function withScopedProductTransaction<TData>(
  surface: ControlPlaneSurface,
  connectionString: string,
  context: ApiRequestContext,
  scopedContext: Omit<ProductTransactionContext, "requestId">,
  operation: string,
  callback: (
    query: ProductTransactionQuery
  ) => Promise<ControlPlaneResult<TData>>,
  options: ControlPlaneRequestOptions = {}
): Promise<ControlPlaneResult<TData>> {
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
      message: surface.unexpectedFailureMessage,
      request_id: context.requestId,
      account_id: scopedContext.accountId,
      caller_id: scopedContext.callerId
    });
    return apiTemporaryUnavailable(surface.temporarilyUnavailableMessage, {
      errorId: context.correlationId,
      reported: true
    });
  }
}

function pendingCredentialFromRequest(
  surface: ControlPlaneSurface,
  request: Request
): ControlPlaneResult<PendingCredentialBearer> {
  const parsed = parseCallerBearerApiKey(request.headers.get("authorization"));
  if (!parsed.ok) {
    if (parsed.code !== "missing_authorization") {
      return invalidCallerCredentialsError(surface);
    }
    return {
      ok: false,
      error: {
        status: 401,
        code: "authentication_required",
        message: surface.bearerRequiredMessage
      }
    };
  }
  return { ok: true, data: parsed };
}

async function lookupPendingCredential(
  surface: ControlPlaneSurface,
  query: ProductTransactionQuery,
  bearer: PendingCredentialBearer
): Promise<ControlPlaneResult<{ accountId: string; callerId: string }>> {
  const result = await query<CallerCredentialLookupRow>(
    callerCredentialLookupStatement(bearer.keyId)
  );
  const row = result.rows[0];
  if (!row || row.status !== "pending_activation" || row.revoked_at) {
    return invalidCallerCredentialsError(surface);
  }

  if (!pendingSecretMatches(bearer.secret, row.secret_hmac_sha256)) {
    return invalidCallerCredentialsError(surface);
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
  surface: ControlPlaneSurface,
  query: ProductTransactionQuery,
  credential: PendingCredentialRow | null,
  bearer: PendingCredentialBearer,
  now: Date,
  expireStatement: (callerCredentialId: string) => TransactionContextStatement
): Promise<ControlPlaneResult<null>> {
  if (!credential) {
    return invalidCallerCredentialsError(surface);
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
      await query(expireStatement(credential.caller_credential_id));
    }
    return invalidCallerCredentialsError(surface);
  }

  if (!pendingSecretMatches(bearer.secret, credential.secret_hmac_sha256)) {
    return invalidCallerCredentialsError(surface);
  }

  return { ok: true, data: null };
}

function pendingSecretMatches(secret: string, storedDigest: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(storedDigest)) {
    return false;
  }

  const suppliedDigest = callerApiKeySecretDigest(secret);
  const supplied = Buffer.from(suppliedDigest, "hex");
  const stored = Buffer.from(storedDigest, "hex");
  return timingSafeEqual(supplied, stored);
}

export async function handlePendingCredentialRequest<TData>(
  surface: ControlPlaneSurface,
  request: Request,
  context: ApiRequestContext,
  body: unknown,
  options: ControlPlaneRequestOptions,
  spec: {
    trustedIpUnavailableMessage: string;
    limitKind: ControlPlaneIpLimitKind;
    operation: string;
    run: (
      query: ProductTransactionQuery,
      input: {
        setupRequestId: string;
        pendingCredential: PendingCredentialBearer;
        accountId: string;
        callerId: string;
      }
    ) => Promise<ControlPlaneResult<TData>>;
  }
): Promise<ControlPlaneResult<TData>> {
  const parsed = parseSetupRequestIdBody(surface, body);
  if (!parsed.ok) {
    return parsed;
  }

  const pendingCredential = pendingCredentialFromRequest(surface, request);
  if (!pendingCredential.ok) {
    return pendingCredential;
  }

  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return apiTemporaryUnavailable(spec.trustedIpUnavailableMessage);
  }
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(surface.databaseUnavailableMessage);
  }

  const lookupResult = await withControlPlaneTransaction(
    surface,
    context,
    `${spec.operation}_lookup`,
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        spec.limitKind
      );
      if (!limit.ok) {
        return limit;
      }

      return lookupPendingCredential(surface, query, pendingCredential.data);
    },
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withScopedProductTransaction(
    surface,
    connectionString,
    context,
    {
      authSurface: "caller",
      accountId: lookupResult.data.accountId,
      callerId: lookupResult.data.callerId
    },
    spec.operation,
    (query) =>
      spec.run(query, {
        ...lookupResult.data,
        setupRequestId: parsed.data.setupRequestId,
        pendingCredential: pendingCredential.data
      }),
    options
  );
}
