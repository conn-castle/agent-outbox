import { parseJsonc } from "../system-contract.mjs";

const REQUIRED_WORKER_SECRET_NAMES = [
  "CLERK_SECRET_KEY",
  "SENTRY_DSN",
  "CALLER_KEY_HASH_SECRET",
  "SMOKE_OR_CLEANUP_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET"
];

/**
 * @param {string} wranglerConfigContent
 * @param {string} runtimeCronSchedule
 * @returns {string[]}
 */
export function validateWranglerCronSchedule(
  wranglerConfigContent,
  runtimeCronSchedule
) {
  let config;
  try {
    config = /** @type {{ triggers?: { crons?: unknown } }} */ (
      parseJsonc(wranglerConfigContent)
    );
  } catch {
    return ["wrangler.jsonc must be parseable JSONC for cron drift checks"];
  }

  const crons = config?.triggers?.crons;
  if (
    !Array.isArray(crons) ||
    !crons.every((cron) => typeof cron === "string")
  ) {
    return ["wrangler.jsonc triggers.crons must be a string array"];
  }

  const failures = [];
  if (crons.length !== 1) {
    failures.push(
      "wrangler.jsonc must define exactly one cron while the runtime scheduled canary reports one configured schedule"
    );
  }

  if (!crons.includes(runtimeCronSchedule)) {
    failures.push(
      `wrangler.jsonc triggers.crons must include runtime scheduled canary ${runtimeCronSchedule}`
    );
  }

  return failures;
}

/**
 * @param {string} wranglerConfigContent
 * @returns {string[]}
 */
export function validateWranglerRequiredSecrets(wranglerConfigContent) {
  let config;
  try {
    config = /** @type {{ secrets?: { required?: unknown } }} */ (
      parseJsonc(wranglerConfigContent)
    );
  } catch {
    return ["wrangler.jsonc must be parseable JSONC for secret drift checks"];
  }

  const requiredSecrets = config?.secrets?.required;
  if (
    !Array.isArray(requiredSecrets) ||
    !requiredSecrets.every((name) => typeof name === "string")
  ) {
    return ["wrangler.jsonc secrets.required must be a string array"];
  }

  const expected = new Set(REQUIRED_WORKER_SECRET_NAMES);
  const actual = new Set(requiredSecrets);
  const failures = [];
  for (const name of REQUIRED_WORKER_SECRET_NAMES) {
    if (!actual.has(name)) {
      failures.push(`wrangler.jsonc secrets.required missing ${name}`);
    }
  }
  for (const name of requiredSecrets) {
    if (!expected.has(name)) {
      failures.push(
        `wrangler.jsonc secrets.required must not include non-Worker secret or config ${name}`
      );
    }
  }

  return failures;
}
