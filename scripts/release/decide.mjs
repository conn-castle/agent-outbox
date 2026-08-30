import {
  FULL_GIT_SHA,
  WORKER_VERSION_ID,
  isWorkerVersionId
} from "./identity.mjs";
import { markerMatchesRun, parseOwnershipMarker } from "./marker.mjs";

/**
 * @typedef {import("./model.mjs").GithubRelease} GithubRelease
 * @typedef {import("./marker.mjs").OwnershipMarker} OwnershipMarker
 *
 * @typedef {{
 *   kind:
 *     | "absent"
 *     | "owned_prepared"
 *     | "owned_publishing"
 *     | "committed"
 *     | "published_tag_pending"
 *     | "conflict"
 *     | "hold",
 *   reason?: string,
 *   release?: GithubRelease,
 *   marker?: OwnershipMarker | null,
 *   extraDrafts?: GithubRelease[]
 * }} SameTagClassification
 */

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
 * @param {{
 *   releases: GithubRelease[],
 *   tagCommit: string | null,
 *   expectedSha: string,
 *   repository: string,
 *   runId: string,
 *   releaseTag: string,
 *   requireExactRun?: boolean
 * }} input
 * @returns {SameTagClassification}
 */
export function classifySameTagReleases(input) {
  const requireExactRun = input.requireExactRun !== false;
  const ownership = {
    repository: input.repository,
    runId: input.runId,
    candidateSha: input.expectedSha,
    releaseTag: input.releaseTag
  };
  const sameTag = input.releases.filter(
    (release) => release.tagName === input.releaseTag
  );
  const temporaryOwnedDrafts = input.releases.filter(
    (release) =>
      release.draft &&
      /^untagged-[0-9a-f]+$/i.test(release.tagName) &&
      markerMatchesRun(parseOwnershipMarker(release.body), ownership, {
        requireExactRun
      })
  );
  const drafts = [
    ...sameTag.filter((release) => release.draft),
    ...temporaryOwnedDrafts.filter(
      (release) => release.tagName !== input.releaseTag
    )
  ];
  const published = sameTag.filter((release) => !release.draft);

  if (published.length > 1) {
    return {
      kind: "conflict",
      reason: "multiple published releases share the tag"
    };
  }

  if (published.length === 1) {
    const release = published[0];
    if (input.tagCommit) {
      if (!input.expectedSha || input.tagCommit === input.expectedSha) {
        return {
          kind: "committed",
          release,
          extraDrafts: drafts
        };
      }
      return {
        kind: "conflict",
        reason: "published release tag does not resolve to the candidate",
        release
      };
    }
    return {
      kind: "published_tag_pending",
      reason: "published release tag is not yet visible",
      release,
      extraDrafts: drafts
    };
  }

  if (
    input.expectedSha &&
    input.tagCommit &&
    input.tagCommit !== input.expectedSha
  ) {
    return {
      kind: "conflict",
      reason: "remote tag points at another SHA"
    };
  }
  if (input.tagCommit && drafts.length === 0) {
    return {
      kind: "hold",
      reason: "orphan tag without a GitHub release"
    };
  }
  if (drafts.length === 0) {
    return { kind: "absent" };
  }
  if (drafts.length > 1) {
    const owned = drafts.filter((release) =>
      markerMatchesRun(parseOwnershipMarker(release.body), ownership, {
        requireExactRun
      })
    );
    return {
      kind: "conflict",
      reason:
        owned.length === 0
          ? "multiple candidate drafts exist"
          : owned.length === 1
            ? "owned candidate draft is not unique"
            : "multiple owned candidate drafts exist"
    };
  }

  const draft = drafts[0];
  const marker = parseOwnershipMarker(draft.body);
  if (!markerMatchesRun(marker, ownership, { requireExactRun })) {
    return {
      kind: "conflict",
      reason: "unowned or malformed draft",
      release: draft
    };
  }
  if (input.expectedSha && draft.targetCommitish !== input.expectedSha) {
    return {
      kind: "conflict",
      reason: "owned draft target is not the candidate",
      release: draft
    };
  }
  if (marker?.state === "publishing") {
    return { kind: "owned_publishing", release: draft, marker };
  }
  return { kind: "owned_prepared", release: draft, marker };
}

/**
 * @param {{
 *   versions?: { version_id?: unknown, percentage?: unknown }[]
 * } | undefined} deployment
 * @param {string | null | undefined} liveSha
 * @param {{ priorVersionId?: string | null, candidateVersionId?: string | null, expectedSha: string, priorSha?: string | null }} identities
 */
export function classifyLiveTraffic(deployment, liveSha, identities) {
  const versions = Array.isArray(deployment?.versions)
    ? deployment.versions
    : [];
  const placements = versions.map((version) => ({
    versionId: String(version.version_id ?? ""),
    percentage: Number(version.percentage)
  }));
  const prior = identities.priorVersionId ?? "";
  const candidate = identities.candidateVersionId ?? "";
  const uniqueHundred =
    placements.length === 1 && placements[0].percentage === 100
      ? placements[0].versionId
      : "";
  const onlyPrior =
    placements.length === 1 &&
    placements[0].percentage === 100 &&
    placements[0].versionId === prior;
  const onlyCandidate =
    placements.length === 1 &&
    placements[0].percentage === 100 &&
    placements[0].versionId === candidate;
  const staged =
    placements.length === 2 &&
    placements.some(
      (placement) =>
        placement.versionId === prior && placement.percentage === 100
    ) &&
    placements.some(
      (placement) =>
        placement.versionId === candidate && placement.percentage === 0
    );
  return {
    placements,
    liveSha: liveSha ?? null,
    onlyPrior,
    onlyCandidate,
    staged,
    uniqueHundredPercentVersionId: isWorkerVersionId(uniqueHundred)
      ? uniqueHundred
      : "",
    liveIsCandidate: liveSha === identities.expectedSha,
    liveIsPrior:
      typeof identities.priorSha === "string" &&
      identities.priorSha !== "" &&
      liveSha === identities.priorSha
  };
}

/**
 * Derive prior Worker identity from observed live state only when every
 * invariant proves the candidate is not live and the tag is absent.
 *
 * @param {{
 *   tagCommit?: string | null,
 *   expectedSha?: string | null,
 *   candidateVersionId?: string | null,
 *   knownPriorSha?: string | null,
 *   knownPriorVersionId?: string | null,
 *   deployment?: { versions?: { version_id?: unknown, percentage?: unknown }[] },
 *   liveSha?: string | null,
 *   liveConfigured?: boolean,
 *   cloudflareReadable?: boolean
 * }} input
 * @returns {{ priorSha: string, priorVersionId: string } | null}
 */
export function derivePriorIdentityFromLiveState(input) {
  if (input.cloudflareReadable !== true || input.tagCommit) {
    return null;
  }
  if (!FULL_GIT_SHA.test(input.expectedSha ?? "")) {
    return null;
  }
  if (
    input.liveConfigured !== true ||
    !FULL_GIT_SHA.test(input.liveSha ?? "")
  ) {
    return null;
  }
  if (input.liveSha === input.expectedSha) {
    return null;
  }
  if (
    typeof input.knownPriorSha === "string" &&
    FULL_GIT_SHA.test(input.knownPriorSha) &&
    input.liveSha !== input.knownPriorSha
  ) {
    return null;
  }
  const versions = Array.isArray(input.deployment?.versions)
    ? input.deployment.versions
    : [];
  if (
    versions.length !== 1 ||
    Number(versions[0]?.percentage) !== 100 ||
    !isWorkerVersionId(String(versions[0]?.version_id ?? ""))
  ) {
    return null;
  }
  const liveVersionId = String(versions[0].version_id);
  if (
    isWorkerVersionId(input.candidateVersionId ?? "") &&
    liveVersionId === input.candidateVersionId
  ) {
    return null;
  }
  if (
    isWorkerVersionId(input.knownPriorVersionId ?? "") &&
    liveVersionId !== input.knownPriorVersionId
  ) {
    return null;
  }
  return {
    priorSha: /** @type {string} */ (input.liveSha),
    priorVersionId: liveVersionId
  };
}

/** @param {SameTagClassification} classification */
export function classifiedRelease(classification) {
  if (!classification.release) {
    throw new Error(
      `classification ${classification.kind} is missing a release`
    );
  }
  return classification.release;
}

/**
 * @param {{
 *   githubReadable?: boolean,
 *   cloudflareReadable?: boolean,
 *   classification: ReturnType<typeof classifySameTagReleases>,
 *   traffic?: ReturnType<typeof classifyLiveTraffic>,
 *   priorVersionId?: string | null,
 *   priorSha?: string | null
 * }} snapshot
 */
export function decideReconciliation(snapshot) {
  if (snapshot.githubReadable === false) {
    return {
      action: "hold",
      reason: "GitHub is unreadable after publish intent",
      mutate: false
    };
  }
  const classification = snapshot.classification;
  if (classification.kind === "committed") {
    return {
      action: "committed",
      releaseId: classification.release?.id,
      mutate: false
    };
  }
  if (classification.kind === "published_tag_pending") {
    return {
      action: "retry-publish",
      releaseId: classifiedRelease(classification).id,
      mutate: "publish-only"
    };
  }
  if (classification.kind === "owned_publishing") {
    return {
      action: "retry-publish",
      releaseId: classifiedRelease(classification).id,
      mutate: "publish-only"
    };
  }
  if (classification.kind === "hold" || classification.kind === "conflict") {
    return {
      action: "hold",
      reason: classification.reason,
      mutate: false
    };
  }
  if (classification.kind === "absent") {
    return { action: "absent", mutate: false };
  }
  if (classification.kind !== "owned_prepared") {
    return {
      action: "hold",
      reason: "unrecognized GitHub release state",
      mutate: false
    };
  }
  if (snapshot.cloudflareReadable === false) {
    return {
      action: "hold",
      reason: "Cloudflare is unreadable; refusing destructive draft cleanup",
      mutate: false
    };
  }
  if (!FULL_GIT_SHA.test(snapshot.priorSha ?? "")) {
    return {
      action: "hold",
      reason: "prior runtime SHA is unknown; refusing draft cleanup",
      mutate: false
    };
  }
  const traffic = snapshot.traffic;
  if (!traffic) {
    return {
      action: "hold",
      reason: "live Worker traffic could not be classified",
      mutate: false
    };
  }
  const priorVersionId =
    (isWorkerVersionId(snapshot.priorVersionId ?? "")
      ? snapshot.priorVersionId
      : "") || traffic.uniqueHundredPercentVersionId;
  if (
    (traffic.onlyCandidate || traffic.liveIsCandidate || traffic.staged) &&
    !isWorkerVersionId(snapshot.priorVersionId ?? "")
  ) {
    return {
      action: "hold",
      reason: "prior Worker version is unknown; refusing draft cleanup",
      mutate: false
    };
  }
  if (!isWorkerVersionId(priorVersionId)) {
    return {
      action: "hold",
      reason: "prior Worker version is unknown; refusing draft cleanup",
      mutate: false
    };
  }
  if (traffic.onlyCandidate || traffic.liveIsCandidate || traffic.staged) {
    return {
      action: "restore-then-delete-draft",
      releaseId: classifiedRelease(classification).id,
      priorVersionId: snapshot.priorVersionId,
      priorSha: snapshot.priorSha,
      mutate: "restore-and-delete-prepared"
    };
  }
  if (
    traffic.onlyPrior ||
    traffic.liveIsPrior ||
    traffic.uniqueHundredPercentVersionId === priorVersionId
  ) {
    return {
      action: "collapse-then-delete-draft",
      releaseId: classifiedRelease(classification).id,
      priorVersionId,
      priorSha: snapshot.priorSha,
      mutate: "collapse-and-delete-prepared"
    };
  }
  return {
    action: "hold",
    reason: "live Worker traffic is ambiguous",
    mutate: false
  };
}

/**
 * Decide whether a failed GitHub mutation should be retried.
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
