import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ReleaseHoldError } from "../scripts/release/identity.mjs";
import {
  expectedReleasePhaseTuples,
  deployJobReleasePhaseTuples
} from "../scripts/release/order.mjs";
import {
  runDraftPreparation,
  runReconciliation
} from "../scripts/release/phases.mjs";
import {
  CANDIDATE_VERSION,
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
import { runReleasePhases } from "./helpers/release-phases.mjs";

test("fault injection restores prior traffic and leaves the version reusable", async () => {
  /** @type {("upload" | "persist-candidate" | "staged" | "promote")[]} */
  const failures = ["upload", "persist-candidate", "staged", "promote"];
  for (const failBefore of failures) {
    const github = scriptedGithub({
      listReleases: [[draftRelease()]],
      remoteTagCommit: [null],
      getRelease: [
        draftRelease(),
        draftRelease(),
        draftRelease({
          assets: [{ id: 1, name: "checksums.txt", size: 4 }]
        })
      ],
      uploadAsset: [{ status: 0 }],
      downloadAsset: [Buffer.from("abcd")],
      updateRelease: [{ status: 0 }]
    });
    const cloudflare = scriptedCloudflare();
    await assert.rejects(
      runReleasePhases(orchestrator(github, cloudflare), {
        assets: [
          {
            name: "checksums.txt",
            path: "/tmp/checksums.txt",
            bytes: Buffer.from("abcd")
          }
        ],
        liveConfig: {
          routes: [{ pattern: "app.example" }],
          triggers: { crons: ["1 * * * *"] }
        },
        candidateConfig: {
          routes: [{ pattern: "app.example" }],
          triggers: { crons: ["1 * * * *"] }
        },
        migrate: async () => {},
        overrideSmoke: async () => {},
        productionSmoke: async () => {},
        failBefore
      }),
      new RegExp(
        {
          upload: "version upload failed",
          "persist-candidate": "candidate identity persist failed",
          staged: "0% deploy failed",
          promote: "promotion failed"
        }[failBefore]
      ),
      failBefore
    );
    if (failBefore === "persist-candidate") {
      assert.equal(cloudflare.calls.uploadVersion, 1, failBefore);
    } else if (failBefore === "upload") {
      assert.equal(cloudflare.calls.uploadVersion, 0, failBefore);
    }
    assert.ok(github.calls.updateRelease >= 1, failBefore);
    const ownedDraft = draftRelease({ body: preparedMarker() });
    const cleanupGithub = scriptedGithub({
      listReleases: [[ownedDraft]],
      remoteTagCommit: [null],
      getRelease: [ownedDraft, ownedDraft, null],
      deleteRelease: [{ status: 0 }]
    });
    const cleanupCloudflare = scriptedCloudflare({
      deploymentStatus: [
        {
          versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
        },
        {
          versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
        }
      ]
    });
    await runReconciliation(orchestrator(cleanupGithub, cleanupCloudflare), {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      requireExactRun: false,
      liveSha: OTHER_SHA
    });
    assert.deepEqual(
      cleanupCloudflare.calls.deployVersions[0].placements,
      [{ versionId: PRIOR_VERSION, percentage: 100 }],
      failBefore
    );
    assert.equal(cleanupGithub.calls.deleteRelease, 1, failBefore);
    const reused = await runDraftPreparation(
      orchestrator(
        scriptedGithub({
          listReleases: [[]],
          remoteTagCommit: [null],
          createDraft: [
            {
              status: 0,
              release: draftRelease({
                targetCommitish: OTHER_SHA,
                body: marker("prepared", { candidateSha: OTHER_SHA })
              })
            }
          ]
        })
      ),
      { ...RELEASE, expectedSha: OTHER_SHA }
    );
    assert.equal(reused.kind, "owned_prepared", failBefore);
  }
});

test("committed releases refuse a different SHA and are not rolled back", async () => {
  const github = scriptedGithub({
    listReleases: [[publishedRelease()]],
    remoteTagCommit: [RELEASE.expectedSha]
  });
  await assert.rejects(
    runDraftPreparation(orchestrator(github), {
      ...RELEASE,
      expectedSha: OTHER_SHA
    }),
    ReleaseHoldError
  );
  const decision = await runReconciliation(
    orchestrator(github, scriptedCloudflare()),
    {
      ...RELEASE,
      priorVersionId: PRIOR_VERSION,
      liveSha: RELEASE.expectedSha
    }
  );
  assert.equal(decision.action, "committed");
  assert.equal(github.calls.deleteRelease, 0);
});

test("transaction fault at override smoke collapses to prior@100 only", async () => {
  const github = scriptedGithub({
    listReleases: [[draftRelease()]],
    remoteTagCommit: [null],
    getRelease: [
      draftRelease(),
      draftRelease(),
      draftRelease({ assets: [{ id: 1, name: "checksums.txt", size: 4 }] })
    ],
    uploadAsset: [{ status: 0 }],
    downloadAsset: [Buffer.from("abcd")],
    updateRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare();
  await assert.rejects(
    runReleasePhases(orchestrator(github, cloudflare), {
      assets: [
        {
          name: "checksums.txt",
          path: "/tmp/checksums.txt",
          bytes: Buffer.from("abcd")
        }
      ],
      liveConfig: { routes: [], triggers: {} },
      candidateConfig: { routes: [], triggers: {} },
      migrate: async () => {},
      failBefore: "override-smoke"
    }),
    /override smoke failed/
  );
  const ownedDraft = draftRelease({ body: preparedMarker() });
  const cleanup = scriptedCloudflare({
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
  const cleanupGithub = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null],
    getRelease: [ownedDraft, ownedDraft, null],
    deleteRelease: [{ status: 0 }]
  });
  await runReconciliation(orchestrator(cleanupGithub, cleanup), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    requireExactRun: false,
    liveSha: OTHER_SHA
  });
  assert.deepEqual(cleanup.calls.deployVersions[0].placements, [
    { versionId: PRIOR_VERSION, percentage: 100 }
  ]);
});

test("migration and smoke gateways are invoked in order and publication is last", async () => {
  /** @type {string[]} */
  const order = [];
  const github = scriptedGithub({
    listReleases: [[], [draftRelease()], [publishedRelease()]],
    remoteTagCommit: [null, null, null, RELEASE.expectedSha],
    createDraft: [{ status: 0, release: draftRelease() }],
    getRelease: [
      draftRelease(),
      draftRelease(),
      draftRelease({ assets: [{ id: 1, name: "checksums.txt", size: 3 }] })
    ],
    uploadAsset: [{ status: 0 }],
    downloadAsset: [Buffer.from("cli")],
    updateRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare();
  await runReleasePhases(orchestrator(github, cloudflare), {
    assets: [
      {
        name: "checksums.txt",
        path: "/tmp/checksums.txt",
        bytes: Buffer.from("cli")
      }
    ],
    liveConfig: { routes: ["a"], triggers: { crons: ["17 * * * *"] } },
    candidateConfig: { routes: ["a"], triggers: { crons: ["17 * * * *"] } },
    rollbackTargetSmoke: async () => {
      order.push("rollback-target-smoke");
      assert.equal(cloudflare.calls.uploadVersion, 0);
    },
    migrate: async () => {
      order.push("migrate");
      assert.equal(cloudflare.calls.uploadVersion, 1);
      assert.equal(cloudflare.calls.deployVersions.length, 0);
    },
    overrideSmoke: async () => {
      order.push("override-smoke");
      assert.equal(cloudflare.calls.deployVersions.length, 1);
      assert.equal(
        cloudflare.calls.deployVersions[0].placements[1].percentage,
        0
      );
    },
    productionSmoke: async () => {
      order.push("production-smoke");
      assert.equal(cloudflare.calls.deployVersions.length, 2);
      assert.equal(
        cloudflare.calls.deployVersions[1].placements[0].percentage,
        100
      );
    }
  });
  assert.deepEqual(order, [
    "rollback-target-smoke",
    "migrate",
    "override-smoke",
    "production-smoke"
  ]);
  assert.equal(cloudflare.calls.uploadVersion, 1);
  assert.equal(cloudflare.calls.deployVersions.length, 2);
  assert.ok(github.calls.createDraft === 1);
  assert.ok(github.calls.getRelease >= 4);
  assert.ok(github.calls.updateRelease >= 4);
});

test("pre-persistence failure restores prior traffic and deletes the owned prepared draft", async () => {
  const ownedDraft = draftRelease();
  const github = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null],
    getRelease: [ownedDraft, ownedDraft, null],
    deleteRelease: [{ status: 0 }]
  });
  const cloudflare = scriptedCloudflare({
    deploymentStatus: [
      { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] },
      { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
    ]
  });
  const decision = await runReconciliation(orchestrator(github, cloudflare), {
    repository: RELEASE.repository,
    releaseTag: RELEASE.releaseTag,
    requireExactRun: false,
    liveSha: OTHER_SHA
  });
  assert.equal(decision.action, "collapse-then-delete-draft");
  assert.equal(decision.priorSha, OTHER_SHA);
  assert.equal(decision.priorVersionId, PRIOR_VERSION);
  assert.deepEqual(cloudflare.calls.deployVersions[0].placements, [
    { versionId: PRIOR_VERSION, percentage: 100 }
  ]);
  assert.equal(github.calls.deleteRelease, 1);
  assert.equal(github.calls.getRelease, 3);
});

test("pre-persistence cleanup holds when live state is unsafe or unreadable", async () => {
  const ownedDraft = draftRelease();
  /** @type {[string, { liveSha?: string, tagCommit?: string | null, deploymentStatus?: any[], runtimeCanary?: () => Promise<unknown> }][]} */
  const variants = [
    [
      "candidate live SHA",
      {
        liveSha: RELEASE.expectedSha,
        deploymentStatus: [
          { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
        ]
      }
    ],
    [
      "candidate live traffic",
      {
        liveSha: RELEASE.expectedSha,
        deploymentStatus: [
          { versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }] }
        ]
      }
    ],
    [
      "staged traffic",
      {
        liveSha: OTHER_SHA,
        deploymentStatus: [
          {
            versions: [
              { version_id: PRIOR_VERSION, percentage: 100 },
              { version_id: CANDIDATE_VERSION, percentage: 0 }
            ]
          }
        ]
      }
    ],
    [
      "remote tag present",
      {
        liveSha: OTHER_SHA,
        tagCommit: OTHER_SHA,
        deploymentStatus: [
          { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
        ]
      }
    ],
    [
      "unconfigured canary",
      {
        runtimeCanary: async () => ({
          environment: { configured: false, release: OTHER_SHA }
        }),
        deploymentStatus: [
          { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
        ]
      }
    ],
    [
      "canary unreadable",
      {
        runtimeCanary: async () => {
          throw new Error("canary down");
        },
        deploymentStatus: [
          { versions: [{ version_id: PRIOR_VERSION, percentage: 100 }] }
        ]
      }
    ]
  ];
  for (const [label, variant] of variants) {
    const github = scriptedGithub({
      listReleases: [[ownedDraft]],
      remoteTagCommit: [variant.tagCommit ?? null]
    });
    const cloudflare = scriptedCloudflare({
      deploymentStatus: variant.deploymentStatus
    });
    await assert.rejects(
      runReconciliation(
        orchestrator(
          github,
          cloudflare,
          variant.runtimeCanary ? { runtimeCanary: variant.runtimeCanary } : {}
        ),
        {
          repository: RELEASE.repository,
          releaseTag: RELEASE.releaseTag,
          requireExactRun: false,
          liveSha: variant.liveSha
        }
      ),
      ReleaseHoldError,
      label
    );
    assert.equal(github.calls.deleteRelease, 0, label);
    assert.equal(cloudflare.calls.deployVersions.length, 0, label);
  }

  const unreadableGithub = scriptedGithub({
    listReleases: [[ownedDraft]],
    remoteTagCommit: [null]
  });
  const unreadableCloudflare = scriptedCloudflare({
    deploymentStatus: [new Error("cloudflare timeout")]
  });
  await assert.rejects(
    runReconciliation(orchestrator(unreadableGithub, unreadableCloudflare), {
      repository: RELEASE.repository,
      releaseTag: RELEASE.releaseTag,
      requireExactRun: false,
      liveSha: OTHER_SHA
    }),
    /Cloudflare is unreadable/
  );
  assert.equal(unreadableGithub.calls.deleteRelease, 0);
});

test("behavioral phase runner and deploy workflow share the exported release order", () => {
  const deployWorkflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8"
  );
  const deployJob = deployWorkflow.slice(
    deployWorkflow.indexOf("  deploy:"),
    deployWorkflow.indexOf("  publish-cli-homebrew:")
  );
  assert.deepEqual(
    deployJobReleasePhaseTuples(deployJob),
    expectedReleasePhaseTuples()
  );
});

test("capture-rollback proves the live prior against the marker before persistence", async () => {
  const owned = draftRelease({
    body: preparedMarker(),
    assets: [{ id: 1, name: "checksums.txt", size: 3 }]
  });
  const github = scriptedGithub({
    listReleases: [[owned]],
    remoteTagCommit: [null],
    getRelease: [owned],
    downloadAsset: [Buffer.from("cli")],
    updateRelease: [{ status: 0 }]
  });
  await assert.rejects(
    runReleasePhases(
      orchestrator(github, scriptedCloudflare(), {
        runtimeCanary: async () => ({
          environment: { configured: true, release: RELEASE.expectedSha }
        })
      }),
      {
        assets: [
          {
            name: "checksums.txt",
            path: "/tmp/checksums.txt",
            bytes: Buffer.from("cli")
          }
        ]
      }
    ),
    /differs from marker-recorded prior/
  );
  assert.equal(github.calls.updateRelease, 0);
});

test("scripted Cloudflare deploymentStatus preserves explicit null and undefined entries", async () => {
  const scripted = scriptedCloudflare({
    deploymentStatus: [null, undefined]
  });
  assert.equal(await scripted.deploymentStatus(), null);
  assert.equal(await scripted.deploymentStatus(), undefined);
  const unscripted = scriptedCloudflare();
  assert.deepEqual(await unscripted.deploymentStatus(), {
    versions: [{ version_id: PRIOR_VERSION, percentage: 100 }]
  });
});
