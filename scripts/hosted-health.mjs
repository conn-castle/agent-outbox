import { pathToFileURL } from "node:url";

import { readOptionalEnvFile } from "./dotenv.mjs";
import {
  check,
  fetchJsonCheck,
  responseCode,
  runChecksCli,
  safeErrorMessage
} from "./hosted-checks.mjs";
import { ROOT } from "./repo-root.mjs";
import { runtimeProbes } from "./runtime-smoke.mjs";

const ENV_FILE_NAME = "AGENT_OUTBOX_HOSTED_HEALTH_ENV_FILE";
const FALLBACK_ENV_FILE_NAME = "AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE";
const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_ENV_NAMES = ["APP_BASE_URL", "SMOKE_OR_CLEANUP_TOKEN"];

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
  return readOptionalEnvFile(
    env[ENV_FILE_NAME] ?? env[FALLBACK_ENV_FILE_NAME],
    root,
    "Hosted health"
  );
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

  const checks = [];
  for (const probe of runtimeProbes({
    token,
    invalidToken: "invalid",
    requireErrorCanaryEnvelope: true
  })) {
    checks.push(await probeCheck(fetchImpl, baseUrl, probe, timeoutMs));
  }

  for (const evidence of OPERATOR_EVIDENCE) {
    checks.push(evidenceCheck(env, evidence));
  }

  return checks;
}

/**
 * Sends one probe and reports its outcome as a named check.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} baseUrl
 * @param {import("./runtime-smoke.mjs").RuntimeProbe} probe
 * @param {number} timeoutMs
 */
async function probeCheck(fetchImpl, baseUrl, probe, timeoutMs) {
  const { name, path: pathname, expect } = probe;
  const url = new URL(pathname, baseUrl);

  if (expect === "page") {
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

  return fetchJsonCheck(
    name,
    () =>
      fetchImpl(
        url,
        expect === "ok"
          ? {
              method: probe.method,
              headers: probe.headers,
              signal: AbortSignal.timeout(timeoutMs)
            }
          : { headers: probe.headers, signal: AbortSignal.timeout(timeoutMs) }
      ),
    `${pathname} returned a non-JSON response`,
    (response, body) => {
      const details = { status_code: response.status };
      const matched =
        expect === "ok"
          ? response.ok && body.ok === true
          : response.status === expect.status &&
            (expect.code === undefined ||
              (body.ok === false && body.code === expect.code));
      if (!matched) {
        return check(
          name,
          "fail",
          responseCode(body, "unexpected_response"),
          expect === "ok"
            ? `${pathname} returned an unexpected response`
            : `${pathname} did not return ${expect.code ?? expect.status}`,
          details
        );
      }
      try {
        probe.validate?.(body);
      } catch (error) {
        return check(
          name,
          "fail",
          "unexpected_response",
          safeErrorMessage(error),
          details
        );
      }
      return expect === "ok"
        ? check(
            name,
            "pass",
            String(body.code ?? "ok"),
            `${pathname} ok`,
            details
          )
        : check(
            name,
            "pass",
            expect.code ?? String(body.code),
            `${pathname} rejected as expected`,
            details
          );
    }
  );
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runChecksCli(readHostedHealthEnv, runHostedHealthChecks);
}
