import { serializeOwnershipMarker } from "../../scripts/release/marker.mjs";

export const RELEASE = {
  repository: "conn-castle/agent-outbox",
  releaseTag: "v1.2.3",
  expectedSha: "1111111111111111111111111111111111111111",
  runId: "33196586800"
};
export const OTHER_SHA = "2222222222222222222222222222222222222222";
export const PRIOR_VERSION = "123e4567-e89b-12d3-a456-426614174000";
export const CANDIDATE_VERSION = "123e4567-e89b-12d3-a456-426614174001";
export const DRAFT_ID = 9001;

/**
 * @param {"prepared" | "publishing"} [state]
 * @param {Record<string, string>} [overrides]
 */
export function marker(state = "prepared", overrides = {}) {
  return serializeOwnershipMarker({
    repository: RELEASE.repository,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseTag: RELEASE.releaseTag,
    state,
    ...overrides
  });
}

export function preparedMarker(overrides = {}) {
  return marker("prepared", {
    priorSha: OTHER_SHA,
    priorVersionId: PRIOR_VERSION,
    candidateVersionId: CANDIDATE_VERSION,
    ...overrides
  });
}

export function draftRelease(overrides = {}) {
  return {
    id: DRAFT_ID,
    tagName: RELEASE.releaseTag,
    targetCommitish: RELEASE.expectedSha,
    draft: true,
    body: marker("prepared"),
    assets: [],
    ...overrides
  };
}

export function publishedRelease(overrides = {}) {
  return {
    id: 8001,
    tagName: RELEASE.releaseTag,
    targetCommitish: RELEASE.expectedSha,
    draft: false,
    body: marker("publishing"),
    assets: [],
    ...overrides
  };
}

/**
 * @param {Record<string, any[]>} [script]
 * @param {{ omitGetActionsRun?: boolean }} [options]
 * @returns {import("../../scripts/release/gateway-github.mjs").GithubGateway & {
 *   calls: {
 *     listReleases: number,
 *     getRelease: number,
 *     remoteTagCommit: number,
 *     createDraft: number,
 *     updateRelease: number,
 *     uploadAsset: number,
 *     downloadAsset: number,
 *     deleteRelease: number,
 *     getActionsRun: number
 *   }
 * }}
 */
export function scriptedGithub(script = {}, options = {}) {
  const calls = {
    listReleases: 0,
    getRelease: 0,
    remoteTagCommit: 0,
    createDraft: 0,
    updateRelease: 0,
    uploadAsset: 0,
    downloadAsset: 0,
    deleteRelease: 0,
    getActionsRun: 0
  };
  /**
   * @param {keyof typeof calls} name
   * @param {any[]} fallback
   */
  const take = (name, fallback) => {
    const queue = script[name] ?? fallback;
    const index = Math.min(calls[name], queue.length - 1);
    calls[name] += 1;
    const value = queue[index];
    if (value instanceof Error) {
      throw value;
    }
    return typeof value === "function" ? value(calls) : value;
  };
  return {
    calls,
    listReleases: async () => take("listReleases", [[]]),
    getRelease: async (
      /** @type {string} */ _repository,
      /** @type {number} */ _releaseId
    ) => take("getRelease", [null]),
    remoteTagCommit: async () => take("remoteTagCommit", [null]),
    createDraft: async () =>
      take("createDraft", [{ status: 1, stderr: "missing" }]),
    updateRelease: async () =>
      take("updateRelease", [{ status: 1, stderr: "missing" }]),
    uploadAsset: async () =>
      take("uploadAsset", [{ status: 1, stderr: "missing" }]),
    downloadAsset: async () => take("downloadAsset", [Buffer.from("x")]),
    deleteRelease: async () => take("deleteRelease", [{ status: 0 }]),
    ...(options.omitGetActionsRun
      ? {}
      : {
          getActionsRun: async () => take("getActionsRun", [null])
        })
  };
}

/**
 * @param {{
 *   deploymentStatus?: any[],
 *   uploadVersion?: { versionId: string } | Error,
 *   deployVersions?: Error | ((placements: { versionId: string, percentage: number }[]) => void),
 *   listVersions?: unknown
 * }} [script]
 */
export function scriptedCloudflare(script = {}) {
  /** @type {{ deploymentStatus: number, uploadVersion: number, listVersions: number, deployVersions: { placements: { versionId: string, percentage: number }[], message?: string }[] }} */
  const calls = {
    deploymentStatus: 0,
    uploadVersion: 0,
    listVersions: 0,
    deployVersions: []
  };
  return {
    calls,
    deploymentStatus: async () => {
      calls.deploymentStatus += 1;
      if (!Object.hasOwn(script, "deploymentStatus")) {
        return {
          versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
        };
      }
      const queue = script.deploymentStatus;
      const value = Array.isArray(queue)
        ? queue[
            Math.min(calls.deploymentStatus - 1, Math.max(queue.length - 1, 0))
          ]
        : queue;
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
    listVersions: async () => {
      calls.listVersions += 1;
      if (script.listVersions instanceof Error) {
        throw script.listVersions;
      }
      return script.listVersions ?? [];
    },
    uploadVersion: async (
      /** @type {NodeJS.ProcessEnv | Record<string, string | undefined>} */ _env
    ) => {
      calls.uploadVersion += 1;
      if (script.uploadVersion instanceof Error) {
        throw script.uploadVersion;
      }
      return script.uploadVersion ?? { versionId: CANDIDATE_VERSION };
    },
    /**
     * @param {{ versionId: string, percentage: number }[]} placements
     * @param {string} [message]
     */
    deployVersions: async (placements, message) => {
      calls.deployVersions.push({ placements, message });
      if (typeof script.deployVersions === "function") {
        script.deployVersions(placements);
        return;
      }
      if (script.deployVersions instanceof Error) {
        throw script.deployVersions;
      }
    }
  };
}

/**
 * @param {ReturnType<typeof scriptedGithub>} github
 * @param {ReturnType<typeof scriptedCloudflare>} [cloudflare]
 * @param {Record<string, unknown>} [extras]
 */
export function orchestrator(github, cloudflare, extras = {}) {
  return {
    github,
    cloudflare,
    sleep: async () => {},
    runtimeCanary: async () => ({
      environment: { configured: true, release: OTHER_SHA }
    }),
    ...extras
  };
}
