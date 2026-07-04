import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import type { TransactionContextStatement } from "./database.ts";
import { requireCallerKeyHashSecret } from "./env.ts";

type CallerAuthResult =
  | { ok: true; callerId: "runtime-smoke-caller" }
  | {
      ok: false;
      status: 401 | 403;
      code:
        | "missing_authorization"
        | "invalid_authorization_scheme"
        | "invalid_bearer_token";
    };

export const CALLER_API_KEY_PREFIX = "aob_live";
export const CALLER_API_KEY_ID_BYTES = 16;
export const CALLER_API_KEY_SECRET_BYTES = 32;
export const CALLER_API_KEY_PREFIX_VISIBLE_CHARACTERS = 20;
export const CALLER_API_KEY_LAST_VISIBLE_CHARACTERS = 4;

const BASE32_LOWER_NO_PADDING_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE32_LOWER_NO_PADDING_PATTERN = /^[a-z2-7]+$/;
const CALLER_API_KEY_ID_LENGTH = base32EncodedLength(CALLER_API_KEY_ID_BYTES);
const CALLER_API_KEY_SECRET_LENGTH = base32EncodedLength(
  CALLER_API_KEY_SECRET_BYTES
);

export type CallerApiKeyId = string;
export type CallerApiKeySecret = string;
export type CallerApiKey = string;

export type CallerApiKeyParts = {
  keyId: CallerApiKeyId;
  secret: CallerApiKeySecret;
};

export type CallerApiKeyDisplayMetadata = {
  keyId: CallerApiKeyId;
  keyPrefix: string;
  keyLastCharacters: string;
};

export type DisplayOnceCallerApiKeyMaterial = CallerApiKeyDisplayMetadata & {
  plaintextApiKey: CallerApiKey;
  secretDigest: string;
};

export type CallerApiKeyParseResult =
  | ({
      ok: true;
    } & CallerApiKeyParts &
      CallerApiKeyDisplayMetadata)
  | {
      ok: false;
      code: "invalid_caller_api_key";
    };

export type CallerBearerApiKeyParseResult =
  | ({
      ok: true;
      apiKey: CallerApiKey;
    } & CallerApiKeyParts &
      CallerApiKeyDisplayMetadata)
  | {
      ok: false;
      status: 401;
      code:
        | "missing_authorization"
        | "invalid_authorization_scheme"
        | "invalid_caller_api_key";
    };

export type StoredCallerCredentialStatus =
  "active" | "pending_activation" | "revoked" | "expired";

export type StoredCallerCredentialDigest = {
  accountId: string;
  callerId: string;
  keyId: CallerApiKeyId;
  secretDigest: string;
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  status: StoredCallerCredentialStatus;
};

export type CallerCredentialLookupRow = {
  account_id: string;
  caller_id: string;
  key_id: CallerApiKeyId;
  secret_hmac_sha256: string;
  status: StoredCallerCredentialStatus;
  revoked_at: Date | string | null;
  expires_at: Date | string | null;
};

function tokenDigest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function validateCallerBearer(
  authorizationHeader: string | null,
  expectedToken: string
): CallerAuthResult {
  if (!authorizationHeader) {
    return {
      ok: false,
      status: 401,
      code: "missing_authorization"
    };
  }

  const [scheme, token, extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra) {
    return {
      ok: false,
      status: 401,
      code: "invalid_authorization_scheme"
    };
  }

  const tokenMatches = timingSafeEqual(
    tokenDigest(token),
    tokenDigest(expectedToken)
  );
  if (!tokenMatches) {
    return {
      ok: false,
      status: 403,
      code: "invalid_bearer_token"
    };
  }

  return { ok: true, callerId: "runtime-smoke-caller" };
}

export function generateCallerApiKeyMaterial(): DisplayOnceCallerApiKeyMaterial {
  const keyId = encodeBase32LowerNoPadding(
    randomBytes(CALLER_API_KEY_ID_BYTES)
  );
  const secret = encodeBase32LowerNoPadding(
    randomBytes(CALLER_API_KEY_SECRET_BYTES)
  );
  const plaintextApiKey = formatCallerApiKey({ keyId, secret });
  const secretDigest = callerApiKeySecretDigest(secret);

  return {
    plaintextApiKey,
    secretDigest,
    ...callerApiKeyDisplayMetadata(plaintextApiKey, keyId)
  };
}

export function formatCallerApiKey(parts: CallerApiKeyParts): CallerApiKey {
  return `${CALLER_API_KEY_PREFIX}_${parts.keyId}_${parts.secret}`;
}

export function parseCallerApiKey(apiKey: string): CallerApiKeyParseResult {
  const normalizedApiKey = apiKey.trim();
  const parts = normalizedApiKey.split("_");
  if (
    parts.length !== 4 ||
    parts[0] !== "aob" ||
    parts[1] !== "live" ||
    !isExpectedCallerApiKeyPart(parts[2], CALLER_API_KEY_ID_LENGTH) ||
    !isExpectedCallerApiKeyPart(parts[3], CALLER_API_KEY_SECRET_LENGTH)
  ) {
    return { ok: false, code: "invalid_caller_api_key" };
  }

  const keyId = parts[2];
  const secret = parts[3];
  const displayMetadata = callerApiKeyDisplayMetadata(normalizedApiKey, keyId);

  return {
    ok: true,
    secret,
    ...displayMetadata
  };
}

export function parseCallerBearerApiKey(
  authorizationHeader: string | null
): CallerBearerApiKeyParseResult {
  if (!authorizationHeader) {
    return {
      ok: false,
      status: 401,
      code: "missing_authorization"
    };
  }

  const [scheme, apiKey, extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !apiKey || extra) {
    return {
      ok: false,
      status: 401,
      code: "invalid_authorization_scheme"
    };
  }

  const parsed = parseCallerApiKey(apiKey);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 401,
      code: parsed.code
    };
  }

  return {
    ok: true,
    apiKey,
    keyId: parsed.keyId,
    secret: parsed.secret,
    keyPrefix: parsed.keyPrefix,
    keyLastCharacters: parsed.keyLastCharacters
  };
}

export function callerApiKeySecretDigest(secret: CallerApiKeySecret) {
  const hashSecret = requireCallerKeyHashSecret();

  return createHmac("sha256", hashSecret).update(secret).digest("hex");
}

export function callerCredentialLookupStatement(
  keyId: CallerApiKeyId
): TransactionContextStatement {
  return {
    sql: "select * from public.agent_outbox_lookup_caller_credential($1)",
    values: [keyId]
  };
}

export function storedCallerCredentialDigestFromLookupRow(
  row: CallerCredentialLookupRow
): StoredCallerCredentialDigest {
  return {
    accountId: row.account_id,
    callerId: row.caller_id,
    keyId: row.key_id,
    secretDigest: row.secret_hmac_sha256,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    status: row.status
  };
}

export function callerApiKeyDisplayMetadata(
  apiKey: CallerApiKey,
  keyId: CallerApiKeyId
): CallerApiKeyDisplayMetadata {
  return {
    keyId,
    keyPrefix: apiKey.slice(0, CALLER_API_KEY_PREFIX_VISIBLE_CHARACTERS),
    keyLastCharacters: apiKey.slice(-CALLER_API_KEY_LAST_VISIBLE_CHARACTERS)
  };
}

function base32EncodedLength(byteLength: number) {
  return Math.ceil((byteLength * 8) / 5);
}

function encodeBase32LowerNoPadding(bytes: Uint8Array) {
  let value = 0;
  let bits = 0;
  let encoded = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      encoded += BASE32_LOWER_NO_PADDING_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    encoded += BASE32_LOWER_NO_PADDING_ALPHABET[(value << (5 - bits)) & 31];
  }

  return encoded;
}

function isExpectedCallerApiKeyPart(value: string, expectedLength: number) {
  return (
    value.length === expectedLength &&
    BASE32_LOWER_NO_PADDING_PATTERN.test(value)
  );
}
