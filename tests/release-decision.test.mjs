import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyFinalizeFailure,
  classifyLiveTraffic,
  classifySameTagReleases,
  decideReconciliation,
  derivePriorIdentityFromLiveState
} from "../scripts/release/decide.mjs";
import { releaseMetadata } from "../scripts/release/identity.mjs";
import {
  assertClaimedIdentities,
  markerMatchesRun,
  parseOwnershipMarker,
  serializeOwnershipMarker
} from "../scripts/release/marker.mjs";
import { normalizeGithubRelease } from "../scripts/release/model.mjs";
import {
  CANDIDATE_VERSION,
  DRAFT_ID,
  OTHER_SHA,
  PRIOR_VERSION,
  RELEASE,
  draftRelease,
  marker,
  orchestrator,
  preparedMarker,
  publishedRelease,
  scriptedCloudflare,
  scriptedGithub
} from "./helpers/release-fixtures.mjs";

test("production release metadata comes from a stable package version", () => {
  assert.deepEqual(
    releaseMetadata({ name: "agent-outbox", version: "1.2.3" }),
    {
      releaseTag: "v1.2.3"
    }
  );
  assert.throws(
    () => releaseMetadata({ name: "agent-outbox", version: "0.0.0" }),
    /version must be a numbered stable release/
  );
});

test("ownership markers round-trip exact repository, run, SHA, tag, and state", () => {
  const body = marker("prepared");
  assert.deepEqual(parseOwnershipMarker(body), {
    repository: RELEASE.repository,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseTag: RELEASE.releaseTag,
    state: "prepared"
  });
  const withIdentities = serializeOwnershipMarker({
    repository: RELEASE.repository,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseTag: RELEASE.releaseTag,
    state: "prepared",
    priorSha: OTHER_SHA,
    priorVersionId: PRIOR_VERSION,
    candidateVersionId: CANDIDATE_VERSION
  });
  assert.equal(parseOwnershipMarker(withIdentities)?.priorSha, OTHER_SHA);
  assert.equal(
    parseOwnershipMarker(withIdentities)?.candidateVersionId,
    CANDIDATE_VERSION
  );
  const publishing = serializeOwnershipMarker(
    {
      repository: RELEASE.repository,
      runId: RELEASE.runId,
      candidateSha: RELEASE.expectedSha,
      releaseTag: RELEASE.releaseTag,
      state: "publishing",
      priorSha: OTHER_SHA,
      priorVersionId: PRIOR_VERSION,
      candidateVersionId: CANDIDATE_VERSION
    },
    `${body}\nGenerated notes`
  );
  assert.equal(parseOwnershipMarker(publishing)?.state, "publishing");
  assert.match(publishing, /Generated notes/);
  assert.equal(markerMatchesRun(parseOwnershipMarker(body), RELEASE), true);
  assert.equal(
    markerMatchesRun(parseOwnershipMarker(body), {
      ...RELEASE,
      runId: "1"
    }),
    false
  );
});

test("same-tag classification uses release id and exact ownership, never tag uniqueness", () => {
  assert.equal(
    classifySameTagReleases({
      releases: [],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "absent"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [draftRelease()],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "owned_prepared"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [draftRelease({ body: marker("publishing") })],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "owned_publishing"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [draftRelease({ body: "not a marker" })],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "conflict"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [draftRelease({ body: marker("prepared", { runId: "1" }) })],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "conflict"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [draftRelease(), draftRelease({ id: 9002, body: "unowned" })],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "conflict"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [publishedRelease()],
      tagCommit: RELEASE.expectedSha,
      ...RELEASE
    }).kind,
    "committed"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [publishedRelease()],
      tagCommit: OTHER_SHA,
      ...RELEASE
    }).kind,
    "conflict"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [publishedRelease()],
      tagCommit: null,
      ...RELEASE
    }).kind,
    "published_tag_pending"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [publishedRelease(), draftRelease()],
      tagCommit: RELEASE.expectedSha,
      ...RELEASE
    }).kind,
    "committed"
  );
  assert.equal(
    classifySameTagReleases({
      releases: [],
      tagCommit: RELEASE.expectedSha,
      ...RELEASE
    }).kind,
    "hold"
  );
});

test("reconciliation decision table covers committed, restore, publish retry, and hold", () => {
  const prepared = classifySameTagReleases({
    releases: [draftRelease()],
    tagCommit: null,
    ...RELEASE
  });
  const publishing = classifySameTagReleases({
    releases: [draftRelease({ body: marker("publishing") })],
    tagCommit: null,
    ...RELEASE
  });
  const committed = classifySameTagReleases({
    releases: [publishedRelease()],
    tagCommit: RELEASE.expectedSha,
    ...RELEASE
  });
  assert.equal(
    decideReconciliation({
      classification: committed,
      traffic: classifyLiveTraffic(
        { versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }] },
        RELEASE.expectedSha,
        {
          priorVersionId: PRIOR_VERSION,
          candidateVersionId: CANDIDATE_VERSION,
          expectedSha: RELEASE.expectedSha
        }
      ),
      priorVersionId: PRIOR_VERSION
    }).action,
    "committed"
  );
  assert.equal(
    decideReconciliation({
      classification: prepared,
      traffic: classifyLiveTraffic(
        { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] },
        OTHER_SHA,
        {
          priorVersionId: PRIOR_VERSION,
          candidateVersionId: CANDIDATE_VERSION,
          expectedSha: RELEASE.expectedSha,
          priorSha: OTHER_SHA
        }
      ),
      priorVersionId: PRIOR_VERSION,
      priorSha: OTHER_SHA
    }).action,
    "collapse-then-delete-draft"
  );
  assert.equal(
    decideReconciliation({
      classification: prepared,
      traffic: classifyLiveTraffic(
        { versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }] },
        RELEASE.expectedSha,
        {
          priorVersionId: PRIOR_VERSION,
          candidateVersionId: CANDIDATE_VERSION,
          expectedSha: RELEASE.expectedSha
        }
      ),
      priorVersionId: PRIOR_VERSION,
      priorSha: OTHER_SHA
    }).action,
    "restore-then-delete-draft"
  );
  assert.equal(
    decideReconciliation({
      classification: prepared,
      traffic: classifyLiveTraffic(
        { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] },
        OTHER_SHA,
        {
          priorVersionId: PRIOR_VERSION,
          candidateVersionId: CANDIDATE_VERSION,
          expectedSha: RELEASE.expectedSha,
          priorSha: OTHER_SHA
        }
      ),
      priorVersionId: PRIOR_VERSION
    }).action,
    "hold"
  );
  assert.equal(
    decideReconciliation({
      classification: publishing,
      traffic: classifyLiveTraffic(
        { versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }] },
        RELEASE.expectedSha,
        {
          priorVersionId: PRIOR_VERSION,
          candidateVersionId: CANDIDATE_VERSION,
          expectedSha: RELEASE.expectedSha
        }
      ),
      priorVersionId: PRIOR_VERSION
    }).action,
    "retry-publish"
  );
  assert.equal(
    decideReconciliation({
      githubReadable: false,
      classification: publishing
    }).action,
    "hold"
  );
  assert.equal(
    decideReconciliation({
      classification: classifySameTagReleases({
        releases: [publishedRelease()],
        tagCommit: null,
        ...RELEASE
      })
    }).action,
    "retry-publish"
  );
  assert.equal(
    decideReconciliation({
      classification: {
        kind: "hold",
        reason: "orphan tag without a GitHub release"
      }
    }).action,
    "hold"
  );
});

test("finalize retries only transient GitHub failures", () => {
  assert.equal(classifyFinalizeFailure("HTTP 502 Bad Gateway"), "transient");
  assert.equal(
    classifyFinalizeFailure("HTTP 403: Resource not accessible by integration"),
    "permanent"
  );
});

test("normalizeGithubRelease keeps numeric ids as the canonical identity", () => {
  const release = normalizeGithubRelease({
    id: 378670392,
    tag_name: "v0.2.7",
    target_commitish: RELEASE.expectedSha,
    draft: true,
    body: "",
    assets: []
  });
  assert.equal(release.id, 378670392);
  assert.equal(release.draft, true);
});

test("claimed identities cannot replace missing or conflicting derived state", () => {
  const derived = {
    releaseId: DRAFT_ID,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseTag: RELEASE.releaseTag,
    repository: RELEASE.repository,
    priorSha: OTHER_SHA,
    priorVersionId: PRIOR_VERSION,
    candidateVersionId: CANDIDATE_VERSION,
    state: /** @type {"prepared"} */ ("prepared")
  };
  assert.doesNotThrow(() =>
    assertClaimedIdentities(derived, {
      candidateSha: RELEASE.expectedSha,
      priorVersionId: PRIOR_VERSION
    })
  );
  assert.throws(
    () =>
      assertClaimedIdentities(derived, {
        priorVersionId: "00000000-0000-4000-8000-000000000099"
      }),
    /does not match derived/
  );
  assert.throws(
    () =>
      assertClaimedIdentities(
        { ...derived, priorSha: null },
        { priorSha: OTHER_SHA }
      ),
    /not present in derived/
  );
});

test("observed live state supplies prior identity only when every invariant holds", () => {
  const safe = {
    tagCommit: null,
    expectedSha: RELEASE.expectedSha,
    deployment: {
      versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
    },
    liveSha: OTHER_SHA,
    liveConfigured: true,
    cloudflareReadable: true
  };
  assert.deepEqual(derivePriorIdentityFromLiveState(safe), {
    priorSha: OTHER_SHA,
    priorVersionId: PRIOR_VERSION
  });
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      liveSha: RELEASE.expectedSha
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({ ...safe, tagCommit: OTHER_SHA }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({ ...safe, cloudflareReadable: false }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      deployment: {
        versions: [
          { version_id: PRIOR_VERSION, percentage: 100 },
          { version_id: CANDIDATE_VERSION, percentage: 0 }
        ]
      }
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({ ...safe, liveConfigured: false }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({ ...safe, liveSha: "not-a-sha" }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({ ...safe, expectedSha: "not-a-sha" }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      deployment: {
        versions: [{ version_id: PRIOR_VERSION, percentage: 90 }]
      }
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      deployment: { versions: [{ version_id: "not-a-uuid", percentage: 100 }] }
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      candidateVersionId: PRIOR_VERSION
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      knownPriorVersionId: CANDIDATE_VERSION
    }),
    null
  );
  assert.equal(
    derivePriorIdentityFromLiveState({
      ...safe,
      knownPriorSha: RELEASE.expectedSha
    }),
    null
  );
});

test("pure release modules have no node: or process.env coupling", () => {
  for (const name of ["identity", "marker", "model", "decide", "order"]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../scripts/release/${name}.mjs`, import.meta.url)),
      "utf8"
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.equal(/from ["']node:/.test(code), false, name);
    assert.equal(/process\.env/.test(code), false, name);
  }
});
