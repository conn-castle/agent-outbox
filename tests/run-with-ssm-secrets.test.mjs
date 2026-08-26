import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AWS_PROFILE,
  loadSecretEnvironment,
  parseArguments,
  setEntries
} from "../scripts/run-with-ssm-secrets.mjs";

test("parses a named secret set and child command", () => {
  assert.deepEqual(
    parseArguments([
      "--set",
      "sentry-production",
      "--",
      "sentry-cli",
      "issues",
      "list"
    ]),
    {
      setName: "sentry-production",
      command: "sentry-cli",
      commandArgs: ["issues", "list"]
    }
  );
});

test("removes pnpm's forwarded argument separator", () => {
  assert.deepEqual(
    parseArguments([
      "--set",
      "sentry-production",
      "--",
      "sentry-cli",
      "--",
      "issues",
      "list"
    ]).commandArgs,
    ["issues", "list"]
  );
});

test("rejects an unknown secret set with the supported names", () => {
  assert.throws(
    () => setEntries("missing"),
    /known sets: cloudflare-ratelimit-production, sentry-production/
  );
});

test("loads only the Cloudflare rate-limit parameters", () => {
  /** @type {string[]} */
  const parameters = [];
  const environment = loadSecretEnvironment("cloudflare-ratelimit-production", {
    profile: DEFAULT_AWS_PROFILE,
    readParameter(parameter) {
      parameters.push(parameter);
      return `value-for-${parameter.split("/").at(-1)}`;
    }
  });

  assert.deepEqual(environment, {
    CLOUDFLARE_ZONE_ID: "value-for-cloudflare-zone-id",
    CLOUDFLARE_WAF_API_TOKEN: "value-for-cloudflare-waf-api-token"
  });
  assert.deepEqual(parameters, [
    "/agent-outbox/environments/production/cloudflare-zone-id",
    "/agent-outbox/environments/production/cloudflare-waf-api-token"
  ]);
});

test("loads only the selected SSM parameters using the canonical conn profile", () => {
  /** @type {Array<{parameter: string, profile: string}>} */
  const reads = [];
  const environment = loadSecretEnvironment("sentry-production", {
    profile: DEFAULT_AWS_PROFILE,
    readParameter(parameter, profile) {
      reads.push({ parameter, profile });
      return `value-for-${parameter.split("/").at(-1)}`;
    }
  });

  assert.equal(DEFAULT_AWS_PROFILE, "conn");
  assert.deepEqual(environment, {
    SENTRY_AUTH_TOKEN: "value-for-sentry-auth-token",
    SENTRY_ORG: "value-for-sentry-organization-slug",
    SENTRY_PROJECT: "value-for-sentry-project-slug"
  });
  assert.deepEqual(
    reads.map(({ parameter }) => parameter),
    [
      "/agent-outbox/environments/production/sentry-auth-token",
      "/agent-outbox/environments/production/sentry-organization-slug",
      "/agent-outbox/environments/production/sentry-project-slug"
    ]
  );
  assert.ok(reads.every(({ profile }) => profile === "conn"));
});

test("allows an explicit AWS profile override", () => {
  /** @type {string[]} */
  const profiles = [];
  loadSecretEnvironment("sentry-production", {
    profile: "alternate",
    readParameter(_parameter, profile) {
      profiles.push(profile);
      return "configured-value";
    }
  });

  assert.deepEqual(profiles, ["alternate", "alternate", "alternate"]);
});
