import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFinalizeFailure,
  classifyReleaseTagState,
  releaseMetadata,
  requireProductionWorkflowContext,
  runReleaseFinalization,
  selectRollbackTarget,
  validateWorkerVersionReleaseTag
} from "../scripts/production-release.mjs";

const RELEASE = {
  repository: "conn-castle/agent-outbox",
  releaseTag: "v1.2.3",
  expectedSha: "1111111111111111111111111111111111111111"
};
const OTHER_SHA = "2222222222222222222222222222222222222222";

/**
 * Scripted release gateway: each method returns (or throws, for Error items) the
 * next value from its queue, clamping to the last entry so a queue of length 1
 * answers every call. `sleep` is a no-op so retry tests run instantly.
 *
 * @param {object} script
 * @param {Array<{ tagCommit: string | null, releaseExists: boolean } | Error>} [script.reconcile]
 * @param {Array<{ status: number, stderr?: string, error?: Error } | Error>} [script.createRelease]
 * @param {Array<string | null | Error>} [script.tagCommit]
 */
function scriptedGateway({
  reconcile = [],
  createRelease = [],
  tagCommit = []
}) {
  const calls = { reconcile: 0, createRelease: 0, tagCommit: 0, sleep: 0 };
  /**
   * @param {"reconcile" | "createRelease" | "tagCommit"} name
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
    tagCommit: () => take("tagCommit", tagCommit),
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

test("finalize classifies release/tag state against the candidate commit", () => {
  const sha = "1111111111111111111111111111111111111111";
  const other = "2222222222222222222222222222222222222222";
  assert.equal(
    classifyReleaseTagState({ tagCommit: null, releaseExists: false }, sha),
    "absent"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: sha, releaseExists: false }, sha),
    "tag_orphan_correct"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: other, releaseExists: false }, sha),
    "tag_wrong_sha"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: sha, releaseExists: true }, sha),
    "released_correct"
  );
  assert.equal(
    classifyReleaseTagState({ tagCommit: other, releaseExists: true }, sha),
    "released_wrong_sha"
  );
  // A published release whose tag cannot be resolved must never read as correct;
  // finalize must refuse it rather than claim idempotent success.
  assert.equal(
    classifyReleaseTagState({ tagCommit: null, releaseExists: true }, sha),
    "released_wrong_sha"
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
    // The deploy-context token must not satisfy the rollback workflow guard.
    assert.throws(
      () => requireProductionWorkflowContext("rollback-production.yml"),
      /must run from rollback-production\.yml/
    );
  } finally {
    restore();
  }
});

test("finalize creates and verifies a release when none exists", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, releaseExists: false }],
    createRelease: [{ status: 0 }],
    tagCommit: [RELEASE.expectedSha]
  });
  await runReleaseFinalization(gateway, RELEASE);
  assert.equal(gateway.calls.createRelease, 1);
});

test("finalize adopts an orphan tag left at the candidate commit", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: RELEASE.expectedSha, releaseExists: false }],
    createRelease: [{ status: 0 }],
    tagCommit: [RELEASE.expectedSha]
  });
  await runReleaseFinalization(gateway, RELEASE);
  assert.equal(gateway.calls.createRelease, 1);
});

test("finalize treats a lost-response transient create as idempotent success", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      { tagCommit: null, releaseExists: false },
      { tagCommit: RELEASE.expectedSha, releaseExists: true }
    ],
    createRelease: [{ status: 1, stderr: "error: request timed out" }],
    tagCommit: []
  });
  await runReleaseFinalization(gateway, RELEASE);
  // The second reconcile finds the release the lost-response create actually made.
  assert.equal(gateway.calls.reconcile, 2);
  assert.equal(gateway.calls.createRelease, 1);
});

test("finalize re-reconciles instead of failing when create reports already_exists", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      { tagCommit: null, releaseExists: false },
      { tagCommit: RELEASE.expectedSha, releaseExists: true }
    ],
    createRelease: [
      { status: 1, stderr: "HTTP 422: Validation Failed (already_exists)" }
    ],
    tagCommit: []
  });
  await runReleaseFinalization(gateway, RELEASE);
  assert.equal(gateway.calls.reconcile, 2);
});

test("finalize retries a transient reconcile read failure", async () => {
  const gateway = scriptedGateway({
    reconcile: [
      new Error("gh api repos/x/y/releases/tags/v1.2.3 failed: HTTP 503"),
      { tagCommit: null, releaseExists: false }
    ],
    createRelease: [{ status: 0 }],
    tagCommit: [RELEASE.expectedSha]
  });
  await runReleaseFinalization(gateway, RELEASE);
  assert.equal(gateway.calls.reconcile, 2);
  assert.equal(gateway.calls.createRelease, 1);
});

test("finalize tolerates read-after-write lag on the finalized tag", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, releaseExists: false }],
    createRelease: [{ status: 0 }],
    tagCommit: [null, RELEASE.expectedSha]
  });
  await runReleaseFinalization(gateway, RELEASE);
  assert.equal(gateway.calls.tagCommit, 2);
});

test("finalize refuses to publish when the created tag resolves to a different commit", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, releaseExists: false }],
    createRelease: [{ status: 0 }],
    tagCommit: [OTHER_SHA]
  });
  await assert.rejects(
    runReleaseFinalization(gateway, RELEASE),
    /resolved to 2222.*expected 1111/
  );
});

test("finalize refuses to reuse a release number that already points at another commit", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: OTHER_SHA, releaseExists: true }],
    createRelease: [],
    tagCommit: []
  });
  await assert.rejects(
    runReleaseFinalization(gateway, RELEASE),
    /refusing to reuse the release number/
  );
  assert.equal(gateway.calls.createRelease, 0);
});

test("finalize fails loud on a permanent create failure", async () => {
  const gateway = scriptedGateway({
    reconcile: [{ tagCommit: null, releaseExists: false }],
    createRelease: [
      { status: 1, stderr: "HTTP 403: Resource not accessible by integration" }
    ],
    tagCommit: []
  });
  await assert.rejects(
    runReleaseFinalization(gateway, RELEASE),
    /gh release create failed/
  );
});
