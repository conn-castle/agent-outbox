import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { certifiedReleaseAssets } from "../scripts/release/assets.mjs";
import { selectRollbackTarget } from "../scripts/release/decide.mjs";
import {
  GH_SPAWN_MAX_BUFFER_BYTES,
  assertGithubMutationResult,
  collectCommandStdoutBytes,
  githubCommandSpawnOptions,
  listGithubReleases
} from "../scripts/release/gateway-github.mjs";
import {
  PublicationStateUnknownError,
  ReleaseHoldError,
  serializeWorkerVersionMessage
} from "../scripts/release/identity.mjs";
import {
  assertCapturedPriorMatchesMarker,
  parseOwnershipMarker
} from "../scripts/release/marker.mjs";
import {
  RESTORE_PROOF_ATTEMPTS,
  RESTORE_PROOF_BACKOFF_MS,
  cleanupOwnedPreparedDraft,
  deriveReleaseIdentities,
  persistOwnedDraftIdentities,
  runAbandonedDetection,
  runAssetReconciliation,
  runDraftPreparation,
  runReconciliation,
  runReleasePublication
} from "../scripts/release/phases.mjs";
import {
  installCompensationHandlers,
  requireProductionWorkflowContext
} from "../scripts/production-release.mjs";
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

const CERTIFIED_ASSET = {
  name: "checksums.txt",
  path: "/tmp/checksums.txt",
  bytes: Buffer.from("abcd")
};
const CERTIFIED_RELEASE_ASSETS = [
  { id: 1, name: "checksums.txt", size: CERTIFIED_ASSET.bytes.length }
];

test("draft preparation creates a release-id-owned prepared draft", async () => {
  const github = scriptedGithub({
    listReleases: [[], [draftRelease()]],
    remoteTagCommit: [null],
    createDraft: [
      {
        status: 0,
        release: draftRelease()
      }
    ]
  });
  const result = await runDraftPreparation(orchestrator(github), RELEASE);
  assert.equal(result.kind, "owned_prepared");
  assert.equal(result.releaseId, DRAFT_ID);
  assert.equal(github.calls.createDraft, 1);
});

test("draft preparation adopts this run's exact marker and refuses duplicates", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease()]],
    remoteTagCommit: [null]
  });
  const adopted = await runDraftPreparation(orchestrator(github), RELEASE);
  assert.equal(adopted.releaseId, DRAFT_ID);
  assert.equal(github.calls.createDraft, 0);

  const duplicates = scriptedGithub({
    listReleases: [[draftRelease(), draftRelease({ id: 9002 })]],
    remoteTagCommit: [null]
  });
  await assert.rejects(
    runDraftPreparation(orchestrator(duplicates), RELEASE),
    ReleaseHoldError
  );
  assert.equal(duplicates.calls.createDraft, 0);
});

test("asset reconciliation uploads missing bytes and refuses conflicting assets", async () => {
  const local = Buffer.from("certified-bytes");
  const assets = [
    { name: "checksums.txt", path: "/tmp/checksums.txt", bytes: local }
  ];
  const github = scriptedGithub({
    getRelease: [
      draftRelease(),
      draftRelease(),
      draftRelease({
        assets: [{ id: 11, name: "checksums.txt", size: local.length }]
      })
    ],
    uploadAsset: [{ status: 0 }],
    downloadAsset: [local]
  });
  await runAssetReconciliation(orchestrator(github), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    releaseId: DRAFT_ID,
    assets
  });
  assert.equal(github.calls.uploadAsset, 1);
  assert.equal(github.calls.getRelease, 3);

  const conflicting = scriptedGithub({
    getRelease: [
      draftRelease({
        assets: [{ id: 11, name: "checksums.txt", size: 1 }]
      })
    ],
    downloadAsset: [Buffer.from("different")]
  });
  await assert.rejects(
    runAssetReconciliation(orchestrator(conflicting), {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      runId: RELEASE.runId,
      candidateSha: RELEASE.expectedSha,
      releaseId: DRAFT_ID,
      assets
    }),
    /differs from the certified build/
  );
  assert.equal(conflicting.calls.uploadAsset, 0);
});

test("asset reconciliation refuses mutation without the exact ownership marker", async () => {
  const assets = [
    {
      name: "checksums.txt",
      path: "/tmp/checksums.txt",
      bytes: Buffer.from("x")
    }
  ];
  const github = scriptedGithub({
    getRelease: [draftRelease({ body: "not a marker" })]
  });
  await assert.rejects(
    runAssetReconciliation(orchestrator(github), {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      runId: RELEASE.runId,
      candidateSha: RELEASE.expectedSha,
      releaseId: DRAFT_ID,
      assets
    }),
    /publishing, published, or unowned/
  );
  assert.equal(github.calls.uploadAsset, 0);
});

test("publication marks publishing by id before the publish mutation", async () => {
  /** @type {string[]} */
  const patches = [];
  const ownedDraft = draftRelease({
    tagName: "untagged-e5874a3f76e2804256df"
  });
  const github = scriptedGithub({
    listReleases: [[ownedDraft], [publishedRelease()]],
    remoteTagCommit: [null, null, RELEASE.expectedSha],
    getRelease: [
      draftRelease({
        tagName: ownedDraft.tagName,
        assets: CERTIFIED_RELEASE_ASSETS
      })
    ],
    downloadAsset: [CERTIFIED_ASSET.bytes],
    updateRelease: [
      () => {
        patches.push("publishing");
        return { status: 0 };
      },
      () => {
        patches.push("publish");
        return { status: 0 };
      }
    ]
  });
  const updateRelease = github.updateRelease;
  /** @type {Record<string, unknown>[]} */
  const updateInputs = [];
  github.updateRelease = async (...args) => {
    updateInputs.push(args[2]);
    return updateRelease(...args);
  };
  await runReleasePublication(orchestrator(github), {
    ...RELEASE,
    releaseId: DRAFT_ID,
    assets: [CERTIFIED_ASSET]
  });
  assert.deepEqual(patches, ["publishing", "publish"]);
  assert.equal(updateInputs[1].tag_name, RELEASE.releaseTag);
  assert.equal(updateInputs[1].target_commitish, RELEASE.expectedSha);
  assert.equal(updateInputs[1].draft, false);
});

test("ambiguous publication after publishing intent holds and never deletes", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease({ body: marker("publishing") })]],
    remoteTagCommit: [null],
    getRelease: [
      draftRelease({
        body: marker("publishing"),
        assets: CERTIFIED_RELEASE_ASSETS
      })
    ],
    downloadAsset: [CERTIFIED_ASSET.bytes],
    updateRelease: [{ status: 1, stderr: "request timed out" }]
  });
  await assert.rejects(
    runReleasePublication(orchestrator(github), {
      ...RELEASE,
      releaseId: DRAFT_ID,
      assets: [CERTIFIED_ASSET]
    }),
    (error) => error instanceof PublicationStateUnknownError
  );
  assert.equal(github.calls.deleteRelease, 0);
});

test("reconciliation restores prior@100 then deletes only the owned prepared draft", async () => {
  const ownedDraft = draftRelease({ body: preparedMarker() });
  const github = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null],
    getRelease: [ownedDraft, ownedDraft, null],
    deleteRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare({
    deploymentStatus: [
      {
        versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }]
      },
      {
        versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
      }
    ]
  });
  const decision = await runReconciliation(orchestrator(github, cloudflare), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    requireExactRun: false,
    liveSha: RELEASE.expectedSha
  });
  assert.equal(decision.action, "restore-then-delete-draft");
  assert.deepEqual(cloudflare.calls.deployVersions[0].placements, [
    { versionId: PRIOR_VERSION, percentage: 100 }
  ]);
  assert.equal(github.calls.deleteRelease, 1);
  assert.equal(github.calls.getRelease, 3);
});

test("reconciliation never deletes a publishing draft or published release", async () => {
  const publishingDraft = draftRelease({
    body: preparedMarker({ state: "publishing" }),
    assets: CERTIFIED_RELEASE_ASSETS
  });
  const publishingGithub = scriptedGithub({
    listReleases: [[publishingDraft], [publishingDraft], [publishedRelease()]],
    remoteTagCommit: [null, null, RELEASE.expectedSha],
    getRelease: [publishingDraft],
    downloadAsset: [CERTIFIED_ASSET.bytes],
    updateRelease: [{ status: 0 }]
  });
  await runReconciliation(
    orchestrator(publishingGithub, scriptedCloudflare()),
    {
      ...RELEASE,
      priorVersionId: PRIOR_VERSION,
      assets: [CERTIFIED_ASSET]
    }
  );
  assert.equal(publishingGithub.calls.deleteRelease, 0);

  const publishedGithub = scriptedGithub({
    listReleases: [[publishedRelease()]],
    remoteTagCommit: [RELEASE.expectedSha]
  });
  const published = await runReconciliation(
    orchestrator(publishedGithub, scriptedCloudflare()),
    {
      ...RELEASE,
      priorVersionId: PRIOR_VERSION,
      liveSha: RELEASE.expectedSha
    }
  );
  assert.equal(published.action, "committed");
  assert.equal(publishedGithub.calls.deleteRelease, 0);
  assert.equal(publishedGithub.calls.updateRelease, 0);
});

test("artifact-less reconciliation holds instead of retry-publishing unproved assets", async () => {
  const publishingDraft = draftRelease({
    body: preparedMarker({ state: "publishing" })
  });
  const github = scriptedGithub({
    listReleases: [[publishingDraft]],
    remoteTagCommit: [null],
    updateRelease: [{ status: 0 }]
  });
  await assert.rejects(
    runReconciliation(orchestrator(github, scriptedCloudflare()), {
      ...RELEASE,
      priorVersionId: PRIOR_VERSION
    }),
    (error) =>
      error instanceof ReleaseHoldError &&
      /certified CLI asset/.test(error.message) &&
      !(error instanceof PublicationStateUnknownError)
  );
  assert.equal(github.calls.updateRelease, 0);
  assert.equal(github.calls.deleteRelease, 0);
});

test("abandoned detection reports drafts and does not mutate", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease()]],
    getActionsRun: [{ status: "completed", conclusion: "failure" }]
  });
  await assert.rejects(
    runAbandonedDetection(orchestrator(github), {
      repository: RELEASE.repository
    }),
    /abandoned GitHub release drafts detected: 1/
  );
  assert.equal(github.calls.deleteRelease, 0);
  assert.equal(github.calls.updateRelease, 0);
});

test("abandoned detection warns on unowned drafts without failing the schedule", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease({ body: "human draft", id: 42 })]]
  });
  const result = await runAbandonedDetection(orchestrator(github), {
    repository: RELEASE.repository
  });
  assert.deepEqual(result.abandonedDrafts, []);
  assert.equal(result.unownedOrMalformedDrafts.length, 1);
  assert.equal(result.unownedOrMalformedDrafts[0].releaseId, 42);
  assert.equal(github.calls.deleteRelease, 0);
  assert.equal(github.calls.getActionsRun, 0);
});

test("compensation handlers run once on SIGINT/SIGTERM", async () => {
  const processRef = {
    /** @type {Record<string, ((...args: any[]) => unknown) | undefined>} */
    handlers: {},
    /**
     * @param {NodeJS.Signals} signal
     * @param {(...args: any[]) => void} handler
     */
    once(signal, handler) {
      this.handlers[signal] = handler;
    },
    /**
     * @param {NodeJS.Signals} signal
     * @param {(...args: any[]) => void} [_handler]
     */
    removeListener(signal, _handler) {
      delete this.handlers[signal];
    }
  };
  let runs = 0;
  /** @type {number[]} */
  const exits = [];
  const stop = installCompensationHandlers(
    async () => {
      runs += 1;
    },
    {
      processRef,
      signals: ["SIGTERM"],
      exitProcess: (code) => {
        exits.push(code);
      }
    }
  );
  const first = processRef.handlers.SIGTERM;
  assert.ok(first);
  await first();
  await processRef.handlers.SIGTERM?.();
  assert.equal(runs, 1);
  assert.deepEqual(exits, [1]);
  stop();
});

test("compensation still exits nonzero when cleanup throws", async () => {
  const processRef = {
    /** @type {Record<string, ((...args: any[]) => unknown) | undefined>} */
    handlers: {},
    /**
     * @param {NodeJS.Signals} signal
     * @param {(...args: any[]) => void} handler
     */
    once(signal, handler) {
      this.handlers[signal] = handler;
    },
    /**
     * @param {NodeJS.Signals} signal
     * @param {(...args: any[]) => void} [_handler]
     */
    removeListener(signal, _handler) {
      delete this.handlers[signal];
    }
  };
  /** @type {number[]} */
  const exits = [];
  installCompensationHandlers(
    async () => {
      throw new Error("cleanup failed");
    },
    {
      processRef,
      signals: ["SIGINT"],
      exitProcess: (code) => {
        exits.push(code);
      }
    }
  );
  await processRef.handlers.SIGINT?.();
  assert.deepEqual(exits, [1]);
});

test("rollback target requires one fully active Worker version and a live release SHA", () => {
  assert.deepEqual(
    selectRollbackTarget(
      {
        versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
      },
      {
        environment: { configured: true, release: OTHER_SHA }
      }
    ),
    {
      rollbackVersionId: PRIOR_VERSION,
      rollbackRelease: OTHER_SHA
    }
  );
  assert.throws(
    () =>
      selectRollbackTarget(
        {
          versions: [
            { version_id: PRIOR_VERSION, percentage: 100 },
            { version_id: CANDIDATE_VERSION, percentage: 0 }
          ]
        },
        { environment: { configured: true, release: OTHER_SHA } }
      ),
    /exactly one version at 100% traffic/
  );
});

test("production mutations require the sanctioned GitHub Actions context", () => {
  const keys = ["GITHUB_ACTIONS", "GITHUB_REF", "GITHUB_WORKFLOW_REF"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  };
  try {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REF = "refs/heads/main";
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/deploy-production.yml@refs/heads/main";
    assert.doesNotThrow(() =>
      requireProductionWorkflowContext("deploy-production.yml")
    );
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/reconcile-production-release.yml@refs/heads/main";
    assert.doesNotThrow(() =>
      requireProductionWorkflowContext("reconcile-production-release.yml")
    );
    assert.throws(
      () => requireProductionWorkflowContext("rollback-production.yml"),
      /must run from rollback-production\.yml/
    );
  } finally {
    restore();
  }
});

test("certifiedReleaseAssets requires the four archives plus checksums", () => {
  assert.throws(
    () => certifiedReleaseAssets("/tmp/missing-dist-dir-for-release"),
    /ENOENT|incomplete/
  );
});

test("manual reconciliation derives identities after 0% staging without optional IDs", async () => {
  const ownedDraft = draftRelease({ body: preparedMarker() });
  const github = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null],
    getRelease: [ownedDraft, ownedDraft, null],
    deleteRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare({
    deploymentStatus: [
      {
        versions: [
          { version_id: PRIOR_VERSION, percentage: 100 },
          { version_id: CANDIDATE_VERSION, percentage: 0 }
        ]
      },
      {
        versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
      }
    ]
  });
  const decision = await runReconciliation(orchestrator(github, cloudflare), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    requireExactRun: false,
    liveSha: OTHER_SHA
  });
  assert.equal(decision.action, "restore-then-delete-draft");
  assert.deepEqual(cloudflare.calls.deployVersions[0].placements, [
    { versionId: PRIOR_VERSION, percentage: 100 }
  ]);
});

test("manual reconciliation derives identities after 100% promotion without optional IDs", async () => {
  const ownedDraft = draftRelease({
    body: preparedMarker({ candidateVersionId: undefined })
  });
  const github = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null],
    getRelease: [ownedDraft, ownedDraft, null],
    deleteRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare({
    listVersions: [
      {
        id: CANDIDATE_VERSION,
        annotations: {
          "workers/message": serializeWorkerVersionMessage({
            runId: RELEASE.runId,
            releaseId: DRAFT_ID,
            sha: RELEASE.expectedSha
          })
        }
      }
    ],
    deploymentStatus: [
      {
        versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }]
      },
      {
        versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
      }
    ]
  });
  const decision = await runReconciliation(orchestrator(github, cloudflare), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    requireExactRun: false,
    liveSha: RELEASE.expectedSha
  });
  assert.equal(decision.action, "restore-then-delete-draft");
  assert.equal(cloudflare.calls.listVersions, 1);
});

test("candidate Worker version derivation holds on malformed or duplicate identity", async () => {
  const ownedDraft = draftRelease({
    body: preparedMarker({ candidateVersionId: undefined })
  });
  const message = serializeWorkerVersionMessage({
    runId: RELEASE.runId,
    releaseId: DRAFT_ID,
    sha: RELEASE.expectedSha
  });
  const derivedWhenUnreadable = await deriveReleaseIdentities(
    orchestrator(
      scriptedGithub({
        listReleases: [[ownedDraft]],
        remoteTagCommit: [null]
      }),
      scriptedCloudflare({
        listVersions: new Error("versions list unavailable")
      })
    ),
    {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      requireExactRun: false
    }
  );
  assert.equal(derivedWhenUnreadable.candidateVersionId, null);

  const zeroMatches = await deriveReleaseIdentities(
    orchestrator(
      scriptedGithub({
        listReleases: [[ownedDraft]],
        remoteTagCommit: [null]
      }),
      scriptedCloudflare({ listVersions: [] })
    ),
    {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      requireExactRun: false
    }
  );
  assert.equal(zeroMatches.candidateVersionId, null);

  await assert.rejects(
    deriveReleaseIdentities(
      orchestrator(
        scriptedGithub({
          listReleases: [[ownedDraft]],
          remoteTagCommit: [null]
        }),
        scriptedCloudflare({
          listVersions: { unexpected: true }
        })
      ),
      {
        repository: RELEASE.repository,
        releaseTag: RELEASE.releaseTag,
        requireExactRun: false
      }
    ),
    /Worker version list is malformed/
  );

  await assert.rejects(
    deriveReleaseIdentities(
      orchestrator(
        scriptedGithub({
          listReleases: [[ownedDraft]],
          remoteTagCommit: [null]
        }),
        scriptedCloudflare({
          listVersions: [
            {
              id: CANDIDATE_VERSION,
              annotations: { "workers/message": message }
            },
            {
              id: "123e4567-e89b-12d3-a456-426614174099",
              annotations: { "workers/message": message }
            }
          ]
        })
      ),
      {
        repository: RELEASE.repository,
        releaseTag: RELEASE.releaseTag,
        requireExactRun: false
      }
    ),
    /multiple Worker versions share the candidate identity/
  );

  await assert.rejects(
    deriveReleaseIdentities(
      orchestrator(
        scriptedGithub({
          listReleases: [[ownedDraft]],
          remoteTagCommit: [null]
        }),
        scriptedCloudflare({
          listVersions: [
            { id: "not-a-uuid", annotations: { "workers/message": message } }
          ]
        })
      ),
      {
        repository: RELEASE.repository,
        releaseTag: RELEASE.releaseTag,
        requireExactRun: false
      }
    ),
    /matched Worker version identity is malformed/
  );
});

test("cleanup proofs fail closed on traffic, runtime, draft, tag, and delete errors", async () => {
  const ownedDraft = draftRelease({ body: preparedMarker() });
  const identities = {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    releaseId: DRAFT_ID,
    runId: RELEASE.runId,
    candidateSha: RELEASE.expectedSha,
    priorVersionId: PRIOR_VERSION,
    priorSha: OTHER_SHA
  };

  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({ getRelease: [ownedDraft] }),
        scriptedCloudflare({
          deploymentStatus: [
            {
              versions: [
                { version_id: PRIOR_VERSION, percentage: 100 },
                { version_id: CANDIDATE_VERSION, percentage: 0 }
              ]
            }
          ]
        })
      ),
      identities
    ),
    /did not collapse to the prior version at 100%/
  );

  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({ getRelease: [ownedDraft] }),
        scriptedCloudflare({
          deploymentStatus: [
            { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
          ]
        }),
        {
          runtimeCanary: async () => ({
            environment: { configured: true, release: RELEASE.expectedSha }
          })
        }
      ),
      identities
    ),
    /did not prove the prior release SHA/
  );

  const publishingCloudflare = scriptedCloudflare({
    deploymentStatus: [
      { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
    ]
  });
  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({
          getRelease: [draftRelease({ body: marker("publishing") })]
        }),
        publishingCloudflare
      ),
      identities
    ),
    /refusing draft deletion on a publishing/
  );
  assert.equal(publishingCloudflare.calls.deployVersions.length, 0);

  const taggedCloudflare = scriptedCloudflare({
    deploymentStatus: [
      { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
    ]
  });
  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({
          getRelease: [ownedDraft],
          remoteTagCommit: [RELEASE.expectedSha]
        }),
        taggedCloudflare
      ),
      identities
    ),
    /remote tag is present/
  );
  assert.equal(taggedCloudflare.calls.deployVersions.length, 0);

  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({
          getRelease: [ownedDraft, ownedDraft],
          remoteTagCommit: [null],
          deleteRelease: [{ status: 1, stderr: "HTTP 500" }]
        }),
        scriptedCloudflare({
          deploymentStatus: [
            { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
          ]
        })
      ),
      identities
    ),
    /delete owned prepared draft/
  );

  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        scriptedGithub({
          getRelease: [ownedDraft, ownedDraft, ownedDraft],
          remoteTagCommit: [null],
          deleteRelease: [{ status: 0 }]
        }),
        scriptedCloudflare({
          deploymentStatus: [
            { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
          ]
        })
      ),
      identities
    ),
    /still present after delete/
  );

  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(scriptedGithub(), scriptedCloudflare()),
      { ...identities, priorSha: "" }
    ),
    /prior runtime SHA is unknown/
  );
});

test("publication holds if the remote tag changes after the publishing marker", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease()]],
    remoteTagCommit: [null, OTHER_SHA],
    updateRelease: [{ status: 0 }, { status: 0 }]
  });
  await assert.rejects(
    runReleasePublication(orchestrator(github), {
      ...RELEASE,
      releaseId: DRAFT_ID,
      assets: [CERTIFIED_ASSET]
    }),
    /points at 2222222222222222222222222222222222222222/
  );
  assert.equal(github.calls.updateRelease, 1);
});

test("abandoned detection excludes queued and in-progress owning runs", async () => {
  const active = draftRelease({
    body: marker("prepared"),
    id: 11
  });
  const queued = draftRelease({
    body: marker("prepared"),
    id: 12
  });
  const malformed = draftRelease({ body: "not a marker", id: 13 });
  const terminal = draftRelease({
    body: marker("prepared"),
    id: 14
  });
  const github = scriptedGithub({
    listReleases: [[active, queued, malformed, terminal]],
    getActionsRun: [
      { status: "in_progress" },
      { status: "queued" },
      { status: "completed", conclusion: "failure" }
    ]
  });
  await assert.rejects(
    runAbandonedDetection(orchestrator(github), {
      repository: RELEASE.repository
    }),
    /abandoned GitHub release drafts detected: 1/
  );
  assert.equal(github.calls.getActionsRun, 3);
  assert.equal(github.calls.deleteRelease, 0);
});

test("abandoned detection fails closed when getActionsRun is unavailable", async () => {
  const github = scriptedGithub(
    { listReleases: [[draftRelease()]] },
    { omitGetActionsRun: true }
  );
  assert.equal("getActionsRun" in github, false);
  await assert.rejects(
    runAbandonedDetection(orchestrator(github), {
      repository: RELEASE.repository
    }),
    /requires github.getActionsRun/
  );
});

test("publication holds when certified assets are missing before draft:false", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease({ body: marker("publishing") })]],
    remoteTagCommit: [null],
    updateRelease: [{ status: 0 }]
  });
  await assert.rejects(
    runReleasePublication(orchestrator(github), {
      ...RELEASE,
      releaseId: DRAFT_ID
    }),
    (error) =>
      error instanceof ReleaseHoldError &&
      /certified CLI asset/.test(error.message)
  );
  assert.equal(github.calls.updateRelease, 0);
});

test("publication re-proves certified assets immediately before draft:false", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease()]],
    remoteTagCommit: [null],
    updateRelease: [{ status: 0 }, { status: 0 }],
    getRelease: [draftRelease({ assets: CERTIFIED_RELEASE_ASSETS })],
    downloadAsset: [Buffer.from("tampered")]
  });
  await assert.rejects(
    runReleasePublication(orchestrator(github), {
      ...RELEASE,
      releaseId: DRAFT_ID,
      assets: [CERTIFIED_ASSET]
    }),
    /differs from the certified build/
  );
  assert.equal(github.calls.updateRelease, 1);
});

test("GitHub release listing continues past twenty pages to an owned draft", () => {
  const owned = draftRelease({ id: 9001 });
  const pages = Array.from({ length: 21 }, (_, page) =>
    Array.from({ length: 100 }, (__, index) =>
      publishedRelease({ id: page * 100 + index + 1 })
    )
  );
  pages.push([owned]);
  let requestedPage = 0;
  const releases = listGithubReleases(RELEASE.repository, (apiPath) => {
    requestedPage += 1;
    assert.match(apiPath, new RegExp(`[?&]page=${requestedPage}(?:$|&)`));
    return pages[requestedPage - 1];
  });
  assert.equal(releases.length, 2101);
  assert.equal(releases.at(-1)?.id, owned.id);
  assert.equal(requestedPage, 22);
});

test("assertGithubMutationResult fails closed on errors and nonzero status", () => {
  assert.doesNotThrow(() => assertGithubMutationResult({ status: 0 }, "noop"));
  assert.throws(
    () =>
      assertGithubMutationResult(
        { status: 1, stderr: "HTTP 500" },
        "delete owned prepared draft"
      ),
    /delete owned prepared draft/
  );
  assert.throws(
    () =>
      assertGithubMutationResult(
        { status: 0, error: new Error("transport") },
        "delete owned prepared draft"
      ),
    /transport/
  );
});

test("GitHub spawn options and stdout collection exceed Node's 1 MiB default", () => {
  const oversized = 1024 * 1024 + 128 * 1024;
  assert.ok(GH_SPAWN_MAX_BUFFER_BYTES > 1024 * 1024);
  const options = githubCommandSpawnOptions({ encoding: null });
  assert.equal(options.maxBuffer, GH_SPAWN_MAX_BUFFER_BYTES);
  const defaulted = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(Buffer.alloc(${oversized}, 1))`],
    { encoding: null }
  );
  assert.equal(
    defaulted.error && "code" in defaulted.error
      ? defaulted.error.code
      : undefined,
    "ENOBUFS"
  );
  const buffered = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(Buffer.alloc(${oversized}, 9))`],
    githubCommandSpawnOptions({ encoding: null, cwd: process.cwd() })
  );
  assert.equal(buffered.status, 0);
  assert.equal(buffered.error, undefined);
  assert.equal(buffered.stdout?.length, oversized);
  const streamed = collectCommandStdoutBytes(process.execPath, [
    "-e",
    `process.stdout.write(Buffer.alloc(${oversized}, 7))`
  ]);
  assert.equal(streamed.length, oversized);
  assert.equal(streamed[0], 7);
  assert.equal(streamed[streamed.length - 1], 7);
});

test("publication retries while the tag ref is not yet visible", async () => {
  const github = scriptedGithub({
    listReleases: [
      [draftRelease()],
      [publishedRelease()],
      [publishedRelease()]
    ],
    remoteTagCommit: [null, null, null, RELEASE.expectedSha],
    getRelease: [draftRelease({ assets: CERTIFIED_RELEASE_ASSETS })],
    downloadAsset: [CERTIFIED_ASSET.bytes],
    updateRelease: [{ status: 0 }, { status: 0 }]
  });
  const result = await runReleasePublication(orchestrator(github), {
    ...RELEASE,
    releaseId: DRAFT_ID,
    assets: [CERTIFIED_ASSET]
  });
  assert.equal(result.kind, "committed");
  assert.equal(github.calls.updateRelease, 2);
});

test("publication tag lag exhaustion is PublicationStateUnknownError", async () => {
  const github = scriptedGithub({
    listReleases: [[publishedRelease()]],
    remoteTagCommit: [null]
  });
  await assert.rejects(
    runReleasePublication(orchestrator(github), {
      ...RELEASE,
      releaseId: DRAFT_ID,
      assets: [CERTIFIED_ASSET]
    }),
    (error) => error instanceof PublicationStateUnknownError
  );
  assert.equal(github.calls.updateRelease, 0);
  assert.equal(github.calls.deleteRelease, 0);
});

test("published same-tag leftover draft never rolls back or deletes", async () => {
  const leftover = draftRelease({ body: preparedMarker() });
  const github = scriptedGithub({
    listReleases: [[publishedRelease(), leftover]],
    remoteTagCommit: [RELEASE.expectedSha]
  });
  const cloudflare = scriptedCloudflare();
  const decision = await runReconciliation(orchestrator(github, cloudflare), {
    ...RELEASE,
    priorVersionId: PRIOR_VERSION,
    liveSha: RELEASE.expectedSha
  });
  assert.equal(decision.action, "committed");
  assert.equal(cloudflare.calls.deployVersions.length, 0);
  assert.equal(github.calls.deleteRelease, 0);
});

test("restore proof retries until the prior SHA is visible", async () => {
  const ownedDraft = draftRelease({ body: preparedMarker() });
  let canaryCalls = 0;
  /** @type {number[]} */
  const sleeps = [];
  await cleanupOwnedPreparedDraft(
    orchestrator(
      scriptedGithub({
        getRelease: [ownedDraft, ownedDraft, null],
        remoteTagCommit: [null]
      }),
      scriptedCloudflare({
        deploymentStatus: [
          { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
        ]
      }),
      {
        runtimeCanary: async () => {
          canaryCalls += 1;
          if (canaryCalls < 3) {
            return {
              environment: {
                configured: true,
                release: RELEASE.expectedSha
              }
            };
          }
          return {
            environment: { configured: true, release: OTHER_SHA }
          };
        },
        sleep: async (/** @type {number} */ ms) => {
          sleeps.push(ms);
        }
      }
    ),
    {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      releaseId: DRAFT_ID,
      runId: RELEASE.runId,
      candidateSha: RELEASE.expectedSha,
      priorVersionId: PRIOR_VERSION,
      priorSha: OTHER_SHA
    }
  );
  assert.equal(canaryCalls, 3);
  assert.deepEqual(sleeps, [
    RESTORE_PROOF_BACKOFF_MS,
    RESTORE_PROOF_BACKOFF_MS
  ]);
});

test("restore proof exhaustion refuses draft deletion", async () => {
  const ownedDraft = draftRelease({ body: preparedMarker() });
  let canaryCalls = 0;
  /** @type {number[]} */
  const sleeps = [];
  const github = scriptedGithub({
    getRelease: [ownedDraft],
    remoteTagCommit: [null]
  });
  await assert.rejects(
    cleanupOwnedPreparedDraft(
      orchestrator(
        github,
        scriptedCloudflare({
          deploymentStatus: [
            { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
          ]
        }),
        {
          runtimeCanary: async () => {
            canaryCalls += 1;
            return {
              environment: {
                configured: true,
                release: RELEASE.expectedSha
              }
            };
          },
          sleep: async (/** @type {number} */ ms) => {
            sleeps.push(ms);
          }
        }
      ),
      {
        repository: RELEASE.repository,
        releaseTag: RELEASE.releaseTag,
        releaseId: DRAFT_ID,
        runId: RELEASE.runId,
        candidateSha: RELEASE.expectedSha,
        priorVersionId: PRIOR_VERSION,
        priorSha: OTHER_SHA
      }
    ),
    /did not prove the prior release SHA/
  );
  assert.equal(canaryCalls, RESTORE_PROOF_ATTEMPTS);
  assert.equal(sleeps.length, RESTORE_PROOF_ATTEMPTS - 1);
  assert.equal(github.calls.deleteRelease, 0);
});

test("same-run rerun fails loudly when captured prior diverges from the marker", async () => {
  const recorded = parseOwnershipMarker(preparedMarker());
  assert.throws(
    () =>
      assertCapturedPriorMatchesMarker(recorded, {
        rollbackVersionId: CANDIDATE_VERSION,
        rollbackRelease: OTHER_SHA
      }),
    /differs from marker-recorded prior/
  );
  assert.doesNotThrow(() =>
    assertCapturedPriorMatchesMarker(recorded, {
      rollbackVersionId: PRIOR_VERSION,
      rollbackRelease: OTHER_SHA
    })
  );
  const github = scriptedGithub({
    getRelease: [draftRelease({ body: preparedMarker() })],
    updateRelease: [{ status: 0 }]
  });
  await assert.rejects(
    persistOwnedDraftIdentities(orchestrator(github), {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      runId: RELEASE.runId,
      candidateSha: RELEASE.expectedSha,
      releaseId: DRAFT_ID,
      priorSha: RELEASE.expectedSha,
      priorVersionId: CANDIDATE_VERSION
    }),
    /differs from marker-recorded prior/
  );
  assert.equal(github.calls.updateRelease, 0);
});
