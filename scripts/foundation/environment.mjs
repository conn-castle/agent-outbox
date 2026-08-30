import { parseEnv } from "../dotenv.mjs";

const REQUIRED_ENV_NAMES = [
  "APP_ENV",
  "PORT",
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "SUPABASE_PROJECT_REF",
  "DATABASE_URL",
  "DATABASE_APP_ROLE_URL",
  "DATABASE_MIGRATION_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "STRIPE_ACCOUNT_ID",
  "SENTRY_DSN",
  "SENTRY_BROWSER_DSN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN"
];

const OPTIONAL_LOCAL_ENV_NAMES = [
  "AGENT_OUTBOX_BASE_URL",
  "AGENT_OUTBOX_CONFIG_PATH",
  "AGENT_OUTBOX_CALLER",
  "AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE",
  "AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE",
  "AGENT_OUTBOX_HOSTED_HEALTH_QUOTA_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_FILE_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_AUDIT_EVIDENCE",
  "AGENT_OUTBOX_HOSTED_HEALTH_ABUSE_COST_EVIDENCE",
  "AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE",
  "AGENT_OUTBOX_BILLING_SMOKE_COOKIE",
  "AWS_PROFILE",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_ZONE_NAME",
  "CLOUDFLARE_NAMESERVERS",
  "CLOUDFLARE_DNS_API_TOKEN",
  "CLOUDFLARE_HYPERDRIVE_ID",
  "CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN",
  "CLOUDFLARE_TOKEN_MANAGEMENT_API_TOKEN",
  "CLOUDFLARE_WAF_API_TOKEN",
  "NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN",
  "SENTRY_RELEASE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD",
  "AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH"
];

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function requiredEnvNames(exampleContent) {
  const exampleNames = new Set(parseEnv(exampleContent).keys());
  return REQUIRED_ENV_NAMES.filter((name) => exampleNames.has(name));
}

/**
 * @param {string} exampleContent
 * @returns {string[]}
 */
export function validateRequiredEnvExample(exampleContent) {
  const actualNames = [...parseEnv(exampleContent).keys()];
  const expectedNames = new Set(REQUIRED_ENV_NAMES);
  const allowedNames = new Set([
    ...REQUIRED_ENV_NAMES,
    ...OPTIONAL_LOCAL_ENV_NAMES
  ]);
  const actualNameSet = new Set(actualNames);

  const missing = REQUIRED_ENV_NAMES.filter((name) => !actualNameSet.has(name));
  const extra = actualNames.filter((name) => !allowedNames.has(name));

  return [
    ...missing.map((name) => `.env.example missing required name ${name}`),
    ...extra.map((name) => `.env.example contains unknown name ${name}`)
  ];
}

/**
 * @param {string} exampleContent
 * @param {string} actualContent
 * @returns {string[]}
 */
export function missingEnvNames(exampleContent, actualContent) {
  const actual = parseEnv(actualContent);
  return requiredEnvNames(exampleContent).filter((name) => !actual.get(name));
}
