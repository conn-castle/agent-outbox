import { selectRollbackTarget } from "../../scripts/release/decide.mjs";
import {
  assertCapturedPriorMatchesMarker,
  parseOwnershipMarker
} from "../../scripts/release/marker.mjs";
import {
  persistOwnedDraftIdentities,
  runAssetReconciliation,
  runDraftPreparation,
  runReleasePublication
} from "../../scripts/release/phases.mjs";
import { assertWorkerTriggersUnchanged } from "../../scripts/worker-deploy.mjs";
import {
  RELEASE,
  orchestrator as makeOrchestrator
} from "./release-fixtures.mjs";

/**
 * Exercise the real exported phase sequence in shipping workflow order.
 *
 * @param {ReturnType<typeof makeOrchestrator>} orch
 * @param {{
 *   assets: { name: string, path: string, bytes: Buffer }[],
 *   liveConfig?: unknown,
 *   candidateConfig?: unknown,
 *   rollbackTargetSmoke?: () => unknown | Promise<unknown>,
 *   migrate?: () => unknown | Promise<unknown>,
 *   overrideSmoke?: () => unknown | Promise<unknown>,
 *   productionSmoke?: () => unknown | Promise<unknown>,
 *   failAfter?: "upload" | "staged" | "override-smoke" | "promote"
 * }} input
 */
export async function runReleasePhases(orch, input) {
  const cloudflare = orch.cloudflare;
  if (!cloudflare) {
    throw new Error("Cloudflare gateway is required for production release");
  }

  const draft = await runDraftPreparation(orch, RELEASE);
  if (draft.kind === "committed") {
    return draft;
  }

  await runAssetReconciliation(orch, {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseId: draft.releaseId,
    assets: input.assets
  });

  const deployment = await cloudflare.deploymentStatus();
  const canary = await orch.runtimeCanary();
  const rollback = selectRollbackTarget(deployment, canary);
  const current = await orch.github.getRelease(
    RELEASE.repository,
    draft.releaseId
  );
  assertCapturedPriorMatchesMarker(
    parseOwnershipMarker(current?.body ?? ""),
    rollback
  );
  await persistOwnedDraftIdentities(orch, {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseId: draft.releaseId,
    priorSha: rollback.rollbackRelease,
    priorVersionId: rollback.rollbackVersionId
  });

  if (input.rollbackTargetSmoke) {
    await input.rollbackTargetSmoke();
  }

  assertWorkerTriggersUnchanged(
    input.liveConfig ?? { routes: [], triggers: {} },
    input.candidateConfig ?? input.liveConfig ?? { routes: [], triggers: {} }
  );

  if (input.failAfter === "upload") {
    throw new Error("version upload failed");
  }
  const uploaded = await cloudflare.uploadVersion({});
  await persistOwnedDraftIdentities(orch, {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseId: draft.releaseId,
    candidateVersionId: uploaded.versionId
  });

  if (input.migrate) {
    await input.migrate();
  }

  if (input.failAfter === "staged") {
    throw new Error("0% deploy failed");
  }
  await cloudflare.deployVersions(
    [
      { versionId: rollback.rollbackVersionId, percentage: 100 },
      { versionId: uploaded.versionId, percentage: 0 }
    ],
    `Stage candidate ${uploaded.versionId} at 0%`
  );

  if (input.overrideSmoke) {
    await input.overrideSmoke();
  }
  if (input.failAfter === "override-smoke") {
    throw new Error("override smoke failed");
  }

  if (input.failAfter === "promote") {
    throw new Error("promotion failed");
  }
  await cloudflare.deployVersions(
    [{ versionId: uploaded.versionId, percentage: 100 }],
    `Promote candidate ${uploaded.versionId} to 100%`
  );

  if (input.productionSmoke) {
    await input.productionSmoke();
  }

  await runReleasePublication(orch, {
    ...RELEASE,
    releaseId: draft.releaseId
  });
  return { kind: "committed", releaseId: draft.releaseId };
}
