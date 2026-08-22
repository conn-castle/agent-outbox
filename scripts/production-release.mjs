import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyCommittedMarketingReleaseFiles } from "./marketing-screenshots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_NAME = "agent-outbox";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WORKER_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINALIZE_MAX_ATTEMPTS = 5;
const FINALIZE_BACKOFF_MS = 5_000;
const FINALIZE_VERIFY_MAX_ATTEMPTS = 4;
const FINALIZE_VERIFY_BACKOFF_MS = 2_000;

/**
 * Resolve the immutable release identity from checked-in package metadata.
 *
 * @param {{ name?: unknown, version?: unknown }} packageJson
 */
export function releaseMetadata(packageJson) {
  if (packageJson.name !== WORKER_NAME) {
    throw new Error(`package name must be ${WORKER_NAME}`);
  }
  if (
    typeof packageJson.version !== "string" ||
    !STABLE_VERSION.test(packageJson.version) ||
    packageJson.version === "0.0.0"
  ) {
    throw new Error(
      "package version must be a numbered stable release such as 0.1.0"
    );
  }
  return {
    releaseTag: `v${packageJson.version}`
  };
}

/**
 * Select the exact healthy production state that an automatic rollback must
 * restore if the candidate release does not certify.
 *
 * @param {unknown} deploymentStatus
 * @param {unknown} runtimeCanary
 */
export function selectRollbackTarget(deploymentStatus, runtimeCanary) {
  const status = /** @type {{ versions?: unknown }} */ (deploymentStatus);
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  const activeVersion =
    /** @type {{ version_id?: unknown, percentage?: unknown } | undefined} */ (
      versions[0]
    );
  if (
    versions.length !== 1 ||
    Number(activeVersion?.percentage) !== 100 ||
    typeof activeVersion?.version_id !== "string" ||
    !WORKER_VERSION_ID.test(activeVersion.version_id)
  ) {
    throw new Error(
      "rollback requires exactly one version at 100% traffic with a valid version id"
    );
  }

  const canary =
    /** @type {{ environment?: { configured?: unknown, release?: unknown } }} */ (
      runtimeCanary
    );
  const rollbackRelease = canary?.environment?.release;
  if (
    canary?.environment?.configured !== true ||
    typeof rollbackRelease !== "string" ||
    !FULL_GIT_SHA.test(rollbackRelease)
  ) {
    throw new Error("rollback requires a configured live release SHA");
  }

  return {
    rollbackVersionId: activeVersion.version_id,
    rollbackRelease
  };
}

/**
 * @param {unknown} workerVersion
 * @param {string} expectedVersionId
 * @param {string} expectedReleaseTag
 */
export function validateWorkerVersionReleaseTag(
  workerVersion,
  expectedVersionId,
  expectedReleaseTag
) {
  const version =
    /** @type {{ id?: unknown, annotations?: Record<string, unknown> }} */ (
      workerVersion
    );
  if (version?.id !== expectedVersionId) {
    throw new Error("Cloudflare returned a different Worker version id");
  }
  if (version.annotations?.["workers/tag"] !== expectedReleaseTag) {
    throw new Error(
      `Worker version ${expectedVersionId} does not carry release tag ${expectedReleaseTag}`
    );
  }
}

/**
 * Classify the GitHub release/tag state for a candidate commit so finalization
 * can (a) treat an already-published release on the same SHA as idempotent
 * success — covering the create-succeeded-but-response-was-lost case, (b) adopt
 * an orphan tag left at the same SHA by a prior partial run, and (c) refuse to
 * move an immutable release number onto a different commit.
 *
 * @param {{ tagCommit: string | null, releaseExists: boolean }} state
 * @param {string} expectedSha
 * @returns {"absent" | "tag_orphan_correct" | "tag_wrong_sha" | "released_correct" | "released_wrong_sha"}
 */
export function classifyReleaseTagState(state, expectedSha) {
  if (state.releaseExists) {
    return state.tagCommit === expectedSha
      ? "released_correct"
      : "released_wrong_sha";
  }
  if (state.tagCommit === null) {
    return "absent";
  }
  return state.tagCommit === expectedSha
    ? "tag_orphan_correct"
    : "tag_wrong_sha";
}

/**
 * Decide whether a failed `gh release create` should be retried. Only transient
 * transport/availability failures are retried; authentication, permission,
 * validation, ruleset, and wrong-tag failures are permanent and must fail loud
 * rather than loop.
 *
 * @param {string} stderr
 * @returns {"transient" | "permanent"}
 */
export function classifyFinalizeFailure(stderr) {
  const text = String(stderr).toLowerCase();
  const transient =
    /http 5\d\d/.test(text) ||
    /http 429/.test(text) ||
    /rate limit/.test(text) ||
    /secondary rate/.test(text) ||
    /timeout|timed out|temporar|connection reset|connection refused|econnreset|no such host|dial tcp|network|tls handshake|unexpected eof|try again|service unavailable|bad gateway|gateway timeout/.test(
      text
    );
  return transient ? "transient" : "permanent";
}

/** @param {Record<string, string>} outputs */
function writeGithubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  const content = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  appendFileSync(outputPath, `${content}\n`, "utf8");
}

/**
 * @param {"deploy-production.yml" | "rollback-production.yml"} workflow
 */
export function requireProductionWorkflowContext(workflow) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Production releases must run in GitHub Actions.");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Production releases must run from refs/heads/main.");
  }
  if (
    !process.env.GITHUB_WORKFLOW_REF?.includes(
      `/.github/workflows/${workflow}@`
    )
  ) {
    throw new Error(`Production mutation must run from ${workflow}.`);
  }
}

function requireCandidateSha() {
  const sha = process.env.GITHUB_SHA ?? "";
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error("GITHUB_SHA must be the 40-character candidate commit.");
  }
  return sha;
}

function requireReleaseTag() {
  const releaseTag = process.env.RELEASE_TAG ?? "";
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be a numbered vX.Y.Z release tag.");
  }
  return releaseTag;
}

function requireRepository() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be set to owner/repo.");
  }
  return repository;
}

/**
 * Resolve the commit a local tag points at, or null when the tag is absent.
 *
 * @param {string} tag
 * @returns {string | null}
 */
function localTagCommit(tag) {
  const result = spawnSync(
    "git",
    ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(`failed to inspect ${tag}`);
  }
  return result.stdout.trim();
}

/** @param {string[]} args */
function runGh(args) {
  return spawnSync("gh", args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
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
    return JSON.parse(result.stdout);
  }
  const stderr = result.stderr ?? "";
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return null;
  }
  throw new Error(`gh api ${apiPath} failed: ${stderr.trim() || "unknown"}`);
}

/**
 * Resolve the commit a remote tag points at (dereferencing annotated tags), or
 * null when the tag does not exist on the remote.
 *
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
 * @param {string} tag
 * @returns {{ tagCommit: string | null, releaseExists: boolean }}
 */
function reconcileReleaseState(repository, tag) {
  const release = ghApiJsonOrNull(`repos/${repository}/releases/tags/${tag}`);
  return {
    tagCommit: remoteTagCommit(repository, tag),
    releaseExists: release !== null
  };
}

/**
 * @param {string} repository
 * @param {string} tag
 * @param {string} sha
 */
function createGithubRelease(repository, tag, sha) {
  return runGh([
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--target",
    sha,
    "--title",
    tag,
    "--generate-notes",
    "--latest"
  ]);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function prepareRelease() {
  requireProductionWorkflowContext("deploy-production.yml");
  verifyCommittedMarketingReleaseFiles();
  const metadata = releaseMetadata(
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  );
  const candidateSha = requireCandidateSha();
  const tagCommit = localTagCommit(metadata.releaseTag);
  if (tagCommit !== null && tagCommit !== candidateSha) {
    throw new Error(
      `${metadata.releaseTag} already exists at ${tagCommit}; release numbers are immutable, so bump the package version before deploying a different commit`
    );
  }

  writeGithubOutputs({
    release_tag: metadata.releaseTag
  });
}

async function captureRollbackTarget() {
  requireProductionWorkflowContext("deploy-production.yml");
  const baseUrl = process.env.APP_BASE_URL;
  const smokeToken = process.env.SMOKE_OR_CLEANUP_TOKEN;
  if (!baseUrl || !smokeToken) {
    throw new Error(
      "APP_BASE_URL and SMOKE_OR_CLEANUP_TOKEN are required to capture rollback state"
    );
  }

  const statusResult = spawnSync(
    "corepack",
    [
      "pnpm",
      "exec",
      "wrangler",
      "deployments",
      "status",
      "--name",
      WORKER_NAME,
      "--json",
      "--env-file",
      "/dev/null"
    ],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  if (statusResult.error) {
    throw statusResult.error;
  }
  if (statusResult.status !== 0) {
    throw new Error("unable to inspect the current Worker deployment");
  }

  const response = await fetch(new URL("/api/runtime/canary", baseUrl), {
    headers: { authorization: `Bearer ${smokeToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`runtime canary returned ${response.status}`);
  }
  const target = selectRollbackTarget(
    JSON.parse(statusResult.stdout),
    await response.json()
  );
  writeGithubOutputs({
    rollback_version_id: target.rollbackVersionId,
    rollback_release: target.rollbackRelease
  });
}

/**
 * @typedef {object} ReleaseGateway
 * @property {(repository: string, tag: string) =>
 *   ({ tagCommit: string | null, releaseExists: boolean }
 *     | Promise<{ tagCommit: string | null, releaseExists: boolean }>)} reconcile
 * @property {(repository: string, tag: string, sha: string) =>
 *   ({ status: number | null, stderr?: string, error?: Error }
 *     | Promise<{ status: number | null, stderr?: string, error?: Error }>)} createRelease
 * @property {(repository: string, tag: string) =>
 *   (string | null | Promise<string | null>)} tagCommit
 * @property {(ms: number) => void | Promise<void>} sleep
 */

/** @type {ReleaseGateway} */
const defaultReleaseGateway = {
  reconcile: reconcileReleaseState,
  createRelease: createGithubRelease,
  tagCommit: remoteTagCommit,
  sleep: delay
};

/** @param {string} stderr */
function isAlreadyExistsFailure(stderr) {
  return /already[_ ]exists/i.test(stderr);
}

/** @param {unknown} error */
function isTransientGatewayError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return classifyFinalizeFailure(message) === "transient";
}

/**
 * Confirm the finalized tag resolves to the candidate commit, tolerating brief
 * read-after-write lag on the git ref but refusing a tag that resolves to a
 * different commit.
 *
 * @param {ReleaseGateway} gateway
 * @param {string} repository
 * @param {string} releaseTag
 * @param {string} expectedSha
 */
async function verifyFinalizedTag(
  gateway,
  repository,
  releaseTag,
  expectedSha
) {
  for (let attempt = 1; attempt <= FINALIZE_VERIFY_MAX_ATTEMPTS; attempt += 1) {
    const commit = await gateway.tagCommit(repository, releaseTag);
    if (commit === expectedSha) {
      return;
    }
    if (commit !== null && commit !== expectedSha) {
      throw new Error(
        `${releaseTag} resolved to ${commit} after finalize; expected ${expectedSha}`
      );
    }
    if (attempt < FINALIZE_VERIFY_MAX_ATTEMPTS) {
      await gateway.sleep(FINALIZE_VERIFY_BACKOFF_MS);
    }
  }
  throw new Error(
    `${releaseTag} did not resolve to ${expectedSha} after finalize`
  );
}

/**
 * Publish the numbered GitHub release for the smoke-verified candidate. This
 * runs after the Worker is already live and verified, so a tagging failure must
 * never revert production. It reconciles the current release/tag state, treats
 * an already-published release on the candidate SHA as success (covering a
 * create whose response was lost), adopts a correct-SHA orphan tag, retries only
 * transient GitHub failures, refuses to move an immutable release number onto a
 * different commit, and proves the resulting tag resolves to the candidate SHA.
 *
 * @param {ReleaseGateway} gateway
 * @param {{ repository: string, releaseTag: string, expectedSha: string }} input
 */
export async function runReleaseFinalization(
  gateway,
  { repository, releaseTag, expectedSha }
) {
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
    let state;
    try {
      state = await gateway.reconcile(repository, releaseTag);
    } catch (error) {
      if (isTransientGatewayError(error) && attempt < FINALIZE_MAX_ATTEMPTS) {
        await gateway.sleep(FINALIZE_BACKOFF_MS * attempt);
        continue;
      }
      throw error;
    }

    const kind = classifyReleaseTagState(state, expectedSha);
    if (kind === "released_correct") {
      console.log(`${releaseTag} is already released on ${expectedSha}.`);
      return;
    }
    if (kind === "released_wrong_sha" || kind === "tag_wrong_sha") {
      throw new Error(
        `${releaseTag} already points at ${state.tagCommit}; refusing to reuse the release number for ${expectedSha}`
      );
    }

    const result = await gateway.createRelease(
      repository,
      releaseTag,
      expectedSha
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      await verifyFinalizedTag(gateway, repository, releaseTag, expectedSha);
      console.log(`Published ${releaseTag} on ${expectedSha}.`);
      return;
    }

    const stderr = result.stderr ?? "";
    // "already exists" means a release for the tag is already present; that is a
    // signal to re-reconcile (the next iteration resolves to released_correct or
    // fails loud on a wrong-SHA tag), not a permanent finalize failure.
    if (
      classifyFinalizeFailure(stderr) === "permanent" &&
      !isAlreadyExistsFailure(stderr)
    ) {
      throw new Error(
        `gh release create failed: ${stderr.trim() || "unknown error"}`
      );
    }
    console.warn(
      `gh release create attempt ${attempt}/${FINALIZE_MAX_ATTEMPTS} did not complete cleanly; reconciling and retrying.`
    );
    if (attempt < FINALIZE_MAX_ATTEMPTS) {
      await gateway.sleep(FINALIZE_BACKOFF_MS * attempt);
    }
  }

  throw new Error(
    `unable to finalize ${releaseTag} after ${FINALIZE_MAX_ATTEMPTS} attempts`
  );
}

async function finalizeRelease() {
  requireProductionWorkflowContext("deploy-production.yml");
  const releaseTag = requireReleaseTag();
  const expectedSha = requireCandidateSha();
  const repository = requireRepository();
  await runReleaseFinalization(defaultReleaseGateway, {
    repository,
    releaseTag,
    expectedSha
  });
}

function verifyRollbackVersion() {
  requireProductionWorkflowContext("rollback-production.yml");
  const versionId = process.env.WORKER_VERSION_ID ?? "";
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const result = spawnSync(
    "corepack",
    [
      "pnpm",
      "exec",
      "wrangler",
      "versions",
      "view",
      versionId,
      "--name",
      WORKER_NAME,
      "--json",
      "--env-file",
      "/dev/null"
    ],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("unable to inspect the requested Worker version");
  }
  validateWorkerVersionReleaseTag(
    JSON.parse(result.stdout),
    versionId,
    releaseTag
  );
}

async function main() {
  switch (process.argv[2]) {
    case "prepare":
      prepareRelease();
      break;
    case "capture-rollback":
      await captureRollbackTarget();
      break;
    case "finalize":
      await finalizeRelease();
      break;
    case "verify-rollback-version":
      verifyRollbackVersion();
      break;
    default:
      throw new Error(
        "Usage: node scripts/production-release.mjs <prepare|capture-rollback|finalize|verify-rollback-version>"
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
