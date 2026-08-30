import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyCommittedMarketingReleaseFiles } from "./marketing-screenshots.mjs";
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
    readGitFile,
    sleep: delay
  };
}

function mutationInputFromEnv(env = process.env) {
  const context = resolveReleaseContext(env, {
    workflow: "deploy-production.yml",
    requireExactRun: true
  });
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
    const context = resolveReleaseContext(process.env, {
      workflow: "deploy-production.yml",
      requireExactRun: true
    });
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
      draft_state: result.kind === "committed" ? "committed" : "prepared"
    });
  });
}

async function uploadReleaseAssets() {
  await withDeployCompensation(async () => {
    const context = resolveReleaseContext(process.env, {
      workflow: "deploy-production.yml",
      requireExactRun: true,
      requireReleaseId: true
    });
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
    const context = resolveReleaseContext(process.env, {
      workflow: "deploy-production.yml",
      requireExactRun: true,
      requireReleaseId: true
    });
    const orchestrator = defaultOrchestrator();
    const status = await orchestrator.cloudflare.deploymentStatus();
    const response = await fetch(new URL("/api/runtime/canary", baseUrl), {
      headers: { authorization: `Bearer ${smokeToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`runtime canary returned ${response.status}`);
    }
    const target = selectRollbackTarget(status, await response.json());
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
    const context = resolveReleaseContext(process.env, {
      workflow: "deploy-production.yml",
      requireExactRun: true,
      requireReleaseId: true
    });
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

async function publishRelease() {
  await withDeployCompensation(async () => {
    const context = resolveReleaseContext(process.env, {
      workflow: "deploy-production.yml",
      requireExactRun: true,
      requireReleaseId: true
    });
    try {
      await runReleasePublication(defaultOrchestrator(), {
        repository: context.repository,
        releaseTag: context.releaseTag,
        expectedSha: context.candidateSha,
        runId: /** @type {string} */ (context.runId),
        releaseId: /** @type {number} */ (context.releaseId)
      });
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

async function main() {
  switch (process.argv[2]) {
    case "prepare":
      prepareRelease();
      break;
    case "prepare-draft":
      await prepareReleaseDraft();
      break;
    case "upload-assets":
      await uploadReleaseAssets();
      break;
    case "capture-rollback":
      await captureRollbackTarget();
      break;
    case "compare-triggers":
      compareWorkerTriggers();
      break;
    case "upload-worker":
      await uploadWorkerVersion();
      break;
    case "deploy-staged":
      await deployStagedWorker();
      break;
    case "promote":
      await promoteWorker();
      break;
    case "publish":
      await publishRelease();
      break;
    case "reconcile":
      await reconcileRelease();
      break;
    case "detect-abandoned":
      await detectAbandoned();
      break;
    case "verify-rollback-version":
      verifyRollbackVersion();
      break;
    default:
      throw new Error(
        "Usage: node scripts/production-release.mjs <prepare|prepare-draft|upload-assets|capture-rollback|compare-triggers|upload-worker|deploy-staged|promote|publish|reconcile|detect-abandoned|verify-rollback-version>"
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
