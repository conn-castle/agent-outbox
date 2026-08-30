import {
  FULL_GIT_SHA,
  REPOSITORY_NAME,
  RELEASE_TAG_PATTERN,
  POSITIVE_INTEGER_ID,
  ReleaseHoldError,
  isWorkerVersionId
} from "./identity.mjs";

const OWNERSHIP_MARKER_PATTERN =
  /<!-- agent-outbox-release-ownership\s*(\{[\s\S]*?\})\s*-->/;

/**
 * @typedef {{
 *   repository: string,
 *   runId: string,
 *   candidateSha: string,
 *   releaseTag: string,
 *   state: "prepared" | "publishing",
 *   priorSha?: string,
 *   priorVersionId?: string,
 *   candidateVersionId?: string
 * }} OwnershipMarker
 */

/**
 * @param {OwnershipMarker} marker
 * @param {string} [existingBody]
 */
export function serializeOwnershipMarker(marker, existingBody = "") {
  if (!REPOSITORY_NAME.test(marker.repository)) {
    throw new Error("ownership marker repository must be owner/repo");
  }
  if (!POSITIVE_INTEGER_ID.test(marker.runId)) {
    throw new Error("ownership marker run id must be a positive integer");
  }
  if (!FULL_GIT_SHA.test(marker.candidateSha)) {
    throw new Error("ownership marker candidate SHA must be a full git SHA");
  }
  if (!RELEASE_TAG_PATTERN.test(marker.releaseTag)) {
    throw new Error("ownership marker release tag must be vX.Y.Z");
  }
  if (marker.state !== "prepared" && marker.state !== "publishing") {
    throw new Error("ownership marker state must be prepared or publishing");
  }
  if (marker.priorSha !== undefined && !FULL_GIT_SHA.test(marker.priorSha)) {
    throw new Error("ownership marker prior SHA must be a full git SHA");
  }
  if (
    marker.priorVersionId !== undefined &&
    !isWorkerVersionId(marker.priorVersionId)
  ) {
    throw new Error("ownership marker prior version id must be a Worker UUID");
  }
  if (
    marker.candidateVersionId !== undefined &&
    !isWorkerVersionId(marker.candidateVersionId)
  ) {
    throw new Error(
      "ownership marker candidate version id must be a Worker UUID"
    );
  }
  /** @type {Record<string, string>} */
  const payload = {
    repository: marker.repository,
    runId: marker.runId,
    candidateSha: marker.candidateSha,
    releaseTag: marker.releaseTag,
    state: marker.state
  };
  if (marker.priorSha) {
    payload.priorSha = marker.priorSha;
  }
  if (marker.priorVersionId) {
    payload.priorVersionId = marker.priorVersionId;
  }
  if (marker.candidateVersionId) {
    payload.candidateVersionId = marker.candidateVersionId;
  }
  const block = `<!-- agent-outbox-release-ownership\n${JSON.stringify(
    payload
  )}\n-->`;
  const remainder = stripOwnershipMarker(existingBody).trim();
  return remainder === "" ? `${block}\n` : `${block}\n${remainder}\n`;
}

/** @param {string} [body] */
export function stripOwnershipMarker(body = "") {
  return body.replace(OWNERSHIP_MARKER_PATTERN, "").trim();
}

/**
 * @param {unknown} body
 * @returns {OwnershipMarker | null}
 */
export function parseOwnershipMarker(body) {
  if (typeof body !== "string" || body.trim() === "") {
    return null;
  }
  const match = OWNERSHIP_MARKER_PATTERN.exec(body);
  if (!match) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.repository !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.candidateSha !== "string" ||
    typeof payload.releaseTag !== "string" ||
    (payload.state !== "prepared" && payload.state !== "publishing")
  ) {
    return null;
  }
  try {
    serializeOwnershipMarker(/** @type {OwnershipMarker} */ (payload), "");
  } catch {
    return null;
  }
  return /** @type {OwnershipMarker} */ (payload);
}

/**
 * @param {OwnershipMarker | null} marker
 * @param {Partial<Omit<OwnershipMarker, "state">> & { repository: string, releaseTag: string }} expected
 * @param {{ requireExactRun?: boolean }} [options]
 */
export function markerMatchesRun(marker, expected, options = {}) {
  if (marker === null) {
    return false;
  }
  if (
    marker.repository !== expected.repository ||
    marker.releaseTag !== expected.releaseTag
  ) {
    return false;
  }
  if (expected.candidateSha && marker.candidateSha !== expected.candidateSha) {
    return false;
  }
  if (
    options.requireExactRun !== false &&
    expected.runId &&
    marker.runId !== expected.runId
  ) {
    return false;
  }
  return true;
}

/**
 * @param {OwnershipMarker} marker
 * @param {number} releaseId
 */
export function identitiesFromMarker(marker, releaseId) {
  return {
    releaseId,
    runId: marker.runId,
    candidateSha: marker.candidateSha,
    releaseTag: marker.releaseTag,
    repository: marker.repository,
    priorSha: marker.priorSha ?? null,
    priorVersionId: marker.priorVersionId ?? null,
    candidateVersionId: marker.candidateVersionId ?? null,
    state: marker.state
  };
}

/**
 * @param {{
 *   releaseId?: number | string | null,
 *   runId?: string | null,
 *   candidateSha?: string | null,
 *   priorSha?: string | null,
 *   priorVersionId?: string | null,
 *   candidateVersionId?: string | null
 * }} derived
 * @param {{
 *   candidateSha?: string,
 *   runId?: string,
 *   releaseId?: number | string,
 *   priorSha?: string,
 *   priorVersionId?: string,
 *   candidateVersionId?: string
 * }} [claimed]
 */
export function assertClaimedIdentities(derived, claimed = {}) {
  /** @type {[string, string | number | null | undefined, string | number | null | undefined][]} */
  const pairs = [
    ["candidateSha", claimed.candidateSha, derived.candidateSha],
    ["runId", claimed.runId, derived.runId],
    ["releaseId", claimed.releaseId, derived.releaseId],
    ["priorSha", claimed.priorSha, derived.priorSha],
    ["priorVersionId", claimed.priorVersionId, derived.priorVersionId],
    [
      "candidateVersionId",
      claimed.candidateVersionId,
      derived.candidateVersionId
    ]
  ];
  for (const [name, claimedValue, derivedValue] of pairs) {
    if (
      claimedValue === undefined ||
      claimedValue === null ||
      claimedValue === ""
    ) {
      continue;
    }
    if (
      derivedValue === undefined ||
      derivedValue === null ||
      derivedValue === ""
    ) {
      throw new ReleaseHoldError(
        `claimed ${name} is not present in derived GitHub/Cloudflare state`
      );
    }
    if (String(claimedValue) !== String(derivedValue)) {
      throw new ReleaseHoldError(
        `claimed ${name} does not match derived GitHub/Cloudflare state`
      );
    }
  }
}

/**
 * @param {OwnershipMarker | null} marker
 * @param {{ rollbackVersionId: string, rollbackRelease: string }} captured
 */
export function assertCapturedPriorMatchesMarker(marker, captured) {
  if (
    marker?.priorVersionId &&
    marker.priorVersionId !== captured.rollbackVersionId
  ) {
    throw new ReleaseHoldError(
      `captured rollback version ${captured.rollbackVersionId} differs from marker-recorded prior ${marker.priorVersionId}; refusing to fork prior identity on the same run`
    );
  }
  if (marker?.priorSha && marker.priorSha !== captured.rollbackRelease) {
    throw new ReleaseHoldError(
      `captured rollback SHA ${captured.rollbackRelease} differs from marker-recorded prior ${marker.priorSha}; refusing to fork prior identity on the same run`
    );
  }
}
