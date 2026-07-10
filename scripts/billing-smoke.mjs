import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseEnv } from "./foundation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE_NAME = "AGENT_OUTBOX_BILLING_SMOKE_ENV_FILE";
const FALLBACK_ENV_FILE_NAME = "AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE";
const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_ENV_NAMES = [
  "APP_BASE_URL",
  "PUBLIC_APP_BASE_URL",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
];
const COOKIE_ENV_NAME = "AGENT_OUTBOX_BILLING_SMOKE_COOKIE";

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   root?: string
 * }} [options]
 * @returns {Map<string, string>}
 */
export function readBillingSmokeEnv(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? ROOT;
  const explicitPath = env[ENV_FILE_NAME] ?? env[FALLBACK_ENV_FILE_NAME];
  const envPath =
    explicitPath && explicitPath.trim() !== ""
      ? path.resolve(explicitPath)
      : path.join(root, ".env");
  if (!existsSync(envPath)) {
    if (explicitPath) {
      throw new Error(`Billing smoke env file does not exist: ${envPath}`);
    }
    return new Map();
  }

  return parseEnv(readFileSync(envPath, "utf8"));
}

/**
 * @param {string} name
 * @param {"pass" | "fail" | "action_required"} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function check(name, status, code, message, details = {}) {
  return { name, status, code, message, ...details };
}

/**
 * @param {Map<string, string>} env
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number
 * }} [options]
 */
export async function runBillingSmokeChecks(env, options = {}) {
  const missing = REQUIRED_ENV_NAMES.filter((name) => !env.get(name));
  if (missing.length > 0) {
    return [
      check(
        "configuration",
        "fail",
        "missing_configuration",
        `Missing required values: ${missing.join(", ")}`
      )
    ];
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const baseUrl = env.get("APP_BASE_URL");
  const publicBaseUrl = env.get("PUBLIC_APP_BASE_URL");
  const cookie = env.get(COOKIE_ENV_NAME)?.trim();
  const checks = [
    publicUrlCheck(baseUrl, publicBaseUrl),
    priceConfigCheck(env),
    portalConfigCheck(env)
  ];

  if (!cookie) {
    checks.push(
      check(
        "checkout_sessions",
        "action_required",
        "clerk_session_cookie_required",
        `${COOKIE_ENV_NAME} is required to create hosted Checkout sessions.`
      ),
      check(
        "billing_portal_session",
        "action_required",
        "clerk_session_cookie_required",
        `${COOKIE_ENV_NAME} is required to create a hosted Billing Portal session.`
      )
    );
    return checks;
  }

  checks.push(
    await checkoutSessionCheck(fetchImpl, baseUrl, cookie, "monthly", timeoutMs)
  );
  checks.push(
    await checkoutSessionCheck(fetchImpl, baseUrl, cookie, "yearly", timeoutMs)
  );
  checks.push(await portalSessionCheck(fetchImpl, baseUrl, cookie, timeoutMs));
  checks.push(
    check(
      "live_completion",
      "action_required",
      "owner_approval_required",
      "Full live completion requires an owner-approved no-charge or charge/refund protocol."
    )
  );

  return checks;
}

/**
 * @param {string | undefined} baseUrl
 * @param {string | undefined} publicBaseUrl
 */
function publicUrlCheck(baseUrl, publicBaseUrl) {
  if (baseUrl === publicBaseUrl && baseUrl?.startsWith("https://")) {
    return check(
      "public_urls",
      "pass",
      "public_urls_match",
      "APP_BASE_URL and PUBLIC_APP_BASE_URL match over HTTPS"
    );
  }

  return check(
    "public_urls",
    "fail",
    "public_urls_mismatch",
    "APP_BASE_URL and PUBLIC_APP_BASE_URL must match over HTTPS for hosted billing redirects."
  );
}

/**
 * @param {Map<string, string>} env
 */
function priceConfigCheck(env) {
  const monthly = env.get("STRIPE_PAID_MONTHLY_PRICE_ID") ?? "";
  const yearly = env.get("STRIPE_PAID_YEARLY_PRICE_ID") ?? "";
  if (monthly.startsWith("price_") && yearly.startsWith("price_")) {
    return check(
      "price_config",
      "pass",
      "price_ids_configured",
      "Monthly and yearly Stripe price ids are configured."
    );
  }

  return check(
    "price_config",
    "fail",
    "invalid_price_ids",
    "Monthly and yearly Stripe price ids must be configured."
  );
}

/**
 * @param {Map<string, string>} env
 */
function portalConfigCheck(env) {
  const portal = env.get("STRIPE_BILLING_PORTAL_CONFIGURATION_ID") ?? "";
  if (portal.startsWith("bpc_")) {
    return check(
      "portal_config",
      "pass",
      "portal_configured",
      "Stripe Billing Portal configuration id is configured."
    );
  }

  return check(
    "portal_config",
    "fail",
    "invalid_portal_configuration",
    "Stripe Billing Portal configuration id must be configured."
  );
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string | undefined} baseUrl
 * @param {string} cookie
 * @param {"monthly" | "yearly"} interval
 * @param {number} timeoutMs
 */
async function checkoutSessionCheck(
  fetchImpl,
  baseUrl,
  cookie,
  interval,
  timeoutMs
) {
  try {
    const response = await fetchImpl(
      new URL("/api/billing/checkout", baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify({ interval }),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await response.json();
    } catch {
      return check(
        `checkout_${interval}`,
        "fail",
        "invalid_json_response",
        `${interval} Checkout endpoint returned a non-JSON response.`,
        { status_code: response.status }
      );
    }
    if (response.status === 401 || response.status === 403) {
      return check(
        `checkout_${interval}`,
        "action_required",
        "valid_clerk_session_required",
        "A valid Clerk session cookie is required for hosted Checkout smoke."
      );
    }
    const url = responseDataUrl(body);
    if (
      response.ok &&
      body.ok === true &&
      url?.startsWith("https://checkout.stripe.com/")
    ) {
      return check(
        `checkout_${interval}`,
        "pass",
        "checkout_session_created",
        `${interval} Checkout session was created.`
      );
    }
    return check(
      `checkout_${interval}`,
      "fail",
      responseCode(body, "checkout_unexpected_response"),
      `${interval} Checkout session was not created.`,
      { status_code: response.status }
    );
  } catch (error) {
    return check(
      `checkout_${interval}`,
      "fail",
      "request_failed",
      safeErrorMessage(error)
    );
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string | undefined} baseUrl
 * @param {string} cookie
 * @param {number} timeoutMs
 */
async function portalSessionCheck(fetchImpl, baseUrl, cookie, timeoutMs) {
  try {
    const response = await fetchImpl(new URL("/api/billing/portal", baseUrl), {
      method: "POST",
      headers: { cookie },
      signal: AbortSignal.timeout(timeoutMs)
    });
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await response.json();
    } catch {
      return check(
        "billing_portal_session",
        "fail",
        "invalid_json_response",
        "Billing Portal endpoint returned a non-JSON response.",
        { status_code: response.status }
      );
    }
    if (response.status === 401 || response.status === 403) {
      return check(
        "billing_portal_session",
        "action_required",
        "valid_clerk_session_required",
        "A valid Clerk session cookie is required for Billing Portal smoke."
      );
    }
    if (
      response.status === 400 &&
      responseCode(body, "") === "invalid_request"
    ) {
      return check(
        "billing_portal_session",
        "action_required",
        "active_stripe_customer_required",
        "Billing Portal smoke requires an account with an existing Stripe customer."
      );
    }
    const url = responseDataUrl(body);
    if (
      response.ok &&
      body.ok === true &&
      url?.startsWith("https://billing.stripe.com/")
    ) {
      return check(
        "billing_portal_session",
        "pass",
        "portal_session_created",
        "Billing Portal session was created."
      );
    }
    return check(
      "billing_portal_session",
      "fail",
      responseCode(body, "portal_unexpected_response"),
      "Billing Portal session was not created.",
      { status_code: response.status }
    );
  } catch (error) {
    return check(
      "billing_portal_session",
      "fail",
      "request_failed",
      safeErrorMessage(error)
    );
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} fallback
 */
function responseCode(body, fallback) {
  const nestedError =
    body.error && typeof body.error === "object"
      ? /** @type {Record<string, unknown>} */ (body.error)
      : {};
  return String(body.code ?? nestedError.code ?? fallback);
}

/**
 * @param {Record<string, unknown>} body
 */
function responseDataUrl(body) {
  const data =
    body.data && typeof body.data === "object"
      ? /** @type {Record<string, unknown>} */ (body.data)
      : {};
  return typeof data.url === "string" ? data.url : null;
}

/**
 * @param {unknown} error
 */
function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "request failed";
}

/**
 * @param {Array<{ status: string }>} checks
 */
export function exitCodeForBillingSmoke(checks) {
  if (checks.some((entry) => entry.status === "fail")) {
    return 1;
  }
  if (checks.some((entry) => entry.status === "action_required")) {
    return 2;
  }
  return 0;
}

/**
 * @param {Array<{ status: string }>} checks
 */
export function billingSmokeSummary(checks) {
  return {
    ok: checks.every((entry) => entry.status === "pass"),
    action_required: checks.some((entry) => entry.status === "action_required"),
    checks
  };
}

async function main() {
  let env;
  try {
    env = readBillingSmokeEnv();
  } catch (error) {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const checks = await runBillingSmokeChecks(env);
  const summary = billingSmokeSummary(checks);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = exitCodeForBillingSmoke(checks);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
