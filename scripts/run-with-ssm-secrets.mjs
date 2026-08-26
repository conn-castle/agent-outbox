#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import url from "node:url";

export const DEFAULT_AWS_PROFILE = "conn";

const PRODUCTION = "/agent-outbox/environments/production";

/** @type {Readonly<Record<string, ReadonlyArray<{envVar: string, parameter: string}>>>} */
export const SECRET_SETS = Object.freeze({
  "cloudflare-ratelimit-production": Object.freeze([
    {
      envVar: "CLOUDFLARE_ZONE_ID",
      parameter: `${PRODUCTION}/cloudflare-zone-id`
    },
    {
      envVar: "CLOUDFLARE_WAF_API_TOKEN",
      parameter: `${PRODUCTION}/cloudflare-waf-api-token`
    }
  ]),
  "sentry-production": Object.freeze([
    {
      envVar: "SENTRY_AUTH_TOKEN",
      parameter: `${PRODUCTION}/sentry-auth-token`
    },
    {
      envVar: "SENTRY_ORG",
      parameter: `${PRODUCTION}/sentry-organization-slug`
    },
    {
      envVar: "SENTRY_PROJECT",
      parameter: `${PRODUCTION}/sentry-project-slug`
    }
  ])
});

/** @param {string[]} argv */
export function parseArguments(argv) {
  if (argv[0] !== "--set" || !argv[1]) {
    throw new Error(
      "usage: run-with-ssm-secrets.mjs --set <name> -- <command> [args...]"
    );
  }

  const separator = argv.indexOf("--", 2);
  if (separator === -1 || !argv[separator + 1]) {
    throw new Error("a command is required after --");
  }

  if (separator !== 2) {
    throw new Error(`unexpected argument: ${argv[2]}`);
  }

  return {
    setName: argv[1],
    command: argv[separator + 1],
    commandArgs: argv.slice(separator + 2).filter((arg, index) => {
      return index !== 0 || arg !== "--";
    })
  };
}

/** @param {string} setName */
export function setEntries(setName) {
  const entries = SECRET_SETS[setName];
  if (!entries) {
    throw new Error(
      `unknown secret set '${setName}'; known sets: ${Object.keys(SECRET_SETS)
        .sort()
        .join(", ")}`
    );
  }
  return entries;
}

/**
 * @param {string} setName
 * @param {{profile?: string, readParameter?: (parameter: string, profile: string) => string}} [options]
 */
export function loadSecretEnvironment(
  setName,
  {
    profile = process.env.AWS_PROFILE || DEFAULT_AWS_PROFILE,
    readParameter = readSsmParameter
  } = {}
) {
  return Object.fromEntries(
    setEntries(setName).map(({ envVar, parameter }) => [
      envVar,
      readParameter(parameter, profile)
    ])
  );
}

/**
 * @param {string} parameter
 * @param {string} profile
 */
function readSsmParameter(parameter, profile) {
  let output;
  try {
    output = execFileSync(
      "aws",
      [
        "ssm",
        "get-parameter",
        "--profile",
        profile,
        "--name",
        parameter,
        "--with-decryption",
        "--query",
        "Parameter.Value",
        "--output",
        "json"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    const caught = /** @type {{stderr?: string|Buffer, message?: string}} */ (
      error
    );
    const detail = String(caught.stderr ?? caught.message ?? error).trim();
    throw new Error(
      `could not read ${parameter} with AWS profile ${profile}: ${detail}\n` +
        `Authenticate with: aws sso login --profile ${profile} --use-device-code --no-browser`
    );
  }

  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(
      `could not parse the SSM response for ${parameter} with AWS profile ${profile}`
    );
  }
  if (typeof value !== "string") {
    throw new Error(
      `SSM returned a non-string value for ${parameter} with AWS profile ${profile}`
    );
  }
  return value;
}

/** @param {string[]} argv */
export function run(argv) {
  const { setName, command, commandArgs } = parseArguments(argv);
  const secrets = loadSecretEnvironment(setName);
  const result = spawnSync(command, commandArgs, {
    env: { ...process.env, ...secrets },
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function isInvokedAsScript() {
  return (
    process.argv[1] &&
    url.pathToFileURL(process.argv[1]).href === import.meta.url
  );
}

if (isInvokedAsScript()) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-with-ssm-secrets: ${message}\n`);
    process.exitCode = 1;
  }
}
