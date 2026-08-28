import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFinalizeFailure,
  classifyReleaseTagState,
  githubReleaseCreateArgs,
  githubReleasePublishArgs,
  PublicationStateUnknownError,
  releaseMetadata,
  requireProductionWorkflowContext,
  runReleaseDraftPreparation,
  runReleasePublication,
  selectRollbackTarget,
  validateReleaseRepairSource,
  validateWorkerVersionReleaseTag
} from "../scripts/production-release.mjs";

const RELEASE = {
  repository: "conn-castle/agent-outbox",
  releaseTag: "v1.2.3",
  expectedSha: "1111111111111111111111111111111111111111"
};
const OTHER_SHA = "2222222222222222222222222222222222222222";
/** @type {any} */
const REPAIR_SOURCE = {
  sourceRunId: "123456789",
  releaseTag: RELEASE.releaseTag,
  candidateSha: RELEASE.expectedSha,
  run: {
    id: 123456789,
    path: ".github/workflows/deploy-production.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: RELEASE.expectedSha,
    status: "completed",
    conclusion: "failure"
  },
  jobs: {
    jobs: [
      "Certify exact release SHA / make release-check",
      "Certify exact release SHA / make browser",
      "Certify exact release SHA / make migration-replay",
      "Build and validate release CLI",
      "Deploy and verify production Worker"
    ]
      .map((name) => ({
        name,
        conclusion: "success",
        head_sha: RELEASE.expectedSha
      }))
      .concat({
        name: "Tag verified production release",
        conclusion: "failure",
        head_sha: RELEASE.expectedSha
      })
  },
  artifacts: {
    artifacts: [
      {
        name: `agent-outbox-release-${RELEASE.expectedSha}`,
        expired: false
      }
    ]
  },
  candidatePackageJson: { name: "agent-outbox", version: "1.2.3" }
};

/**
 * Scripted release gateway: each method returns (or throws, for Error items) the
 * next value from its queue, clamping to the last entry so a queue of length 1
 * answers every call. `sleep` is a no-op so retry tests run instantly.
 *
 * @param {object} script
 * @param {Array<object | Error>} [script.reconcile]
 * @param {Array<{ status: number, stderr?: string, error?: Error } | Error>} [script.createRelease]
 * @param {Array<{ status: number, stderr?: string, error?: Error } | Error>} [script.publishRelease]
 */
function scriptedGateway({
  reconcile = [],
  createRelease = [],
  publishRelease = []
}) {
  const calls = {
    reconcile: 0,
    createRelease: 0,
    publishRelease: 0,
    sleep: 0
  };
  /**
   * @param {"reconcile" | "createRelease" | "publishRelease"} name
   * @param {any[]} queue
   */
  const take = (name, queue) => {
    const index = Math.min(calls[name], queue.length - 1);
    calls[name] += 1;
    const value = queue[index];
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  return {
    calls,
    reconcile: () => take("reconcile", reconcile),
    createRelease: () => take("createRelease", createRelease),
    publishRelease: () => take("publishRelease", publishRelease),
    sleep: () => {
      calls.sleep += 1;
    }
  };
}

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
  assert.throws(
    () => releaseMetadata({ name: "agent-outbox", version: "1.2.3-beta.1" }),
    /version must be a numbered stable release/
  );
});

test("release repair accepts only the exact failed certified production source", () => {
  assert.deepEqual(validateReleaseRepairSource(REPAIR_SOURCE), {
    artifactName: `agent-outbox-release-${RELEASE.expectedSha}`
  });

  /** @type {[string, (source: any) => void][]} */
  const invalidCases = [
    ["automatic run", (source) => (source.run.event = "push")],
    ["wrong candidate", (source) => (source.run.head_sha = OTHER_SHA)],
    ["successful run", (source) => (source.run.conclusion = "success")],
    [
      "missing certification",
      (source) => {
        source.jobs.jobs = source.jobs.jobs.filter(
          (/** @type {any} */ job) =>
            job.name !== "Certify exact release SHA / make browser"
        );
      }
    ],
    [
      "failed deploy",
      (source) => {
        source.jobs.jobs.find(
          (/** @type {any} */ job) =>
            job.name === "Deploy and verify production Worker"
        ).conclusion = "failure";
      }
    ],
    [
      "expired artifact",
      (source) => (source.artifacts.artifacts[0].expired = true)
    ],
    [
      "wrong version",
      (source) => (source.candidatePackageJson.version = "1.2.4")
    ]
  ];
  for (const [description, mutate] of invalidCases) {
    const source = structuredClone(REPAIR_SOURCE);
    mutate(source);
    assert.throws(() => validateReleaseRepairSource(source), description);
  }
});

test("release creation remains draft until certified CLI assets are uploaded", () => {
  const args = githubReleaseCreateArgs(
    RELEASE.repository,
    RELEASE.releaseTag,
    RELEASE.expectedSha
  );
  assert.equal(args.includes("--draft"), true);
  assert.equal(args.includes("--latest"), false);
  assert.deepEqual(
    githubReleasePublishArgs(RELEASE.repository, RELEASE.releaseTag),
    [
      "release",
      "edit",
      RELEASE.releaseTag,
      "--repo",
      RELEASE.repository,
      "--draft=false",
      "--latest"
    ]
  );
});

test("manual rollback accepts only a Worker version stamped with the requested release tag", () => {
  assert.doesNotThrow(() =>
    validateWorkerVersionReleaseTag(
      {
        id: "123e4567-e89b-12d3-a456-426614174000",
        annotations: { "workers/tag": "v1.2.3" }
      },
      "123e4567-e89b-12d3-a456-426614174000",
      "v1.2.3"
    )
  );
  assert.throws(
    () =>
      validateWorkerVersionReleaseTag(
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          annotations: { "workers/tag": "v1.2.4" }
        },
        "123e4567-e89b-12d3-a456-426614174000",
        "v1.2.3"
      ),
    /does not carry release tag v1.2.3/
  );
  // Cloudflare returning a different version id than requested must be rejected
  // before the annotation check, so a rollback never targets the wrong version.
  assert.throws(
    () =>
      validateWorkerVersionReleaseTag(
        {
          id: "00000000-0000-4000-8000-000000000000",
          annotations: { "workers/tag": "v1.2.3" }
        },
        "123e4567-e89b-12d3-a456-426614174000",
        "v1.2.3"
      ),
    /different Worker version id/
  );
});

test("rollback target requires one fully active Worker version and a live release SHA", () => {
  assert.deepEqual(
    selectRollbackTarget(
      {
        id: "deployment-id",
        versions: [
          {
            version_id: "123e4567-e89b-12d3-a456-426614174000",
            percentage: 100
          }
        ]
      },
      {
        ok: true,
        code: "runtime_canary_ok",
        environment: {
          configured: true,
          release: "fedcba9876543210fedcba9876543210fedcba98"
        }
      }
    ),
    {
      rollbackVersionId: "123e4567-e89b-12d3-a456-426614174000",
      rollbackRelease: "fedcba9876543210fedcba9876543210fedcba98"
    }
  );

  assert.throws(
    () =>
      selectRollbackTarget(
        {
          versions: [
            { version_id: "version-a", percentage: 50 },
            { version_id: "version-b", percentage: 50 }
          ]
        },
        {
          environment: {
            configured: true,
            release: "fedcba9876543210fedcba9876543210fedcba98"
          }
        }
      ),
    /exactly one version at 100% traffic/
  );
  // A single version mid-rollout (not 100%) must not be captured as the
  // known-good rollback target.
  assert.throws(
    () =>
      selectRollbackTarget(
        {
          versions: [
            {
              version_id: "123e4567-e89b-12d3-a456-426614174000",
              percentage: 50
            }
          ]
        },
        {
          environment: {
            configured: true,
            release: "fedcba9876543210fedcba9876543210fedcba98"
          }
        }
      ),
    /exactly one version at 100% traffic/
  );
  // A malformed version id must be rejected even at 100%.
  assert.throws(
    () =>
      selectRollbackTarget(
        { versions: [{ version_id: "not-a-uuid", percentage: 100 }] },
        {
          environment: {
            configured: true,
            release: "fedcba9876543210fedcba9876543210fedcba98"
          }
        }
      ),
    /exactly one version at 100% traffic/
  );
  // An unconfigured runtime environment has no trustworthy live release SHA.
  assert.throws(
    () =>
      selectRollbackTarget(
        {
          versions: [
            {
              version_id: "123e4567-e89b-12d3-a456-426614174000",
              percentage: 100
            }
          ]
        },
        {
          environment: {
            configured: false,
            release: "fedcba9876543210fedcba9876543210fedcba98"
          }
        }
      ),
    /live release SHA/
  );
  assert.throws(
    () =>
      selectRollbackTarget(
        {
          versions: [
            {
              version_id: "123e4567-e89b-12d3-a456-426614174000",
              percentage: 100
            }
          ]
        },
        { environment: { configured: true, release: null } }
      ),
    /live release SHA/
  );
});

test("release transaction classifies drafts by target and publications by tag", () => {
  const sha = "1111111111111111111111111111111111111111";
  const other = "2222222222222222222222222222222222222222";
  assert.equal(
    classifyReleaseTagState({ tagCommit: null, release: null }, sha),
    "absent"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: sha, release: null }, sha),
    "tag_orphan_correct"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: other, release: null }, sha),
    "tag_wrong_sha"
  );
  assert.equal(
    classifyReleaseTagState(
      {
        tagCommit: null,
        release: {
          isDraft: true,
          tagName: "v1.2.3",
          targetCommitish: sha
        }
      },
      sha
    ),
    "draft_correct"
  );
  assert.equal(
    classifyReleaseTagState(
      {
        tagCommit: null,
        release: {
          isDraft: true,
          tagName: "v1.2.3",
          targetCommitish: other
        }
      },
      sha
    ),
    "draft_wrong_sha"
  );
  assert.equal(
    classifyReleaseTagState(
      {
        tagCommit: sha,
        release: {
          isDraft: false,
          tagName: "v1.2.3",
          targetCommitish: other
        }
      },
      sha
    ),
    "published_correct"
  );
  assert.equal(
    classifyReleaseTagState(
      {
        tagCommit: null,
        release: {
          isDraft: false,
          tagName: "v1.2.3",
          targetCommitish: sha
        }
      },
      sha
    ),
    "published_wrong_sha"
  );
});

test("finalize retries only transient GitHub failures", () => {
  for (const transient of [
    "HTTP 502 Bad Gateway",
    "HTTP 503 Service Unavailable",
    "HTTP 429 Too Many Requests",
    "You have exceeded a secondary rate limit",
    "dial tcp: connection reset by peer",
    "request timed out"
  ]) {
    assert.equal(classifyFinalizeFailure(transient), "transient", transient);
  }
  for (const permanent of [
    "HTTP 403: Resource not accessible by integration",
    "HTTP 401 Bad credentials",
    "HTTP 422 Validation Failed: already_exists",
    "tag creation was rejected by a repository ruleset"
  ]) {
    assert.equal(classifyFinalizeFailure(permanent), "permanent", permanent);
  }
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
    process.env.GITHUB_ACTIONS = "false";
    assert.throws(
      () => requireProductionWorkflowContext("deploy-production.yml"),
      /must run in GitHub Actions/
    );

    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REF = "refs/heads/feature";
    assert.throws(
      () => requireProductionWorkflowContext("deploy-production.yml"),
      /must run from refs\/heads\/main/
    );

    process.env.GITHUB_REF = "refs/heads/main";
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/ci.yml@refs/heads/main";
    assert.throws(
      () => requireProductionWorkflowContext("deploy-production.yml"),
      /must run from deploy-production\.yml/
    );

    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/deploy-production.yml@refs/heads/main";
    assert.doesNotThrow(() =>
      requireProductionWorkflowContext("deploy-production.yml")
    );
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/repair-production-release.yml@refs/heads/main";
    assert.doesNotThrow(() =>
      requireProductionWorkflowContext("repair-production-release.yml")
    );
    // The deploy-context token must not satisfy the rollback workflow guard.
    assert.throws(
      () => requireProductionWorkflowContext("rollback-production.yml"),
      /must run from rollback-production\.yml/
    );
  } finally {
    restore();
  }
});

const DRAFT = {
  tagCommit: null,
  release: {
    isDraft: true,
    tagName: RELEASE.releaseTag,
    targetCommitish: RELEASE.expectedSha
  }
};
const PUBLISHED = {
  tagCommit: RELEASE.expectedSha,
  release: {
    isDraft: false,
    tagName: RELEASE.releaseTag,
    targetCommitish: RELEASE.expectedSha
  }
};

test("draft preparation creates and reconciles an untagged exact-candidate draft", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, release: null }, DRAFT],
    createRelease: [{ status: 0 }]
  });
  await runReleaseDraftPreparation(gateway, RELEASE);
  assert.equal(gateway.calls.createRelease, 1);
  assert.equal(gateway.calls.reconcile, 2);
});

test("draft preparation adopts an orphan tag at the candidate commit", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: RELEASE.expectedSha, release: null }, DRAFT],
    createRelease: [{ status: 0 }]
  });
  await runReleaseDraftPreparation(gateway, RELEASE);
  assert.equal(gateway.calls.createRelease, 1);
});

test("draft preparation treats a lost create response as idempotent success", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, release: null }, DRAFT],
    createRelease: [{ status: 1, stderr: "error: request timed out" }]
  });
  await runReleaseDraftPreparation(gateway, RELEASE);
  assert.equal(gateway.calls.reconcile, 2);
  assert.equal(gateway.calls.createRelease, 1);
});

test("draft preparation re-reconciles when create reports already_exists", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, release: null }, DRAFT],
    createRelease: [
      { status: 1, stderr: "HTTP 422: Validation Failed (already_exists)" }
    ]
  });
  await runReleaseDraftPreparation(gateway, RELEASE);
  assert.equal(gateway.calls.reconcile, 2);
});

test("draft preparation retries a transient reconcile read failure", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      new Error("gh api repos/x/y/releases/tags/v1.2.3 failed: HTTP 503"),
      DRAFT
    ],
    createRelease: []
  });
  await runReleaseDraftPreparation(gateway, RELEASE);
  assert.equal(gateway.calls.reconcile, 2);
  assert.equal(gateway.calls.createRelease, 0);
});

test("draft preparation refuses a draft targeting another candidate", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      {
        tagCommit: null,
        release: {
          isDraft: true,
          tagName: RELEASE.releaseTag,
          targetCommitish: OTHER_SHA
        }
      }
    ]
  });
  await assert.rejects(
    runReleaseDraftPreparation(gateway, RELEASE),
    /not bound to candidate/
  );
  assert.equal(gateway.calls.createRelease, 0);
});

test("draft preparation fails loud on a permanent create failure", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, release: null }],
    createRelease: [
      { status: 1, stderr: "HTTP 403: Resource not accessible by integration" }
    ]
  });
  await assert.rejects(
    runReleaseDraftPreparation(gateway, RELEASE),
    /gh release create failed/
  );
});

test("publication publishes the prepared draft and proves the exact tag", async () => {
  const gateway = scriptedGateway({
    reconcile: [DRAFT, PUBLISHED],
    publishRelease: [{ status: 0 }]
  });
  await runReleasePublication(gateway, RELEASE);
  assert.equal(gateway.calls.publishRelease, 1);
  assert.equal(gateway.calls.reconcile, 2);
});

test("publication reconciles a lost publish response", async () => {
  const gateway = scriptedGateway({
    reconcile: [DRAFT, PUBLISHED],
    publishRelease: [{ status: 1, stderr: "request timed out" }]
  });
  await runReleasePublication(gateway, RELEASE);
  assert.equal(gateway.calls.publishRelease, 1);
});

test("publication is idempotent after the exact release is public", async () => {
  const gateway = scriptedGateway({ reconcile: [PUBLISHED] });
  await runReleasePublication(gateway, RELEASE);
  assert.equal(gateway.calls.publishRelease, 0);
});

test("publication refuses a wrong-candidate draft", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      {
        tagCommit: null,
        release: {
          isDraft: true,
          tagName: RELEASE.releaseTag,
          targetCommitish: OTHER_SHA
        }
      }
    ]
  });
  await assert.rejects(
    runReleasePublication(gateway, RELEASE),
    /not an exact-candidate draft/
  );
});

test("publication fails loud on a permanent provider failure", async () => {
  const gateway = scriptedGateway({
    reconcile: [DRAFT],
    publishRelease: [
      { status: 1, stderr: "HTTP 403: Resource not accessible by integration" }
    ]
  });
  await assert.rejects(
    runReleasePublication(gateway, RELEASE),
    /gh release publish failed/
  );
});

test("publication refuses rollback when a transient publish outcome stays ambiguous", async () => {
  const gateway = scriptedGateway({
    reconcile: [DRAFT],
    publishRelease: [{ status: 1, stderr: "request timed out" }]
  });
  await assert.rejects(
    runReleasePublication(gateway, RELEASE),
    (error) =>
      error instanceof PublicationStateUnknownError &&
      /refusing automatic rollback/.test(error.message)
  );
});
