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
 * Classify the GitHub release/tag state for a candidate commit. Draft releases
 * are identified by their exact target commit because GitHub does not create
 * the tag until the draft is published. Published releases are identified by
 * the immutable tag itself.
 *
 * @param {{
 *   tagCommit: string | null,
 *   release: null | {
 *     isDraft: boolean,
 *     tagName: string,
 *     targetCommitish: string
 *   }
 * }} state
 * @param {string} expectedSha
 * @returns {"absent" | "tag_orphan_correct" | "tag_wrong_sha" | "draft_correct" | "draft_wrong_sha" | "published_correct" | "published_wrong_sha"}
 */
export function classifyReleaseTagState(state, expectedSha) {
  if (state.release === null) {
    if (state.tagCommit === null) {
      return "absent";
    }
    return state.tagCommit === expectedSha
      ? "tag_orphan_correct"
      : "tag_wrong_sha";
  }
  if (state.release.isDraft) {
    if (state.tagCommit !== null && state.tagCommit !== expectedSha) {
      return "draft_wrong_sha";
    }
    return state.tagCommit === expectedSha ||
      state.release.targetCommitish === expectedSha
      ? "draft_correct"
      : "draft_wrong_sha";
  }
  return state.tagCommit === expectedSha
    ? "published_correct"
    : "published_wrong_sha";
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

export class PublicationStateUnknownError extends Error {
  /** @param {string} releaseTag @param {{ cause?: unknown }} [options] */
  constructor(releaseTag, options) {
    super(
      `${releaseTag} publication may have succeeded, but its final state could not be proven; refusing automatic rollback until reconciliation succeeds`,
      options
    );
    this.name = "PublicationStateUnknownError";
  }
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
 * @param {"deploy-production.yml" | "repair-production-release.yml" | "rollback-production.yml"} workflow
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

function requireReleaseMutationCandidateSha() {
  if (
    process.env.GITHUB_WORKFLOW_REF?.includes(
      "/.github/workflows/repair-production-release.yml@"
    )
  ) {
    requireProductionWorkflowContext("repair-production-release.yml");
    const candidateSha = process.env.RELEASE_CANDIDATE_SHA ?? "";
    if (!FULL_GIT_SHA.test(candidateSha)) {
      throw new Error(
        "RELEASE_CANDIDATE_SHA must be the 40-character certified repair candidate."
      );
    }
    return candidateSha;
  }
  requireProductionWorkflowContext("deploy-production.yml");
  return requireCandidateSha();
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
 * Prove that a release repair adopts one certified artifact from a failed
 * production run whose candidate was already deployed and verified.
 *
 * @param {{
 *   sourceRunId: string,
 *   releaseTag: string,
 *   candidateSha: string,
 *   run: unknown,
 *   jobs: unknown,
 *   artifacts: unknown,
 *   candidatePackageJson: unknown
 * }} input
 */
export function validateReleaseRepairSource(input) {
  const {
    sourceRunId,
    releaseTag,
    candidateSha,
    run,
    jobs,
    artifacts,
    candidatePackageJson
  } = input;
  if (!/^[1-9]\d*$/.test(sourceRunId)) {
    throw new Error("SOURCE_RUN_ID must be a positive GitHub Actions run id.");
  }
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be a numbered vX.Y.Z release tag.");
  }
  if (!FULL_GIT_SHA.test(candidateSha)) {
    throw new Error("RELEASE_CANDIDATE_SHA must be a full Git commit SHA.");
  }

  const runState =
    /** @type {{
     * id?: unknown,
     * path?: unknown,
     * event?: unknown,
     * head_branch?: unknown,
     * head_sha?: unknown,
     * status?: unknown,
     * conclusion?: unknown
     * }} */ (run);
  if (String(runState.id) !== sourceRunId) {
    throw new Error("release repair source run id does not match GitHub");
  }
  if (
    runState.path !== ".github/workflows/deploy-production.yml" ||
    runState.event !== "workflow_dispatch" ||
    runState.head_branch !== "main" ||
    runState.head_sha !== candidateSha ||
    runState.status !== "completed" ||
    runState.conclusion !== "failure"
  ) {
    throw new Error(
      "release repair requires a failed completed manual production run on main at the exact candidate"
    );
  }

  const metadata = releaseMetadata(
    /** @type {{ name?: unknown, version?: unknown }} */ (candidatePackageJson)
  );
  if (metadata.releaseTag !== releaseTag) {
    throw new Error(
      `candidate package resolves to ${metadata.releaseTag}, not ${releaseTag}`
    );
  }

  const jobList = Array.isArray(/** @type {{ jobs?: unknown }} */ (jobs)?.jobs)
    ? /** @type {{ name?: unknown, conclusion?: unknown, head_sha?: unknown }[]} */ (
        /** @type {{ jobs: unknown[] }} */ (jobs).jobs
      )
    : [];
  const requiredSuccessfulJobs = [
    "Certify exact release SHA / make release-check",
    "Certify exact release SHA / make browser",
    "Certify exact release SHA / make migration-replay",
    "Build and validate release CLI",
    "Deploy and verify production Worker"
  ];
  for (const name of requiredSuccessfulJobs) {
    if (
      !jobList.some(
        (job) =>
          job.name === name &&
          job.conclusion === "success" &&
          job.head_sha === candidateSha
      )
    ) {
      throw new Error(
        `release repair source is missing successful job: ${name}`
      );
    }
  }
  if (
    !jobList.some(
      (job) =>
        job.name === "Tag verified production release" &&
        job.conclusion === "failure" &&
        job.head_sha === candidateSha
    )
  ) {
    throw new Error(
      "release repair source must have failed at numbered release finalization"
    );
  }

  const expectedArtifactName = `agent-outbox-release-${candidateSha}`;
  const artifactList = Array.isArray(
    /** @type {{ artifacts?: unknown }} */ (artifacts)?.artifacts
  )
    ? /** @type {{ name?: unknown, expired?: unknown }[]} */ (
        /** @type {{ artifacts: unknown[] }} */ (artifacts).artifacts
      )
    : [];
  const matchingArtifacts = artifactList.filter(
    (artifact) => artifact.name === expectedArtifactName
  );
  if (
    matchingArtifacts.length !== 1 ||
    matchingArtifacts[0].expired !== false
  ) {
    throw new Error(
      `release repair requires one unexpired ${expectedArtifactName} artifact`
    );
  }
  return { artifactName: expectedArtifactName };
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
 * @returns {{
 *   tagCommit: string | null,
 *   release: null | {
 *     isDraft: boolean,
 *     tagName: string,
 *     targetCommitish: string
 *   }
 * }}
 */
function reconcileReleaseState(repository, tag) {
  const result = runGh([
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "isDraft,tagName,targetCommitish"
  ]);
  if (result.error) {
    throw result.error;
  }
  let release = null;
  if (result.status === 0) {
    release = JSON.parse(result.stdout);
  } else if (!/release not found|not found/i.test(result.stderr ?? "")) {
    throw new Error(
      `gh release view ${tag} failed: ${(result.stderr ?? "").trim() || "unknown"}`
    );
  }
  return {
    tagCommit: remoteTagCommit(repository, tag),
    release
  };
}

/**
 * @param {string} repository
 * @param {string} tag
 * @param {string} sha
 */
export function githubReleaseCreateArgs(repository, tag, sha) {
  return [
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
    "--draft"
  ];
}

/**
 * @param {string} repository
 * @param {string} tag
 * @param {string} sha
 */
function createGithubRelease(repository, tag, sha) {
  return runGh(githubReleaseCreateArgs(repository, tag, sha));
}

/**
 * @param {string} repository
 * @param {string} tag
 */
export function githubReleasePublishArgs(repository, tag) {
  return [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--latest"
  ];
}

/** @param {string} repository @param {string} tag */
function publishGithubRelease(repository, tag) {
  return runGh(githubReleasePublishArgs(repository, tag));
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
 *   ({
 *     tagCommit: string | null,
 *     release: null | { isDraft: boolean, tagName: string, targetCommitish: string }
 *   } | Promise<{
 *     tagCommit: string | null,
 *     release: null | { isDraft: boolean, tagName: string, targetCommitish: string }
 *   }>)} reconcile
 * @property {(repository: string, tag: string, sha: string) =>
 *   ({ status: number | null, stderr?: string, error?: Error }
 *     | Promise<{ status: number | null, stderr?: string, error?: Error }>)} createRelease
 * @property {(repository: string, tag: string) =>
 *   ({ status: number | null, stderr?: string, error?: Error }
 *     | Promise<{ status: number | null, stderr?: string, error?: Error }>)} publishRelease
 * @property {(ms: number) => void | Promise<void>} sleep
 */

/** @type {ReleaseGateway} */
const defaultReleaseGateway = {
  reconcile: reconcileReleaseState,
  createRelease: createGithubRelease,
  publishRelease: publishGithubRelease,
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
 * Prepare an unpublished release transaction for the exact candidate. A draft
 * is validated by targetCommitish, not by a tag that GitHub creates only when
 * the release is published.
 *
 * @param {ReleaseGateway} gateway
 * @param {{ repository: string, releaseTag: string, expectedSha: string }} input
 */
export async function runReleaseDraftPreparation(
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
    if (kind === "draft_correct") {
      console.log(`${releaseTag} draft is prepared on ${expectedSha}.`);
      return;
    }
    if (kind === "published_correct") {
      console.log(`${releaseTag} is already published on ${expectedSha}.`);
      return;
    }
    if (
      kind === "draft_wrong_sha" ||
      kind === "published_wrong_sha" ||
      kind === "tag_wrong_sha"
    ) {
      throw new Error(
        `${releaseTag} is not bound to candidate ${expectedSha}; refusing to reuse the release number`
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
      if (attempt < FINALIZE_MAX_ATTEMPTS) {
        await gateway.sleep(FINALIZE_VERIFY_BACKOFF_MS);
        continue;
      }
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
    `unable to prepare ${releaseTag} draft after ${FINALIZE_MAX_ATTEMPTS} attempts`
  );
}

/**
 * Publish the prepared release as the transaction commit point. Success means
 * both the release and its immutable tag resolve to the exact candidate.
 *
 * @param {ReleaseGateway} gateway
 * @param {{ repository: string, releaseTag: string, expectedSha: string }} input
 */
export async function runReleasePublication(
  gateway,
  { repository, releaseTag, expectedSha }
) {
  let publicationMutationAttempted = false;
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
    let state;
    try {
      state = await gateway.reconcile(repository, releaseTag);
    } catch (error) {
      if (isTransientGatewayError(error) && attempt < FINALIZE_MAX_ATTEMPTS) {
        await gateway.sleep(FINALIZE_BACKOFF_MS * attempt);
        continue;
      }
      if (publicationMutationAttempted) {
        throw new PublicationStateUnknownError(releaseTag, { cause: error });
      }
      throw error;
    }
    const kind = classifyReleaseTagState(state, expectedSha);
    if (kind === "published_correct") {
      console.log(`${releaseTag} is published on ${expectedSha}.`);
      return;
    }
    if (kind !== "draft_correct") {
      throw new Error(
        `${releaseTag} is not an exact-candidate draft; refusing publication`
      );
    }

    publicationMutationAttempted = true;
    let result;
    try {
      result = await gateway.publishRelease(repository, releaseTag);
    } catch (error) {
      throw new PublicationStateUnknownError(releaseTag, { cause: error });
    }
    if (result.error) {
      throw result.error;
    }
    const stderr = result.stderr ?? "";
    if (
      result.status !== 0 &&
      classifyFinalizeFailure(stderr) === "permanent"
    ) {
      throw new Error(
        `gh release publish failed: ${stderr.trim() || "unknown error"}`
      );
    }
    if (attempt < FINALIZE_MAX_ATTEMPTS) {
      await gateway.sleep(FINALIZE_VERIFY_BACKOFF_MS);
    }
  }
  throw new PublicationStateUnknownError(releaseTag);
}

async function prepareReleaseDraft() {
  const releaseTag = requireReleaseTag();
  const expectedSha = requireReleaseMutationCandidateSha();
  const repository = requireRepository();
  await runReleaseDraftPreparation(defaultReleaseGateway, {
    repository,
    releaseTag,
    expectedSha
  });
}

async function publishRelease() {
  const releaseTag = requireReleaseTag();
  const expectedSha = requireReleaseMutationCandidateSha();
  const repository = requireRepository();
  try {
    await runReleasePublication(defaultReleaseGateway, {
      repository,
      releaseTag,
      expectedSha
    });
    writeGithubOutputs({ publication_state: "published" });
  } catch (error) {
    writeGithubOutputs({
      publication_state:
        error instanceof PublicationStateUnknownError
          ? "unknown"
          : "unpublished"
    });
    throw error;
  }
}

function validateReleaseRepair() {
  requireProductionWorkflowContext("repair-production-release.yml");
  const repository = requireRepository();
  const sourceRunId = process.env.SOURCE_RUN_ID ?? "";
  const releaseTag = requireReleaseTag();
  const candidateSha = process.env.RELEASE_CANDIDATE_SHA ?? "";
  if (!FULL_GIT_SHA.test(candidateSha)) {
    throw new Error("RELEASE_CANDIDATE_SHA must be a full Git commit SHA.");
  }

  const currentSha = requireCandidateSha();
  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", candidateSha, currentSha],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (ancestry.error) {
    throw ancestry.error;
  }
  if (ancestry.status !== 0) {
    throw new Error(
      "release repair candidate must be an ancestor of the current main SHA"
    );
  }

  const packageResult = spawnSync(
    "git",
    ["show", `${candidateSha}:package.json`],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (packageResult.error) {
    throw packageResult.error;
  }
  if (packageResult.status !== 0) {
    throw new Error("unable to read package.json from repair candidate");
  }

  const run = ghApiJsonOrNull(
    `repos/${repository}/actions/runs/${sourceRunId}`
  );
  const jobs = ghApiJsonOrNull(
    `repos/${repository}/actions/runs/${sourceRunId}/jobs?per_page=100&filter=all`
  );
  const artifacts = ghApiJsonOrNull(
    `repos/${repository}/actions/runs/${sourceRunId}/artifacts?per_page=100`
  );
  if (!run || !jobs || !artifacts) {
    throw new Error("release repair source run evidence is unavailable");
  }
  const result = validateReleaseRepairSource({
    sourceRunId,
    releaseTag,
    candidateSha,
    run,
    jobs,
    artifacts,
    candidatePackageJson: JSON.parse(packageResult.stdout)
  });
  writeGithubOutputs({
    artifact_name: result.artifactName,
    candidate_sha: candidateSha,
    release_tag: releaseTag
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
    case "prepare-draft":
      await prepareReleaseDraft();
      break;
    case "publish":
      await publishRelease();
      break;
    case "validate-repair":
      validateReleaseRepair();
      break;
    case "verify-rollback-version":
      verifyRollbackVersion();
      break;
    default:
      throw new Error(
        "Usage: node scripts/production-release.mjs <prepare|prepare-draft|capture-rollback|publish|validate-repair|verify-rollback-version>"
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
