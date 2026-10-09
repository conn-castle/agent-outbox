import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyCommittedMarketingReleaseFiles } from "./marketing-screenshots.mjs";
import { certifiedReleaseAssets } from "./release/assets.mjs";
import { selectRollbackTarget } from "./release/decide.mjs";
import { createCloudflareGateway } from "./release/gateway-cloudflare.mjs";
import {
  WRANGLER_CONFIG_RELATIVE_PATH,
  localTagCommit,
  readGitFile
} from "./release/gateway-git.mjs";
import { defaultGithubGateway } from "./release/gateway-github.mjs";
import {
  CANDIDATE_WORKER_VERSION_ID_ENV_NAME,
  FULL_GIT_SHA,
  GITHUB_RELEASE_ID_ENV_NAME,
  PRIOR_WORKER_VERSION_ID_ENV_NAME,
  PublicationStateUnknownError,
  ReleaseHoldError,
  WORKER_NAME,
  isFullGitSha,
  isPositiveIntegerId,
  isWorkerVersionId,
  parsePositiveIntegerId,
  releaseMetadata,
  requireFullGitSha,
  requireReleaseTag,
  requireRepositoryName,
  requireRunId,
  validateActionsContext,
  validateWorkerVersionReleaseTag
} from "./release/identity.mjs";
import {
  assertCapturedPriorMatchesMarker,
  parseOwnershipMarker
} from "./release/marker.mjs";
import {
  persistOwnedDraftIdentities,
  runAbandonedDetection,
  runAssetReconciliation,
  runDraftPreparation,
  runReconciliation,
  runReleasePublication
} from "./release/phases.mjs";
import { ROOT } from "./repo-root.mjs";
import {
  assertWorkerTriggersUnchanged,
  runPromoteCandidate,
  runStagedVersionDeploy,
  runWorkerVersionUpload
} from "./worker-deploy.mjs";

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
 * @param {"deploy-production.yml" | "reconcile-production-release.yml" | "rollback-production.yml" | "detect-abandoned-production-release.yml"} workflow
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function requireProductionWorkflowContext(workflow, env = process.env) {
  const failures = validateActionsContext(env, {
    allowedWorkflows: [workflow],
    requireMainRef: workflow !== "detect-abandoned-production-release.yml"
  });
  if (failures.length > 0) {
    throw new Error(failures[0]);
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{
 *   workflow: "deploy-production.yml" | "reconcile-production-release.yml" | "rollback-production.yml" | "detect-abandoned-production-release.yml",
 *   requireExactRun?: boolean,
 *   requireReleaseId?: boolean
 * }} options
 */
function resolveReleaseContext(env, options) {
  requireProductionWorkflowContext(options.workflow, env);
  const explicitSha = env.RELEASE_CANDIDATE_SHA ?? "";
  const candidateSha = isFullGitSha(explicitSha)
    ? explicitSha
    : requireFullGitSha(env.GITHUB_SHA, "GITHUB_SHA");
  const releaseIdRaw = env[GITHUB_RELEASE_ID_ENV_NAME];
  const releaseId = options.requireReleaseId
    ? parsePositiveIntegerId(releaseIdRaw, GITHUB_RELEASE_ID_ENV_NAME)
    : isPositiveIntegerId(releaseIdRaw ?? "")
      ? Number(releaseIdRaw)
      : undefined;
  const priorSha = env.AGENT_OUTBOX_ROLLBACK_RELEASE ?? "";
  const priorVersionId = env[PRIOR_WORKER_VERSION_ID_ENV_NAME] ?? "";
  const candidateVersionId = env[CANDIDATE_WORKER_VERSION_ID_ENV_NAME] ?? "";
  const runId =
    options.requireExactRun === false
      ? isPositiveIntegerId(env.GITHUB_RUN_ID ?? "")
        ? env.GITHUB_RUN_ID
        : undefined
      : requireRunId(env.GITHUB_RUN_ID);
  return {
    repository: requireRepositoryName(env.GITHUB_REPOSITORY),
    releaseTag: requireReleaseTag(env.RELEASE_TAG),
    candidateSha,
    runId,
    releaseId,
    claimed: {
      candidateSha:
        options.requireExactRun === false && !isFullGitSha(explicitSha)
          ? undefined
          : candidateSha,
      runId: options.requireExactRun === false ? undefined : runId,
      releaseId: releaseId === undefined ? undefined : String(releaseId),
      priorSha: isFullGitSha(priorSha) ? priorSha : undefined,
      priorVersionId: isWorkerVersionId(priorVersionId)
        ? priorVersionId
        : undefined,
      candidateVersionId: isWorkerVersionId(candidateVersionId)
        ? candidateVersionId
        : undefined
    }
  };
}

/**
 * @param {() => unknown | Promise<unknown>} cleanup
 * @param {{
 *   processRef?: {
 *     once: (signal: NodeJS.Signals, listener: (...args: any[]) => void) => unknown,
 *     removeListener: (signal: NodeJS.Signals, listener: (...args: any[]) => void) => unknown
 *   },
 *   signals?: NodeJS.Signals[],
 *   exitProcess?: (code: number) => void
 * }} [options]
 */
export function installCompensationHandlers(cleanup, options = {}) {
  const processRef = options.processRef ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const exitProcess =
    options.exitProcess ??
    ((code) => {
      process.exit(code);
    });
  let ran = false;
  const handler = async () => {
    if (ran) {
      return;
    }
    ran = true;
    try {
      await cleanup();
    } catch (error) {
      console.error(error);
    } finally {
      exitProcess(1);
    }
  };
  for (const signal of signals) {
    processRef.once(signal, handler);
  }
  return () => {
    for (const signal of signals) {
      processRef.removeListener(signal, handler);
    }
  };
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function defaultRuntimeCanary() {
  const baseUrl = process.env.APP_BASE_URL;
  const smokeToken = process.env.SMOKE_OR_CLEANUP_TOKEN;
  if (!baseUrl || !smokeToken) {
    throw new Error(
      "APP_BASE_URL and SMOKE_OR_CLEANUP_TOKEN are required to prove runtime SHA"
    );
  }
  const response = await fetch(new URL("/api/runtime/canary", baseUrl), {
    headers: { authorization: `Bearer ${smokeToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`runtime canary returned ${response.status}`);
  }
  return response.json();
}

function defaultOrchestrator() {
  return {
    github: defaultGithubGateway,
    cloudflare: createCloudflareGateway(process.env),
    runtimeCanary: defaultRuntimeCanary,
    sleep: delay
  };
}

/** @param {boolean} [requireReleaseId] */
function deployReleaseContext(requireReleaseId = false) {
  return resolveReleaseContext(process.env, {
    workflow: "deploy-production.yml",
    requireExactRun: true,
    requireReleaseId
  });
}

function mutationInputFromEnv() {
  const context = deployReleaseContext();
  return {
    repository: context.repository,
    releaseTag: context.releaseTag,
    expectedSha: context.candidateSha,
    runId: /** @type {string} */ (context.runId)
  };
}

/** @param {() => unknown | Promise<unknown>} work */
async function withDeployCompensation(work) {
  const stop = installCompensationHandlers(async () => {
    const context = deployReleaseContext();
    await runReconciliation(defaultOrchestrator(), {
      repository: context.repository,
      releaseTag: context.releaseTag,
      expectedSha: context.candidateSha,
      runId: context.runId,
      requireExactRun: true,
      priorVersionId: context.claimed.priorVersionId ?? null,
      candidateVersionId: context.claimed.candidateVersionId ?? null,
      priorSha: context.claimed.priorSha ?? null
    });
  });
  try {
    return await work();
  } finally {
    stop();
  }
}

function prepareRelease() {
  requireProductionWorkflowContext("deploy-production.yml");
  verifyCommittedMarketingReleaseFiles();
  const metadata = releaseMetadata(
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  );
  const candidateSha = requireFullGitSha(process.env.GITHUB_SHA, "GITHUB_SHA");
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

async function prepareReleaseDraft() {
  await withDeployCompensation(async () => {
    const input = mutationInputFromEnv();
    const result = await runDraftPreparation(defaultOrchestrator(), input);
    writeGithubOutputs({
      github_release_id: String(result.releaseId),
      draft_state:
        result.kind === "committed"
          ? "committed"
          : result.kind === "owned_publishing"
            ? "publishing"
            : "prepared"
    });
  });
}

async function uploadReleaseAssets() {
  await withDeployCompensation(async () => {
    const context = deployReleaseContext(true);
    await runAssetReconciliation(defaultOrchestrator(), {
      repository: context.repository,
      releaseId: /** @type {number} */ (context.releaseId),
      runId: context.runId,
      candidateSha: context.candidateSha,
      releaseTag: context.releaseTag
    });
  });
}

async function captureRollbackTarget() {
  await withDeployCompensation(async () => {
    const baseUrl = process.env.APP_BASE_URL;
    const smokeToken = process.env.SMOKE_OR_CLEANUP_TOKEN;
    if (!baseUrl || !smokeToken) {
      throw new Error(
        "APP_BASE_URL and SMOKE_OR_CLEANUP_TOKEN are required to capture rollback state"
      );
    }
    const context = deployReleaseContext(true);
    const orchestrator = defaultOrchestrator();
    const status = await orchestrator.cloudflare.deploymentStatus();
    const target = selectRollbackTarget(
      status,
      await orchestrator.runtimeCanary()
    );
    const current = await orchestrator.github.getRelease(
      context.repository,
      /** @type {number} */ (context.releaseId)
    );
    assertCapturedPriorMatchesMarker(
      parseOwnershipMarker(current?.body ?? ""),
      target
    );
    await persistOwnedDraftIdentities(orchestrator, {
      repository: context.repository,
      releaseId: /** @type {number} */ (context.releaseId),
      runId: /** @type {string} */ (context.runId),
      candidateSha: context.candidateSha,
      releaseTag: context.releaseTag,
      priorSha: target.rollbackRelease,
      priorVersionId: target.rollbackVersionId
    });
    writeGithubOutputs({
      rollback_version_id: target.rollbackVersionId,
      rollback_release: target.rollbackRelease
    });
  });
}

function compareWorkerTriggers() {
  requireProductionWorkflowContext("deploy-production.yml");
  const liveSha = process.env.AGENT_OUTBOX_ROLLBACK_RELEASE ?? "";
  if (!FULL_GIT_SHA.test(liveSha)) {
    throw new Error(
      "AGENT_OUTBOX_ROLLBACK_RELEASE must be the live release SHA"
    );
  }
  const liveConfig = readGitFile(liveSha, WRANGLER_CONFIG_RELATIVE_PATH);
  const candidateConfig = readFileSync(
    path.join(ROOT, WRANGLER_CONFIG_RELATIVE_PATH),
    "utf8"
  );
  assertWorkerTriggersUnchanged(liveConfig, candidateConfig);
}

async function uploadWorkerVersion() {
  await withDeployCompensation(async () => {
    const context = deployReleaseContext(true);
    const result = runWorkerVersionUpload({ env: process.env });
    await persistOwnedDraftIdentities(defaultOrchestrator(), {
      repository: context.repository,
      releaseId: /** @type {number} */ (context.releaseId),
      runId: /** @type {string} */ (context.runId),
      candidateSha: context.candidateSha,
      releaseTag: context.releaseTag,
      candidateVersionId: result.versionId
    });
    writeGithubOutputs({
      candidate_version_id: result.versionId
    });
  });
}

async function deployStagedWorker() {
  await withDeployCompensation(async () => {
    requireProductionWorkflowContext("deploy-production.yml");
    runStagedVersionDeploy({ env: process.env });
  });
}

async function promoteWorker() {
  await withDeployCompensation(async () => {
    requireProductionWorkflowContext("deploy-production.yml");
    runPromoteCandidate({ env: process.env });
  });
}

/**
 * Recover uncertain publication once inside the successful deploy path. Each
 * recovery mutation requires a fresh full live smoke and certified byte proof;
 * cleanup and signal compensation never receive this capability.
 *
 * @param {import("./release/phases.mjs").ReleaseOrchestrator} orchestrator
 * @param {Parameters<typeof runReleasePublication>[1]} input
 * @param {() => unknown | Promise<unknown>} verifyLiveCandidate
 */
export async function runDeployPublication(
  orchestrator,
  input,
  verifyLiveCandidate
) {
  try {
    return await runReleasePublication(orchestrator, input);
  } catch (error) {
    if (!(error instanceof PublicationStateUnknownError)) {
      throw error;
    }
    console.warn(
      `${input.releaseTag} publication is unproven; attempting one bounded recovery with fresh live smoke and certified assets.`
    );
    return runReleasePublication(orchestrator, {
      ...input,
      verifyLiveCandidate
    });
  }
}

function verifyLiveCandidateForPublication() {
  const result = spawnSync("corepack", ["pnpm", "run", "smoke-runtime"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_OUTBOX_EXPECTED_RELEASE: requireFullGitSha(
        process.env.GITHUB_SHA,
        "GITHUB_SHA"
      ),
      AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1",
      AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1",
      AGENT_OUTBOX_WORKER_VERSION_OVERRIDE: ""
    },
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new ReleaseHoldError(
      "fresh live runtime smoke failed; refusing automatic publication recovery"
    );
  }
}

async function publishRelease() {
  await withDeployCompensation(async () => {
    const context = deployReleaseContext(true);
    try {
      await runDeployPublication(
        defaultOrchestrator(),
        {
          repository: context.repository,
          releaseTag: context.releaseTag,
          expectedSha: context.candidateSha,
          runId: /** @type {string} */ (context.runId),
          releaseId: /** @type {number} */ (context.releaseId),
          assets: certifiedReleaseAssets()
        },
        verifyLiveCandidateForPublication
      );
      writeGithubOutputs({ publication_state: "published" });
    } catch (error) {
      writeGithubOutputs({
        publication_state:
          error instanceof ReleaseHoldError ? "hold" : "unpublished"
      });
      throw error;
    }
  });
}

async function reconcileRelease() {
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "";
  const manualReconcile = workflowRef.includes(
    "/.github/workflows/reconcile-production-release.yml@"
  );
  const context = resolveReleaseContext(process.env, {
    workflow: manualReconcile
      ? "reconcile-production-release.yml"
      : "deploy-production.yml",
    requireExactRun: !manualReconcile
  });
  const orchestrator = defaultOrchestrator();
  let liveSha = null;
  try {
    const body = await defaultRuntimeCanary();
    if (FULL_GIT_SHA.test(body?.environment?.release ?? "")) {
      liveSha = body.environment.release;
    }
  } catch {
    liveSha = null;
  }
  const decision = await runReconciliation(orchestrator, {
    repository: context.repository,
    releaseTag: context.releaseTag,
    expectedSha: context.claimed.candidateSha,
    runId: context.claimed.runId,
    requireExactRun: !manualReconcile,
    priorVersionId: context.claimed.priorVersionId ?? null,
    candidateVersionId: context.claimed.candidateVersionId ?? null,
    priorSha: context.claimed.priorSha ?? null,
    liveSha,
    releaseId: context.releaseId
  });
  if (process.env.GITHUB_OUTPUT) {
    writeGithubOutputs({
      reconciliation_action: String(decision.action)
    });
  }
}

async function detectAbandoned() {
  requireProductionWorkflowContext("detect-abandoned-production-release.yml");
  await runAbandonedDetection(defaultOrchestrator(), {
    repository: requireRepositoryName(process.env.GITHUB_REPOSITORY)
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

const COMMANDS = {
  prepare: prepareRelease,
  "prepare-draft": prepareReleaseDraft,
  "upload-assets": uploadReleaseAssets,
  "capture-rollback": captureRollbackTarget,
  "compare-triggers": compareWorkerTriggers,
  "upload-worker": uploadWorkerVersion,
  "deploy-staged": deployStagedWorker,
  promote: promoteWorker,
  publish: publishRelease,
  reconcile: reconcileRelease,
  "detect-abandoned": detectAbandoned,
  "verify-rollback-version": verifyRollbackVersion
};

async function main() {
  const command = process.argv[2] ?? "";
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(
      `Usage: node scripts/production-release.mjs <${Object.keys(COMMANDS).join("|")}>`
    );
  }
  await COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)]();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
