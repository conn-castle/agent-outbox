import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertNoForbiddenWorkflowCommands,
  validateAbandonedReleaseDetectionWorkflow,
  validateProductionDeployWorkflow,
  validateProductionReconciliationWorkflow,
  validateProductionRollbackWorkflow
} from "../scripts/foundation.mjs";

test("workflow guard rejects deploy and publish commands", () => {
  const failures = assertNoForbiddenWorkflowCommands({
    ".github/workflows/release-check.yml":
      "run: wrangler deploy\nrun: supabase migration up --linked"
  });

  assert.deepEqual(failures, [
    ".github/workflows/release-check.yml contains forbidden command: wrangler deploy",
    ".github/workflows/release-check.yml contains forbidden command: supabase migration"
  ]);
  assert.deepEqual(
    assertNoForbiddenWorkflowCommands({
      ".github/workflows/deploy-production.yml":
        "run: gh release create v1.0.0",
      ".github/workflows/reconcile-production-release.yml":
        "run: gh release create v1.0.0"
    }),
    [
      ".github/workflows/deploy-production.yml contains forbidden command: gh release create",
      ".github/workflows/reconcile-production-release.yml contains forbidden command: gh release create"
    ]
  );
});

test("production deploy workflow guard accepts only the manual deploy contract", () => {
  const deployWorkflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8"
  );
  const rollbackWorkflow = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8"
  );
  const reconcileWorkflow = readFileSync(
    new URL(
      "../.github/workflows/reconcile-production-release.yml",
      import.meta.url
    ),
    "utf8"
  );
  const detectWorkflow = readFileSync(
    new URL(
      "../.github/workflows/detect-abandoned-production-release.yml",
      import.meta.url
    ),
    "utf8"
  );

  assert.deepEqual(
    assertNoForbiddenWorkflowCommands({
      ".github/workflows/deploy-production.yml": deployWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateProductionDeployWorkflow(deployWorkflow, "24.18.0"),
    []
  );
  assert.deepEqual(
    validateProductionRollbackWorkflow(rollbackWorkflow, "24.18.0"),
    []
  );
  assert.deepEqual(
    assertNoForbiddenWorkflowCommands({
      ".github/workflows/reconcile-production-release.yml": reconcileWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateProductionReconciliationWorkflow(reconcileWorkflow, "24.18.0"),
    []
  );
  assert.deepEqual(
    validateAbandonedReleaseDetectionWorkflow(detectWorkflow, "24.18.0"),
    []
  );
  const deployWithoutPersist = deployWorkflow.replaceAll(
    "          persist-credentials: false\n",
    ""
  );
  assert.notEqual(deployWithoutPersist, deployWorkflow);
  assert.ok(
    validateProductionDeployWorkflow(deployWithoutPersist, "24.18.0").some(
      (failure) => failure.includes("persisted checkout credentials")
    )
  );
  const verifyPinnedToCandidate = deployWorkflow.replace(
    `      - name: Verify deployed release
        if: steps.prepare-draft.outputs.draft_state != 'committed'
        env:
          AGENT_OUTBOX_EXPECTED_RELEASE: \${{ github.sha }}
          AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"
          APP_BASE_URL: https://app.agent-outbox.dev
          SMOKE_OR_CLEANUP_TOKEN: \${{ secrets.SMOKE_OR_CLEANUP_TOKEN }}
        run: corepack pnpm run smoke-runtime`,
    `      - name: Verify deployed release
        if: steps.prepare-draft.outputs.draft_state != 'committed'
        env:
          AGENT_OUTBOX_EXPECTED_RELEASE: \${{ github.sha }}
          AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"
          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"
          AGENT_OUTBOX_WORKER_VERSION_OVERRIDE: "pinned"
          APP_BASE_URL: https://app.agent-outbox.dev
          SMOKE_OR_CLEANUP_TOKEN: \${{ secrets.SMOKE_OR_CLEANUP_TOKEN }}
        run: corepack pnpm run smoke-runtime`
  );
  assert.notEqual(verifyPinnedToCandidate, deployWorkflow);
  assert.ok(
    validateProductionDeployWorkflow(verifyPinnedToCandidate, "24.18.0").some(
      (failure) => failure.includes("without an override after promotion")
    )
  );

  for (const [description, brokenWorkflow] of [
    [
      "unprotected",
      reconcileWorkflow.replace("    environment: production\n", "")
    ],
    [
      "scheduled mutation",
      `on:\n  schedule:\n    - cron: "0 * * * *"\n${reconcileWorkflow}`
    ],
    [
      "direct wrangler deploy",
      reconcileWorkflow.replace(
        "run: node scripts/production-release.mjs reconcile",
        "run: wrangler deploy"
      )
    ],
    [
      "missing GitHub token",
      reconcileWorkflow.replace("          GH_TOKEN: ${{ github.token }}\n", "")
    ]
  ]) {
    assert.notEqual(brokenWorkflow, reconcileWorkflow, description);
    assert.notDeepEqual(
      validateProductionReconciliationWorkflow(brokenWorkflow, "24.18.0"),
      [],
      description
    );
  }
  const detectorInProductionConcurrency = detectWorkflow.replace(
    "permissions:\n  contents: read\n",
    "concurrency:\n  group: production-deploy\npermissions:\n  contents: read\n"
  );
  assert.notDeepEqual(
    validateAbandonedReleaseDetectionWorkflow(
      detectorInProductionConcurrency,
      "24.18.0"
    ),
    []
  );
  const detectorWithoutGithubToken = detectWorkflow.replace(
    "          GH_TOKEN: ${{ github.token }}\n",
    ""
  );
  assert.notEqual(detectorWithoutGithubToken, detectWorkflow);
  assert.notDeepEqual(
    validateAbandonedReleaseDetectionWorkflow(
      detectorWithoutGithubToken,
      "24.18.0"
    ),
    []
  );
  const detectorWithoutActionsRead = detectWorkflow.replace(
    "  actions: read\n",
    ""
  );
  assert.notEqual(detectorWithoutActionsRead, detectWorkflow);
  assert.notDeepEqual(
    validateAbandonedReleaseDetectionWorkflow(
      detectorWithoutActionsRead,
      "24.18.0"
    ),
    []
  );
  const releaseCheckWorkflow = readFileSync(
    new URL("../.github/workflows/release-check.yml", import.meta.url),
    "utf8"
  );
  assert.match(
    releaseCheckWorkflow,
    /^  workflow_call:$/m,
    "production certification must call the exact release-check workflow"
  );
  assert.equal(
    /tags:\s*\n\s*-\s*"v\*"/.test(releaseCheckWorkflow),
    false,
    "release-check must not use a redundant tag-push trigger"
  );

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(
    packageJson.scripts["worker:dry-run"],
    /^corepack pnpm run worker:build && /,
    "production dry-run must not depend on a globally available pnpm shim"
  );

  const openNextConfig = readFileSync(
    new URL("../open-next.config.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    openNextConfig,
    /config\.buildCommand = "corepack pnpm run next:build";/,
    "OpenNext build must not depend on a globally available pnpm shim"
  );

  const withoutCleanup = deployWorkflow.replace(
    /      - name: Reconcile uncommitted release[\s\S]*?(?=\n  publish-cli-homebrew:)/,
    ""
  );
  assert.notEqual(
    withoutCleanup,
    deployWorkflow,
    "reconciliation cleanup regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(withoutCleanup, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must reconcile uncommitted releases through if: always() cleanup"
    ),
    true,
    "uncommitted releases must be reconciled through if: always() cleanup"
  );

  const cleanupWithoutAlways = deployWorkflow.replace(
    "        if: always()\n",
    "        if: failure()\n"
  );
  assert.notEqual(
    cleanupWithoutAlways,
    deployWorkflow,
    "cleanup-always regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(cleanupWithoutAlways, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    ),
    true,
    "cancellation recovery must use if: always() reconciliation"
  );

  const withoutProductionMigrations = deployWorkflow.replace(
    /      - name: Apply production database migrations[\s\S]*?(?=\n      - name: Validate production migration history after apply)/,
    ""
  );
  assert.notEqual(
    withoutProductionMigrations,
    deployWorkflow,
    "production-migration regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutProductionMigrations,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before traffic promotion"
    ),
    true,
    "production migrations must remain inside the protected release sequence"
  );

  const withoutPostDeployHumanQueryProof = deployWorkflow.replace(
    /      - name: Verify deployed release[\s\S]*?AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"\n/,
    "      - name: Verify deployed release\n        env:\n"
  );
  assert.notEqual(
    withoutPostDeployHumanQueryProof,
    deployWorkflow,
    "post-deploy human-query regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutPostDeployHumanQueryProof,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must smoke the candidate through a version override before promotion and without an override after promotion"
    ),
    true,
    "the candidate release must prove the deployed human review query"
  );

  const nMinusOneIncompatibleSmoke = deployWorkflow.replace(
    '          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"',
    '          AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"\n' +
      '          AGENT_OUTBOX_RUNTIME_SMOKE_USE_PROCESS_ENV: "1"'
  );
  assert.notEqual(
    nMinusOneIncompatibleSmoke,
    deployWorkflow,
    "N-1 smoke regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      nMinusOneIncompatibleSmoke,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must keep rollback-target smoke compatible with the outgoing release contract"
    ),
    true,
    "rollback-target smoke must tolerate fields absent from the outgoing release"
  );

  const firstAtHostMask = deployWorkflow.replace(
    'host="${host##*@}"',
    'host="${host#*@}"'
  );
  assert.notEqual(
    firstAtHostMask,
    deployWorkflow,
    "migration-host-mask regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(firstAtHostMask, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before traffic promotion"
    ),
    true,
    "migration host masking must follow URL parsing through the final at-sign"
  );

  for (const stepName of [
    "Prepare exact-candidate GitHub release draft",
    "Upload certified CLI assets to draft",
    "Require public release repository",
    "Create Homebrew preflight token",
    "Verify Homebrew tap access",
    "Verify rollback target before deploy",
    "Require production migration credential",
    "Compare Worker routes and cron triggers",
    "Upload inactive Worker version",
    "Deploy prior@100 and candidate@0",
    "Verify candidate through version override",
    "Promote candidate to 100%",
    "Publish exact-candidate GitHub release",
    "Require publicly downloadable release assets"
  ]) {
    const withoutRequiredStep = deployWorkflow.replace(
      new RegExp(`      - name: ${stepName}[\\s\\S]*?(?=\\n      - name:)`),
      ""
    );
    assert.notEqual(
      withoutRequiredStep,
      deployWorkflow,
      `${stepName} regression fixture must modify the workflow`
    );
    assert.notDeepEqual(
      validateProductionDeployWorkflow(withoutRequiredStep, "24.18.0"),
      [],
      `${stepName} must remain required by the production workflow guard`
    );
  }

  const withoutHomebrewPublication = deployWorkflow.replace(
    /\n  publish-cli-homebrew:[\s\S]*$/,
    ""
  );
  assert.notEqual(
    withoutHomebrewPublication,
    deployWorkflow,
    "Homebrew-publication regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutHomebrewPublication,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must verify the public CLI release and open the guarded Homebrew cask PR after publication"
    ),
    true,
    "numbered releases must retain CLI asset and Homebrew cask publication"
  );

  const withoutPreDeployCliCertification = deployWorkflow.replace(
    /\n  build-cli:[\s\S]*?(?=\n  deploy:)/,
    ""
  );
  assert.notEqual(
    withoutPreDeployCliCertification,
    deployWorkflow,
    "pre-deploy CLI certification regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutPreDeployCliCertification,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must include pre-deploy CLI artifact certification"
    ),
    true,
    "CLI packaging and Homebrew validation must complete before production deploy"
  );

  const withoutAssetUpload = deployWorkflow.replace(
    "node scripts/production-release.mjs upload-assets",
    "node scripts/production-release.mjs prepare-draft"
  );
  assert.notEqual(
    withoutAssetUpload,
    deployWorkflow,
    "CLI asset upload regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(withoutAssetUpload, "24.18.0").includes(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    ),
    true,
    "certified CLI assets must be uploaded and verified before production mutation"
  );

  const withoutUploadWorkerGithubToken = deployWorkflow.replace(
    "          GH_TOKEN: ${{ github.token }}\n          AGENT_OUTBOX_GITHUB_RELEASE_ID:\n            ${{ steps.prepare-draft.outputs.github_release_id }}\n          AGENT_OUTBOX_RELEASE_TAG:\n",
    "          AGENT_OUTBOX_GITHUB_RELEASE_ID:\n            ${{ steps.prepare-draft.outputs.github_release_id }}\n          AGENT_OUTBOX_RELEASE_TAG:\n"
  );
  assert.notEqual(
    withoutUploadWorkerGithubToken,
    deployWorkflow,
    "upload-worker GH_TOKEN regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutUploadWorkerGithubToken,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must supply GH_TOKEN to GitHub release identity mutations"
    ),
    true,
    "inactive Worker upload must receive GH_TOKEN to persist owned draft identities"
  );

  const rollbackTargetEchoSkip = deployWorkflow.replace(
    /(      - name: Verify rollback target before deploy[\s\S]*?)run: corepack pnpm run smoke-runtime/,
    "$1run: echo skip"
  );
  assert.notEqual(
    rollbackTargetEchoSkip,
    deployWorkflow,
    "rollback-target smoke-command regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      rollbackTargetEchoSkip,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must prove the captured rollback target with smoke-runtime and AGENT_OUTBOX_EXPECTED_RELEASE"
    ),
    true,
    "rollback-target verification must run smoke-runtime"
  );

  const withoutRollbackExpectedRelease = deployWorkflow.replace(
    /          AGENT_OUTBOX_EXPECTED_RELEASE:\n            \$\{\{ steps.rollback-target.outputs.rollback_release \}\}\n/,
    ""
  );
  assert.notEqual(
    withoutRollbackExpectedRelease,
    deployWorkflow,
    "rollback-target expected-release regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      withoutRollbackExpectedRelease,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must prove the captured rollback target with smoke-runtime and AGENT_OUTBOX_EXPECTED_RELEASE"
    ),
    true,
    "rollback-target smoke must pin AGENT_OUTBOX_EXPECTED_RELEASE to the captured rollback SHA"
  );

  const captureRollbackEchoSkip = deployWorkflow.replace(
    "        run: node scripts/production-release.mjs capture-rollback",
    "        run: echo skip"
  );
  assert.notEqual(
    captureRollbackEchoSkip,
    deployWorkflow,
    "capture-rollback command regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      captureRollbackEchoSkip,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    ),
    true,
    "deploy-job run commands must match the exported release phase contract"
  );

  const promoteWithoutCandidateGuard = deployWorkflow.replace(
    "      - name: Promote candidate to 100%\n        if: steps.prepare-draft.outputs.draft_state != 'committed'\n",
    "      - name: Promote candidate to 100%\n"
  );
  assert.notEqual(
    promoteWithoutCandidateGuard,
    deployWorkflow,
    "candidate-guard regression fixture must modify the workflow"
  );
  assert.equal(
    validateProductionDeployWorkflow(
      promoteWithoutCandidateGuard,
      "24.18.0"
    ).includes(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    ),
    true,
    "candidate mutation steps must keep the uncommitted draft_state guard"
  );
});

test("production deploy workflow guard rejects automatic and incomplete deploy workflows", () => {
  const unsafeWorkflow = `
    on:
      workflow_dispatch:
      push:
        branches: [main]
    jobs:
      deploy:
        environment: staging
        steps:
          - uses: actions/setup-node@v6
            with:
              node-version: 25.0.0
          - run: pnpm run worker:deploy
  `;

  const failures = validateProductionDeployWorkflow(unsafeWorkflow, "24.18.0");
  assert.equal(
    failures.includes(
      ".github/workflows/deploy-production.yml must be manual-only and not include push:"
    ),
    true
  );
  assert.equal(
    failures.includes(
      ".github/workflows/deploy-production.yml must include certified release flow"
    ),
    true
  );
});
