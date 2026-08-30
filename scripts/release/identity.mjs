export const WORKER_NAME = "agent-outbox";
export const WORKER_VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const RELEASE_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const POSITIVE_INTEGER_ID = /^[1-9]\d*$/;
export const REPOSITORY_NAME = /^[^/\s]+\/[^/\s]+$/;

const WORKER_VERSION_MESSAGE =
  /^run ([1-9]\d*) release ([1-9]\d*) ([0-9a-f]{12})$/;
const WORKER_VERSION_MESSAGE_MAX_LENGTH = 100;

export const GITHUB_RELEASE_ID_ENV_NAME = "AGENT_OUTBOX_GITHUB_RELEASE_ID";
export const PRIOR_WORKER_VERSION_ID_ENV_NAME =
  "AGENT_OUTBOX_PRIOR_WORKER_VERSION_ID";
export const CANDIDATE_WORKER_VERSION_ID_ENV_NAME =
  "AGENT_OUTBOX_CANDIDATE_WORKER_VERSION_ID";

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isWorkerVersionId(value) {
  return typeof value === "string" && WORKER_VERSION_ID.test(value);
}

export class ReleaseHoldError extends Error {
  /** @param {string} reason @param {{ cause?: unknown }} [options] */
  constructor(reason, options) {
    super(`release transaction is in hold state: ${reason}`, options);
    this.name = "ReleaseHoldError";
  }
}

export class PublicationStateUnknownError extends ReleaseHoldError {
  /** @param {string} releaseTag @param {{ cause?: unknown }} [options] */
  constructor(releaseTag, options) {
    super(
      `${releaseTag} publication may have succeeded, but its final state could not be proven; refusing automatic rollback or draft deletion`,
      options
    );
    this.name = "PublicationStateUnknownError";
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFullGitSha(value) {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isReleaseTag(value) {
  return typeof value === "string" && RELEASE_TAG_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPositiveIntegerId(value) {
  return typeof value === "string" && POSITIVE_INTEGER_ID.test(value);
}

/**
 * Parse a GitHub release or Actions run id that must already be a positive
 * integer. Callers supply the field name used in the error.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function parsePositiveIntegerId(value, name) {
  const text = String(value ?? "").trim();
  if (!POSITIVE_INTEGER_ID.test(text)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const id = Number(text);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return id;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
export function requireFullGitSha(value, name) {
  if (!isFullGitSha(value)) {
    throw new Error(`${name} must be the 40-character candidate commit.`);
  }
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {string}
 */
export function requireReleaseTag(value, name = "RELEASE_TAG") {
  if (!isReleaseTag(value)) {
    throw new Error(`${name} must be a numbered vX.Y.Z release tag.`);
  }
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function requireRepositoryName(value) {
  if (typeof value !== "string" || !REPOSITORY_NAME.test(value)) {
    throw new Error("GITHUB_REPOSITORY must be set to owner/repo.");
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {string}
 */
export function requireRunId(value, name = "GITHUB_RUN_ID") {
  if (!isPositiveIntegerId(value)) {
    throw new Error(`${name} must be a positive GitHub Actions run id.`);
  }
  return /** @type {string} */ (value);
}

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
 * @param {{
 *   runId: string,
 *   releaseId: string | number,
 *   sha: string
 * }} input
 */
export function serializeWorkerVersionMessage(input) {
  const runId = String(input.runId ?? "");
  const releaseId = String(input.releaseId ?? "");
  const sha = String(input.sha ?? "");
  if (!POSITIVE_INTEGER_ID.test(runId)) {
    throw new Error("Worker version message run id must be a positive integer");
  }
  if (!POSITIVE_INTEGER_ID.test(releaseId)) {
    throw new Error(
      "Worker version message release id must be a positive integer"
    );
  }
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error("Worker version message requires a 40-character git SHA");
  }
  const message = `run ${runId} release ${releaseId} ${sha.slice(0, 12)}`;
  if (message.length > WORKER_VERSION_MESSAGE_MAX_LENGTH) {
    throw new Error(
      `Worker version message exceeds ${WORKER_VERSION_MESSAGE_MAX_LENGTH} characters`
    );
  }
  const parsed = parseWorkerVersionMessage(message);
  if (
    parsed.runId !== runId ||
    parsed.releaseId !== releaseId ||
    parsed.sha12 !== sha.slice(0, 12)
  ) {
    throw new Error("Worker version message failed round-trip validation");
  }
  return message;
}

/**
 * @param {unknown} value
 * @returns {{ runId: string, releaseId: string, sha12: string }}
 */
export function parseWorkerVersionMessage(value) {
  if (typeof value !== "string") {
    throw new Error("Worker version message is missing");
  }
  const match = WORKER_VERSION_MESSAGE.exec(value.trim());
  if (!match) {
    throw new Error(`Worker version message is not exact: ${value}`);
  }
  return {
    runId: match[1],
    releaseId: match[2],
    sha12: match[3]
  };
}

export class WorkerVersionMatchError extends Error {
  /**
   * @param {string} expectedMessage
   * @param {number} matchCount
   */
  constructor(expectedMessage, matchCount) {
    super(
      `expected exactly one Worker version with message ${expectedMessage}, found ${matchCount}`
    );
    this.name = "WorkerVersionMatchError";
    this.expectedMessage = expectedMessage;
    this.matchCount = matchCount;
  }
}

/**
 * @param {unknown} versions
 * @param {{ runId: string, releaseId: string | number, sha: string }} expected
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {any | null}
 */
export function findExactWorkerVersion(versions, expected, options = {}) {
  const expectedMessage = serializeWorkerVersionMessage(expected);
  const list = Array.isArray(versions) ? versions : [];
  const matches = list.filter((version) => {
    const annotations =
      /** @type {{ annotations?: Record<string, unknown> }} */ (version)
        .annotations;
    const message = annotations?.["workers/message"];
    return message === expectedMessage;
  });
  if (matches.length === 0 && options.allowMissing) {
    return null;
  }
  if (matches.length !== 1) {
    throw new WorkerVersionMatchError(expectedMessage, matches.length);
  }
  return matches[0];
}

/**
 * Shared GitHub Actions workflow-context contract. Callers pass `env`; this
 * module never reads `process.env`.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{
 *   allowedWorkflows: string[],
 *   requireMainRef?: boolean,
 *   actionsMessage?: string,
 *   refMessage?: string,
 *   workflowMessage?: string
 * }} options
 * @returns {string[]}
 */
export function validateActionsContext(env, options) {
  const failures = [];
  const actionsMessage =
    options.actionsMessage ?? "Production releases must run in GitHub Actions.";
  const refMessage =
    options.refMessage ?? "Production releases must run from refs/heads/main.";
  if (env.GITHUB_ACTIONS !== "true") {
    failures.push(actionsMessage);
  }
  if (
    options.requireMainRef !== false &&
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    failures.push(refMessage);
  }
  if (
    !options.allowedWorkflows.some((workflow) =>
      env.GITHUB_WORKFLOW_REF?.includes(`/.github/workflows/${workflow}@`)
    )
  ) {
    failures.push(
      options.workflowMessage ??
        (options.allowedWorkflows.length === 1
          ? `Production mutation must run from ${options.allowedWorkflows[0]}.`
          : `Production mutation must run from ${options.allowedWorkflows.join(" or ")}.`)
    );
  }
  return failures;
}
