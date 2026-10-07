/** Setup-request start, helpers, approved-code exchange, and pending-credential finalization shared by caller connect and rotate/revoke flows. */
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";

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
  withSavepoint,
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

export type SetupOperation = "connect" | "rotate" | "revoke";

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

function isForeignKeyViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: unknown }).code === "23503";
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

type SetupStartInput = {
  operation: SetupOperation;
  messages: CallerFlowMessages;
  request: Request;
  context: ApiRequestContext;
  body: unknown;
  options: CallerFlowRequestOptions;
};

function parseSetupStartBody(
  messages: CallerFlowMessages,
  operation: SetupOperation,
  flow: "browser" | "device",
  body: unknown
): SetupResult<{
  callerId: string | null;
  localCallerName: string;
  displayName: string;
  callbackUrl: string | null;
}> {
  const fields: ApiFieldError[] = [];
  if (!isPlainRecord(body)) {
    return apiValidationFailed(messages.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const callerId =
    operation !== "connect"
      ? requiredUuidText(body, "caller_id", fields)
      : null;
  const localCallerName = requiredText(body, "local_caller_name", fields);
  const displayName =
    operation === "connect"
      ? requiredText(body, "display_name", fields)
      : localCallerName;
  const callbackUrl =
    flow === "browser"
      ? requiredCallbackUrl(body, "callback_url", fields)
      : null;

  if (fields.length > 0) {
    return apiValidationFailed(messages.validationFailed, fields);
  }

  return {
    ok: true,
    data: { callerId, localCallerName, displayName, callbackUrl }
  };
}

function createSetupRequestStatement(input: {
  operation: SetupOperation;
  flow: "browser" | "device";
  localCallerName: string;
  displayName: string;
  callbackUrl: string | null;
  deviceCodeHash: string | null;
  userCodeHash: string | null;
  callerId: string | null;
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
        device_code_hash,
        user_code_hash,
        caller_id,
        expires_at,
        poll_interval_seconds
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9::timestamptz, $10)
      returning setup_request_id::text as setup_request_id
    `,
    values: [
      input.operation,
      input.flow,
      input.localCallerName,
      input.displayName,
      input.callbackUrl,
      input.deviceCodeHash,
      input.userCodeHash,
      input.callerId,
      input.expiresAt.toISOString(),
      DEVICE_POLL_INTERVAL_SECONDS
    ]
  };
}

type DeviceCodes = { deviceCode: string; userCode: string };

/**
 * Validates the body, public base URL and trusted client IP, then creates any
 * device codes and the expiry before the control-plane transaction applies the
 * IP limit and inserts the setup row. Connect inserts directly; rotate and
 * revoke insert inside a savepoint so an unknown target caller returns 400
 * without discarding the limit increment.
 */
async function handleSetupStartRequest<
  TCodes extends DeviceCodes | null,
  TData
>(
  input: SetupStartInput,
  flow: "browser" | "device",
  createCodes: () => TCodes,
  response: (
    row: { setup_request_id: string },
    baseUrl: string,
    expiresAt: Date,
    codes: TCodes
  ) => TData
): Promise<SetupResult<TData>> {
  const { operation, messages, request, context, body, options } = input;
  const parsed = parseSetupStartBody(messages, operation, flow, body);
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
      `Trusted client IP is unavailable for caller ${operation} start.`
    );
  }

  const codes = createCodes();
  const expiresAt = setupRequestExpiresAt(options.now ?? new Date());

  return withControlPlaneTransaction(
    messages,
    context,
    `caller_${operation}_${flow}_start`,
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipAddress,
        `caller_${operation}_start`
      );
      if (!limit.ok) {
        return limit;
      }

      const insert = () =>
        query<{ setup_request_id: string }>(
          createSetupRequestStatement({
            operation,
            flow,
            ...parsed.data,
            deviceCodeHash: codes ? setupCodeDigest(codes.deviceCode) : null,
            userCodeHash: codes
              ? setupCodeDigest(normalizeUserCode(codes.userCode))
              : null,
            expiresAt
          })
        );

      let result: { rows: { setup_request_id: string }[] };
      if (operation === "connect") {
        result = await insert();
      } else {
        try {
          result = await withSavepoint(query, "caller_setup_request", insert);
        } catch (error) {
          if (isForeignKeyViolation(error)) {
            return invalidRequestError(
              `Caller ${operation} target was not found.`
            );
          }
          throw error;
        }
      }

      return {
        ok: true,
        data: response(result.rows[0], baseUrl.data, expiresAt, codes)
      };
    },
    options
  );
}

/**
 * Starts a browser setup request and returns the approval URL, request ID and
 * expiry.
 */
export async function handleSetupBrowserStartRequest(
  input: SetupStartInput
): Promise<
  SetupResult<{
    approval_url: string;
    setup_request_id: string;
    expires_at: string;
  }>
> {
  return handleSetupStartRequest(
    input,
    "browser",
    () => null,
    ({ setup_request_id: setupRequestId }, baseUrl, expiresAt) => {
      const approvalUrl = new URL(
        `/caller/${input.operation}/approve`,
        baseUrl
      );
      approvalUrl.searchParams.set("setup_request_id", setupRequestId);

      return {
        approval_url: approvalUrl.toString(),
        setup_request_id: setupRequestId,
        expires_at: expiresAt.toISOString()
      };
    }
  );
}

/**
 * Starts a device setup request, storing only code hashes, and returns the
 * codes, verification URLs, expiry and poll interval.
 */
export async function handleSetupDeviceStartRequest(
  input: SetupStartInput
): Promise<
  SetupResult<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_at: string;
    poll_interval_seconds: number;
  }>
> {
  return handleSetupStartRequest(
    input,
    "device",
    () => ({
      deviceCode: `dev_${randomBytes(DEVICE_TOKEN_BYTES).toString("base64url")}`,
      userCode: generateUserCode()
    }),
    (_row, baseUrl, expiresAt, { deviceCode, userCode }) => {
      const verificationUri = new URL(
        `/caller/${input.operation}/device`,
        baseUrl
      ).toString();
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
        expires_at: expiresAt.toISOString(),
        poll_interval_seconds: DEVICE_POLL_INTERVAL_SECONDS
      };
    }
  );
}

export type PendingCredentialBearer = {
  apiKey: string;
  keyId: string;
  secret: string;
} & CallerApiKeyDisplayMetadata;

/**
 * Reads device_code from a plain object, trims it, and requires nonempty,
 * storable text of at most 512 UTF-16 code units. Invalid input returns a
 * 422 validation failure with the flow's message and field errors.
 * This validates request text only; the caller must verify the device token.
 */
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

/**
 * Reads setup_code from a plain object, trims it, and requires nonempty,
 * storable text of at most 512 UTF-16 code units. Invalid input returns a
 * 422 validation failure with the flow's message and field errors.
 * This validates request text only; the caller must verify the setup token.
 */
function parseSetupCodeBody(
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

/**
 * Requires DATABASE_APP_ROLE_URL, then runs the callback with control-plane
 * context and the request ID using the injected or default transaction runner.
 * Returns callback results, including failures, unchanged. Missing database
 * configuration returns the flow's database-unavailable 503; thrown transaction
 * or callback failures are reported with operation and request context and
 * return the flow's temporary-unavailable 503 with the correlation ID.
 */
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

/**
 * Runs the callback using the supplied connection string and scope plus the
 * request ID, through the injected or default transaction runner. The caller
 * supplies the connection string; this wrapper does not check configuration.
 * Returns callback results, including failures, unchanged. Thrown transaction
 * or callback failures are reported with operation, request, and account/caller
 * context and return the flow's temporary-unavailable 503 with the correlation ID.
 */
async function withScopedProductTransaction<TData>(
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

/**
 * Verifies a pending_activation credential row loaded inside the caller-scoped
 * transaction against the bearer secret. A missing, non-pending, or revoked
 * row, a missing or past expires_at, a malformed stored digest, or a secret
 * mismatch returns the flow's invalid-credential 401. Only a pending row whose
 * expires_at has passed is first marked expired with the flow's expire statement.
 */
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

/**
 * Runs an approved setup-code exchange request: validates setup_code or
 * device_code, then requires a trusted client IP and hashes the code (hashing
 * first when hashBeforeIp is set, so hash-secret errors take precedence), then
 * requires DATABASE_APP_ROLE_URL. Connect sets hashBeforeIp, so a missing or
 * too-short hash secret throws even when the trusted IP is unavailable.
 * Rotate and revoke leave hashBeforeIp unset: the IP check comes first, so
 * those hash-secret failures throw only after a trusted IP is present.
 * setupCodeDigest runs exactly once when hashing is reached. The early digest
 * is reused after the IP check without hashing again. Hash-secret exceptions
 * propagate outside both transaction wrappers; they are thrown, not returned
 * or converted into the flow's reported temporary-unavailable 503.
 *
 * Lookup and exchange use separate transactions. The control-plane transaction
 * applies the flow's IP limit, then runs the lookup callback to resolve the
 * approving account and user. Only after it succeeds does the human-scoped
 * transaction run the exchange callback. The exchange callback locks and
 * revalidates the setup row; this helper does not lock between transactions.
 * Each step returns the first SetupResult failure unchanged. Transaction and
 * callback throws become the wrapper's reported temporary-unavailable 503,
 * using the flow's messages and operation names.
 *
 * exchangeMessages, when set, replaces messages only for the exchange
 * transaction. Lookup keeps messages. Connect passes this override; rotate
 * and revoke do not.
 */
export async function handleApprovedSetupCodeRequest<TData>(input: {
  request: Request;
  context: ApiRequestContext;
  body: unknown;
  options: CallerFlowRequestOptions;
  messages: CallerFlowMessages;
  codeField: "setup_code" | "device_code";
  ipUnavailableMessage: string;
  limitKind: Parameters<typeof enforceIpControlPlaneLimit>[2];
  lookupOperation: string;
  exchangeOperation: string;
  exchangeMessages?: CallerFlowMessages;
  hashBeforeIp?: boolean;
  lookup: (
    query: ProductTransactionQuery,
    codeHash: string
  ) => Promise<SetupResult<{ accountId: string; userId: string }>>;
  exchange: (
    query: ProductTransactionQuery,
    codeHash: string
  ) => Promise<SetupResult<TData>>;
}): Promise<SetupResult<TData>> {
  const { request, context, body, options, messages } = input;
  const parsed =
    input.codeField === "setup_code"
      ? parseSetupCodeBody(messages, body)
      : parseDevicePollBody(messages, body);
  if (!parsed.ok) {
    return parsed;
  }

  const code =
    "setupCode" in parsed.data ? parsed.data.setupCode : parsed.data.deviceCode;
  const earlyCodeHash = input.hashBeforeIp ? setupCodeDigest(code) : undefined;
  const ipAddress = trustedClientIpAddress(request);
  if (!ipAddress) {
    return apiTemporaryUnavailable(input.ipUnavailableMessage);
  }

  const codeHash = earlyCodeHash ?? setupCodeDigest(code);
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

      return input.lookup(query, codeHash);
    },
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withScopedProductTransaction(
    input.exchangeMessages ?? messages,
    connectionString,
    context,
    {
      authSurface: "human",
      accountId: lookupResult.data.accountId,
      userId: lookupResult.data.userId
    },
    input.exchangeOperation,
    (query) => input.exchange(query, codeHash),
    options
  );
}

/**
 * Runs a pending-credential activate or abort request: validates
 * setup_request_id, then parses the bearer credential, then requires a trusted
 * client IP and DATABASE_APP_ROLE_URL. A control-plane transaction applies the
 * flow's IP limit and resolves the pending credential's account and caller; the
 * finalize callback then runs in a caller-scoped transaction. Each step returns
 * the first failure unchanged, using the flow's messages and operation names.
 */
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
