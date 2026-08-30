import { certifiedReleaseAssets } from "./assets.mjs";
import {
  classifyFinalizeFailure,
  classifiedRelease,
  classifyLiveTraffic,
  classifySameTagReleases,
  decideReconciliation,
  derivePriorIdentityFromLiveState
} from "./decide.mjs";
import { resolveCandidateWorkerVersionId } from "./gateway-cloudflare.mjs";
import {
  assertGithubMutationResult,
  commandFailureMessage
} from "./gateway-github.mjs";
import {
  FULL_GIT_SHA,
  PublicationStateUnknownError,
  ReleaseHoldError,
  isWorkerVersionId
} from "./identity.mjs";
import {
  assertClaimedIdentities,
  identitiesFromMarker,
  markerMatchesRun,
  parseOwnershipMarker,
  serializeOwnershipMarker
} from "./marker.mjs";

export const RESTORE_PROOF_ATTEMPTS = 6;
export const RESTORE_PROOF_BACKOFF_MS = 10_000;
const FINALIZE_MAX_ATTEMPTS = 5;
const FINALIZE_BACKOFF_MS = 5_000;
const FINALIZE_VERIFY_BACKOFF_MS = 2_000;

const ACTIVE_ACTIONS_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending"
]);

/**
 * @typedef {import("./model.mjs").GithubRelease} GithubRelease
 * @typedef {import("./marker.mjs").OwnershipMarker} OwnershipMarker
 * @typedef {import("./decide.mjs").SameTagClassification} SameTagClassification
 * @typedef {import("./gateway-github.mjs").GithubGateway} GithubGateway
 * @typedef {import("./gateway-cloudflare.mjs").CloudflareGateway} CloudflareGateway
 * @typedef {import("./gateway-cloudflare.mjs").WorkerDeploymentStatus} WorkerDeploymentStatus
 *
 * @typedef {object} ReleaseOrchestrator
 * @property {GithubGateway} github
 * @property {CloudflareGateway} [cloudflare]
 * @property {(url: string, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @property {() => unknown | Promise<unknown>} [runtimeCanary]
 * @property {(relativePath: string, sha: string) => string} [readGitFile]
 * @property {(ms: number) => void | Promise<void>} sleep
 */

/** @param {unknown} error */
function isTransientGatewayError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return classifyFinalizeFailure(message) === "transient";
}

/** @param {string} stderr */
function isAlreadyExistsFailure(stderr) {
  return /already[_ ]exists/i.test(stderr);
}

/**
 * Prove the exact-owned prepared draft. Missing releases fail loudly;
 * published, publishing, or unowned drafts are holds.
 *
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   runId: string,
 *   candidateSha: string,
 *   releaseTag: string
 * }} ownership
 * @param {number} releaseId
 * @param {string} context
 * @returns {Promise<{ release: GithubRelease, marker: OwnershipMarker }>}
 */
async function requireOwnedPreparedDraft(
  orchestrator,
  ownership,
  releaseId,
  context
) {
  const release = await orchestrator.github.getRelease(
    ownership.repository,
    releaseId
  );
  if (!release) {
    throw new Error(`release ${releaseId} is not present for ${context}`);
  }
  if (!release.draft) {
    throw new ReleaseHoldError(
      `refusing ${context} on a published GitHub release`
    );
  }
  const marker = parseOwnershipMarker(release.body);
  if (
    !marker ||
    !markerMatchesRun(marker, ownership) ||
    marker.state !== "prepared"
  ) {
    throw new ReleaseHoldError(
      `refusing ${context} on a publishing, published, or unowned draft`
    );
  }
  return { release, marker };
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   expectedSha: string,
 *   runId: string,
 *   requireExactRun?: boolean
 * }} input
 */
async function readGithubReleaseSnapshot(orchestrator, input) {
  const [releases, tagCommit] = await Promise.all([
    orchestrator.github.listReleases(input.repository),
    orchestrator.github.remoteTagCommit(input.repository, input.releaseTag)
  ]);
  return {
    releases,
    tagCommit,
    classification: classifySameTagReleases({
      releases,
      tagCommit,
      expectedSha: input.expectedSha,
      repository: input.repository,
      runId: input.runId,
      releaseTag: input.releaseTag,
      requireExactRun: input.requireExactRun
    })
  };
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   requireExactRun?: boolean,
 *   runId?: string,
 *   claimed?: {
 *     candidateSha?: string,
 *     runId?: string,
 *     releaseId?: number | string,
 *     priorSha?: string,
 *     priorVersionId?: string,
 *     candidateVersionId?: string
 *   }
 * }} input
 */
export async function deriveReleaseIdentities(orchestrator, input) {
  const { releases, tagCommit, classification } =
    await readGithubReleaseSnapshot(orchestrator, {
      repository: input.repository,
      releaseTag: input.releaseTag,
      expectedSha: input.claimed?.candidateSha ?? "",
      runId: input.runId ?? "",
      requireExactRun: input.requireExactRun
    });

  if (classification.kind === "absent") {
    return {
      kind: /** @type {const} */ ("absent"),
      tagCommit: null,
      releaseId: null,
      runId: null,
      candidateSha: null,
      releaseTag: input.releaseTag,
      repository: input.repository,
      priorSha: null,
      priorVersionId: null,
      candidateVersionId: null,
      state: null,
      marker: null,
      release: null,
      classification,
      releases
    };
  }

  if (
    classification.kind === "committed" ||
    classification.kind === "published_tag_pending"
  ) {
    const release = classifiedRelease(classification);
    const derived = {
      kind: classification.kind,
      tagCommit,
      releaseId: release.id,
      runId: parseOwnershipMarker(release.body)?.runId ?? null,
      candidateSha:
        tagCommit ||
        input.claimed?.candidateSha ||
        (FULL_GIT_SHA.test(release.targetCommitish)
          ? release.targetCommitish
          : null),
      releaseTag: input.releaseTag,
      repository: input.repository,
      priorSha: null,
      priorVersionId: null,
      candidateVersionId: null,
      state: /** @type {const} */ ("published"),
      marker: parseOwnershipMarker(release.body),
      release,
      classification,
      releases
    };
    assertClaimedIdentities(
      { ...derived, runId: derived.runId ?? "" },
      {
        ...input.claimed,
        runId: undefined,
        priorSha: undefined,
        priorVersionId: undefined,
        candidateVersionId: undefined
      }
    );
    if (
      input.claimed?.candidateSha &&
      derived.candidateSha &&
      input.claimed.candidateSha !== derived.candidateSha
    ) {
      throw new ReleaseHoldError(
        "claimed candidateSha does not match derived GitHub/Cloudflare state"
      );
    }
    return derived;
  }

  if (classification.kind === "hold" || classification.kind === "conflict") {
    throw new ReleaseHoldError(
      classification.reason ?? "GitHub release state is not unique"
    );
  }

  const release = classifiedRelease(classification);
  const marker = classification.marker ?? parseOwnershipMarker(release.body);
  if (!marker) {
    throw new ReleaseHoldError(
      "no exact-owned draft could be derived for the tag"
    );
  }
  const derived = identitiesFromMarker(marker, release.id);
  if (
    marker.state === "prepared" &&
    orchestrator.cloudflare?.listVersions &&
    !derived.candidateVersionId &&
    derived.runId &&
    derived.candidateSha
  ) {
    let raw;
    try {
      raw = await orchestrator.cloudflare.listVersions();
    } catch (error) {
      if (error instanceof ReleaseHoldError) {
        throw error;
      }
      raw = undefined;
    }
    if (raw !== undefined) {
      const matchId = resolveCandidateWorkerVersionId(raw, {
        runId: derived.runId,
        releaseId: derived.releaseId,
        candidateSha: derived.candidateSha
      });
      if (matchId) {
        derived.candidateVersionId = matchId;
      }
    }
  }
  assertClaimedIdentities(derived, input.claimed);
  return {
    kind: marker.state === "publishing" ? "owned_publishing" : "owned_prepared",
    tagCommit,
    ...derived,
    marker,
    release,
    classification,
    releases
  };
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseId: number,
 *   runId: string,
 *   candidateSha: string,
 *   releaseTag: string,
 *   priorSha?: string | null,
 *   priorVersionId?: string | null,
 *   candidateVersionId?: string | null
 * }} input
 */
export async function persistOwnedDraftIdentities(orchestrator, input) {
  const { release, marker } = await requireOwnedPreparedDraft(
    orchestrator,
    {
      repository: input.repository,
      runId: input.runId,
      candidateSha: input.candidateSha,
      releaseTag: input.releaseTag
    },
    input.releaseId,
    "identity persistence"
  );
  if (
    (marker.priorSha && input.priorSha && marker.priorSha !== input.priorSha) ||
    (marker.priorVersionId &&
      input.priorVersionId &&
      marker.priorVersionId !== input.priorVersionId)
  ) {
    throw new ReleaseHoldError(
      "captured prior identity differs from marker-recorded prior; refusing to fork rollback target on the same run"
    );
  }
  const next = {
    ...marker,
    priorSha: input.priorSha || marker.priorSha,
    priorVersionId: input.priorVersionId || marker.priorVersionId,
    candidateVersionId: input.candidateVersionId || marker.candidateVersionId
  };
  const result = await orchestrator.github.updateRelease(
    input.repository,
    input.releaseId,
    { body: serializeOwnershipMarker(next, release.body) }
  );
  assertGithubMutationResult(result, "persist owned draft identities");
  return next;
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {string} priorSha
 */
async function provePriorRuntimeRestored(orchestrator, priorSha) {
  if (!FULL_GIT_SHA.test(priorSha)) {
    throw new ReleaseHoldError(
      "prior runtime SHA is unknown; refusing draft cleanup"
    );
  }
  if (!orchestrator.runtimeCanary) {
    throw new Error("runtime canary is required to prove restored prior SHA");
  }
  /** @type {unknown} */
  let lastError = new Error(
    "restored runtime did not prove the prior release SHA"
  );
  for (let attempt = 1; attempt <= RESTORE_PROOF_ATTEMPTS; attempt += 1) {
    try {
      const canary = await orchestrator.runtimeCanary();
      const release =
        /** @type {{ environment?: { configured?: unknown, release?: unknown } }} */ (
          canary
        ).environment;
      if (release?.configured === true && release.release === priorSha) {
        return;
      }
      lastError = new Error(
        "restored runtime did not prove the prior release SHA"
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt < RESTORE_PROOF_ATTEMPTS) {
      await orchestrator.sleep(RESTORE_PROOF_BACKOFF_MS);
    }
  }
  throw lastError;
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   releaseId: number,
 *   runId: string,
 *   candidateSha: string
 * }} identities
 */
async function proveOwnedPreparedDraftForCleanup(orchestrator, identities) {
  const { release } = await requireOwnedPreparedDraft(
    orchestrator,
    {
      repository: identities.repository,
      runId: identities.runId,
      candidateSha: identities.candidateSha,
      releaseTag: identities.releaseTag
    },
    identities.releaseId,
    "draft deletion"
  );
  const tagCommit = await orchestrator.github.remoteTagCommit(
    identities.repository,
    identities.releaseTag
  );
  if (tagCommit) {
    throw new ReleaseHoldError(
      "remote tag is present; refusing automatic draft deletion"
    );
  }
  return release;
}

/**
 * Restore prior traffic only after proving the exact-owned prepared draft and
 * that the tag is absent, then re-prove both before delete.
 *
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   releaseId: number,
 *   runId: string,
 *   candidateSha: string,
 *   priorVersionId: string,
 *   priorSha: string
 * }} identities
 */
export async function cleanupOwnedPreparedDraft(orchestrator, identities) {
  if (!FULL_GIT_SHA.test(identities.priorSha)) {
    throw new ReleaseHoldError(
      "prior runtime SHA is unknown; refusing draft cleanup"
    );
  }
  if (!isWorkerVersionId(identities.priorVersionId)) {
    throw new ReleaseHoldError("prior Worker version is unknown");
  }
  if (!orchestrator.cloudflare) {
    throw new ReleaseHoldError(
      "Cloudflare gateway is required to restore traffic"
    );
  }

  await proveOwnedPreparedDraftForCleanup(orchestrator, identities);

  await orchestrator.cloudflare.deployVersions(
    [{ versionId: identities.priorVersionId, percentage: 100 }],
    `Restore prior ${identities.priorVersionId} to 100%`
  );
  const status = await orchestrator.cloudflare.deploymentStatus();
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (
    versions.length !== 1 ||
    Number(versions[0]?.percentage) !== 100 ||
    String(versions[0]?.version_id ?? "") !== identities.priorVersionId
  ) {
    throw new Error("Cloudflare did not collapse to the prior version at 100%");
  }

  await provePriorRuntimeRestored(orchestrator, identities.priorSha);

  await proveOwnedPreparedDraftForCleanup(orchestrator, identities);

  const deleted = await orchestrator.github.deleteRelease(
    identities.repository,
    identities.releaseId
  );
  assertGithubMutationResult(deleted, "delete owned prepared draft");

  const gone = await orchestrator.github.getRelease(
    identities.repository,
    identities.releaseId
  );
  if (gone !== null) {
    throw new Error("owned prepared draft is still present after delete");
  }
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   expectedSha: string,
 *   runId: string,
 *   requireExactRun?: boolean
 * }} input
 */
export async function runDraftPreparation(orchestrator, input) {
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
    let snapshot;
    try {
      snapshot = await readGithubReleaseSnapshot(orchestrator, input);
    } catch (error) {
      if (isTransientGatewayError(error) && attempt < FINALIZE_MAX_ATTEMPTS) {
        await orchestrator.sleep(FINALIZE_BACKOFF_MS * attempt);
        continue;
      }
      throw error;
    }
    const { classification } = snapshot;
    if (classification.kind === "committed") {
      if (!classification.release) {
        throw new Error("committed classification is missing a release id");
      }
      console.log(
        `${input.releaseTag} is already published on ${input.expectedSha}.`
      );
      return {
        kind: "committed",
        releaseId: classification.release.id
      };
    }
    if (classification.kind === "owned_prepared") {
      if (!classification.release) {
        throw new Error("owned draft classification is missing a release id");
      }
      console.log(
        `${input.releaseTag} draft ${classification.release.id} is prepared on ${input.expectedSha}.`
      );
      return {
        kind: "owned_prepared",
        releaseId: classification.release.id
      };
    }
    if (classification.kind === "owned_publishing") {
      throw new ReleaseHoldError(
        `draft ${classification.release?.id ?? "unknown"} is already publishing; refusing to recreate or clean it`
      );
    }
    if (classification.kind === "published_tag_pending") {
      throw new PublicationStateUnknownError(input.releaseTag);
    }
    if (classification.kind !== "absent") {
      throw new ReleaseHoldError(
        classification.reason ?? "GitHub release state is not unique"
      );
    }

    const body = serializeOwnershipMarker({
      repository: input.repository,
      runId: input.runId,
      candidateSha: input.expectedSha,
      releaseTag: input.releaseTag,
      state: "prepared"
    });
    const result = await orchestrator.github.createDraft({
      repository: input.repository,
      tag: input.releaseTag,
      sha: input.expectedSha,
      body
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0 && result.release) {
      return {
        kind: "owned_prepared",
        releaseId: result.release.id
      };
    }
    const stderr = result.stderr ?? "";
    if (
      classifyFinalizeFailure(stderr) === "permanent" &&
      !isAlreadyExistsFailure(stderr)
    ) {
      throw new Error(
        commandFailureMessage("GitHub draft create failed", result)
      );
    }
    console.warn(
      `GitHub draft create attempt ${attempt}/${FINALIZE_MAX_ATTEMPTS} did not complete cleanly; reconciling.`
    );
    if (attempt < FINALIZE_MAX_ATTEMPTS) {
      await orchestrator.sleep(
        result.status === 0
          ? FINALIZE_VERIFY_BACKOFF_MS
          : FINALIZE_BACKOFF_MS * attempt
      );
    }
  }
  throw new Error(
    `unable to prepare ${input.releaseTag} draft after ${FINALIZE_MAX_ATTEMPTS} attempts`
  );
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseId: number,
 *   runId?: string,
 *   candidateSha?: string,
 *   releaseTag?: string,
 *   assets?: { name: string, path: string, bytes: Buffer }[]
 * }} input
 */
export async function runAssetReconciliation(orchestrator, input) {
  if (!input.runId || !input.candidateSha || !input.releaseTag) {
    throw new Error(
      "asset reconciliation requires exact ownership identity (run id, candidate SHA, and release tag)"
    );
  }
  const ownership = {
    repository: input.repository,
    runId: input.runId,
    candidateSha: input.candidateSha,
    releaseTag: input.releaseTag
  };

  const { release } = await requireOwnedPreparedDraft(
    orchestrator,
    ownership,
    input.releaseId,
    "asset reconciliation"
  );
  const assets = input.assets ?? certifiedReleaseAssets();
  for (const asset of assets) {
    const existing = release.assets.filter((item) => item.name === asset.name);
    if (existing.length > 1) {
      throw new Error(`duplicate GitHub asset name ${asset.name}`);
    }
    if (existing.length === 1) {
      const downloaded = await orchestrator.github.downloadAsset(
        input.repository,
        existing[0].id
      );
      if (
        !Buffer.isBuffer(downloaded) ||
        Buffer.compare(downloaded, asset.bytes) !== 0
      ) {
        throw new Error(
          `existing CLI release asset differs from the certified build: ${asset.name}`
        );
      }
      continue;
    }
    await requireOwnedPreparedDraft(
      orchestrator,
      ownership,
      input.releaseId,
      "asset reconciliation"
    );
    const uploaded = await orchestrator.github.uploadAsset(
      input.repository,
      input.releaseId,
      asset.name,
      asset.path
    );
    if (uploaded.error) {
      throw uploaded.error;
    }
    if (uploaded.status !== 0) {
      throw new Error(
        commandFailureMessage(`asset upload failed for ${asset.name}`, uploaded)
      );
    }
  }

  const verified = await orchestrator.github.getRelease(
    input.repository,
    input.releaseId
  );
  if (!verified) {
    throw new Error(
      `release ${input.releaseId} disappeared during asset proof`
    );
  }
  const expectedNames = assets.map((asset) => asset.name).sort();
  const actualNames = verified.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(
      "draft release asset inventory differs from the certified build"
    );
  }
  for (const asset of assets) {
    const remote = verified.assets.find((item) => item.name === asset.name);
    if (!remote) {
      throw new Error(`missing certified asset ${asset.name}`);
    }
    const downloaded = await orchestrator.github.downloadAsset(
      input.repository,
      remote.id
    );
    if (
      !Buffer.isBuffer(downloaded) ||
      Buffer.compare(downloaded, asset.bytes) !== 0
    ) {
      throw new Error(
        `draft release asset differs from the certified build: ${asset.name}`
      );
    }
  }
  return { releaseId: input.releaseId, assets: expectedNames };
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   expectedSha: string,
 *   runId: string,
 *   releaseId: number
 * }} input
 */
export async function runReleasePublication(orchestrator, input) {
  let publicationMutationAttempted = false;
  let markedPublishing = false;
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt += 1) {
    let snapshot;
    try {
      snapshot = await readGithubReleaseSnapshot(orchestrator, input);
    } catch (error) {
      if (isTransientGatewayError(error) && attempt < FINALIZE_MAX_ATTEMPTS) {
        await orchestrator.sleep(FINALIZE_BACKOFF_MS * attempt);
        continue;
      }
      if (publicationMutationAttempted || markedPublishing) {
        throw new PublicationStateUnknownError(input.releaseTag, {
          cause: error
        });
      }
      throw error;
    }
    const { classification, tagCommit } = snapshot;
    if (classification.kind === "committed") {
      console.log(`${input.releaseTag} is published on ${input.expectedSha}.`);
      return {
        kind: "committed",
        releaseId: classifiedRelease(classification).id
      };
    }
    if (classification.kind === "published_tag_pending") {
      if (attempt < FINALIZE_MAX_ATTEMPTS) {
        await orchestrator.sleep(FINALIZE_VERIFY_BACKOFF_MS * attempt);
        continue;
      }
      throw new PublicationStateUnknownError(input.releaseTag);
    }
    if (
      classification.kind !== "owned_prepared" &&
      classification.kind !== "owned_publishing"
    ) {
      throw new ReleaseHoldError(
        classification.reason ??
          `${input.releaseTag} is not an exact-candidate owned draft`
      );
    }
    const ownedRelease = classifiedRelease(classification);
    if (ownedRelease.id !== input.releaseId) {
      throw new ReleaseHoldError(
        `owned draft ${ownedRelease.id} does not match release id ${input.releaseId}`
      );
    }
    if (tagCommit && tagCommit !== input.expectedSha) {
      throw new Error(
        `remote tag ${input.releaseTag} points at ${tagCommit}, not candidate ${input.expectedSha}`
      );
    }

    if (classification.kind === "owned_prepared") {
      const currentMarker = parseOwnershipMarker(ownedRelease.body);
      const body = serializeOwnershipMarker(
        {
          ...(currentMarker ?? {
            repository: input.repository,
            runId: input.runId,
            candidateSha: input.expectedSha,
            releaseTag: input.releaseTag,
            state: "prepared"
          }),
          repository: input.repository,
          runId: input.runId,
          candidateSha: input.expectedSha,
          releaseTag: input.releaseTag,
          state: "publishing"
        },
        ownedRelease.body
      );
      markedPublishing = true;
      let markerResult;
      try {
        markerResult = await orchestrator.github.updateRelease(
          input.repository,
          input.releaseId,
          { body }
        );
      } catch (error) {
        throw new PublicationStateUnknownError(input.releaseTag, {
          cause: error
        });
      }
      if (markerResult.error) {
        throw new PublicationStateUnknownError(input.releaseTag, {
          cause: markerResult.error
        });
      }
      if (markerResult.status !== 0) {
        if (
          classifyFinalizeFailure(markerResult.stderr ?? "") === "permanent"
        ) {
          throw new Error(
            commandFailureMessage(
              "failed to mark draft publishing",
              markerResult
            )
          );
        }
        await orchestrator.sleep(FINALIZE_VERIFY_BACKOFF_MS);
        continue;
      }
    }

    let latestTagCommit;
    try {
      latestTagCommit = await orchestrator.github.remoteTagCommit(
        input.repository,
        input.releaseTag
      );
    } catch (error) {
      throw new ReleaseHoldError(
        "unable to re-resolve the remote tag immediately before publish",
        { cause: error }
      );
    }
    if (latestTagCommit && latestTagCommit !== input.expectedSha) {
      throw new ReleaseHoldError(
        `remote tag ${input.releaseTag} points at ${latestTagCommit}, not candidate ${input.expectedSha}`
      );
    }

    publicationMutationAttempted = true;
    let result;
    try {
      result = await orchestrator.github.updateRelease(
        input.repository,
        input.releaseId,
        { draft: false, make_latest: "true" }
      );
    } catch (error) {
      throw new PublicationStateUnknownError(input.releaseTag, {
        cause: error
      });
    }
    if (result.error) {
      throw new PublicationStateUnknownError(input.releaseTag, {
        cause: result.error
      });
    }
    const stderr = result.stderr ?? "";
    if (
      result.status !== 0 &&
      classifyFinalizeFailure(stderr) === "permanent"
    ) {
      throw new Error(commandFailureMessage("GitHub publish failed", result));
    }
    if (attempt < FINALIZE_MAX_ATTEMPTS) {
      await orchestrator.sleep(FINALIZE_VERIFY_BACKOFF_MS);
    }
  }
  throw new PublicationStateUnknownError(input.releaseTag);
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{
 *   repository: string,
 *   releaseTag: string,
 *   expectedSha?: string,
 *   runId?: string,
 *   priorVersionId?: string | null,
 *   priorSha?: string | null,
 *   candidateVersionId?: string | null,
 *   liveSha?: string | null,
 *   deployment?: WorkerDeploymentStatus,
 *   githubReadable?: boolean,
 *   cloudflareReadable?: boolean,
 *   requireExactRun?: boolean,
 *   releaseId?: number
 * }} input
 */
export async function runReconciliation(orchestrator, input) {
  let githubReadable = input.githubReadable;
  /** @type {Awaited<ReturnType<typeof deriveReleaseIdentities>> | null} */
  let derived = null;
  try {
    derived = await deriveReleaseIdentities(orchestrator, {
      repository: input.repository,
      releaseTag: input.releaseTag,
      requireExactRun: input.requireExactRun,
      runId: input.runId,
      claimed: {
        candidateSha: input.expectedSha,
        runId: input.requireExactRun === false ? undefined : input.runId,
        releaseId: input.releaseId,
        priorSha: input.priorSha ?? undefined,
        priorVersionId: input.priorVersionId ?? undefined,
        candidateVersionId: input.candidateVersionId ?? undefined
      }
    });
    githubReadable = true;
  } catch (error) {
    if (githubReadable === false) {
      throw new PublicationStateUnknownError(input.releaseTag, {
        cause: error
      });
    }
    throw error;
  }

  const expectedSha = derived.candidateSha || input.expectedSha || "";
  const runId = derived.runId || input.runId || "";
  /** @type {SameTagClassification} */
  const classification =
    derived.classification ??
    /** @type {SameTagClassification} */ ({ kind: "absent" });

  let traffic;
  let cloudflareReadable = input.cloudflareReadable;
  /** @type {WorkerDeploymentStatus | undefined} */
  let deployment = input.deployment;
  if (orchestrator.cloudflare && cloudflareReadable !== false) {
    try {
      deployment =
        deployment ?? (await orchestrator.cloudflare.deploymentStatus());
      cloudflareReadable = true;
    } catch (error) {
      cloudflareReadable = false;
      if (classification.kind === "owned_prepared") {
        throw new ReleaseHoldError(
          "Cloudflare is unreadable; refusing destructive draft cleanup",
          { cause: error }
        );
      }
    }
  }

  let liveSha =
    typeof input.liveSha === "string" && FULL_GIT_SHA.test(input.liveSha)
      ? input.liveSha
      : null;
  let liveConfigured = liveSha !== null;
  const needsObservedPrior =
    classification.kind === "owned_prepared" &&
    (!FULL_GIT_SHA.test(derived.priorSha ?? "") ||
      !isWorkerVersionId(derived.priorVersionId ?? ""));
  if (!liveConfigured && needsObservedPrior && orchestrator.runtimeCanary) {
    try {
      const canary = await orchestrator.runtimeCanary();
      const environment =
        /** @type {{ environment?: { configured?: unknown, release?: unknown } }} */ (
          canary
        ).environment;
      if (
        environment?.configured === true &&
        typeof environment.release === "string" &&
        FULL_GIT_SHA.test(environment.release)
      ) {
        liveSha = environment.release;
        liveConfigured = true;
      }
    } catch {
      liveConfigured = false;
    }
  }

  let priorSha = derived.priorSha;
  let priorVersionId = derived.priorVersionId;
  if (needsObservedPrior) {
    const observed = derivePriorIdentityFromLiveState({
      tagCommit: derived.tagCommit,
      expectedSha,
      candidateVersionId: derived.candidateVersionId,
      knownPriorSha: derived.priorSha,
      knownPriorVersionId: derived.priorVersionId,
      deployment,
      liveSha,
      liveConfigured,
      cloudflareReadable: cloudflareReadable === true
    });
    if (observed) {
      if (!FULL_GIT_SHA.test(priorSha ?? "")) {
        priorSha = observed.priorSha;
      }
      if (!isWorkerVersionId(priorVersionId ?? "")) {
        priorVersionId = observed.priorVersionId;
      }
    }
  }

  if (cloudflareReadable === true && deployment) {
    traffic = classifyLiveTraffic(deployment, liveSha, {
      priorVersionId,
      candidateVersionId: derived.candidateVersionId,
      expectedSha,
      priorSha
    });
  }

  const decision = decideReconciliation({
    githubReadable,
    cloudflareReadable,
    classification,
    traffic,
    priorVersionId,
    priorSha
  });

  if (decision.action === "committed") {
    console.log(`${input.releaseTag} is committed at ${expectedSha}.`);
    return decision;
  }
  if (decision.action === "absent") {
    console.log(`${input.releaseTag} has no GitHub release state.`);
    return decision;
  }
  if (decision.action === "hold") {
    throw new ReleaseHoldError(decision.reason ?? "ambiguous release state");
  }
  if (decision.action === "retry-publish") {
    if (!decision.releaseId) {
      throw new ReleaseHoldError("publishing draft is missing a release id");
    }
    await runReleasePublication(orchestrator, {
      ...input,
      expectedSha,
      runId,
      releaseId: decision.releaseId
    });
    return { ...decision, action: "retry-published" };
  }
  if (
    decision.action === "restore-then-delete-draft" ||
    decision.action === "collapse-then-delete-draft"
  ) {
    if (typeof decision.releaseId !== "number") {
      throw new ReleaseHoldError("owned draft is missing a release id");
    }
    await cleanupOwnedPreparedDraft(orchestrator, {
      repository: input.repository,
      releaseTag: input.releaseTag,
      releaseId: decision.releaseId,
      runId,
      candidateSha: expectedSha,
      priorVersionId: String(decision.priorVersionId ?? derived.priorVersionId),
      priorSha: String(decision.priorSha ?? derived.priorSha)
    });
    console.log(
      `Restored prior Worker ${decision.priorVersionId} and deleted owned draft ${decision.releaseId}.`
    );
    return decision;
  }
  throw new ReleaseHoldError(
    `unhandled reconciliation action ${decision.action}`
  );
}

/**
 * @param {ReleaseOrchestrator} orchestrator
 * @param {{ repository: string }} input
 */
export async function runAbandonedDetection(orchestrator, input) {
  const releases = await orchestrator.github.listReleases(input.repository);
  /** @type {Record<string, unknown>[]} */
  const abandonedDrafts = [];
  /** @type {Record<string, unknown>[]} */
  const unownedOrMalformedDrafts = [];
  for (const release of releases) {
    if (!release.draft) {
      continue;
    }
    const marker = parseOwnershipMarker(release.body);
    if (
      marker &&
      marker.repository === input.repository &&
      marker.runId &&
      orchestrator.github.getActionsRun
    ) {
      const ownedMarker = marker;
      const run = await orchestrator.github.getActionsRun(
        input.repository,
        ownedMarker.runId
      );
      if (run && ACTIVE_ACTIONS_RUN_STATUSES.has(String(run.status ?? ""))) {
        continue;
      }
      abandonedDrafts.push({
        releaseId: release.id,
        tagName: release.tagName,
        state: ownedMarker.state,
        runId: ownedMarker.runId,
        candidateSha: ownedMarker.candidateSha,
        owningRun: run
          ? { status: run.status, conclusion: run.conclusion ?? null }
          : null
      });
      continue;
    }
    unownedOrMalformedDrafts.push({
      releaseId: release.id,
      tagName: release.tagName,
      state: marker?.state ?? "unowned-or-malformed",
      runId: marker?.runId ?? null,
      candidateSha: marker?.candidateSha ?? null,
      owningRun: null
    });
  }
  if (unownedOrMalformedDrafts.length > 0) {
    console.warn(JSON.stringify({ unownedOrMalformedDrafts }, null, 2));
    for (const warning of unownedOrMalformedDrafts) {
      console.warn(
        `::warning::unowned or malformed GitHub release draft ${warning.releaseId} tag ${warning.tagName}`
      );
    }
  }
  if (abandonedDrafts.length > 0) {
    console.error(JSON.stringify({ abandonedDrafts }, null, 2));
    throw new Error(
      `abandoned GitHub release drafts detected: ${abandonedDrafts.length}`
    );
  }
  console.log(
    unownedOrMalformedDrafts.length > 0
      ? "No abandoned exact-owned GitHub release drafts detected."
      : "No abandoned GitHub release drafts detected."
  );
  return { abandonedDrafts, unownedOrMalformedDrafts };
}
