import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseEnv } from "./foundation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE_NAME = "AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE";
const FALLBACK_ENV_FILE_NAME = "AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE";
const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_ENV_NAMES = ["APP_BASE_URL", "SMOKE_OR_CLEANUP_TOKEN"];
const SMOKE_HEADERS = {
  "x-agent-outbox-runtime-smoke": "1"
};

const OPERATOR_EVIDENCE = [
  {
    name: "quota",
    envName: "AGENT_OUTBOX_HOSTED_HEALTH_QUOTA_EVIDENCE",
    code: "quota_evidence_required",
    message:
      "Provide content-safe quota evidence or run a smoke-safe quota canary."
  },
  {
    name: "file_path",
    envName: "AGENT_OUTBOX_HOSTED_HEALTH_FILE_EVIDENCE",
    code: "file_path_evidence_required",
    message:
      "Provide a smoke-safe file upload/download evidence marker before launch."
  },
  {
    name: "audit_events",
    envName: "AGENT_OUTBOX_HOSTED_HEALTH_AUDIT_EVIDENCE",
    code: "audit_event_evidence_required",
    message:
      "Provide content-safe audit-event evidence or run a smoke-safe audit canary."
  },
  {
    name: "abuse_cost",
    envName: "AGENT_OUTBOX_HOSTED_HEALTH_ABUSE_COST_EVIDENCE",
    code: "abuse_cost_evidence_required",
    message:
      "Provide read-only provider aggregate evidence for abuse and cost signals."
  }
];

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   root?: string
 * }} [options]
 * @returns {Map<string, string>}
 */
export function readHostedHealthEnv(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? ROOT;
  const explicitPath = env[ENV_FILE_NAME] ?? env[FALLBACK_ENV_FILE_NAME];
  const envPath =
    explicitPath && explicitPath.trim() !== ""
      ? path.resolve(explicitPath)
      : path.join(root, ".env");
  if (!existsSync(envPath)) {
    if (explicitPath) {
      throw new Error(`Hosted health env file does not exist: ${envPath}`);
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
export async function runHostedHealthChecks(env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const baseUrl = env.get("APP_BASE_URL");
  const token = env.get("SMOKE_OR_CLEANUP_TOKEN");
  if (!baseUrl || !token) {
    const missing = REQUIRED_ENV_NAMES.filter((name) => !env.get(name));
    return [
      check(
        "configuration",
        "fail",
        "missing_configuration",
        `Missing required values: ${missing.join(", ")}`
      )
    ];
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  const checks = [];

  checks.push(
    await pageCheck(fetchImpl, baseUrl, "/sign-in", "app", timeoutMs)
  );
  checks.push(
    await pageCheck(fetchImpl, baseUrl, "/sign-out", "auth", timeoutMs)
  );
  checks.push(
    await pageCheck(fetchImpl, baseUrl, "/human", "human_queue", timeoutMs)
  );
  checks.push(
    await jsonCheck(fetchImpl, baseUrl, "/api/runtime/canary", "runtime", {
      headers: authHeaders,
      timeoutMs
    })
  );
  checks.push(
    await errorCodeCheck(
      fetchImpl,
      baseUrl,
      "/api/runtime/caller-auth",
      "caller_api_rejects_missing_auth",
      401,
      "missing_authorization",
      { timeoutMs }
    )
  );
  checks.push(
    await errorCodeCheck(
      fetchImpl,
      baseUrl,
      "/api/runtime/caller-auth",
      "caller_api_rejects_invalid_auth",
      403,
      "invalid_bearer_token",
      { headers: { Authorization: "Bearer invalid" }, timeoutMs }
    )
  );
  checks.push(
    await jsonCheck(
      fetchImpl,
      baseUrl,
      "/api/runtime/caller-auth",
      "caller_api_accepts_smoke_auth",
      { headers: authHeaders, timeoutMs }
    )
  );
  checks.push(
    await jsonCheck(fetchImpl, baseUrl, "/api/runtime/database", "database", {
      headers: authHeaders,
      timeoutMs,
      validate: (body) =>
        body.transaction_context_matched === true &&
        body.restricted_role_matched === true &&
        (body.human_review_query_matched === undefined ||
          body.human_review_query_matched === true)
    })
  );
  checks.push(
    await jsonCheck(fetchImpl, baseUrl, "/api/runtime/log", "logs", {
      headers: authHeaders,
      timeoutMs
    })
  );
  checks.push(
    await jsonCheck(fetchImpl, baseUrl, "/api/runtime/scheduled", "cleanup", {
      method: "POST",
      headers: authHeaders,
      timeoutMs
    })
  );
  checks.push(
    await jsonCheck(fetchImpl, baseUrl, "/api/runtime/sentry", "sentry", {
      method: "POST",
      headers: { ...SMOKE_HEADERS, ...authHeaders },
      timeoutMs,
      validate: (body) => body.sentry_capture_suppressed === true
    })
  );

  for (const evidence of OPERATOR_EVIDENCE) {
    checks.push(evidenceCheck(env, evidence));
  }

  return checks;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} name
 * @param {number} timeoutMs
 */
async function pageCheck(fetchImpl, baseUrl, pathname, name, timeoutMs) {
  const url = new URL(pathname, baseUrl);
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status >= 200 && response.status < 400) {
      return check(name, "pass", "reachable", `${pathname} is reachable`, {
        status_code: response.status
      });
    }
    return check(name, "fail", "unexpected_status", `${pathname} failed`, {
      status_code: response.status
    });
  } catch (error) {
    return check(name, "fail", "request_failed", safeErrorMessage(error));
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} name
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs: number,
 *   validate?: (body: Record<string, unknown>) => boolean
 * }} options
 */
async function jsonCheck(fetchImpl, baseUrl, pathname, name, options) {
  const url = new URL(pathname, baseUrl);
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await response.json();
    } catch {
      return check(
        name,
        "fail",
        "invalid_json_response",
        `${pathname} returned a non-JSON response`,
        { status_code: response.status }
      );
    }
    const valid = options.validate ? options.validate(body) : true;
    if (response.ok && body.ok === true && valid) {
      return check(name, "pass", String(body.code ?? "ok"), `${pathname} ok`, {
        status_code: response.status
      });
    }
    return check(
      name,
      "fail",
      responseCode(body, "unexpected_response"),
      `${pathname} returned an unexpected response`,
      { status_code: response.status }
    );
  } catch (error) {
    return check(name, "fail", "request_failed", safeErrorMessage(error));
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} name
 * @param {number} status
 * @param {string} code
 * @param {{ headers?: Record<string, string>, timeoutMs: number }} options
 */
async function errorCodeCheck(
  fetchImpl,
  baseUrl,
  pathname,
  name,
  status,
  code,
  options
) {
  const url = new URL(pathname, baseUrl);
  try {
    const response = await fetchImpl(url, {
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await response.json();
    } catch {
      return check(
        name,
        "fail",
        "invalid_json_response",
        `${pathname} returned a non-JSON response`,
        { status_code: response.status }
      );
    }
    if (response.status === status && body.ok === false && body.code === code) {
      return check(name, "pass", code, `${pathname} rejected as expected`, {
        status_code: response.status
      });
    }
    return check(
      name,
      "fail",
      responseCode(body, "unexpected_response"),
      `${pathname} did not return ${code}`,
      { status_code: response.status }
    );
  } catch (error) {
    return check(name, "fail", "request_failed", safeErrorMessage(error));
  }
}

/**
 * @param {Map<string, string>} env
 * @param {{ name: string, envName: string, code: string, message: string }} evidence
 */
function evidenceCheck(env, evidence) {
  if (env.get(evidence.envName)?.trim()) {
    return check(
      evidence.name,
      "pass",
      "operator_evidence_present",
      `${evidence.name} evidence marker is present`
    );
  }

  return check(
    evidence.name,
    "action_required",
    evidence.code,
    evidence.message
  );
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
 * @param {unknown} error
 */
function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "request failed";
}

/**
 * @param {Array<{ status: string }>} checks
 */
export function exitCodeForHostedHealth(checks) {
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
export function hostedHealthSummary(checks) {
  return {
    ok: checks.every((entry) => entry.status === "pass"),
    action_required: checks.some((entry) => entry.status === "action_required"),
    checks
  };
}

async function main() {
  let env;
  try {
    env = readHostedHealthEnv();
  } catch (error) {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const checks = await runHostedHealthChecks(env);
  const summary = hostedHealthSummary(checks);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = exitCodeForHostedHealth(checks);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
