/** Setup-request start, helpers, approval decisions, terminal state, approved-code exchange, and pending-credential finalization shared by caller connect and rotate/revoke flows. */
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
  type CallerApiKeyParts,
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
const SETUP_TOKEN_BYTES = 32;
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

export type SetupTerminalStatus = Extract<
  SetupRequestStatus,
  "approved" | "exchanged" | "denied"
>;

export type SetupTerminalStateData = {
  setup_request_id: string;
  operation: SetupOperation;
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

type TerminalSetupStateRow = {
  setup_request_id: string;
  operation: SetupOperation;
  flow: "browser" | "device";
  status: SetupTerminalStatus;
  local_caller_name: string;
  display_name: string;
  caller_id: string | null;
  caller_slug: string | null;
  caller_display_name: string | null;
};

/**
 * Rejects malformed IDs before querying. Lookup is scoped to the account,
 * operation, and a non-empty list of accepted terminal statuses.
 */
export async function getSetupRequestTerminalState(
  query: ProductTransactionQuery,
  input: {
    operation: SetupOperation;
    setupRequestId: string;
    accountId: string;
    statuses: readonly [SetupTerminalStatus, ...SetupTerminalStatus[]];
  }
): Promise<SetupResult<SetupTerminalStateData>> {
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

  const result = await query<TerminalSetupStateRow>(
    terminalSetupStateStatement(input)
  );
  const row = result.rows[0];
  if (!row) {
    return notFoundError(setupRequestNotFoundMessage(input.operation));
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

function terminalSetupStateStatement(input: {
  operation: SetupOperation;
  setupRequestId: string;
  accountId: string;
  statuses: readonly [SetupTerminalStatus, ...SetupTerminalStatus[]];
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

/**
 * Marks expired pending or approved requests before checking pending status;
 * expiry errors take precedence over non-pending errors.
 */
export async function ensurePendingSetupApproval(
  query: ProductTransactionQuery,
  target: {
    setup_request_id: string;
    operation: SetupOperation;
    status: SetupRequestStatus;
    expires_at: string | Date;
  },
  now: Date = new Date()
): Promise<SetupResult<null>> {
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

  return { ok: true, data: null };
}

/**
 * Null callerId and setupCodeHash preserve their stored values on approval.
 */
export function approveSetupRequestStatement(input: {
  setupRequestId: string;
  accountId: string;
  callerId: string | null;
  userId: string;
  setupCodeHash: string | null;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_setup_requests
      set
        account_id = $2,
        caller_id = coalesce($3::uuid, caller_id),
        approved_by_user_id = $4,
        setup_code_hash = coalesce($5, setup_code_hash),
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

/**
 * Rejects malformed IDs before executing the supplied denial statement.
 * The caller's statement defines the operation and account scope.
 */
export async function denySetupRequest(
  query: ProductTransactionQuery,
  input: {
    operation: SetupOperation;
    setupRequestId: string;
    statement: TransactionContextStatement;
  }
): Promise<SetupResult<{ setup_request_id: string; denied: true }>> {
  if (!UUID_PATTERN.test(input.setupRequestId)) {
    return invalidSetupRequestError();
  }

  const result = await query<{ setup_request_id: string }>(input.statement);
  if (!result.rows[0]) {
    return notFoundError(setupRequestNotFoundMessage(input.operation));
  }
  return {
    ok: true,
    data: {
      setup_request_id: result.rows[0].setup_request_id,
      denied: true
    }
  };
}

export function setupRequestNotFoundMessage(operation: SetupOperation): string {
  return operation === "connect"
    ? "Caller connect setup request was not found."
    : `Caller ${operation} request was not found.`;
}

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
  return sqlState(error) === "23505";
}

function isForeignKeyViolation(error: unknown) {
  return sqlState(error) === "23503";
}

/** Returns the `code` (SQLSTATE) of an error object, if it has one. */
function sqlState(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

export function setupRequestExpired(
  row: { expires_at: string | Date },
  now: Date
) {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

/**
 * Uses 32 random bytes encoded as base64url after the setup_ prefix.
 */
export function generateSetupCode(): string {
  return `setup_${randomBytes(SETUP_TOKEN_BYTES).toString("base64url")}`;
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

/**
 * Rejects non-plain-object bodies immediately. Otherwise validates and trims
 * caller_id for rotate/revoke, local_caller_name, connect-only display_name,
 * then browser-only callback_url, collecting field errors in that order.
 * Rotate/revoke reuse local_caller_name as displayName. Success returns
 * callerId, localCallerName, displayName and callbackUrl, with null callerId
 * for connect and null callbackUrl for device flows.
 */
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
  return parseRecordBody(messages, body, (record, fields) => {
    const callerId =
      operation !== "connect"
        ? requiredUuidText(record, "caller_id", fields)
        : null;
    const localCallerName = requiredText(record, "local_caller_name", fields);
    const displayName =
      operation === "connect"
        ? requiredText(record, "display_name", fields)
        : localCallerName;
    const callbackUrl =
      flow === "browser"
        ? requiredCallbackUrl(record, "callback_url", fields)
        : null;
    return { callerId, localCallerName, displayName, callbackUrl };
  });
}

/**
 * Builds one insert into public.agent_outbox_caller_setup_requests for the
 * operation, flow, names, callback URL, device/user code hashes, caller ID,
 * expiry and poll interval. Null hashes and caller ID are bound as SQL NULL;
 * the statement returns setup_request_id as text.
 */
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

  return withIpLimitedControlPlaneTransaction(
    messages,
    context,
    `caller_${operation}_${flow}_start`,
    { ipAddress, kind: `caller_${operation}_start` },
    async (query) => {
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

export type PendingCredentialBearer = CallerApiKeyParts &
  CallerApiKeyDisplayMetadata;

/**
 * Rejects non-plain-object bodies with a 422 validation failure, then lets
 * read collect field errors. Any field error returns the flow's 422 validation
 * failure; otherwise read's value is the parsed data. This validates request
 * shape only; callers still verify any token it reads.
 */
export function parseRecordBody<TData>(
  messages: CallerFlowMessages,
  body: unknown,
  read: (record: Record<string, unknown>, fields: ApiFieldError[]) => TData
): SetupResult<TData> {
  if (!isPlainRecord(body)) {
    return apiValidationFailed(messages.validationFailed, [
      fieldError("", "invalid_request", "Request body must be an object.")
    ]);
  }

  const fields: ApiFieldError[] = [];
  const data = read(body, fields);
  if (fields.length > 0) {
    return apiValidationFailed(messages.validationFailed, fields);
  }

  return { ok: true, data };
}

/**
 * Requires DATABASE_APP_ROLE_URL, then opens a control-plane transaction that
 * applies the flow's IP limit before running the callback. A limit failure is
 * returned unchanged; otherwise callback results, including failures, are
 * returned unchanged. Missing database configuration returns the flow's
 * database-unavailable 503; thrown failures follow withFlowTransaction.
 */
export async function withIpLimitedControlPlaneTransaction<TData>(
  messages: CallerFlowMessages,
  context: ApiRequestContext,
  operation: string,
  ipLimit: {
    ipAddress: string;
    kind: Parameters<typeof enforceIpControlPlaneLimit>[2];
  },
  callback: (query: ProductTransactionQuery) => Promise<SetupResult<TData>>,
  options: CallerFlowRequestOptions = {}
): Promise<SetupResult<TData>> {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    return apiTemporaryUnavailable(messages.databaseUnavailable);
  }

  return withFlowTransaction(
    messages,
    connectionString,
    context,
    { authSurface: "control_plane" },
    operation,
    async (query) => {
      const limit = await enforceIpControlPlaneLimit(
        query,
        ipLimit.ipAddress,
        ipLimit.kind
      );
      return limit.ok ? callback(query) : limit;
    },
    options
  );
}

/**
 * Runs the callback with the supplied connection string, scope and request ID
 * through the injected or default transaction runner; this wrapper does not
 * check configuration. Returns callback results, including failures,
 * unchanged. Thrown transaction or callback failures are reported with
 * operation, request, and any account/caller context and return the flow's
 * temporary-unavailable 503 with the correlation ID.
 */
async function withFlowTransaction<TData>(
  messages: CallerFlowMessages,
  connectionString: string,
  context: ApiRequestContext,
  scope: Omit<ProductTransactionContext, "requestId">,
  operation: string,
  callback: (query: ProductTransactionQuery) => Promise<SetupResult<TData>>,
  options: CallerFlowRequestOptions
): Promise<SetupResult<TData>> {
  const runTransaction = options.runProductTransaction ?? runProductTransaction;
  try {
    return await runTransaction(
      connectionString,
      {
        requestId: context.requestId,
        ...scope
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
      account_id: scope.accountId,
      caller_id: scope.callerId
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
  const parsed = parseRecordBody(messages, body, (record, fields) =>
    requiredText(record, input.codeField, fields, 512)
  );
  if (!parsed.ok) {
    return parsed;
  }

  const code = parsed.data;
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

  const lookupResult = await withIpLimitedControlPlaneTransaction(
    messages,
    context,
    input.lookupOperation,
    { ipAddress, kind: input.limitKind },
    (query) => input.lookup(query, codeHash),
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withFlowTransaction(
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
  const parsed = parseRecordBody(messages, body, (record, fields) =>
    requiredUuidText(record, "setup_request_id", fields)
  );
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

  const lookupResult = await withIpLimitedControlPlaneTransaction(
    messages,
    context,
    input.lookupOperation,
    { ipAddress, kind: input.limitKind },
    (query) => lookupPendingCredential(query, messages, pendingCredential.data),
    options
  );

  if (!lookupResult.ok) {
    return lookupResult;
  }

  return withFlowTransaction(
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
        setupRequestId: parsed.data,
        pendingCredential: pendingCredential.data
      }),
    options
  );
}
