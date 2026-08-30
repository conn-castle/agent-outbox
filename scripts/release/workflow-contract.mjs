import { deployReleasePhaseOrderMatches } from "./order.mjs";
import { escapeRegExp } from "../regex.mjs";
import {
  workflowHasLine,
  workflowJobContent,
  workflowNamedStepContent,
  workflowRunStepIncludes
} from "../workflow-yaml.mjs";

export const PRODUCTION_DEPLOY_WORKFLOW_PATH =
  ".github/workflows/deploy-production.yml";
export const PRODUCTION_RECONCILE_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-release.yml";
export const ABANDONED_RELEASE_DETECTION_WORKFLOW_PATH =
  ".github/workflows/detect-abandoned-production-release.yml";
export const PRODUCTION_ROLLBACK_WORKFLOW_PATH =
  ".github/workflows/rollback-production.yml";

export const RELEASE_WORKFLOW_PATHS = [
  PRODUCTION_DEPLOY_WORKFLOW_PATH,
  PRODUCTION_RECONCILE_WORKFLOW_PATH,
  ABANDONED_RELEASE_DETECTION_WORKFLOW_PATH,
  PRODUCTION_ROLLBACK_WORKFLOW_PATH
];

const TRAFFIC_ONLY_FORBIDDEN_SECRET_NAMES = [
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAID_MONTHLY_PRICE_ID",
  "STRIPE_PAID_YEARLY_PRICE_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_BROWSER_DSN",
  "SENTRY_RELEASE",
  "CALLER_KEY_HASH_SECRET",
  "CLOUDFLARE_HYPERDRIVE_ID"
];

/** @param {string} stepContent */
function trafficOnlyForbiddenSecretNames(stepContent) {
  return TRAFFIC_ONLY_FORBIDDEN_SECRET_NAMES.filter((name) =>
    stepContent.includes(name)
  );
}

/**
 * @param {string} deployWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionDeployWorkflow(
  deployWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const validateRefJob = workflowJobContent(
    deployWorkflowContent,
    "validate-ref"
  );
  const deployJob = workflowJobContent(deployWorkflowContent, "deploy");
  const buildCliJob = workflowJobContent(deployWorkflowContent, "build-cli");
  const homebrewJob = workflowJobContent(
    deployWorkflowContent,
    "publish-cli-homebrew"
  );
  const uploadWorkerStep = workflowNamedStepContent(
    deployJob,
    "Upload inactive Worker version"
  );
  const stagedDeployStep = workflowNamedStepContent(
    deployJob,
    "Deploy prior@100 and candidate@0"
  );
  const promoteStep = workflowNamedStepContent(
    deployJob,
    "Promote candidate to 100%"
  );
  const captureRollbackStep = workflowNamedStepContent(
    deployJob,
    "Capture healthy rollback target"
  );
  const downloadCertifiedCliStep = workflowNamedStepContent(
    deployJob,
    "Download certified CLI artifacts"
  );
  const prepareDraftStep = workflowNamedStepContent(
    deployJob,
    "Prepare exact-candidate GitHub release draft"
  );
  const uploadCliStep = workflowNamedStepContent(
    deployJob,
    "Upload certified CLI assets to draft"
  );
  const requirePublicRepositoryStep = workflowNamedStepContent(
    deployJob,
    "Require public release repository"
  );
  const tapPreflightTokenStep = workflowNamedStepContent(
    deployJob,
    "Create Homebrew preflight token"
  );
  const tapPreflightAccessStep = workflowNamedStepContent(
    deployJob,
    "Verify Homebrew tap access"
  );
  const publishReleaseStep = workflowNamedStepContent(
    deployJob,
    "Publish exact-candidate GitHub release"
  );
  const requireMigrationCredentialStep = workflowNamedStepContent(
    deployJob,
    "Require production migration credential"
  );
  const migrationStep = workflowNamedStepContent(
    deployJob,
    "Apply production database migrations"
  );
  const preMigrationValidationStep = workflowNamedStepContent(
    deployJob,
    "Validate production migration history before apply"
  );
  const postMigrationValidationStep = workflowNamedStepContent(
    deployJob,
    "Validate production migration history after apply"
  );
  const verifyRollbackTargetStep = workflowNamedStepContent(
    deployJob,
    "Verify rollback target before deploy"
  );
  const overrideSmokeStep = workflowNamedStepContent(
    deployJob,
    "Verify candidate through version override"
  );
  const verifyStep = workflowNamedStepContent(
    deployJob,
    "Verify deployed release"
  );
  const cleanupStep = workflowNamedStepContent(
    deployJob,
    "Reconcile uncommitted release"
  );
  const ensureReleaseTagStep = workflowNamedStepContent(
    buildCliJob,
    "Ensure exact local release tag"
  );
  const buildCliStep = workflowNamedStepContent(
    buildCliJob,
    "Build tagged CLI release artifacts"
  );
  const validateCaskStep = workflowNamedStepContent(
    buildCliJob,
    "Validate generated Homebrew cask"
  );
  const uploadCertifiedCliStep = workflowNamedStepContent(
    buildCliJob,
    "Upload certified CLI artifacts"
  );
  const downloadPublishedCliStep = workflowNamedStepContent(
    homebrewJob,
    "Download certified CLI artifacts"
  );
  const publicAssetsStep = workflowNamedStepContent(
    homebrewJob,
    "Require publicly downloadable release assets"
  );
  const tapTokenStep = workflowNamedStepContent(
    homebrewJob,
    "Create GitHub App token for tap repo"
  );
  const updateCaskStep = workflowNamedStepContent(
    homebrewJob,
    "Update Homebrew cask"
  );
  const tapPullRequestStep = workflowNamedStepContent(
    homebrewJob,
    "Create PR in tap repo"
  );
  /** @type {[string, boolean][]} */
  const requirements = [
    [
      "workflow_dispatch trigger",
      workflowHasLine(deployWorkflowContent, /^\s*workflow_dispatch:\s*$/)
    ],
    [
      "production environment",
      workflowHasLine(deployJob, /^\s*environment:\s*production\s*$/)
    ],
    [
      `Node ${nodeVersion}`,
      workflowHasLine(
        deployJob,
        new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
      )
    ],
    [
      "main-ref validation job",
      workflowHasLine(
        validateRefJob,
        /^\s*run:\s*test "\$GITHUB_REF" = "refs\/heads\/main"\s*$/
      )
    ],
    [
      "certified release flow",
      deployWorkflowContent.includes(
        "uses: ./.github/workflows/release-check.yml"
      ) &&
        deployWorkflowContent.includes(
          "run: node scripts/production-release.mjs prepare"
        ) &&
        workflowHasLine(
          deployJob,
          /^\s*needs:\s*\[prepare-release, certify, build-cli\]\s*$/
        )
    ],
    [
      "pre-deploy CLI artifact certification",
      workflowHasLine(
        buildCliJob,
        /^\s*needs:\s*\[prepare-release, certify\]\s*$/
      ) &&
        ensureReleaseTagStep.includes("git show-ref --verify") &&
        ensureReleaseTagStep.includes(
          'git tag "${RELEASE_TAG}" "${GITHUB_SHA}"'
        ) &&
        workflowRunStepIncludes(
          buildCliStep,
          'make cli-release-dist RELEASE_TAG="${RELEASE_TAG}"'
        ) &&
        validateCaskStep.includes(
          "ruby -c dist/homebrew/Casks/agent-outbox.rb"
        ) &&
        validateCaskStep.includes(
          "brew style dist/homebrew/Casks/agent-outbox.rb"
        ) &&
        uploadCertifiedCliStep.includes("actions/upload-artifact@") &&
        uploadCertifiedCliStep.includes(
          "name: agent-outbox-release-${{ github.sha }}"
        )
    ],
    [
      "production deploy concurrency group",
      workflowHasLine(
        deployWorkflowContent,
        /^\s*group:\s*production-deploy\s*$/
      )
    ],
    ["rollback-target verification step", Boolean(verifyRollbackTargetStep)],
    [
      "production migration credential requirement step",
      Boolean(requireMigrationCredentialStep)
    ]
  ];
  for (const [description, present] of requirements) {
    if (!present) {
      failures.push(
        `.github/workflows/deploy-production.yml must include ${description}`
      );
    }
  }

  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        deployWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/deploy-production.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }

  if (
    uploadWorkerStep.includes("wrangler deploy") ||
    stagedDeployStep.includes("wrangler deploy") ||
    promoteStep.includes("wrangler deploy")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must upload an inactive Worker version through production-release.mjs"
    );
  }
  if (
    !requireMigrationCredentialStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !requireMigrationCredentialStep.includes(
      'if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]'
    ) ||
    !requireMigrationCredentialStep.includes('host="${host##*@}"') ||
    !migrationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !preMigrationValidationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    ) ||
    !postMigrationValidationStep.includes(
      "DATABASE_MIGRATION_URL: ${{ secrets.DATABASE_MIGRATION_URL }}"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must apply and validate production migrations through the protected release job before traffic promotion"
    );
  }
  if (
    !verifyStep.includes("AGENT_OUTBOX_EXPECTED_RELEASE: ${{ github.sha }}") ||
    !verifyStep.includes(
      'AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"'
    ) ||
    !overrideSmokeStep.includes("AGENT_OUTBOX_WORKER_VERSION_OVERRIDE") ||
    verifyStep.includes("AGENT_OUTBOX_WORKER_VERSION_OVERRIDE")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must smoke the candidate through a version override before promotion and without an override after promotion"
    );
  }
  const requireHumanReviewQueryCanary =
    'AGENT_OUTBOX_REQUIRE_HUMAN_REVIEW_QUERY_CANARY: "1"';
  if (verifyRollbackTargetStep.includes(requireHumanReviewQueryCanary)) {
    failures.push(
      ".github/workflows/deploy-production.yml must keep rollback-target smoke compatible with the outgoing release contract"
    );
  }
  if (
    !verifyRollbackTargetStep.includes("AGENT_OUTBOX_EXPECTED_RELEASE:") ||
    !verifyRollbackTargetStep.includes(
      "steps.rollback-target.outputs.rollback_release"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must prove the captured rollback target with smoke-runtime and AGENT_OUTBOX_EXPECTED_RELEASE"
    );
  }
  if (
    !uploadWorkerStep.includes("CLOUDFLARE_HYPERDRIVE_ID") ||
    !uploadWorkerStep.includes("AGENT_OUTBOX_RELEASE_TAG") ||
    !uploadWorkerStep.includes("AGENT_OUTBOX_GITHUB_RELEASE_ID")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply release and Hyperdrive metadata"
    );
  }
  const githubToken = "GH_TOKEN: ${{ github.token }}";
  if (
    !prepareDraftStep.includes(githubToken) ||
    !uploadCliStep.includes(githubToken) ||
    !captureRollbackStep.includes(githubToken) ||
    !uploadWorkerStep.includes(githubToken) ||
    !publishReleaseStep.includes(githubToken) ||
    !cleanupStep.includes(githubToken)
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply GH_TOKEN to GitHub release identity mutations"
    );
  }
  if (
    !/^\s*needs:\s*\[prepare-release, build-cli, deploy\]\s*$/m.test(
      homebrewJob
    ) ||
    !/^\s*contents:\s*read\s*$/m.test(homebrewJob) ||
    !downloadPublishedCliStep.includes("actions/download-artifact@") ||
    !downloadPublishedCliStep.includes(
      "name: agent-outbox-release-${{ github.sha }}"
    ) ||
    !publicAssetsStep.includes("curl -fsSL") ||
    !publicAssetsStep.includes("cmp -s") ||
    !publicAssetsStep.includes(
      "Make conn-castle/agent-outbox public before publishing its Homebrew cask."
    ) ||
    !tapTokenStep.includes("secrets.HOMEBREW_TAP_APP_ID") ||
    !tapTokenStep.includes("secrets.HOMEBREW_TAP_PRIVATE_KEY") ||
    !tapTokenStep.includes("repositories: homebrew-tap") ||
    !updateCaskStep.includes("dist/homebrew/Casks/agent-outbox.rb") ||
    !updateCaskStep.includes("homebrew-tap/Casks/agent-outbox.rb") ||
    !tapPullRequestStep.includes(
      "branch: bump-agent-outbox-${{ env.RELEASE_TAG }}"
    )
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must verify the public CLI release and open the guarded Homebrew cask PR after publication"
    );
  }
  const releasePreparedBeforeDeploy =
    /^\s*contents:\s*write\s*$/m.test(deployJob) &&
    downloadCertifiedCliStep.includes("actions/download-artifact@") &&
    downloadCertifiedCliStep.includes(
      "name: agent-outbox-release-${{ github.sha }}"
    ) &&
    requirePublicRepositoryStep.includes(".visibility") &&
    tapPreflightTokenStep.includes("actions/create-github-app-token@") &&
    tapPreflightTokenStep.includes("secrets.HOMEBREW_TAP_APP_ID") &&
    tapPreflightTokenStep.includes("secrets.HOMEBREW_TAP_PRIVATE_KEY") &&
    tapPreflightAccessStep.includes("repos/conn-castle/homebrew-tap") &&
    captureRollbackStep.includes("AGENT_OUTBOX_GITHUB_RELEASE_ID");
  if (!releasePreparedBeforeDeploy) {
    failures.push(
      ".github/workflows/deploy-production.yml must prepare and byte-verify the exact-candidate draft before production mutation"
    );
  }
  if (!publishReleaseStep.includes("id: publish-release")) {
    failures.push(
      ".github/workflows/deploy-production.yml must publish and prove the exact release only after live verification"
    );
  }
  const cleanupCoversUncommittedRelease =
    cleanupStep.includes("timeout-minutes: 15") &&
    /^\s*timeout-minutes:\s*60\s*$/m.test(deployJob);
  if (!cleanupCoversUncommittedRelease) {
    failures.push(
      ".github/workflows/deploy-production.yml must reconcile uncommitted releases through if: always() cleanup"
    );
  }
  if (
    !uploadWorkerStep.includes("CLERK_SECRET_KEY") ||
    !uploadWorkerStep.includes("STRIPE_SECRET_KEY") ||
    !uploadWorkerStep.includes("SENTRY_DSN") ||
    !uploadWorkerStep.includes("CLOUDFLARE_HYPERDRIVE_ID")
  ) {
    failures.push(
      ".github/workflows/deploy-production.yml must supply Worker runtime secrets only to the version upload step"
    );
  }
  for (const [stepName, stepContent] of [
    ["Deploy prior@100 and candidate@0", stagedDeployStep],
    ["Promote candidate to 100%", promoteStep],
    ["Reconcile uncommitted release", cleanupStep]
  ]) {
    if (!stepContent.includes("CLOUDFLARE_API_TOKEN")) {
      failures.push(
        `.github/workflows/deploy-production.yml ${stepName} must supply CLOUDFLARE_API_TOKEN`
      );
    }
    const forbiddenSecrets = trafficOnlyForbiddenSecretNames(stepContent);
    if (forbiddenSecrets.length > 0) {
      failures.push(
        `.github/workflows/deploy-production.yml ${stepName} must not receive unused Worker runtime secrets (${forbiddenSecrets.join(", ")})`
      );
    }
  }
  if (!cleanupStep.includes("SMOKE_OR_CLEANUP_TOKEN")) {
    failures.push(
      ".github/workflows/deploy-production.yml cleanup must supply SMOKE_OR_CLEANUP_TOKEN to prove restored runtime SHA"
    );
  }
  if (!deployReleasePhaseOrderMatches(deployJob)) {
    failures.push(
      ".github/workflows/deploy-production.yml must match the exported production release phase (step name, run command, condition) contract"
    );
  }
  if (!deployJob.includes("persist-credentials: false")) {
    failures.push(
      ".github/workflows/deploy-production.yml must disable persisted checkout credentials on the production deploy job"
    );
  }

  return failures;
}

/**
 * @param {string} reconcileWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionReconciliationWorkflow(
  reconcileWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const reconcileJob = workflowJobContent(
    reconcileWorkflowContent,
    "reconcile"
  );
  const reconcileStep = workflowNamedStepContent(
    reconcileJob,
    "Reconcile GitHub and Cloudflare transaction state"
  );
  const required = [
    [
      "manual-only trigger",
      workflowHasLine(reconcileWorkflowContent, /^\s*workflow_dispatch:\s*$/)
    ],
    [
      "production serialization",
      workflowHasLine(
        reconcileWorkflowContent,
        /^\s*group:\s*production-deploy\s*$/
      ) &&
        workflowHasLine(
          reconcileWorkflowContent,
          /^\s*cancel-in-progress:\s*false\s*$/
        )
    ],
    [
      "required reconcile input",
      reconcileWorkflowContent.includes("release_tag:")
    ],
    [
      "current main validation",
      reconcileJob.includes('test "$GITHUB_REF" = "refs/heads/main"')
    ],
    [
      "protected reconcile job",
      /^\s*environment:\s*production\s*$/m.test(reconcileJob) &&
        /^\s*contents:\s*write\s*$/m.test(reconcileWorkflowContent)
    ],
    [
      `Node ${nodeVersion}`,
      workflowHasLine(
        reconcileJob,
        new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
      )
    ],
    [
      "shared reconciler",
      reconcileStep.includes("production-release.mjs reconcile") &&
        reconcileStep.includes("GH_TOKEN: ${{ github.token }}")
    ],
    [
      "traffic-only Cloudflare credentials",
      reconcileStep.includes("CLOUDFLARE_API_TOKEN") &&
        reconcileStep.includes("SMOKE_OR_CLEANUP_TOKEN") &&
        trafficOnlyForbiddenSecretNames(reconcileStep).length === 0
    ],
    [
      "disabled checkout credentials",
      reconcileJob.includes("persist-credentials: false")
    ]
  ];
  for (const [description, present] of required) {
    if (!present) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must include ${description}`
      );
    }
  }
  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        reconcileWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }
  for (const forbiddenMutation of [
    "wrangler deploy",
    "migration:migrate",
    "git tag"
  ]) {
    if (reconcileWorkflowContent.includes(forbiddenMutation)) {
      failures.push(
        `.github/workflows/reconcile-production-release.yml must not run ${forbiddenMutation}`
      );
    }
  }
  return failures;
}

/**
 * @param {string} detectWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateAbandonedReleaseDetectionWorkflow(
  detectWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const detectJob = workflowJobContent(detectWorkflowContent, "detect");
  const detectStep = workflowNamedStepContent(
    detectJob,
    "Detect abandoned release drafts"
  );
  if (
    !workflowHasLine(detectWorkflowContent, /^\s*schedule:\s*$/) ||
    !workflowHasLine(detectWorkflowContent, /^\s*workflow_dispatch:\s*$/) ||
    !detectStep.includes("production-release.mjs detect-abandoned") ||
    !detectStep.includes("GH_TOKEN: ${{ github.token }}") ||
    !workflowHasLine(
      detectJob,
      new RegExp(`^\\s*node-version:\\s*${escapeRegExp(nodeVersion)}\\s*$`)
    ) ||
    !workflowHasLine(detectWorkflowContent, /^\s*actions:\s*read\s*$/) ||
    !detectJob.includes("persist-credentials: false")
  ) {
    failures.push(
      ".github/workflows/detect-abandoned-production-release.yml must detect abandoned drafts on a schedule without mutating production"
    );
  }
  if (
    detectWorkflowContent.includes("production-deploy") ||
    detectWorkflowContent.includes("environment: production") ||
    detectWorkflowContent.includes("wrangler") ||
    detectWorkflowContent.includes("migration:migrate")
  ) {
    failures.push(
      ".github/workflows/detect-abandoned-production-release.yml must stay read-only and outside production-deploy concurrency"
    );
  }
  return failures;
}

/**
 * @param {string} rollbackWorkflowContent
 * @param {string} nodeVersion
 * @returns {string[]}
 */
export function validateProductionRollbackWorkflow(
  rollbackWorkflowContent,
  nodeVersion
) {
  const failures = [];
  const validateJob = workflowJobContent(
    rollbackWorkflowContent,
    "validate-target"
  );
  const rollbackJob = workflowJobContent(rollbackWorkflowContent, "rollback");
  const requiredTokens = [
    "workflow_dispatch:",
    "environment: production",
    `node-version: ${nodeVersion}`,
    'run: test "$GITHUB_REF" = "refs/heads/main"',
    "group: production-deploy",
    "node scripts/production-release.mjs verify-rollback-version",
    "corepack pnpm exec wrangler rollback",
    "needs.validate-target.outputs.expected_release",
    "corepack pnpm run smoke-runtime"
  ];
  if (
    !requiredTokens.every((token) => rollbackWorkflowContent.includes(token)) ||
    validateJob === "" ||
    rollbackJob === ""
  ) {
    failures.push(
      ".github/workflows/rollback-production.yml must restore and verify a tagged release"
    );
  }
  for (const forbiddenTrigger of ["push", "pull_request", "schedule"]) {
    if (
      workflowHasLine(
        rollbackWorkflowContent,
        new RegExp(`^\\s*${escapeRegExp(forbiddenTrigger)}:\\s*$`)
      )
    ) {
      failures.push(
        `.github/workflows/rollback-production.yml must be manual-only and not include ${forbiddenTrigger}:`
      );
    }
  }
  return failures;
}
