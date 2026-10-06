/** Setup-request helpers shared by caller connect and rotate/revoke flows. */
import { createHmac, randomInt } from "node:crypto";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

import {
  apiTemporaryUnavailable,
  type ApiErrorInput,
  type ApiFieldError
} from "./api-errors.ts";
import type { TransactionContextStatement } from "./database.ts";
import { absoluteHttpOrigin, requireCallerKeyHashSecret } from "./env.ts";
import { isStorableString, unstorableStringError } from "./input-schema.ts";

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
