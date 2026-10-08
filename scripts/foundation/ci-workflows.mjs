import {
  workflowJobContent,
  workflowMappingBlockContent,
  workflowNamedStepContent,
  workflowStepBlocks,
  parseWorkflowStepTuple,
  workflowRunStepIncludes
} from "../workflow-yaml.mjs";

/** @typedef {import("./toolchain.mjs").PackageJson} PackageJson */
/** @typedef {import("./toolchain.mjs").Toolchain} Toolchain */

export const RELEASE_CHECK_WORKFLOW_PATH =
  ".github/workflows/release-check.yml";
export const POLICY_GATES_WORKFLOW_PATH = ".github/workflows/policy-gates.yml";
export const CI_WORKFLOW_PATHS = [
  RELEASE_CHECK_WORKFLOW_PATH,
  POLICY_GATES_WORKFLOW_PATH
];

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

  for (const workflowPath of [RELEASE_CHECK_WORKFLOW_PATH]) {
    const content = workflowContentsByPath[workflowPath] ?? "";
    const migrationReplayJob = workflowJobContent(content, "migration-replay");
    const services = workflowMappingBlockContent(
      migrationReplayJob,
      "services",
      4
    );
    const postgresService = workflowMappingBlockContent(
      services,
      "postgres",
      6
    );
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

  if (/^\s*concurrency:/m.test(content)) {
    failures.push(`${workflowPath} must not declare concurrency`);
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
 * @param {Toolchain} toolchain
 * @param {Record<string, string>} workflowContentsByPath
 * @returns {string[]}
 */
export function validateWorkflowGoChecks(toolchain, workflowContentsByPath) {
  const failures = [];
  const setupGoVersion = toolchain.goTooling?.githubActionsSetupGo?.version;
  if (!setupGoVersion) {
    return [
      "toolchain.json goTooling.githubActionsSetupGo.version is required"
    ];
  }

  // Match a run step so a job name alone cannot satisfy the Go gate.
  const gateTokenByWorkflowPath = {
    [RELEASE_CHECK_WORKFLOW_PATH]: "run: make go-check"
  };
  for (const [workflowPath, gateToken] of Object.entries(
    gateTokenByWorkflowPath
  )) {
    const content = workflowContentsByPath[workflowPath] ?? "";
    for (const requiredToken of [
      `uses: actions/setup-go@${setupGoVersion}`,
      "go-version-file: cli/go.mod",
      "cache-dependency-path: cli/go.sum",
      gateToken
    ]) {
      if (!content.includes(requiredToken)) {
        failures.push(
          `${workflowPath} must include Go gate token: ${requiredToken}`
        );
      }
    }
  }

  return failures;
}

export const REQUIRED_PULL_REQUEST_CHECKS = [
  "make check",
  "make go-check",
  "make browser",
  "make migration-replay",
  "make release-check",
  "Policy gates"
];

/**
 * @param {Record<string, string>} workflowContentsByPath All workflow files.
 * @returns {string[]}
 */
export function validateRequiredPullRequestChecks(workflowContentsByPath) {
  const failures = [];
  for (const requiredName of REQUIRED_PULL_REQUEST_CHECKS) {
    const definitions = [];
    for (const [workflowPath, content] of Object.entries(
      workflowContentsByPath
    )) {
      const jobs = workflowMappingBlockContent(content, "jobs", 0);
      for (const match of jobs.matchAll(/^    name:[ \t]*(.+?)[ \t]*$/gm)) {
        const name = match[1]
          .replace(/\s+#.*$/, "")
          .replace(/^(['"])(.*)\1$/, "$2");
        if (name === requiredName) {
          definitions.push({ workflowPath, content });
        }
      }
    }
    if (definitions.length !== 1) {
      failures.push(
        `Required pull request check ${requiredName} must be defined exactly once; found ${definitions.length}${definitions.length ? ` in ${definitions.map(({ workflowPath }) => workflowPath).join(", ")}` : ""}`
      );
    }
    for (const { workflowPath, content } of definitions) {
      const events = workflowMappingBlockContent(content, "on", 0);
      if (!/^  pull_request:[ \t]*(?:#.*)?$/m.test(events)) {
        failures.push(
          `${workflowPath} defining ${requiredName} must run on pull_request`
        );
      }
    }
  }
  return failures;
}

/**
 * @param {string} job
 * @returns {import("../workflow-yaml.mjs").WorkflowStepTuple[]}
 */
function makeVerificationSteps(job) {
  return workflowStepBlocks(job)
    .map((lines) => parseWorkflowStepTuple(lines))
    .filter(
      ({ command }) => command?.startsWith("make ") && command !== "make setup"
    );
}

/**
 * @param {Record<string, string>} workflowContentsByPath
 * @param {string} makefileContent
 * @returns {string[]}
 */
export function validateReleaseCheckJob(
  workflowContentsByPath,
  makefileContent
) {
  const failures = [];
  const workflowPath = RELEASE_CHECK_WORKFLOW_PATH;
  const content = workflowContentsByPath[workflowPath] ?? "";
  const job = workflowJobContent(content, "release-check");
  const prerequisiteList = makefileContent.match(
    /^release-check:[ \t]*([^\n\r]+)$/m
  )?.[1];
  if (!prerequisiteList) {
    return ["Makefile must declare release-check prerequisites"];
  }
  const prerequisites = prerequisiteList.trim().split(/\s+/);
  const needs =
    job
      .match(/^    needs:[ \t]*\[([^\]]+)\][ \t]*$/m)?.[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean) ?? [];
  const guard = workflowNamedStepContent(
    job,
    "Require successful prerequisites"
  );
  const firstMakeIndex = job.search(/^\s*(?:- )?run:[ \t]*make /m);
  const requirements = [
    [
      "the make release-check job name",
      /^    name: make release-check[ \t]*$/m.test(job)
    ],
    ["needed prerequisite jobs", needs.length > 0],
    [
      "job-level if: ${{ !cancelled() }}",
      /^    if: \$\{\{ !cancelled\(\) \}\}[ \t]*$/m.test(job)
    ],
    [
      "a failing prerequisite-result guard before any make step",
      parseWorkflowStepTuple(guard.split(/\r?\n/)).condition === null &&
        guard.includes("toJSON(needs)") &&
        guard.includes('all(.[]; .result == "success")') &&
        /^[ \t]+exit 1[ \t]*$/m.test(guard) &&
        firstMakeIndex > job.indexOf(guard) &&
        guard !== ""
    ]
  ];
  for (const [description, present] of requirements) {
    if (!present) {
      failures.push(`${workflowPath} must include ${description}`);
    }
  }
  if (/^\s*(?:- )?continue-on-error:/m.test(content)) {
    failures.push(`${workflowPath} must not declare continue-on-error`);
  }
  const releaseSteps = makeVerificationSteps(job);
  if (releaseSteps.length !== 1) {
    failures.push(
      `${workflowPath} release-check must run verification targets in exactly one make step`
    );
  }
  /** @param {import("../workflow-yaml.mjs").WorkflowStepTuple[]} steps */
  const makeTargets = (steps) =>
    steps.flatMap(({ command }) => (command ?? "").split(/\s+/).slice(1));
  const releaseTargets = makeTargets(releaseSteps);
  const neededTargets = needs.flatMap((needed) => {
    const neededJob = workflowJobContent(content, needed);
    const steps = makeVerificationSteps(neededJob);
    if (/^    if:/m.test(neededJob)) {
      failures.push(
        `${workflowPath} needed job ${needed} must not have a job-level if`
      );
    }
    if (
      steps.length !== 1 ||
      !/^make [A-Za-z0-9_-]+$/.test(steps[0]?.command ?? "")
    ) {
      failures.push(
        `${workflowPath} needed job ${needed} must run exactly one non-setup make target`
      );
    }
    if (steps.some(({ condition }) => condition !== null)) {
      failures.push(
        `${workflowPath} needed job ${needed} must not condition its verification step`
      );
    }
    return makeTargets(steps);
  });
  if (releaseSteps.some(({ condition }) => condition !== null)) {
    failures.push(
      `${workflowPath} release-check must not condition its verification step`
    );
  }
  if (
    releaseTargets.some((target) => neededTargets.includes(target)) ||
    new Set(releaseTargets).size !== releaseTargets.length
  ) {
    failures.push(
      `${workflowPath} release-check must not repeat prerequisite targets`
    );
  }
  const targets = new Set([...releaseTargets, ...neededTargets]);
  if (
    targets.size !== new Set(prerequisites).size ||
    prerequisites.some((target) => !targets.has(target))
  ) {
    failures.push(
      `${workflowPath} release-check and needed-job targets must equal Makefile release-check prerequisites: ${prerequisites.join(" ")}`
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
  const workflowPath = RELEASE_CHECK_WORKFLOW_PATH;
  const content = workflowContentsByPath[workflowPath] ?? "";
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const declarations = lines.filter((line) => /^\s*concurrency:/.test(line));
  if (declarations.length !== 1 || declarations[0] !== "concurrency:") {
    failures.push(
      `${workflowPath} must declare exactly one top-level concurrency block`
    );
  }
  const block = workflowMappingBlockContent(content, "concurrency", 0)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const expected = [
    "concurrency:",
    "  group: release-check-${{ (github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number)) || format('run-{0}', github.run_id) }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
  ];
  if (block.join("\n") !== expected.join("\n")) {
    failures.push(
      `${workflowPath} concurrency must use the literal release-check prefix, PR-number or run-unique group, and PR-only cancellation`
    );
  }
  if (
    lines.filter((line) => /^\s*group:/.test(line)).length !== 1 ||
    lines.some((line) => /^\s*queue:/.test(line)) ||
    block.join("\n").includes("github.workflow")
  ) {
    failures.push(
      `${workflowPath} must not declare extra groups, queue, or github.workflow concurrency`
    );
  }
  return failures;
}
