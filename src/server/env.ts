export const CALLER_KEY_HASH_SECRET_ENV_NAME = "CALLER_KEY_HASH_SECRET";

// HMAC-SHA256 keys should be at least as long as the hash output (32 bytes,
// per RFC 2104) so a short, low-entropy secret cannot weaken caller-key
// digests. The secret is consumed as a UTF-8 string, so this is a character
// floor on the configured value.
export const CALLER_KEY_HASH_SECRET_MIN_LENGTH = 32;

export const RUNTIME_SMOKE_ENV_NAMES = [
  "APP_ENV",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "DATABASE_APP_ROLE_URL",
  "SENTRY_DSN",
  "SMOKE_OR_CLEANUP_TOKEN",
  CALLER_KEY_HASH_SECRET_ENV_NAME
] as const;

export class MissingServerEnvironmentError extends Error {
  readonly code = "missing_server_environment";
  readonly missingName: string;

  constructor(missingName: string) {
    super(`Missing required server environment: ${missingName}`);
    this.name = "MissingServerEnvironmentError";
    this.missingName = missingName;
  }
}

export class InsecureServerEnvironmentError extends Error {
  readonly code = "insecure_server_environment";
  readonly insecureName: string;

  constructor(insecureName: string, requirement: string) {
    super(`Insecure server environment: ${insecureName} ${requirement}`);
    this.name = "InsecureServerEnvironmentError";
    this.insecureName = insecureName;
  }
}

export function requireCallerKeyHashSecret() {
  const value = process.env[CALLER_KEY_HASH_SECRET_ENV_NAME];
  if (!value) {
    throw new MissingServerEnvironmentError(CALLER_KEY_HASH_SECRET_ENV_NAME);
  }

  if (value.length < CALLER_KEY_HASH_SECRET_MIN_LENGTH) {
    throw new InsecureServerEnvironmentError(
      CALLER_KEY_HASH_SECRET_ENV_NAME,
      `must be at least ${CALLER_KEY_HASH_SECRET_MIN_LENGTH} characters`
    );
  }

  return value;
}

export function runtimeConfigStatus() {
  const missing = RUNTIME_SMOKE_ENV_NAMES.filter((name) => !process.env[name]);
  const insecure =
    process.env[CALLER_KEY_HASH_SECRET_ENV_NAME] &&
    process.env[CALLER_KEY_HASH_SECRET_ENV_NAME].length <
      CALLER_KEY_HASH_SECRET_MIN_LENGTH
      ? [CALLER_KEY_HASH_SECRET_ENV_NAME]
      : [];

  return {
    configured: missing.length === 0 && insecure.length === 0,
    missing,
    insecure,
    appEnv: process.env.APP_ENV ?? null,
    appBaseUrlConfigured: Boolean(process.env.APP_BASE_URL),
    publicAppBaseUrlConfigured: Boolean(process.env.PUBLIC_APP_BASE_URL)
  };
}
