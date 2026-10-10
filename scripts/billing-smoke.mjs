import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readOptionalEnvFile } from "./dotenv.mjs";
import {
  check,
  fetchJsonCheck,
  responseCode,
  runChecksCli
} from "./hosted-checks.mjs";

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
  return readOptionalEnvFile(
    env[ENV_FILE_NAME] ?? env[FALLBACK_ENV_FILE_NAME],
    root,
    "Billing smoke"
  );
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

  // The yearly selection expires the known unpaid monthly session before
  // replacement. Keep these requests sequential and never complete either URL.
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
  return fetchJsonCheck(
    `checkout_${interval}`,
    () =>
      fetchImpl(new URL("/api/billing/checkout", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify({ interval }),
        signal: AbortSignal.timeout(timeoutMs)
      }),
    `${interval} Checkout endpoint returned a non-JSON response.`,
    (response, body) => {
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
    }
  );
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string | undefined} baseUrl
 * @param {string} cookie
 * @param {number} timeoutMs
 */
async function portalSessionCheck(fetchImpl, baseUrl, cookie, timeoutMs) {
  return fetchJsonCheck(
    "billing_portal_session",
    () =>
      fetchImpl(new URL("/api/billing/portal", baseUrl), {
        method: "POST",
        headers: { cookie },
        signal: AbortSignal.timeout(timeoutMs)
      }),
    "Billing Portal endpoint returned a non-JSON response.",
    (response, body) => {
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
    }
  );
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runChecksCli(readBillingSmokeEnv, runBillingSmokeChecks);
}
