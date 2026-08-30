/**
 * Single authority for the production deploy-job release sequence. The
 * workflow validator and behavioral ordering tests both consume this list.
 * It matches the shipping YAML, including rollback-target smoke, trigger
 * drift, identity persistence inside capture/upload, migrations, staged
 * deploy, override smoke, promotion, final smoke, publication, and the
 * always-run reconciler. This module is not an executable transaction.
 *
 * Each entry is the contract for step name, exact normalized run command,
 * and `if:` condition (`null` means the step has no condition).
 *
 * @typedef {{
 *   id: string,
 *   stepName: string,
 *   command: string,
 *   condition: string | null
 * }} ProductionDeployReleasePhase
 *
 * @typedef {import("../workflow-yaml.mjs").WorkflowStepTuple} ProductionDeployReleasePhaseTuple
 */

import {
  normalizeRunCommand,
  parseWorkflowStepTuple,
  workflowStepBlocks
} from "../workflow-yaml.mjs";

const CANDIDATE_UNCOMMITTED_CONDITION =
  "steps.prepare-draft.outputs.draft_state != 'committed'";

const REQUIRE_MIGRATION_CREDENTIAL_COMMAND = [
  'if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then',
  'echo "DATABASE_MIGRATION_URL is required in the production GitHub environment secrets." >&2',
  "exit 1",
  "fi",
  'host="${DATABASE_MIGRATION_URL#*://}"',
  'host="${host##*@}"',
  'host="${host%%[:/?]*}"',
  'if [[ -z "$host" ]]; then',
  'echo "DATABASE_MIGRATION_URL has no parseable host; refusing to run migrations unmasked." >&2',
  "exit 1",
  "fi",
  'echo "::add-mask::$host"'
].join("\n");

/** YAML-only credential/pre/post validation and always-run cleanup. */
const NON_BEHAVIORAL_RELEASE_PHASE_IDS = new Set([
  "require-migration-credential",
  "validate-migrations-pre",
  "validate-migrations-post",
  "reconcile"
]);

export { normalizeRunCommand };

/** @type {ProductionDeployReleasePhase[]} */
export const PRODUCTION_DEPLOY_RELEASE_PHASES = [
  {
    id: "prepare-draft",
    stepName: "Prepare exact-candidate GitHub release draft",
    command: "node scripts/production-release.mjs prepare-draft",
    condition: null
  },
  {
    id: "upload-assets",
    stepName: "Upload certified CLI assets to draft",
    command: "node scripts/production-release.mjs upload-assets",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "capture-rollback",
    stepName: "Capture healthy rollback target",
    command: "node scripts/production-release.mjs capture-rollback",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "rollback-target-smoke",
    stepName: "Verify rollback target before deploy",
    command: "corepack pnpm run smoke-runtime",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "compare-triggers",
    stepName: "Compare Worker routes and cron triggers",
    command: "node scripts/production-release.mjs compare-triggers",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "upload-worker",
    stepName: "Upload inactive Worker version",
    command: "node scripts/production-release.mjs upload-worker",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "require-migration-credential",
    stepName: "Require production migration credential",
    command: REQUIRE_MIGRATION_CREDENTIAL_COMMAND,
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "validate-migrations-pre",
    stepName: "Validate production migration history before apply",
    command: "corepack pnpm run migration:validate-pre-migrate",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "migrate",
    stepName: "Apply production database migrations",
    command: "corepack pnpm run migration:migrate",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "validate-migrations-post",
    stepName: "Validate production migration history after apply",
    command: "corepack pnpm run migration:validate",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "deploy-staged",
    stepName: "Deploy prior@100 and candidate@0",
    command: "node scripts/production-release.mjs deploy-staged",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "override-smoke",
    stepName: "Verify candidate through version override",
    command: "corepack pnpm run smoke-runtime",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "promote",
    stepName: "Promote candidate to 100%",
    command: "node scripts/production-release.mjs promote",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "production-smoke",
    stepName: "Verify deployed release",
    command: "corepack pnpm run smoke-runtime",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "publish",
    stepName: "Publish exact-candidate GitHub release",
    command: "node scripts/production-release.mjs publish",
    condition: CANDIDATE_UNCOMMITTED_CONDITION
  },
  {
    id: "reconcile",
    stepName: "Reconcile uncommitted release",
    command: "node scripts/production-release.mjs reconcile",
    condition: "always()"
  }
];

export const PRODUCTION_DEPLOY_RELEASE_STEP_NAMES =
  PRODUCTION_DEPLOY_RELEASE_PHASES.map((phase) => phase.stepName);

/**
 * Behavioral phase ids that ordering tests invoke, in the same relative
 * order as the shipping workflow. YAML-only credential/pre/post validation
 * and always-run cleanup are omitted; the injected `migrate` hook stands in
 * for the YAML migrate step.
 */
export const BEHAVIORAL_RELEASE_PHASE_IDS =
  PRODUCTION_DEPLOY_RELEASE_PHASES.map((phase) => phase.id).filter(
    (id) => !NON_BEHAVIORAL_RELEASE_PHASE_IDS.has(id)
  );

/**
 * @returns {ProductionDeployReleasePhaseTuple[]}
 */
export function expectedReleasePhaseTuples() {
  return PRODUCTION_DEPLOY_RELEASE_PHASES.map((phase) => ({
    stepName: phase.stepName,
    command: normalizeRunCommand(phase.command),
    condition: phase.condition
  }));
}

/**
 * @param {string} deployJobContent
 * @returns {ProductionDeployReleasePhaseTuple[]}
 */
export function deployJobReleasePhaseTuples(deployJobContent) {
  const expected = new Set(PRODUCTION_DEPLOY_RELEASE_STEP_NAMES);
  return workflowStepBlocks(deployJobContent)
    .map((block) => parseWorkflowStepTuple(block))
    .filter((parsed) => expected.has(parsed.stepName));
}

/**
 * @param {ProductionDeployReleasePhaseTuple} actual
 * @param {ProductionDeployReleasePhaseTuple} expected
 * @returns {boolean}
 */
function tuplesEqual(actual, expected) {
  return (
    actual.stepName === expected.stepName &&
    actual.command === expected.command &&
    actual.condition === expected.condition
  );
}

/**
 * @param {string} deployJobContent
 * @returns {boolean}
 */
export function deployReleasePhaseOrderMatches(deployJobContent) {
  const actual = deployJobReleasePhaseTuples(deployJobContent);
  const expected = expectedReleasePhaseTuples();
  return (
    actual.length === expected.length &&
    actual.every((tuple, index) => tuplesEqual(tuple, expected[index]))
  );
}
