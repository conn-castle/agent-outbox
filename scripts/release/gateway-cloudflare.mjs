import { spawnSync } from "node:child_process";

import {
  ReleaseHoldError,
  WORKER_NAME,
  WorkerVersionMatchError,
  findExactWorkerVersion,
  isWorkerVersionId
} from "./identity.mjs";
import {
  GH_SPAWN_MAX_BUFFER_BYTES,
  assertSpawnStdoutBudget
} from "./gateway-github.mjs";
import { ROOT } from "../repo-root.mjs";
import {
  buildWranglerVersionsDeployArgs,
  runWorkerVersionUpload,
  runWranglerVersionsDeploy,
  validateWorkerTrafficEnvironment,
  wranglerDeployEnvironment
} from "../worker-deploy.mjs";

/**
 * @typedef {{ versions?: { version_id?: unknown, percentage?: unknown }[] }} WorkerDeploymentStatus
 *
 * @typedef {object} CloudflareGateway
 * @property {() => WorkerDeploymentStatus | Promise<WorkerDeploymentStatus>} deploymentStatus
 * @property {() => unknown | Promise<unknown>} [listVersions]
 * @property {(versionId: string) => unknown | Promise<unknown>} [viewVersion]
 * @property {(env: NodeJS.ProcessEnv | Record<string, string | undefined>) =>
 *   ({ versionId: string } | Promise<{ versionId: string }>)} uploadVersion
 * @property {(placements: { versionId: string, percentage: number }[], message?: string) =>
 *   void | Promise<void>} deployVersions
 */

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function wranglerJson(args, env) {
  if (env == null) {
    throw new Error("wranglerJson requires an explicit environment");
  }
  const failures = validateWorkerTrafficEnvironment(env);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  const result = spawnSync(
    "corepack",
    ["pnpm", "exec", "wrangler", ...args, "--json", "--env-file", "/dev/null"],
    {
      cwd: ROOT,
      env: wranglerDeployEnvironment(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GH_SPAWN_MAX_BUFFER_BYTES
    }
  );
  assertSpawnStdoutBudget(result.error, GH_SPAWN_MAX_BUFFER_BYTES);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed: ${(result.stderr ?? "").trim() || "unknown"}`
    );
  }
  return JSON.parse(result.stdout);
}

/**
 * @param {unknown} raw
 * @returns {unknown[]}
 */
function parseWorkerVersionList(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    const record = /** @type {{ versions?: unknown, result?: unknown }} */ (
      raw
    );
    if (Array.isArray(record.versions)) {
      return record.versions;
    }
    if (Array.isArray(record.result)) {
      return record.result;
    }
  }
  throw new Error("Cloudflare Worker version list is malformed");
}

/**
 * @param {unknown} raw
 * @param {{ runId: string, releaseId: number, candidateSha: string }} expected
 * @returns {string | null}
 */
export function resolveCandidateWorkerVersionId(raw, expected) {
  let versions;
  try {
    versions = parseWorkerVersionList(raw);
  } catch (error) {
    throw new ReleaseHoldError("Cloudflare Worker version list is malformed", {
      cause: error
    });
  }
  let match;
  try {
    match = findExactWorkerVersion(
      versions,
      {
        runId: expected.runId,
        releaseId: expected.releaseId,
        sha: expected.candidateSha
      },
      { allowMissing: true }
    );
  } catch (error) {
    if (error instanceof WorkerVersionMatchError && error.matchCount > 1) {
      throw new ReleaseHoldError(
        "multiple Worker versions share the candidate identity",
        { cause: error }
      );
    }
    throw new ReleaseHoldError(
      "candidate Worker version identity is malformed",
      { cause: error }
    );
  }
  if (!match) {
    return null;
  }
  const matchId =
    /** @type {{ id?: unknown, version_id?: unknown }} */ (match).id ??
    /** @type {{ version_id?: unknown }} */ (match).version_id;
  if (!isWorkerVersionId(String(matchId ?? ""))) {
    throw new ReleaseHoldError("matched Worker version identity is malformed");
  }
  return String(matchId);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {CloudflareGateway}
 */
export function createCloudflareGateway(env) {
  if (env == null) {
    throw new Error("Cloudflare gateway requires an explicit environment");
  }
  return {
    deploymentStatus: () =>
      /** @type {WorkerDeploymentStatus} */ (
        wranglerJson(["deployments", "status", "--name", WORKER_NAME], env)
      ),
    listVersions: () =>
      wranglerJson(["versions", "list", "--name", WORKER_NAME], env),
    uploadVersion: (uploadEnv) => runWorkerVersionUpload({ env: uploadEnv }),
    deployVersions: (placements, message) => {
      runWranglerVersionsDeploy(
        buildWranglerVersionsDeployArgs(placements, message),
        {
          env,
          allowedWorkflows: [
            "deploy-production.yml",
            "reconcile-production-release.yml"
          ]
        }
      );
    }
  };
}
