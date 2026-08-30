import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT } from "../repo-root.mjs";
import { normalizeGithubRelease } from "./model.mjs";

export const GH_SPAWN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {import("./model.mjs").GithubRelease} GithubRelease
 *
 * @typedef {{
 *   status: number | null,
 *   stdout?: string,
 *   stderr?: string,
 *   error?: Error,
 *   release?: GithubRelease
 * }} GhMutationResult
 *
 * @typedef {object} GithubGateway
 * @property {(repository: string) => GithubRelease[] | Promise<GithubRelease[]>} listReleases
 * @property {(repository: string, releaseId: number) => (GithubRelease | null) | Promise<GithubRelease | null>} getRelease
 * @property {(repository: string, tag: string) => (string | null) | Promise<string | null>} remoteTagCommit
 * @property {(input: { repository: string, tag: string, sha: string, body: string, name?: string }) =>
 *   GhMutationResult | Promise<GhMutationResult>} createDraft
 * @property {(repository: string, releaseId: number, patch: Record<string, unknown>) =>
 *   GhMutationResult | Promise<GhMutationResult>} updateRelease
 * @property {(repository: string, releaseId: number, name: string, filePath: string) =>
 *   GhMutationResult | Promise<GhMutationResult>} uploadAsset
 * @property {(repository: string, assetId: number) => Buffer | Promise<Buffer>} downloadAsset
 * @property {(repository: string, releaseId: number) =>
 *   GhMutationResult | Promise<GhMutationResult>} deleteRelease
 * @property {(repository: string, runId: string) =>
 *   ({ id?: unknown, status?: unknown, conclusion?: unknown } | null)
 *     | Promise<{ id?: unknown, status?: unknown, conclusion?: unknown } | null>} [getActionsRun]
 */

/**
 * @param {{
 *   input?: string,
 *   encoding?: BufferEncoding | null,
 *   maxBuffer?: number,
 *   cwd?: string,
 *   stdio?: import("node:child_process").StdioOptions,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {import("node:child_process").SpawnSyncOptions}
 */
export function githubCommandSpawnOptions(options = {}) {
  return {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: options.encoding === null ? null : (options.encoding ?? "utf8"),
    input: options.input,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? GH_SPAWN_MAX_BUFFER_BYTES
  };
}

/**
 * @param {NodeJS.ErrnoException | Error | undefined} error
 * @param {number} maxBuffer
 */
export function assertSpawnStdoutBudget(error, maxBuffer) {
  if (
    error &&
    "code" in error &&
    /** @type {NodeJS.ErrnoException} */ (error).code === "ENOBUFS"
  ) {
    throw new Error(
      `GitHub CLI stdout exceeded ${maxBuffer} bytes (Node's default spawnSync budget is 1 MiB); refusing a truncated payload`
    );
  }
}

/**
 * Stream command stdout to a temp file so Node's 1 MiB spawnSync maxBuffer
 * cannot truncate GitHub asset bytes.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   input?: string,
 *   spawnSyncImpl?: typeof spawnSync
 * }} [options]
 * @returns {Buffer}
 */
export function collectCommandStdoutBytes(command, args, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agent-outbox-stdout-"));
  const filePath = path.join(tempDir, "stdout.bin");
  const fd = openSync(filePath, "w");
  let closed = false;
  try {
    const result = spawnSyncImpl(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf8",
      input: options.input
    });
    closeSync(fd);
    closed = true;
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `${command} failed: ${String(result.stderr ?? "").trim() || "unknown error"}`
      );
    }
    return readFileSync(filePath);
  } finally {
    if (!closed) {
      closeSync(fd);
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} args
 * @param {{ input?: string, encoding?: BufferEncoding | null, env?: NodeJS.ProcessEnv }} [options]
 */
function runGh(args, options = {}) {
  const spawnOptions = githubCommandSpawnOptions(options);
  const result = spawnSync("gh", args, spawnOptions);
  assertSpawnStdoutBudget(
    result.error,
    spawnOptions.maxBuffer ?? GH_SPAWN_MAX_BUFFER_BYTES
  );
  return result;
}

/**
 * @param {string} apiPath
 * @returns {unknown | null}
 */
function ghApiJsonOrNull(apiPath) {
  const result = runGh([
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    apiPath
  ]);
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return JSON.parse(String(result.stdout));
  }
  const stderr = String(result.stderr ?? "");
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return null;
  }
  throw new Error(`gh api ${apiPath} failed: ${stderr.trim() || "unknown"}`);
}

/**
 * @param {string} repository
 * @param {string} tag
 * @returns {string | null}
 */
function remoteTagCommit(repository, tag) {
  const ref = ghApiJsonOrNull(`repos/${repository}/git/ref/tags/${tag}`);
  if (!ref) {
    return null;
  }
  const object = /** @type {{ object?: { type?: string, sha?: string } }} */ (
    ref
  ).object;
  if (!object?.sha) {
    throw new Error(`tag ${tag} ref is missing an object sha`);
  }
  if (object.type === "tag") {
    const annotated = ghApiJsonOrNull(
      `repos/${repository}/git/tags/${object.sha}`
    );
    const commit = /** @type {{ object?: { sha?: string } }} */ (annotated)
      ?.object?.sha;
    if (!commit) {
      throw new Error(`annotated tag ${tag} is missing a target commit`);
    }
    return commit;
  }
  return object.sha;
}

/**
 * @param {string} repository
 * @returns {GithubRelease[]}
 */
function listGithubReleases(repository) {
  /** @type {GithubRelease[]} */
  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = ghApiJsonOrNull(
      `repos/${repository}/releases?per_page=100&page=${page}`
    );
    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }
    releases.push(...payload.map((release) => normalizeGithubRelease(release)));
    if (payload.length < 100) {
      break;
    }
  }
  return releases;
}

/**
 * @param {string} repository
 * @param {number} releaseId
 */
function getGithubRelease(repository, releaseId) {
  const payload = ghApiJsonOrNull(`repos/${repository}/releases/${releaseId}`);
  return payload ? normalizeGithubRelease(payload) : null;
}

/**
 * @param {{
 *   repository: string,
 *   tag: string,
 *   sha: string,
 *   body: string,
 *   name?: string
 * }} input
 */
function createGithubDraft(input) {
  return runGh(
    [
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${input.repository}/releases`,
      "--input",
      "-"
    ],
    {
      input: JSON.stringify({
        tag_name: input.tag,
        target_commitish: input.sha,
        name: input.name ?? input.tag,
        body: input.body,
        draft: true,
        generate_release_notes: true
      })
    }
  );
}

/**
 * @param {string} repository
 * @param {number} releaseId
 * @param {Record<string, unknown>} patch
 */
function updateGithubRelease(repository, releaseId, patch) {
  return runGh(
    [
      "api",
      "--method",
      "PATCH",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${repository}/releases/${releaseId}`,
      "--input",
      "-"
    ],
    { input: JSON.stringify(patch) }
  );
}

/**
 * @param {string} repository
 * @param {number} releaseId
 * @param {string} name
 * @param {string} filePath
 */
function uploadGithubAsset(repository, releaseId, name, filePath) {
  return runGh([
    "api",
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "Content-Type: application/octet-stream",
    "--input",
    filePath,
    `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  ]);
}

/**
 * @param {string} repository
 * @param {number} assetId
 * @returns {Buffer}
 */
function downloadGithubAsset(repository, assetId) {
  try {
    return collectCommandStdoutBytes("gh", [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repository}/releases/assets/${assetId}`
    ]);
  } catch (error) {
    throw new Error(
      `failed to download GitHub asset ${assetId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/** @param {string} repository @param {number} releaseId */
function deleteGithubRelease(repository, releaseId) {
  return runGh([
    "api",
    "--method",
    "DELETE",
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${repository}/releases/${releaseId}`
  ]);
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string | Buffer>} result
 * @returns {GhMutationResult}
 */
function parseGhReleaseResult(result) {
  /** @type {GhMutationResult} */
  const normalized = {
    status: result.status,
    stdout: result.stdout == null ? undefined : String(result.stdout),
    stderr: result.stderr == null ? undefined : String(result.stderr),
    error: result.error
  };
  if (normalized.error || normalized.status !== 0 || !normalized.stdout) {
    return normalized;
  }
  try {
    return {
      ...normalized,
      release: normalizeGithubRelease(JSON.parse(normalized.stdout))
    };
  } catch {
    return normalized;
  }
}

/**
 * @param {string} prefix
 * @param {{ stderr?: string }} result
 */
export function commandFailureMessage(prefix, result) {
  const stderr = String(result.stderr ?? "").trim();
  return `${prefix}: ${stderr || "unknown error"}`;
}

/**
 * @param {GhMutationResult | null | undefined} result
 * @param {string} action
 */
export function assertGithubMutationResult(result, action) {
  if (!result) {
    throw new Error(`${action} returned no result`);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(commandFailureMessage(action, result));
  }
}

/** @type {GithubGateway} */
export const defaultGithubGateway = {
  listReleases: listGithubReleases,
  getRelease: getGithubRelease,
  remoteTagCommit,
  createDraft: async (input) => parseGhReleaseResult(createGithubDraft(input)),
  updateRelease: async (repository, releaseId, patch) =>
    parseGhReleaseResult(updateGithubRelease(repository, releaseId, patch)),
  uploadAsset: async (repository, releaseId, name, filePath) => {
    const result = uploadGithubAsset(repository, releaseId, name, filePath);
    return {
      status: result.status,
      stderr: String(result.stderr ?? ""),
      error: result.error
    };
  },
  downloadAsset: downloadGithubAsset,
  deleteRelease: async (repository, releaseId) => {
    const result = deleteGithubRelease(repository, releaseId);
    return {
      status: result.status,
      stderr: String(result.stderr ?? ""),
      error: result.error
    };
  },
  getActionsRun: (repository, runId) => {
    const payload = ghApiJsonOrNull(
      `repos/${repository}/actions/runs/${runId}`
    );
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return /** @type {{ id?: unknown, status?: unknown, conclusion?: unknown }} */ (
      payload
    );
  }
};
