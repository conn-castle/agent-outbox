#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ description?: string, enabled?: boolean, [key: string]: unknown }} CloudflareRule
 * @typedef {{ rules?: CloudflareRule[], [key: string]: unknown }} CloudflareRuleset
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} FetchImpl
 * @typedef {{ zoneId: string, token: string, fetchImpl?: FetchImpl }} CloudflareInput
 * @typedef {{ token: string, fetchImpl: FetchImpl, method: "GET" | "PUT", path: string, body?: unknown }} CloudflareRequestInput
 */

export const RATE_LIMIT_RULE_DESCRIPTION =
  "Prepared inactive rate limit for Agent Outbox client events";
export const RATE_LIMIT_PHASE = "http_ratelimit";
export const CLIENT_EVENTS_RATE_LIMIT_EXPRESSION =
  '(http.request.uri.path eq "/api/client-events")';

const API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * @param {CloudflareRule[]} [existingRules]
 * @returns {CloudflareRuleset}
 */
export function buildClientEventsRateLimitRuleset(existingRules = []) {
  const nextRule = {
    description: RATE_LIMIT_RULE_DESCRIPTION,
    expression: CLIENT_EVENTS_RATE_LIMIT_EXPRESSION,
    action: "block",
    enabled: false,
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: 120,
      mitigation_timeout: 10,
      requests_to_origin: true
    },
    action_parameters: {
      response: {
        status_code: 429,
        content_type: "application/json",
        content: '{ "error": "rate_limited" }'
      }
    }
  };
  const rules = [
    ...existingRules.filter(
      (rule) => rule?.description !== RATE_LIMIT_RULE_DESCRIPTION
    ),
    nextRule
  ];
  // The phase entrypoint PUT accepts only description and rules; the ruleset
  // name and kind are immutable and the phase is implied by the URL, so
  // Cloudflare rejects them in the request body.
  return {
    description:
      "Prepared-but-inactive Agent Outbox rate limits. Source checked against Cloudflare Rulesets API docs on 2026-07-07.",
    rules
  };
}

/**
 * @param {CloudflareInput & { fetchImpl: FetchImpl }} input
 */
export async function readRateLimitEntrypoint({ zoneId, token, fetchImpl }) {
  return cloudflareRequest({
    token,
    fetchImpl,
    method: "GET",
    path: `/zones/${zoneId}/rulesets/phases/${RATE_LIMIT_PHASE}/entrypoint`
  });
}

/**
 * @param {CloudflareInput} input
 */
export async function checkRateLimitRule({ zoneId, token, fetchImpl = fetch }) {
  const response = await readRateLimitEntrypoint({ zoneId, token, fetchImpl });
  if (response.status === 404) {
    return { ok: false, present: false, enabled: false };
  }
  const result = await parseCloudflareResponse(response);
  const rule = findPreparedRule(result);
  return {
    ok: true,
    present: Boolean(rule),
    enabled: rule?.enabled === true
  };
}

/**
 * @param {CloudflareInput} input
 */
export async function applyRateLimitRule({ zoneId, token, fetchImpl = fetch }) {
  const current = await readRateLimitEntrypoint({ zoneId, token, fetchImpl });
  /** @type {CloudflareRule[]} */
  let existingRules = [];
  if (current.status !== 404) {
    const currentResult = await parseCloudflareResponse(current);
    if (!Array.isArray(currentResult.rules)) {
      throw new Error("Cloudflare entrypoint response did not include rules.");
    }
    existingRules = currentResult.rules;
  }

  const payload = buildClientEventsRateLimitRuleset(existingRules);
  const response = await cloudflareRequest({
    token,
    fetchImpl,
    method: "PUT",
    path: `/zones/${zoneId}/rulesets/phases/${RATE_LIMIT_PHASE}/entrypoint`,
    body: payload
  });
  await parseCloudflareResponse(response);
  return payload;
}

/**
 * @param {CloudflareRequestInput} input
 */
export async function cloudflareRequest({
  token,
  fetchImpl,
  method,
  path,
  body
}) {
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${token}`
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  return fetchImpl(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * @param {Response} response
 * @returns {Promise<CloudflareRuleset>}
 */
async function parseCloudflareResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const errorMessage = Array.isArray(payload?.errors)
      ? payload.errors
          .map(
            /** @param {{ message?: unknown }} error */
            (error) => error?.message
          )
          .filter(Boolean)
          .join("; ")
      : "";
    const suffix = errorMessage ? `: ${errorMessage}` : "";
    throw new Error(
      `Cloudflare Rulesets API rejected the request (${response.status})${suffix}`
    );
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    throw new Error("Cloudflare Rulesets API response did not include result.");
  }
  return payload.result;
}

/**
 * @param {CloudflareRuleset} result
 */
function findPreparedRule(result) {
  const rules = Array.isArray(result?.rules) ? result.rules : [];
  return rules.find(
    (rule) => rule?.description === RATE_LIMIT_RULE_DESCRIPTION
  );
}

/**
 * @param {string} name
 */
function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const mode = argv[2];
  if (mode !== "--check" && mode !== "--apply") {
    throw new Error(
      "Usage: node scripts/cloudflare-ratelimit.mjs --check|--apply"
    );
  }

  const zoneId = requiredEnv("CLOUDFLARE_ZONE_ID");
  const token = requiredEnv("CLOUDFLARE_WAF_API_TOKEN");
  if (mode === "--check") {
    const result = await checkRateLimitRule({ zoneId, token });
    console.log(
      JSON.stringify({
        ok: result.ok,
        present: result.present,
        enabled: result.enabled
      })
    );
    // The prepared rule must exist and stay disabled; fail the check if it is
    // missing or has been activated so the runbook's present:true / enabled:false
    // expectation is enforced by exit code, not just reported in the JSON.
    if (!result.present || result.enabled) {
      process.exitCode = 1;
    }
    return;
  }

  const payload = await applyRateLimitRule({ zoneId, token });
  const preparedRule = findPreparedRule(payload);
  console.log(
    JSON.stringify({
      ok: true,
      prepared_rule_present: Boolean(preparedRule),
      prepared_rule_enabled: preparedRule?.enabled === true
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
