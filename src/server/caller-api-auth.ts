import { timingSafeEqual } from "node:crypto";

import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  parseCallerBearerApiKey,
  storedCallerCredentialDigestFromLookupRow,
  type CallerCredentialLookupRow,
  type CallerApiKeyDisplayMetadata,
  type CallerApiKeyId,
  type StoredCallerCredentialDigest
} from "./caller-auth.ts";
import type { ApiErrorInput, ApiRequestContext } from "./api-errors.ts";
import {
  runProductTransaction,
  setProductTransactionIdentityContext,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { durationSinceMs, emitRuntimeLog, safeErrorName } from "./logging.ts";

export type CallerCredentialLookup = (
  keyId: CallerApiKeyId
) => Promise<StoredCallerCredentialDigest | null | undefined>;

export type CallerApiAuthSuccess = {
  ok: true;
  accountId: string;
  callerId: string;
  keyId: CallerApiKeyId;
  secretDigest: string;
} & CallerApiKeyDisplayMetadata;

export type CallerApiAuthFailureReason =
  | "missing_authorization"
  | "invalid_authorization_scheme"
  | "invalid_caller_api_key"
  | "credential_not_found"
  | "credential_key_id_mismatch"
  | "invalid_stored_digest"
  | "secret_mismatch"
  | "credential_revoked"
  | "credential_expired"
  | "credential_not_active"
  | "credential_lookup_failed";

export type CallerApiAuthFailure = {
  ok: false;
  clientError: ApiErrorInput;
  internal: {
    reason: CallerApiAuthFailureReason;
    keyId?: CallerApiKeyId;
    credentialStatus?: StoredCallerCredentialDigest["status"];
    secretDigestCompared: boolean;
    secretMatched: boolean | null;
  };
};

export type CallerApiAuthResult = CallerApiAuthSuccess | CallerApiAuthFailure;
type RunProductTransaction = typeof runProductTransaction;

export type AuthenticatedCallerTransactionResult<TResult> =
  | {
      authenticated: true;
      data: TResult;
    }
  | {
      authenticated: false;
      failure: CallerApiAuthFailure;
    };

export type CallerIdentity = {
  accountId: string;
  callerId: string;
};

export type AuthenticateCallerApiRequestOptions = {
  now?: Date;
  requestId?: string;
  correlationId?: string;
  route?: string;
  method?: string;
  startedAtMs?: number;
};

const INVALID_CALLER_CREDENTIALS_CLIENT_ERROR: ApiErrorInput = {
  status: 401,
  code: "invalid_caller_credentials",
  message: "Caller credentials are invalid or no longer usable."
};

const AUTHENTICATION_REQUIRED_CLIENT_ERROR: ApiErrorInput = {
  status: 401,
  code: "authentication_required",
  message: "Caller bearer credentials are required."
};

const TEMPORARY_UNAVAILABLE_CLIENT_ERROR: ApiErrorInput = {
  status: 503,
  code: "temporary_unavailable",
  message: "Caller authentication is temporarily unavailable."
};

const UNKNOWN_CALLER_SECRET_SENTINEL_DIGEST =
  "0000000000000000000000000000000000000000000000000000000000000000";

export async function authenticateCallerApiRequest(
  request: Request,
  lookupCredential: CallerCredentialLookup,
  options: AuthenticateCallerApiRequestOptions = {}
): Promise<CallerApiAuthResult> {
  const failAndLog = (input: Parameters<typeof callerAuthFailure>[0]) => {
    const failure = callerAuthFailure(input);
    emitRuntimeLog({
      level: "warn",
      error_id: options.correlationId,
      request_id: options.requestId,
      surface: "api",
      route: options.route,
      method: options.method,
      status_code: failure.clientError.status,
      duration_ms: durationSinceMs(options.startedAtMs),
      operation: "caller_api_auth",
      message: `caller authentication failed: ${failure.internal.reason}`
    });
    return failure;
  };

  const authHeader = request.headers.get("authorization")?.trim() ?? null;
  const parsed = parseCallerBearerApiKey(authHeader);

  if (!parsed.ok) {
    return failAndLog({
      clientError:
        parsed.code === "missing_authorization"
          ? AUTHENTICATION_REQUIRED_CLIENT_ERROR
          : INVALID_CALLER_CREDENTIALS_CLIENT_ERROR,
      reason: parsed.code,
      secretDigestCompared: false,
      secretMatched: null
    });
  }

  let credential: StoredCallerCredentialDigest | null | undefined;
  try {
    credential = await lookupCredential(parsed.keyId);
  } catch {
    return failAndLog({
      clientError: TEMPORARY_UNAVAILABLE_CLIENT_ERROR,
      keyId: parsed.keyId,
      reason: "credential_lookup_failed",
      secretDigestCompared: false,
      secretMatched: null
    });
  }

  const secretDigest = callerApiKeySecretDigest(parsed.secret);

  if (!credential) {
    // Keep lookup misses on the same comparison path as wrong-secret matches;
    // the result is intentionally discarded to avoid reintroducing a key-id oracle.
    compareCallerSecretDigest(
      secretDigest,
      UNKNOWN_CALLER_SECRET_SENTINEL_DIGEST
    );
    return failAndLog({
      keyId: parsed.keyId,
      reason: "credential_not_found",
      secretDigestCompared: true,
      secretMatched: false
    });
  }

  const digestComparison = compareCallerSecretDigest(
    secretDigest,
    credential.secretDigest
  );

  if (!digestComparison.validStoredDigest) {
    return failAndLog({
      keyId: parsed.keyId,
      credentialStatus: credential.status,
      reason: "invalid_stored_digest",
      secretDigestCompared: false,
      secretMatched: null
    });
  }

  const keyIdReason =
    parsed.keyId === credential.keyId ? null : "credential_key_id_mismatch";
  const lifecycleReason =
    keyIdReason ??
    credentialLifecycleFailure(credential, options.now ?? new Date());

  if (lifecycleReason) {
    return failAndLog({
      keyId: parsed.keyId,
      credentialStatus: credential.status,
      reason: lifecycleReason,
      secretDigestCompared: true,
      secretMatched: digestComparison.matches
    });
  }

  if (!digestComparison.matches) {
    return failAndLog({
      keyId: parsed.keyId,
      credentialStatus: credential.status,
      reason: "secret_mismatch",
      secretDigestCompared: true,
      secretMatched: false
    });
  }

  return {
    ok: true,
    accountId: credential.accountId,
    callerId: credential.callerId,
    keyId: parsed.keyId,
    secretDigest,
    keyPrefix: parsed.keyPrefix,
    keyLastCharacters: parsed.keyLastCharacters
  } as const;
}

export async function runAuthenticatedCallerTransaction<TResult>(
  request: Request,
  context: ApiRequestContext,
  connectionString: string,
  callback: (
    query: ProductTransactionQuery,
    identity: CallerApiAuthSuccess
  ) => Promise<TResult>,
  options: {
    runTransaction?: RunProductTransaction;
  } = {}
): Promise<AuthenticatedCallerTransactionResult<TResult>> {
  const runTransaction = options.runTransaction ?? runProductTransaction;
  return runTransaction(
    connectionString,
    {
      requestId: context.requestId,
      authSurface: "caller"
    },
    async (query) => {
      const auth = await authenticateCallerApiRequest(
        request,
        async (keyId) => {
          const result = await query<CallerCredentialLookupRow>(
            callerCredentialLookupStatement(keyId)
          );
          const row = result.rows[0];
          return row ? storedCallerCredentialDigestFromLookupRow(row) : null;
        },
        {
          requestId: context.requestId,
          correlationId: context.correlationId,
          route: context.route,
          method: context.method,
          startedAtMs: context.startedAtMs
        }
      );

      if (!auth.ok) {
        return { authenticated: false as const, failure: auth };
      }

      await setProductTransactionIdentityContext(query, {
        authSurface: "caller",
        accountId: auth.accountId,
        callerId: auth.callerId
      });
      await updateCallerLastUsedInSavepoint(query, auth, context);
      const data = await callback(query, auth);
      return { authenticated: true as const, data };
    }
  );
}

async function updateCallerLastUsedInSavepoint(
  query: ProductTransactionQuery,
  auth: CallerApiAuthSuccess,
  context: ApiRequestContext
) {
  await query({ sql: "savepoint caller_last_used" });
  try {
    await query(callerCredentialLastUsedStatement(auth));
  } catch (error) {
    await query({ sql: "rollback to savepoint caller_last_used" });
    emitRuntimeLog({
      level: "warn",
      error_id: context.correlationId,
      request_id: context.requestId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 200,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation: "caller_api_auth",
      account_id: auth.accountId,
      caller_id: auth.callerId,
      message: "Caller credential last-used update failed.",
      error_name: safeErrorName(error)
    });
  } finally {
    await query({ sql: "release savepoint caller_last_used" });
  }
}

export function callerCredentialLastUsedStatement(input: {
  accountId: string;
  callerId: string;
  keyId: string;
}): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_caller_credentials
      set last_used_at = now()
      where account_id = $1
        and caller_id = $2
        and key_id = $3
        and (
          last_used_at is null
          or last_used_at < now() - interval '15 minutes'
        )
    `,
    values: [input.accountId, input.callerId, input.keyId]
  };
}

function callerAuthFailure(input: {
  clientError?: ApiErrorInput;
  keyId?: CallerApiKeyId;
  credentialStatus?: StoredCallerCredentialDigest["status"];
  reason: CallerApiAuthFailureReason;
  secretDigestCompared: boolean;
  secretMatched: boolean | null;
}): CallerApiAuthFailure {
  return {
    ok: false,
    clientError: input.clientError ?? INVALID_CALLER_CREDENTIALS_CLIENT_ERROR,
    internal: {
      reason: input.reason,
      keyId: input.keyId,
      credentialStatus: input.credentialStatus,
      secretDigestCompared: input.secretDigestCompared,
      secretMatched: input.secretMatched
    }
  };
}

function credentialLifecycleFailure(
  credential: StoredCallerCredentialDigest,
  now: Date
): CallerApiAuthFailureReason | null {
  if (credential.revokedAt || credential.status === "revoked") {
    return "credential_revoked";
  }

  if (credential.status === "expired" || credentialExpired(credential, now)) {
    return "credential_expired";
  }

  if (credential.status !== "active") {
    return "credential_not_active";
  }

  return null;
}

function credentialExpired(
  credential: StoredCallerCredentialDigest,
  now: Date
) {
  if (!credential.expiresAt) {
    return false;
  }

  const expiresAtMs = new Date(credential.expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime();
}

function compareCallerSecretDigest(
  suppliedDigest: string,
  storedDigest: string
) {
  if (!/^[a-fA-F0-9]{64}$/.test(storedDigest)) {
    return {
      validStoredDigest: false,
      matches: false
    };
  }

  return {
    validStoredDigest: true,
    matches: timingSafeEqual(
      Buffer.from(suppliedDigest, "hex"),
      Buffer.from(storedDigest, "hex")
    )
  };
}
