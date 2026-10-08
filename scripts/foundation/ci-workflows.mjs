import {
  workflowJobContent,
  workflowMappingBlockContent,
  workflowNamedStepContent,
  workflowRunStepIncludes,
  workflowStepBlocks
} from "../workflow-yaml.mjs";

/** @typedef {import("./toolchain.mjs").PackageJson} PackageJson */
/** @typedef {import("./toolchain.mjs").Toolchain} Toolchain */

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const POLICY_GATES_WORKFLOW_PATH = ".github/workflows/policy-gates.yml";
export const CI_WORKFLOW_PATHS = [CI_WORKFLOW_PATH, POLICY_GATES_WORKFLOW_PATH];

const FORBIDDEN_WORKFLOW_TOKENS = [
  "wrangler deploy",
  "npm publish",
  "pnpm publish",
  "gh release create",
  "stripe trigger",
  "stripe fixtures",
  "supabase db push",
  "supabase db reset",
  "supabase migration"
];

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function assertNoForbiddenWorkflowCommands(workflowContentsByPath) {
  const failures = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    for (const token of FORBIDDEN_WORKFLOW_TOKENS) {
      if (content.includes(token)) {
        failures.push(`${workflowPath} contains forbidden command: ${token}`);
      }
    }
  }

  return failures;
}

/**
 * @param {Toolchain} toolchain
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowVersionPins(toolchain, workflowContentsByPath) {
  const errors = [];

  for (const [workflowPath, content] of Object.entries(
    workflowContentsByPath
  )) {
    const nodeVersions = [
      ...content.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)
    ].map((match) => match[1]);
    for (const version of nodeVersions) {
      if (version !== toolchain.node.version) {
        errors.push(
          `${workflowPath} node-version ${version} must match toolchain.json ${toolchain.node.version}`
        );
      }
    }
  }

  return errors;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateMigrationReplayWorkflow(workflowContentsByPath) {
  const failures = [];

  const workflowPath = CI_WORKFLOW_PATH;
  const content = workflowContentsByPath[workflowPath] ?? "";
  const migrationReplayJob = workflowJobContent(content, "migration-replay");
  const services = workflowMappingBlockContent(
    migrationReplayJob,
    "services",
    4
  );
  const postgresService = workflowMappingBlockContent(services, "postgres", 6);
  const migrationStep = workflowNamedStepContent(
    migrationReplayJob,
    "Replay migrations from scratch"
  );
  const databaseStep = workflowNamedStepContent(
    migrationReplayJob,
    "Run database verification suite"
  );
  const jobEnvironment = workflowMappingBlockContent(
    migrationReplayJob,
    "env",
    4
  );
  const databaseEnvironment = workflowMappingBlockContent(
    databaseStep,
    "env",
    8
  );
  /** @param {RegExp} pattern */
  const hasJobEnvironment = (pattern) => pattern.test(jobEnvironment);
  /** @param {RegExp} pattern */
  const hasStepEnvironment = (pattern) => pattern.test(databaseEnvironment);
  const requirements = [
    ["a migration-replay job", migrationReplayJob !== ""],
    [
      "a Postgres 17 service in the migration-replay job",
      /^        image:\s*postgres:17\s*$/m.test(postgresService)
    ],
    [
      "make migration-replay in the named replay step",
      workflowRunStepIncludes(migrationStep, "make migration-replay")
    ],
    [
      "make test-database in the named database verification step",
      workflowRunStepIncludes(databaseStep, "make test-database")
    ],
    [
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification",
      hasJobEnvironment(
        /^      AGENT_OUTBOX_ENABLE_DATABASE_TESTS:\s*["']?1["']?\s*$/m
      ) ||
        hasStepEnvironment(
          /^          AGENT_OUTBOX_ENABLE_DATABASE_TESTS:\s*["']?1["']?\s*$/m
        )
    ],
    [
      "DATABASE_MIGRATION_URL for database verification",
      hasJobEnvironment(/^      DATABASE_MIGRATION_URL:\s*\S+\s*$/m) ||
        hasStepEnvironment(/^          DATABASE_MIGRATION_URL:\s*\S+\s*$/m)
    ],
    [
      "FLYWAY_DOCKER_NETWORK=host in the migration-replay job",
      /^      FLYWAY_DOCKER_NETWORK:\s*host\s*$/m.test(jobEnvironment)
    ],
    [
      "database verification after migration replay",
      migrationStep !== "" &&
        databaseStep !== "" &&
        migrationReplayJob.indexOf(databaseStep) >
          migrationReplayJob.indexOf(migrationStep)
    ]
  ];

  for (const [description, present] of requirements) {
    if (!present) {
      failures.push(`${workflowPath} must include ${description}`);
    }
  }

  return failures;
}

const HUMAN_ONLY_APPROVAL_LABELS = [
  "megachange-approved",
  "migration-destructive-approved",
  "legal-policy-approved"
];

/**
 * @param {string} content
 * @param {number} indentation
 * @returns {{ kind: "scalar", value: string } | { kind: "mapping", value: string } | null}
 */
function readPermissionsDeclaration(content, indentation) {
  const prefix = " ".repeat(indentation);
  const scalar = content.match(
    new RegExp(`^${prefix}permissions:\\s+(\\S+)\\s*$`, "m")
  );
  if (scalar) {
    return { kind: "scalar", value: scalar[1] ?? "" };
  }
  if (new RegExp(`^${prefix}permissions:\\s*(?:#.*)?$`, "m").test(content)) {
    return {
      kind: "mapping",
      value: workflowMappingBlockContent(content, "permissions", indentation)
    };
  }
  return null;
}

/**
 * @param {{ kind: "scalar", value: string } | { kind: "mapping", value: string }} declaration
 * @returns {boolean}
 */
function permissionsAreReadOnly(declaration) {
  if (declaration.kind === "scalar") {
    return declaration.value === "read-all";
  }
  const lines = declaration.value.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (!/^[A-Za-z0-9_-]+:\s*(read|none)\s*$/.test(trimmed)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} content
 * @param {string} job
 * @returns {boolean}
 */
function policyGatesPermissionsAreReadOnly(content, job) {
  const workflowPerms = readPermissionsDeclaration(content, 0);
  const jobPerms = readPermissionsDeclaration(job, 4);
  if (workflowPerms === null && jobPerms === null) {
    return false;
  }
  if (workflowPerms !== null && !permissionsAreReadOnly(workflowPerms)) {
    return false;
  }
  if (jobPerms !== null && !permissionsAreReadOnly(jobPerms)) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validatePolicyGatesWorkflow(workflowContentsByPath) {
  const failures = [];
  const workflowPath = POLICY_GATES_WORKFLOW_PATH;
  const content = workflowContentsByPath[workflowPath] ?? "";
  const job = workflowJobContent(content, "policy-gates");
  const requirements = [
    [
      "a Policy gates workflow name",
      /^name:\s*Policy gates\s*$/m.test(content)
    ],
    [
      "pull_request label retrigger types",
      /^\s+types:\s*\[opened, synchronize, reopened, labeled, unlabeled\]\s*$/m.test(
        content
      )
    ],
    ["a policy-gates job", job !== ""],
    [
      "complete base-to-head changed-path enumeration",
      job.includes("scripts/policy-gates/collect-changed-files.mjs")
    ],
    [
      "megachange evaluation",
      job.includes("scripts/policy-gates/megachange-eval.mjs")
    ],
    [
      "destructive migration scan",
      job.includes("scripts/policy-gates/migration-discipline-scan.mjs")
    ],
    [
      "public legal-policy gate",
      job.includes("scripts/policy-gates/legal-policy-gate.mjs")
    ]
  ];

  for (const [requirement, ok] of requirements) {
    if (!ok) {
      failures.push(`${workflowPath} must include ${requirement}`);
    }
  }

  if (/^\s+push:/m.test(content)) {
    failures.push(`${workflowPath} must not run on push`);
  }

  for (const label of HUMAN_ONLY_APPROVAL_LABELS) {
    if (content.includes(`--add-label ${label}`)) {
      failures.push(
        `${workflowPath} must not apply human-only approval labels`
      );
      break;
    }
  }

  if (!policyGatesPermissionsAreReadOnly(content, job)) {
    failures.push(`${workflowPath} must declare read-only permissions`);
  }

  if (/pulls\/\$\{PR_NUMBER\}\/files/.test(job)) {
    failures.push(
      `${workflowPath} must not use the capped pull request files API`
    );
  }

  return failures;
}

/**
 * @param {PackageJson} packageJson
 * @param {string} makefileContent
 * @returns {string[]}
 */
export function validateDatabaseTestCommand(packageJson, makefileContent) {
  const failures = [];
  // scripts/run-node-tests.sh appends these arguments, unchanged, after the
  // reporter flags. Node still applies --test-concurrency=1 in that position.
  const expectedScript =
    "bash scripts/run-node-tests.sh --test-concurrency=1 tests/*.test.mjs";
  if (packageJson.scripts?.["test:database"] !== expectedScript) {
    failures.push(
      `package.json test:database must be exactly: ${expectedScript}`
    );
  }
  for (const hook of ["pretest:database", "posttest:database"]) {
    if (Object.hasOwn(packageJson.scripts ?? {}, hook)) {
      failures.push(`package.json must not define ${hook}`);
    }
  }

  const targetMatch = makefileContent.match(
    /(?:^|\n)test-database:\s*\n((?:\t[^\n]*(?:\n|$))*)/
  );
  const recipeLines = (targetMatch?.[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.slice(1));
  if (
    recipeLines.length !== 1 ||
    recipeLines[0] !== "corepack pnpm run test:database"
  ) {
    failures.push(
      "Makefile test-database must delegate only to corepack pnpm run test:database"
    );
  }

  return failures;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @param {string} makefileContent
 * @param {Toolchain} toolchain
 * @returns {string[]}
 */
export function validateCiCertificationWorkflow(
  workflowContentsByPath,
  makefileContent,
  toolchain
) {
  const failures = [];
  const workflowPath = CI_WORKFLOW_PATH;
  const content = workflowContentsByPath[workflowPath] ?? "";
  const triggers = workflowMappingBlockContent(content, "on", 0);
  for (const trigger of [
    "pull_request",
    "push",
    "workflow_call",
    "workflow_dispatch"
  ]) {
    if (!new RegExp(`^  ${trigger}:\\s*$`, "m").test(triggers)) {
      failures.push(`${workflowPath} must include ${trigger} trigger`);
    }
  }
  const push = workflowMappingBlockContent(triggers, "push", 2);
  const branches = workflowMappingBlockContent(push, "branches", 4);
  if (!/^      - main\s*$/m.test(branches)) {
    failures.push(`${workflowPath} must include push to main`);
  }

  const goVersion = toolchain.goTooling?.githubActionsSetupGo?.version;
  if (!goVersion) {
    failures.push(
      "toolchain.json goTooling.githubActionsSetupGo.version is required"
    );
  }

  // CI splits make release-check across sibling jobs and a release-only remainder.
  const commandsByJob = {
    check: ["make check"],
    "go-check": ["make go-check"],
    browser: ["make browser"],
    "migration-replay": ["make migration-replay", "make test-database"],
    "release-check": ["make package-check marketing-verify", "make setup"]
  };
  for (const [jobId, commands] of Object.entries(commandsByJob)) {
    const job = workflowJobContent(content, jobId);
    if (
      !job
        .split(/\r?\n/)
        .some((line) => line.trimEnd() === `    name: make ${jobId}`)
    ) {
      failures.push(`${workflowPath} ${jobId} job must be named make ${jobId}`);
    }
    const conditions = job
      .split(/\r?\n/)
      .filter((line) => /^    if:/.test(line));
    if (jobId === "release-check") {
      if (
        conditions.length !== 1 ||
        conditions[0].trim() !== "if: github.event_name != 'push'"
      ) {
        failures.push(
          `${workflowPath} release-check job must use if: github.event_name != 'push'`
        );
      }
    } else if (conditions.length !== 0) {
      failures.push(
        `${workflowPath} ${jobId} job must not have a job-level if`
      );
    }
    if (/^    continue-on-error:/m.test(job)) {
      failures.push(
        `${workflowPath} ${jobId} job must not use continue-on-error`
      );
    }
    const steps = workflowStepBlocks(job).map((lines) => lines.join("\n"));
    for (const command of commands) {
      const gateSteps = steps.filter((step) =>
        workflowRunStepIncludes(step, command)
      );
      if (gateSteps.length === 0) {
        failures.push(
          `${workflowPath} ${jobId} job must run ${command} in a step`
        );
      }
      for (const step of gateSteps) {
        if (/^(?:        |      - )if:/m.test(step)) {
          failures.push(
            `${workflowPath} ${jobId} gate ${command} must not have a step-level if`
          );
        }
        if (/^(?:        |      - )continue-on-error:/m.test(step)) {
          failures.push(
            `${workflowPath} ${jobId} gate ${command} must not use continue-on-error`
          );
        }
      }
    }
    if (goVersion && (jobId === "go-check" || jobId === "release-check")) {
      const setupGo =
        steps.find((step) =>
          step
            .split(/\r?\n/)
            .some(
              (line) =>
                line.trim() === `uses: actions/setup-go@${goVersion}` ||
                line.trim() === `- uses: actions/setup-go@${goVersion}`
            )
        ) ?? "";
      const inputs = workflowMappingBlockContent(setupGo, "with", 8);
      if (
        setupGo === "" ||
        !/^          go-version-file: cli\/go\.mod\s*$/m.test(inputs) ||
        !/^          cache-dependency-path: cli\/go\.sum\s*$/m.test(inputs)
      ) {
        failures.push(
          `${workflowPath} ${jobId} job must set up pinned Go with cli/go.mod and cli/go.sum`
        );
      }
    }
    if (jobId === "release-check") {
      const setupNode =
        steps.find((step) =>
          /^(?:        |      - )uses: actions\/setup-node@\S+\s*$/m.test(step)
        ) ?? "";
      const inputs = workflowMappingBlockContent(setupNode, "with", 8);
      if (
        !inputs
          .split(/\r?\n/)
          .some(
            (line) => line.trim() === `node-version: ${toolchain.node.version}`
          )
      ) {
        failures.push(
          `${workflowPath} release-check job must set up Node ${toolchain.node.version}`
        );
      }
    }
  }
  // A recipe under release-check would run locally but never in CI, where the
  // target's parts run as separate jobs. Make allows blank and comment-only
  // lines between the target and its recipe.
  const releaseTarget = makefileContent.match(/^release-check:([^\n]*)\n/m);
  const matchIndex = releaseTarget?.index;
  const nextMakefileLine =
    releaseTarget && matchIndex !== undefined
      ? makefileContent
          .slice(matchIndex + releaseTarget[0].length)
          .split(/\r?\n/)
          .find((line) => line.trim() !== "" && !/^ *#/.test(line))
      : undefined;
  if (
    releaseTarget?.[1].trim().split(/\s+/).join(" ") !==
      "check go-check package-check marketing-verify" ||
    nextMakefileLine?.startsWith("\t")
  ) {
    failures.push(
      "Makefile release-check must be exactly check go-check package-check marketing-verify with no recipe"
    );
  }
  return failures;
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowConcurrency(workflowContentsByPath) {
  const failures = [];
  for (const workflowPath of CI_WORKFLOW_PATHS) {
    const content = workflowContentsByPath[workflowPath] ?? "";
    const concurrency = workflowMappingBlockContent(content, "concurrency", 0);
    const isCi = workflowPath === CI_WORKFLOW_PATH;
    const group = isCi
      ? "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}"
      : "group: ${{ github.workflow }}-${{ github.event.pull_request.number }}";
    const cancellation = isCi
      ? "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
      : "cancel-in-progress: true";
    const lines = concurrency.split(/\r?\n/).map((line) => line.trim());
    const groupDeclaration =
      concurrency.match(/^  group:[^\n]*(?:\n    [^\n]*)*/m)?.[0] ?? "";
    if (groupDeclaration.replace(/\s+/g, " ").trim() !== group) {
      failures.push(
        `${workflowPath} must use workflow-specific PR concurrency${isCi ? " with a run-ID fallback" : ""}`
      );
    }
    if (!lines.includes(cancellation)) {
      failures.push(
        `${workflowPath} must ${isCi ? "cancel only pull_request runs" : "cancel superseded policy runs"}`
      );
    }
  }
  return failures;
}
