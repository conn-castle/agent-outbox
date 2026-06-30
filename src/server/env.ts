const RUNTIME_SMOKE_ENV_NAMES = [
  "APP_ENV",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "DATABASE_APP_ROLE_URL",
  "SENTRY_DSN",
  "SMOKE_OR_CLEANUP_TOKEN"
] as const;

export function runtimeConfigStatus() {
  const missing = RUNTIME_SMOKE_ENV_NAMES.filter((name) => !process.env[name]);

  return {
    configured: missing.length === 0,
    missing,
    appEnv: process.env.APP_ENV ?? null,
    appBaseUrlConfigured: Boolean(process.env.APP_BASE_URL),
    publicAppBaseUrlConfigured: Boolean(process.env.PUBLIC_APP_BASE_URL)
  };
}
