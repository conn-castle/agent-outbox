import { spawnSync } from "node:child_process";

import { validateBrowserFixtureRunId } from "./browser-fixture-run-id.mjs";

const NETWORK_REMOVAL_ATTEMPTS = 5;

export default async function globalTeardown() {
  // Only remove resources labeled for THIS run (set by playwright.config.ts and
  // consumed by browser-web-server.mjs). Sweeping the generic
  // agent-outbox.browser-fixture=1 label would kill a concurrent run's live
  // Postgres on a shared host. The run label is strictly narrower, so this still
  // never touches a real/local database.
  const rawRunId = process.env.AGENT_OUTBOX_BROWSER_RUN_ID;
  if (!rawRunId) {
    throw new Error(
      "AGENT_OUTBOX_BROWSER_RUN_ID is required for browser test cleanup."
    );
  }
  const runId = validateBrowserFixtureRunId(rawRunId);
  const runLabel = `agent-outbox.browser-fixture-run=${runId}`;

  const containers = dockerIds("ps", ["-aq", "--filter", `label=${runLabel}`]);
  if (containers.length > 0) {
    runDocker(["rm", "-f", ...containers]);
  }

  const networks = dockerNetworkIds(runLabel);
  if (networks.length > 0) {
    removeNetworks(networks);
  }

  const remainingContainers = dockerIds("ps", [
    "-aq",
    "--filter",
    `label=${runLabel}`
  ]);
  const remainingNetworks = dockerNetworkIds(runLabel);
  if (remainingContainers.length > 0 || remainingNetworks.length > 0) {
    throw new Error(
      [
        "Browser Docker cleanup left labeled resources behind.",
        `containers=${remainingContainers.join(",") || "none"}`,
        `networks=${remainingNetworks.join(",") || "none"}`
      ].join(" ")
    );
  }
}

/**
 * @param {string} runLabel
 */
function dockerNetworkIds(runLabel) {
  return dockerIds("network", ["ls", "-q", "--filter", `label=${runLabel}`]);
}

/**
 * @param {string[]} networks
 */
function removeNetworks(networks) {
  let lastError;
  for (let attempt = 1; attempt <= NETWORK_REMOVAL_ATTEMPTS; attempt += 1) {
    const result = spawnSync("docker", ["network", "rm", ...networks], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.status === 0) {
      return;
    }
    lastError = dockerFailureMessage(["network", "rm", ...networks], result);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(lastError ?? "docker network rm failed.");
}

/**
 * @param {string[]} args
 */
function runDocker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw new Error(dockerFailureMessage(args, result));
  }
}

/**
 * @param {string} dockerCommand
 * @param {string[]} args
 */
function dockerIds(dockerCommand, args) {
  const result = spawnSync("docker", [dockerCommand, ...args], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(dockerFailureMessage([dockerCommand, ...args], result));
  }
  return result.stdout.split(/\s+/).filter(Boolean);
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 */
function dockerFailureMessage(args, result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || `exit status ${result.status}`;
  return `docker ${args.join(" ")} failed: ${detail}`;
}
