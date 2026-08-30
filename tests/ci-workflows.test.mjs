import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoForbiddenWorkflowCommands,
  validateDatabaseTestCommand,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
  validateWorkflowGoChecks,
  validateWorkflowVersionPins
} from "../scripts/foundation/ci-workflows.mjs";

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
      ".github/workflows/ci.yml": validWorkflow,
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
      ".github/workflows/ci.yml": commentedWorkflow,
      ".github/workflows/release-check.yml": validWorkflow
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
      ".github/workflows/ci.yml": stepScopedDatabaseEnvironment,
      ".github/workflows/release-check.yml": validWorkflow
    }),
    []
  );

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": "steps: []",
      ".github/workflows/release-check.yml": validWorkflow
    }),
    [
      ".github/workflows/ci.yml must include a migration-replay job",
      ".github/workflows/ci.yml must include a Postgres 17 service in the migration-replay job",
      ".github/workflows/ci.yml must include make migration-replay in the named replay step",
      ".github/workflows/ci.yml must include make test-database in the named database verification step",
      ".github/workflows/ci.yml must include AGENT_OUTBOX_ENABLE_DATABASE_TESTS=1 for database verification",
      ".github/workflows/ci.yml must include DATABASE_MIGRATION_URL for database verification",
      ".github/workflows/ci.yml must include FLYWAY_DOCKER_NETWORK=host in the migration-replay job",
      ".github/workflows/ci.yml must include database verification after migration replay"
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
      ".github/workflows/ci.yml": workflow,
      ".github/workflows/release-check.yml": validWorkflow
    });
    assert.ok(
      failures.includes(
        `.github/workflows/ci.yml must include ${expectedFailure}`
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
      "test:database": "node --test --test-concurrency=1 tests/*.test.mjs"
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
      "package.json test:database must be exactly: node --test --test-concurrency=1 tests/*.test.mjs"
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
      "package.json test:database must be exactly: node --test --test-concurrency=1 tests/*.test.mjs"
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
    { ".github/workflows/ci.yml": "node-version: 26.1.0" }
  );

  assert.deepEqual(failures, [
    ".github/workflows/ci.yml node-version 26.1.0 must match toolchain.json 24.18.0"
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
  const validCiWorkflow = `
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
      - run: make go-check
  `;
  const validReleaseWorkflow = `
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
      - run: make release-check
  `;

  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    []
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": "jobs: {}",
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    [
      ".github/workflows/ci.yml must include Go gate token: uses: actions/setup-go@v6",
      ".github/workflows/ci.yml must include Go gate token: go-version-file: cli/go.mod",
      ".github/workflows/ci.yml must include Go gate token: cache-dependency-path: cli/go.sum",
      ".github/workflows/ci.yml must include Go gate token: run: make go-check"
    ]
  );
  // A job merely named `make go-check` (no run step) must fail: the gate no
  // longer executes even though the token string is present.
  const ciWorkflowNamedButNotRun = `
      name: make go-check
      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum
  `;
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": ciWorkflowNamedButNotRun,
      ".github/workflows/release-check.yml": validReleaseWorkflow
    }),
    [".github/workflows/ci.yml must include Go gate token: run: make go-check"]
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": validCiWorkflow
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: run: make release-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks(toolchain, {
      ".github/workflows/ci.yml": validCiWorkflow,
      ".github/workflows/release-check.yml": "jobs: {}"
    }),
    [
      ".github/workflows/release-check.yml must include Go gate token: uses: actions/setup-go@v6",
      ".github/workflows/release-check.yml must include Go gate token: go-version-file: cli/go.mod",
      ".github/workflows/release-check.yml must include Go gate token: cache-dependency-path: cli/go.sum",
      ".github/workflows/release-check.yml must include Go gate token: run: make release-check"
    ]
  );
  assert.deepEqual(
    validateWorkflowGoChecks({ ...toolchain, goTooling: {} }, {}),
    ["toolchain.json goTooling.githubActionsSetupGo.version is required"]
  );
});
