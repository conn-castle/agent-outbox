import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertNoForbiddenWorkflowCommands,
  validateDatabaseTestCommand,
  validateMigrationReplayWorkflow,
  validatePolicyGatesWorkflow,
  validateCiCertificationWorkflow,
  validateWorkflowConcurrency,
  validateWorkflowVersionPins
} from "../scripts/foundation/ci-workflows.mjs";

const FLYWAY_TOOLCHAIN_FIXTURE = {
  version: "12.10.0",
  image: "flyway/flyway",
  source: "test"
};

test("workflow guard rejects deploy and publish commands", () => {
  const failures = assertNoForbiddenWorkflowCommands({
    ".github/workflows/ci.yml":
      "run: wrangler deploy\nrun: supabase migration up --linked"
  });

  assert.deepEqual(failures, [
    ".github/workflows/ci.yml contains forbidden command: wrangler deploy",
    ".github/workflows/ci.yml contains forbidden command: supabase migration"
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
      ".github/workflows/ci.yml": validWorkflow
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
      ".github/workflows/ci.yml": commentedWorkflow
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
      ".github/workflows/ci.yml": stepScopedDatabaseEnvironment
    }),
    []
  );

  assert.deepEqual(
    validateMigrationReplayWorkflow({
      ".github/workflows/ci.yml": "steps: []"
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
      ".github/workflows/ci.yml": workflow
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
    { ".github/workflows/ci.yml": "node-version: 26.1.0" }
  );

  assert.deepEqual(failures, [
    ".github/workflows/ci.yml node-version 26.1.0 must match toolchain.json 24.18.0"
  ]);
});
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);
const policyWorkflow = readFileSync(
  new URL("../.github/workflows/policy-gates.yml", import.meta.url),
  "utf8"
);
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const toolchain =
  /** @type {import("../scripts/foundation/toolchain.mjs").Toolchain} */ (
    JSON.parse(
      readFileSync(new URL("../toolchain.json", import.meta.url), "utf8")
    )
  );

/** @param {string} workflow */
function certificationFailures(
  workflow,
  targetMakefile = makefile,
  targetToolchain = toolchain
) {
  return validateCiCertificationWorkflow(
    { ".github/workflows/ci.yml": workflow },
    targetMakefile,
    targetToolchain
  );
}

test("CI certification preserves every required context and the complete release gate", () => {
  assert.deepEqual(certificationFailures(ciWorkflow), []);
  assert.deepEqual(
    validateMigrationReplayWorkflow({ ".github/workflows/ci.yml": ciWorkflow }),
    []
  );
  assert.deepEqual(
    validatePolicyGatesWorkflow({
      ".github/workflows/policy-gates.yml": policyWorkflow
    }),
    []
  );
});

/** @type {[string, (workflow: string) => string, string][]} */
const invalidCertificationWorkflows = [
  [
    "missing release job",
    (workflow) => workflow.replace(/\n  release-check:[\s\S]*$/, ""),
    "release-check job must be named make release-check"
  ],
  [
    "missing package gate",
    (workflow) =>
      workflow.replace(
        "run: make package-check marketing-verify",
        "run: make marketing-verify"
      ),
    "release-check job must run make package-check marketing-verify in a step"
  ],
  [
    "missing marketing gate",
    (workflow) =>
      workflow.replace(
        "run: make package-check marketing-verify",
        "run: make package-check"
      ),
    "release-check job must run make package-check marketing-verify in a step"
  ],
  [
    "wrong release condition",
    (workflow) =>
      workflow.replace(
        "if: github.event_name != 'push'",
        "if: github.event_name == 'pull_request'"
      ),
    "release-check job must use if: github.event_name != 'push'"
  ],
  [
    "missing release condition",
    (workflow) => workflow.replace("    if: github.event_name != 'push'\n", ""),
    "release-check job must use if: github.event_name != 'push'"
  ],
  [
    "missing reusable trigger",
    (workflow) => workflow.replace("  workflow_call:\n", ""),
    "must include workflow_call trigger"
  ],
  [
    "missing PR trigger",
    (workflow) => workflow.replace("  pull_request:\n", ""),
    "must include pull_request trigger"
  ],
  [
    "missing manual trigger",
    (workflow) => workflow.replace("  workflow_dispatch:\n", ""),
    "must include workflow_dispatch trigger"
  ],
  [
    "wrong push branch",
    (workflow) => workflow.replace("      - main", "      - other"),
    "must include push to main"
  ],
  [
    "missing release Go setup",
    (workflow) =>
      workflow.replace(
        /(  release-check:[\s\S]*?)      - name: Set up Go[\s\S]*?(?=      - name: Set up dependencies)/,
        "$1"
      ),
    "release-check job must set up pinned Go with cli/go.mod and cli/go.sum"
  ],
  [
    "missing release Node setup",
    (workflow) =>
      workflow.replace(
        /(  release-check:[\s\S]*?)      - name: Set up Node[\s\S]*?(?=      - name: Set up Go)/,
        "$1"
      ),
    `release-check job must set up Node ${toolchain.node.version}`
  ],
  [
    "wrong release Node version",
    (workflow) =>
      workflow.replace(
        /(  release-check:[\s\S]*?node-version:) [^\n]+/,
        "$1 0.0.0"
      ),
    `release-check job must set up Node ${toolchain.node.version}`
  ],
  [
    "missing release dependencies",
    (workflow) =>
      workflow.replace(
        /(  release-check:[\s\S]*?)        run: make setup/,
        "$1        run: true"
      ),
    "release-check job must run make setup in a step"
  ]
];
for (const [
  description,
  mutate,
  expectedFailure
] of invalidCertificationWorkflows) {
  test(`CI certification rejects ${description}`, () => {
    const broken = mutate(ciWorkflow);
    assert.notEqual(
      broken,
      ciWorkflow,
      "regression fixture must change the workflow"
    );
    assert.ok(
      certificationFailures(broken).includes(
        `.github/workflows/ci.yml ${expectedFailure}`
      )
    );
  });
}

for (const [jobId, command] of [
  ["check", "make check"],
  ["go-check", "make go-check"],
  ["browser", "make browser"],
  ["migration-replay", "make migration-replay"],
  ["migration-replay", "make test-database"],
  ["release-check", "make package-check marketing-verify"]
]) {
  test(`CI certification rejects a skipped or suppressed ${command} gate`, () => {
    for (const [property, expectedFailure] of [
      ["if: false", "must not have a step-level if"],
      ["continue-on-error: true", "must not use continue-on-error"]
    ]) {
      const broken = ciWorkflow.replace(
        `        run: ${command}\n`,
        `        ${property}\n        run: ${command}\n`
      );
      assert.notEqual(broken, ciWorkflow);
      assert.ok(
        certificationFailures(broken).includes(
          `.github/workflows/ci.yml ${jobId} gate ${command} ${expectedFailure}`
        )
      );
    }
    const missingGate = ciWorkflow.replace(
      `        run: ${command}\n`,
      "        run: true\n"
    );
    assert.ok(
      certificationFailures(missingGate).includes(
        `.github/workflows/ci.yml ${jobId} job must run ${command} in a step`
      )
    );
  });
}

for (const jobId of [
  "check",
  "go-check",
  "browser",
  "migration-replay",
  "release-check"
]) {
  test(`CI certification protects the ${jobId} required context`, () => {
    const renamed = ciWorkflow.replace(
      `    name: make ${jobId}\n`,
      `    name: other ${jobId}\n`
    );
    assert.ok(
      certificationFailures(renamed).includes(
        `.github/workflows/ci.yml ${jobId} job must be named make ${jobId}`
      )
    );
    const allowedFailure = ciWorkflow.replace(
      `  ${jobId}:\n`,
      `  ${jobId}:\n    continue-on-error: true\n`
    );
    assert.ok(
      certificationFailures(allowedFailure).includes(
        `.github/workflows/ci.yml ${jobId} job must not use continue-on-error`
      )
    );
    if (jobId !== "release-check") {
      const conditional = ciWorkflow.replace(
        `  ${jobId}:\n`,
        `  ${jobId}:\n    if: false\n`
      );
      assert.ok(
        certificationFailures(conditional).includes(
          `.github/workflows/ci.yml ${jobId} job must not have a job-level if`
        )
      );
    }
  });
}

for (const jobId of ["go-check", "release-check"]) {
  test(`CI certification requires Go toolchain inputs in ${jobId} itself`, () => {
    for (const token of [
      `uses: actions/setup-go@${toolchain.goTooling?.githubActionsSetupGo?.version}`,
      "go-version-file: cli/go.mod",
      "cache-dependency-path: cli/go.sum"
    ]) {
      const start = ciWorkflow.indexOf(`  ${jobId}:\n`);
      const broken =
        ciWorkflow.slice(0, start) +
        ciWorkflow.slice(start).replace(token, "removed: true");
      assert.notEqual(broken, ciWorkflow);
      assert.ok(
        certificationFailures(broken).includes(
          `.github/workflows/ci.yml ${jobId} job must set up pinned Go with cli/go.mod and cli/go.sum`
        )
      );
    }
  });
}

test("CI certification rejects a local release-check chain CI would not run", () => {
  for (const prerequisites of [
    "check go-check package-check",
    "check go-check marketing-verify",
    "check go-check package-check marketing-verify browser"
  ]) {
    const broken = makefile.replace(
      /^release-check:.*$/m,
      `release-check: ${prerequisites}`
    );
    assert.notEqual(broken, makefile);
    assert.deepEqual(certificationFailures(ciWorkflow, broken), [
      "Makefile release-check must be exactly check go-check package-check marketing-verify with no recipe"
    ]);
  }
  const withRecipe = makefile.replace(
    /^release-check:.*$/m,
    "$&\n\t./scripts/extra-release-gate.sh"
  );
  assert.notEqual(withRecipe, makefile);
  assert.deepEqual(certificationFailures(ciWorkflow, withRecipe), [
    "Makefile release-check must be exactly check go-check package-check marketing-verify with no recipe"
  ]);
  assert.ok(
    certificationFailures(ciWorkflow, makefile, {
      ...toolchain,
      goTooling: {}
    }).includes(
      "toolchain.json goTooling.githubActionsSetupGo.version is required"
    )
  );
});

test("workflow concurrency preserves isolated non-PR runs and cancels superseded PR runs", () => {
  assert.deepEqual(
    validateWorkflowConcurrency({
      ".github/workflows/ci.yml": ciWorkflow,
      ".github/workflows/policy-gates.yml": policyWorkflow
    }),
    []
  );
});
for (const [workflowPath, workflow] of [
  [".github/workflows/ci.yml", ciWorkflow],
  [".github/workflows/policy-gates.yml", policyWorkflow]
]) {
  test(`${workflowPath} concurrency rejects missing or shared groups`, () => {
    const isCi = workflowPath.endsWith("/ci.yml");
    const groupFailure = `${workflowPath} must use workflow-specific PR concurrency${isCi ? " with a run-ID fallback" : ""}`;
    const cancelFailure = `${workflowPath} must ${isCi ? "cancel only pull_request runs" : "cancel superseded policy runs"}`;
    const brokenWorkflows = [
      [workflow.replace(/^concurrency:\n(?:  [^\n]*\n)+/m, ""), groupFailure],
      [
        workflow.replace(
          /(group:\s*\$\{\{ )github.workflow/,
          "$1github.repository"
        ),
        groupFailure
      ],
      [
        workflow.replace("github.event.pull_request.number", "github.ref"),
        groupFailure
      ],
      [workflow.replace(/^  cancel-in-progress:.*\n/m, ""), cancelFailure],
      [
        workflow.replace(
          /^  cancel-in-progress:.*$/m,
          "  cancel-in-progress: false"
        ),
        cancelFailure
      ]
    ];
    if (isCi) {
      brokenWorkflows.push([
        workflow.replace(" || github.run_id", ""),
        groupFailure
      ]);
      brokenWorkflows.push([
        workflow.replace(
          /^  cancel-in-progress:.*$/m,
          "  cancel-in-progress: true"
        ),
        cancelFailure
      ]);
    }
    for (const [broken, failure] of brokenWorkflows) {
      assert.notEqual(broken, workflow);
      const workflows = {
        ".github/workflows/ci.yml": ciWorkflow,
        ".github/workflows/policy-gates.yml": policyWorkflow,
        [workflowPath]: broken
      };
      assert.ok(validateWorkflowConcurrency(workflows).includes(failure));
    }
  });
}
