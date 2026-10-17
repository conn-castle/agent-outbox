import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

import {
  assertNoForbiddenWorkflowCommands,
  validateBrowserWorkflow,
  validateDatabaseTestCommand,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
  validateRequiredPullRequestChecks,
  validateReleaseCheckJob,
  validateWorkflowConcurrency,
  validateWorkflowGoChecks,
  validateWorkflowVersionPins
} from "../scripts/foundation/ci-workflows.mjs";

import {
  parseWorkflowStepTuple,
  workflowJobContent,
  workflowNamedStepContent
} from "../scripts/workflow-yaml.mjs";

const FLYWAY_TOOLCHAIN_FIXTURE = {
  version: "12.10.0",
  image: "flyway/flyway",
  source: "test"
};

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

test("validateMigrationReplayWorkflow requires raw Postgres-backed CI replay", () => {
  const validWorkflow = `
jobs:
  migration-replay:
    services:
      postgres:
        image: postgres:17
    env:
      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci
      FLYWAY_DOCKER_NETWORK: host
    steps:
      - name: Replay migrations from scratch
        run: make migration-replay
      - name: Run database verification suite
        run: make test-database
  `;

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/release-check.yml": validWorkflow
    }),
    []
  );

  const commentedWorkflow = validWorkflow
    .replace(
      "    services:\n      postgres:",
      `    services: # migration database services
    # The replay job uses raw Postgres.
      postgres: # canonical service`
    )
    .replace("    env:", "    env: # job environment");
  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/release-check.yml": commentedWorkflow
    }),
    []
  );

  const stepScopedDatabaseEnvironment = validWorkflow
    .replace('      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n', "")
    .replace(
      "      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci\n",
      ""
    )
    .replace(
      "        run: make test-database",
      `        env:
          AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
          DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci
        run: make test-database`
    );
  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/release-check.yml": stepScopedDatabaseEnvironment
    }),
    []
  );

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/release-check.yml": "steps: []"
    }),
    [
      ".github/workflows/release-check.yml must include a migration-replay job",
      ".github/workflows/release-check.yml must include a Postgres 17 service in the migration-replay job",
      ".github/workflows/release-check.yml must include make migration-replay in the named replay step",
      ".github/workflows/release-check.yml must include make test-database in the named database verification step",
      ".github/workflows/release-check.yml must include AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification",
      ".github/workflows/release-check.yml must include DATABASE_MIGRATION_URL for database verification",
      ".github/workflows/release-check.yml must include FLYWAY_DOCKER_NETWORK=host in the migration-replay job",
      ".github/workflows/release-check.yml must include database verification after migration replay"
    ]
  );

  const invalidWorkflows = [
    [
      "a commented-out command",
      validWorkflow.replace(
        "        run: make test-database",
        "        # run: make test-database"
      ),
      "make test-database in the named database verification step"
    ],
    [
      "a Postgres image token inside a run block without a service",
      validWorkflow
        .replace(
          `    services:
      postgres:
        image: postgres:17`,
          ""
        )
        .replace(
          `    steps:
      - name: Replay migrations from scratch`,
          `    steps:
      - name: Misleading image text
        run: |
          image: postgres:17
      - name: Replay migrations from scratch`
        ),
      "a Postgres 17 service in the migration-replay job"
    ],
    [
      "database verification before migration replay",
      validWorkflow.replace(
        /      - name: Replay migrations from scratch[\s\S]*?        run: make test-database/,
        `      - name: Run database verification suite
        run: make test-database
      - name: Replay migrations from scratch
        run: make migration-replay`
      ),
      "database verification after migration replay"
    ],
    [
      "database verification in another job",
      validWorkflow.replace(
        `      - name: Run database verification suite
        run: make test-database`,
        `  database-tests:
    steps:
      - name: Run database verification suite
        run: make test-database`
      ),
      "make test-database in the named database verification step"
    ],
    [
      "database opt-in on an unrelated job",
      validWorkflow.replace(
        '      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n',
        ""
      ).concat(`
  unrelated:
    env:
      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
`),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database opt-in outside an env block",
      validWorkflow.replace(
        "    env:\n      AGENT_OUTBOX_ENABLE_DATABASE_TESTS",
        "      AGENT_OUTBOX_ENABLE_DATABASE_TESTS"
      ),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database opt-in under step with",
      validWorkflow
        .replace('      AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"\n', "")
        .replace(
          "        run: make test-database",
          `        with:
          AGENT_OUTBOX_ENABLE_DATABASE_TESTS: "1"
        run: make test-database`
        ),
      "AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification"
    ],
    [
      "database URL under the Postgres service environment",
      validWorkflow
        .replace(
          "      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci\n",
          ""
        )
        .replace(
          "        image: postgres:17",
          `        image: postgres:17
        env:
          DATABASE_MIGRATION_URL: postgresql://postgres:postgres@127.0.0.1:5432/agent_outbox_ci`
        ),
      "DATABASE_MIGRATION_URL for database verification"
    ],
    [
      "Flyway network under job outputs",
      validWorkflow.replace("      FLYWAY_DOCKER_NETWORK: host\n", "").replace(
        "    env:",
        `    outputs:
      FLYWAY_DOCKER_NETWORK: host
    env:`
      ),
      "FLYWAY_DOCKER_NETWORK=host in the migration-replay job"
    ]
  ];
  for (const [description, workflow, expectedFailure] of invalidWorkflows) {
    const failures = validateMigrationReplayWorkflow({
      ".github/workflows/release-check.yml": workflow
    });
    assert.ok(
      failures.includes(
        `.github/workflows/release-check.yml must include ${expectedFailure}`
      ),
      description
    );
  }
});
test("validatePolicyGatesWorkflow requires label-retriggered PR policy checks", () => {
  const validWorkflow = `
name: Policy gates
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: read
  pull-requests: read
jobs:
  policy-gates:
    steps:
      - run: node scripts/policy-gates/collect-changed-files.mjs
      - run: node scripts/policy-gates/megachange-eval.mjs
      - run: node scripts/policy-gates/migration-discipline-scan.mjs
      - run: node scripts/policy-gates/legal-policy-gate.mjs
`;

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow
    }),
    []
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "types: [opened, synchronize, reopened, labeled, unlabeled]",
        "types: [opened, synchronize, reopened]"
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include pull_request label retrigger types"
    ]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": `${validWorkflow}\n  push:\n    branches:\n      - main\n`
    }),
    [".github/workflows/policy-gates.yml must not run on push"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "node scripts/policy-gates/legal-policy-gate.mjs",
        "gh pr edit 1 --add-label legal-policy-approved"
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include public legal-policy gate",
      ".github/workflows/policy-gates.yml must not apply human-only approval labels"
    ]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        ""
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        "permissions:\n  contents: read\n  pull-requests: write\n"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "permissions:\n  contents: read\n  pull-requests: read\n",
        "permissions: write-all\n"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "    steps:",
        "    permissions:\n      pull-requests: write\n    steps:"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "    steps:",
        "    permissions: write-all\n    steps:"
      )
    }),
    [".github/workflows/policy-gates.yml must declare read-only permissions"]
  );

  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": validWorkflow.replace(
        "node scripts/policy-gates/collect-changed-files.mjs",
        'gh api "repos/x/y/pulls/${PR_NUMBER}/files"'
      )
    }),
    [
      ".github/workflows/policy-gates.yml must include complete base-to-head changed-path enumeration",
      ".github/workflows/policy-gates.yml must not use the capped pull request files API"
    ]
  );
});
test("validateDatabaseTestCommand enforces the serialized root test command chain", () => {
  const validPackageJson = {
    scripts: {
      "test:database":
        "bash scripts/run-node-tests.sh --test-concurrency=1 tests/*.test.mjs"
    }
  };
  const validMakefile = `test-database:
\tcorepack pnpm run test:database
`;

  assert.deepEqual(
    validateDatabaseTestCommand(validPackageJson, validMakefile),
    []
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      {
        scripts: {
          "test:database":
            "node --test --test-concurrency=1 tests/example.test.mjs"
        }
      },
      validMakefile
    ),
    [
      "package.json test:database must be exactly: bash scripts/run-node-tests.sh --test-concurrency=1 tests/*.test.mjs"
    ]
  );
  for (const hook of ["pretest:database", "posttest:database"]) {
    assert.deepEqual(
      validateDatabaseTestCommand(
        {
          scripts: {
            ...validPackageJson.scripts,
            [hook]: "node unexpected-hook.mjs"
          }
        },
        validMakefile
      ),
      [`package.json must not define ${hook}`]
    );
  }
  assert.deepEqual(
    validateDatabaseTestCommand(
      {
        scripts: {
          "test:database": "node --test tests/*.test.mjs"
        }
      },
      validMakefile
    ),
    [
      "package.json test:database must be exactly: bash scripts/run-node-tests.sh --test-concurrency=1 tests/*.test.mjs"
    ]
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      validPackageJson,
      `test-database:
\t@true
`
    ),
    [
      "Makefile test-database must delegate only to corepack pnpm run test:database"
    ]
  );
  assert.deepEqual(
    validateDatabaseTestCommand(
      validPackageJson,
      `test-database:
\tcorepack pnpm run test:database
\t@true
`
    ),
    [
      "Makefile test-database must delegate only to corepack pnpm run test:database"
    ]
  );
});
test("validateWorkflowVersionPins rejects CI Node drift", () => {
  const failures = validateWorkflowVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    { ".github/workflows/release-check.yml": "node-version: 26.1.0" }
  );

  assert.deepEqual(failures, [
    ".github/workflows/release-check.yml node-version 26.1.0 must match toolchain.json 24.18.0"
  ]);
});
test("validateWorkflowGoChecks requires Go gate jobs in CI workflows", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      githubActionsSetupGo: { version: "v6" }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const validReleaseWorkflow = `
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
      - run: make go-check
  `;

  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/release-check.yml": "jobs: {}"
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: uses: actions/setup-go@v6",
      ".github/workflows/release-check.yml must include Go gate token: go-version-file: cli/go.mod",
      ".github/workflows/release-check.yml must include Go gate token: cache-dependency-path: cli/go.sum",
      ".github/workflows/release-check.yml must include Go gate token: run: make go-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/release-check.yml": validReleaseWorkflow.replace(
        "run: make go-check",
        "name: make go-check"
      )
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: run: make go-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks({ ...toolchain, goTooling: {} }, {}),
    ["toolchain.json goTooling.githubActionsSetupGo.version is required"]
  );
});

const RELEASE_PATH = ".github/workflows/release-check.yml";
const POLICY_PATH = ".github/workflows/policy-gates.yml";
const MAKEFILE_FIXTURE =
  "release-check: check go-check package-check marketing-verify\n";
const RELEASE_JOB_FIXTURE = `jobs:
  check:
    steps:
      - name: Dependencies
        run: make setup
      - name: Check
        run: make check
  go-check:
    steps:
      - name: Go
        run: make go-check
  release-check:
    name: make release-check
    needs: [check, go-check]
    if: \${{ !cancelled() }}
    steps:
      - name: Require successful prerequisites
        env:
          NEEDS_JSON: \${{ toJSON(needs) }}
        run: |
          set -euo pipefail
          if ! jq -e 'all(.[]; .result == "success")' <<<"$NEEDS_JSON" >/dev/null; then
            exit 1
          fi
      - name: Dependencies
        run: make setup
      - name: Release
        run: make package-check marketing-verify
`;
const CONCURRENCY_FIXTURE = `concurrency:
  group: release-check-\${{ (github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number)) || format('run-{0}', github.run_id) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;
const REQUIRED_CHECKS_FIXTURE = {
  [RELEASE_PATH]: `on:
  pull_request:
jobs:
  check:
    name: make check
  go-check:
    name: make go-check
  release-check:
    name: make release-check
  browser:
    name: make browser
  migration-replay:
    name: make migration-replay
`,
  [POLICY_PATH]: `on:
  pull_request:
jobs:
  policy-gates:
    name: Policy gates
`
};

test("required PR checks each have one definition in a PR workflow", () => {
  assert.deepEqual(
    validateRequiredPullRequestChecks(REQUIRED_CHECKS_FIXTURE),
    []
  );
  const duplicate = `on:
  pull_request:
jobs:
  browser:
    name: make browser
`;
  for (const path of [
    ".github/workflows/extra.yml",
    ".github/workflows/unregistered.yaml"
  ]) {
    for (const name of [
      "make browser",
      '"make browser"',
      "'make browser'",
      "make browser # x"
    ]) {
      const failures = validateRequiredPullRequestChecks({
        ...REQUIRED_CHECKS_FIXTURE,
        [path]: duplicate.replace("name: make browser", `name: ${name}`)
      });
      assert.ok(
        failures.some(
          (failure) =>
            failure.includes("make browser") &&
            failure.includes("found 2") &&
            failure.includes(path)
        ),
        `${path}: ${name}`
      );
    }
  }
  assert.ok(
    validateRequiredPullRequestChecks({
      ...REQUIRED_CHECKS_FIXTURE,
      [RELEASE_PATH]: REQUIRED_CHECKS_FIXTURE[RELEASE_PATH].replace(
        "    name: make browser\n",
        ""
      )
    }).some(
      (failure) =>
        failure.includes("make browser") && failure.includes("found 0")
    )
  );
  assert.ok(
    validateRequiredPullRequestChecks({
      ...REQUIRED_CHECKS_FIXTURE,
      [RELEASE_PATH]: REQUIRED_CHECKS_FIXTURE[RELEASE_PATH].replace(
        "  pull_request:",
        "  workflow_dispatch:"
      )
    }).some((failure) => failure.includes("must run on pull_request"))
  );
  // Workflow/step names must not count as job check definitions.
  assert.ok(
    validateRequiredPullRequestChecks({
      ...REQUIRED_CHECKS_FIXTURE,
      [POLICY_PATH]:
        "name: Policy gates\non:\n  pull_request:\njobs:\n  policy:\n    steps:\n      - name: Policy gates\n"
    }).some(
      (failure) =>
        failure.includes("Policy gates") && failure.includes("found 0")
    )
  );
});

test("release-check derives all prerequisites once and accepts setup steps", () => {
  assert.deepEqual(
    validateReleaseCheckJob(
      { [RELEASE_PATH]: RELEASE_JOB_FIXTURE },
      MAKEFILE_FIXTURE
    ),
    []
  );
  assert.deepEqual(
    validateReleaseCheckJob(
      {
        [RELEASE_PATH]: RELEASE_JOB_FIXTURE.replace(
          "package-check marketing-verify",
          "package-check marketing-verify additional-check"
        )
      },
      "release-check: check go-check package-check marketing-verify additional-check\n"
    ),
    []
  );
});

const INVALID_RELEASE_JOBS = [
  [
    "missing needs",
    "    needs: [check, go-check]\n",
    "",
    "needed prerequisite jobs"
  ],
  [
    "missing cancellation condition",
    "    if: \${{ !cancelled() }}\n",
    "",
    "job-level if"
  ],
  [
    "missing guard",
    "Require successful prerequisites",
    "Unrelated step",
    "prerequisite-result guard"
  ],
  [
    "conditional guard",
    "      - name: Require successful prerequisites",
    "      - name: Require successful prerequisites\n        if: ${{ false }}",
    "prerequisite-result guard"
  ],
  [
    "guard accepting any successful prerequisite",
    "all(.[];",
    "any(.[];",
    "prerequisite-result guard"
  ],
  [
    "guard after setup",
    "      - name: Require successful prerequisites",
    "      - name: Early setup\n        run: make setup\n      - name: Require successful prerequisites",
    "prerequisite-result guard"
  ],
  [
    "guard without failure",
    "            exit 1",
    "          echo failed",
    "prerequisite-result guard"
  ],
  [
    "nested release-check repetition",
    "make package-check marketing-verify",
    "make release-check",
    "must equal Makefile"
  ],
  [
    "missing marketing verification",
    "make package-check marketing-verify",
    "make package-check",
    "must equal Makefile"
  ],
  [
    "repeated check",
    "make package-check marketing-verify",
    "make check package-check marketing-verify",
    "must not repeat"
  ],
  [
    "continue-on-error",
    "    name: make release-check",
    "    continue-on-error: true\n    name: make release-check",
    "continue-on-error"
  ],
  [
    "conditional release verification",
    "        run: make package-check",
    "        if: success()\n        run: make package-check",
    "must not condition"
  ],
  [
    "conditional needed verification",
    "        run: make check",
    "        if: success()\n        run: make check",
    "must not condition"
  ],
  [
    "conditional needed job",
    "  check:\n",
    "  check:\n    if: success()\n",
    "must not have a job-level if"
  ],
  [
    "needed job runs two targets",
    "make go-check",
    "make go-check check",
    "exactly one non-setup"
  ],
  [
    "extra release verification step",
    "        run: make package-check marketing-verify",
    "        run: make package-check marketing-verify\n      - name: Again\n        run: make package-check",
    "exactly one make step"
  ]
];
for (const [description, from, to, expected] of INVALID_RELEASE_JOBS) {
  test(`release-check rejects ${description}`, () => {
    const failures = validateReleaseCheckJob(
      { [RELEASE_PATH]: RELEASE_JOB_FIXTURE.replace(from, to) },
      MAKEFILE_FIXTURE
    );
    assert.ok(
      failures.some((failure) => failure.includes(expected)),
      failures.join("\n")
    );
  });
}

test("workflow concurrency accepts the PR-only run-unique group and comments", () => {
  assert.deepEqual(
    validateWorkflowConcurrency({ [RELEASE_PATH]: CONCURRENCY_FIXTURE }),
    []
  );
  assert.deepEqual(
    validateWorkflowConcurrency({
      [RELEASE_PATH]: CONCURRENCY_FIXTURE.replace(
        "  group:",
        "  # Literal workflow prefix.\n  group:"
      )
    }),
    []
  );
});

const INVALID_CONCURRENCY = [
  [
    "caller workflow prefix",
    CONCURRENCY_FIXTURE.replace("release-check-", "\${{ github.workflow }}-")
  ],
  [
    "unconditional cancellation",
    CONCURRENCY_FIXTURE.replace(
      "cancel-in-progress: \${{ github.event_name == 'pull_request' }}",
      "cancel-in-progress: true"
    )
  ],
  ["missing group", CONCURRENCY_FIXTURE.replace(/^  group:.*\n/m, "")],
  ["queued runs", `${CONCURRENCY_FIXTURE}  queue: max\n`],
  [
    "extra job group",
    `${CONCURRENCY_FIXTURE}jobs:\n  other:\n    concurrency:\n      group: production-deploy\n`
  ],
  [
    "extra group without concurrency",
    `${CONCURRENCY_FIXTURE}jobs:\n  other:\n    group: production-deploy\n`
  ],
  ["missing concurrency", "jobs:\n"],
  [
    "job-level concurrency",
    CONCURRENCY_FIXTURE.split("\n")
      .map((line) => `    ${line}`)
      .join("\n")
  ]
];
for (const [description, workflow] of INVALID_CONCURRENCY) {
  test(`workflow concurrency rejects ${description}`, () => {
    assert.notDeepEqual(
      validateWorkflowConcurrency({ [RELEASE_PATH]: workflow }),
      []
    );
  });
}

test("Policy gates rejects concurrency at workflow or job level", () => {
  const policy = readFileSync(
    new URL(`../${POLICY_PATH}`, import.meta.url),
    "utf8"
  );
  for (const content of [
    CONCURRENCY_FIXTURE + policy,
    policy.replace(
      "    steps:",
      "    concurrency:\n      group: policy\n    steps:"
    )
  ]) {
    assert.ok(
      validatePolicyGatesWorkflow({ [POLICY_PATH]: content }).includes(
        `${POLICY_PATH} must not declare concurrency`
      )
    );
  }
});

const browserWorkflow = readFileSync(
  new URL(`../${RELEASE_PATH}`, import.meta.url),
  "utf8"
);
const browserConfig = readFileSync(
  new URL("../playwright.config.ts", import.meta.url),
  "utf8"
);

test("repository workflow files satisfy verification and policy contracts", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [
        `.github/workflows/${name}`,
        readFileSync(new URL(name, directory), "utf8")
      ])
  );
  const makefile = readFileSync(
    new URL("../Makefile", import.meta.url),
    "utf8"
  );
  const toolchain = JSON.parse(
    readFileSync(new URL("../toolchain.json", import.meta.url), "utf8")
  );
  assert.deepEqual(
    [
      ...validateRequiredPullRequestChecks(workflows),
      ...validateReleaseCheckJob(workflows, makefile),
      ...validateBrowserWorkflow(workflows, browserConfig),
      ...validateWorkflowConcurrency(workflows),
      ...validateMigrationReplayWorkflow(workflows),
      ...validateWorkflowGoChecks(toolchain, workflows),
      ...validatePolicyGatesWorkflow(workflows)
    ],
    []
  );
});

test("browser matrix cannot omit a newly configured project", () => {
  const extendedConfig = browserConfig.replace(
    "  ],\n  webServer:",
    '    ,{ name: "chromium-tablet", use: {} }\n  ],\n  webServer:'
  );
  assert.notEqual(extendedConfig, browserConfig);
  assert.notDeepEqual(
    validateBrowserWorkflow(
      { [RELEASE_PATH]: browserWorkflow },
      extendedConfig
    ),
    []
  );
  const extendedWorkflow = browserWorkflow.replace(
    "project: [chromium-desktop, chromium-mobile]",
    "project: [chromium-desktop, chromium-mobile, chromium-tablet]"
  );
  assert.deepEqual(
    validateBrowserWorkflow(
      { [RELEASE_PATH]: extendedWorkflow },
      extendedConfig
    ),
    []
  );
});

test("browser matrix fails closed when configured coverage cannot be established", () => {
  assert.notDeepEqual(
    validateBrowserWorkflow(
      { [RELEASE_PATH]: browserWorkflow },
      browserConfig.replace(
        "export default defineConfig(",
        "export default withExtraProjects("
      )
    ),
    []
  );
  for (const projects of [
    "[]",
    "additionalProjects",
    '[...additionalProjects, { name: "chromium-desktop" }, { name: "chromium-mobile" }]',
    '[{ name: "chromium-desktop", ...additionalSettings }, { name: "chromium-mobile" }]',
    '[{ name: "chromium-desktop" }, { name: "chromium-desktop" }]'
  ]) {
    assert.notDeepEqual(
      validateBrowserWorkflow(
        { [RELEASE_PATH]: browserWorkflow },
        `export default defineConfig({ projects: ${projects} });`
      ),
      [],
      projects
    );
  }
});

test("browser aggregate accepts only complete successful coverage", () => {
  const guard = workflowNamedStepContent(
    workflowJobContent(browserWorkflow, "browser"),
    "Require successful browser suites"
  );
  const { command } = parseWorkflowStepTuple(guard.split(/\r?\n/));
  assert.ok(command);
  /** @type {[string, string | undefined, boolean][]} */
  const scenarios = [
    ["both matrix instances succeeded", "success", true],
    ["a project failed", "failure", false],
    ["a project was cancelled", "cancelled", false],
    ["coverage was skipped", "skipped", false],
    ["coverage was missing", "", false],
    ["result was missing", undefined, false],
    ["unrecognized result", "invalid", false]
  ];
  for (const [description, browserResult, succeeds] of scenarios) {
    const env = { ...process.env };
    delete env.BROWSER_RESULT;
    if (browserResult !== undefined) {
      env.BROWSER_RESULT = browserResult;
    }
    /** @type {import("node:child_process").SpawnSyncReturns<string>} */
    const execution = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env
    });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status === 0, succeeds, description);
    if (!succeeds) {
      assert.match(execution.stdout, /::error::make browser requires/);
    }
  }
});

const INVALID_BROWSER_WORKFLOWS = [
  [
    "missing mobile",
    "project: [chromium-desktop, chromium-mobile]",
    "project: [chromium-desktop]"
  ],
  [
    "mobile excluded",
    "project: [chromium-desktop, chromium-mobile]",
    "project: [chromium-desktop, chromium-mobile]\n        exclude:\n          - project: chromium-mobile"
  ],
  ["fail-fast cancellation", "fail-fast: false", "fail-fast: true"],
  [
    "conditional matrix",
    "  browser-suites:\n",
    "  browser-suites:\n    if: false\n"
  ],
  [
    "conditional test command",
    "        run: corepack pnpm run browser",
    "        if: false\n        run: corepack pnpm run browser"
  ],
  [
    "filtered tests",
    "--project=${{ matrix.project }}",
    "--project=${{ matrix.project }} --grep=smoke"
  ],
  [
    "hardcoded desktop",
    "--project=${{ matrix.project }}",
    "--project=chromium-desktop"
  ],
  [
    "matrix continue-on-error",
    "  browser-suites:\n",
    "  browser-suites:\n    continue-on-error: true\n"
  ],
  [
    "test continue-on-error",
    "        run: corepack pnpm run browser",
    "        continue-on-error: true\n        run: corepack pnpm run browser"
  ],
  [
    "aggregate continue-on-error",
    "    name: make browser\n",
    "    name: make browser\n    continue-on-error: true\n"
  ],
  ["missing matrix dependency", "    needs: [browser-suites]", "    needs: []"],
  [
    "skipped aggregate on failed dependencies",
    "    if: ${{ always() }}",
    "    if: success()"
  ],
  [
    "conditional aggregate guard",
    "      - name: Require successful browser suites",
    "      - name: Require successful browser suites\n        if: false"
  ],
  ["accepting failure", '"success" ]]; then', '"cancelled" ]]; then'],
  [
    "guard exits successfully",
    "            exit 1\n          fi\n\n  migration-replay:",
    "            exit 0\n          fi\n\n  migration-replay:"
  ],
  [
    "result guard disabled",
    'if [[ "${BROWSER_RESULT:-}" != "success" ]]; then',
    "if false; then"
  ],
  [
    "result guard uses forged success",
    "BROWSER_RESULT: ${{ needs['browser-suites'].result }}",
    "BROWSER_RESULT: success"
  ],
  [
    "colliding diagnostics",
    "name: release-check-browser-failures-${{ matrix.project }}",
    "name: release-check-browser-failures"
  ],
  [
    "lost diagnostics",
    "          path: test-results/",
    "          path: nonexistent/"
  ],
  [
    "shortened retention",
    "          retention-days: 7",
    "          retention-days: 1"
  ]
];
for (const [description, from, to] of INVALID_BROWSER_WORKFLOWS) {
  test(`browser workflow rejects ${description}`, () => {
    const unsafe = browserWorkflow.replace(from, to);
    assert.notEqual(unsafe, browserWorkflow, "mutation must change workflow");
    assert.notDeepEqual(
      validateBrowserWorkflow({ [RELEASE_PATH]: unsafe }, browserConfig),
      []
    );
  });
}
