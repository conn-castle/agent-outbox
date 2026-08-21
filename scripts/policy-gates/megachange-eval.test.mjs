#!/usr/bin/env node
/**
 * Self-validation fixture runner for megachange-eval.mjs.
 *
 * Usage: node scripts/policy-gates/megachange-eval.test.mjs [--fixtures PATH]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { values: args } = parseArgs({
  options: {
    fixtures: {
      type: "string",
      default: "scripts/policy-gates/megachange-cap-fixtures.txt"
    }
  }
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));
const evalScript = join(scriptDir, "megachange-eval.mjs");

const lines = readFileSync(args.fixtures, "utf8").split("\n");
let total = 0;
let failures = 0;

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;

  const row = JSON.parse(line);
  total += 1;

  const cmd = [
    evalScript,
    "--synthetic",
    "--file-count",
    String(row.file_count),
    "--line-total",
    String(row.line_total),
    ...(row.label_present ? ["--label-present"] : [])
  ];

  const result = spawnSync(process.execPath, cmd, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(
      `FIXTURE ERROR: ${row.name} — script exited ${result.status}\n${result.stderr}\n`
    );
    failures += 1;
    continue;
  }

  const data = JSON.parse(result.stdout);
  if (data.verdict !== row.expected) {
    process.stderr.write(
      `FIXTURE MISMATCH: ${JSON.stringify(row.name)} ` +
        `expected=${row.expected} actual=${data.verdict} ` +
        `reason=${JSON.stringify(data.reason)}\n`
    );
    failures += 1;
  }
}

const realDiffFixtures = [
  {
    name: "single-line replacements count as files but not lines",
    files: [
      ...Array.from({ length: 31 }, (_, index) => ({
        filename: `src/renamed-import-${index}.ts`,
        additions: 1,
        deletions: 1
      })),
      { filename: "src/real-change.ts", additions: 1000, deletions: 0 }
    ],
    expected: "fail",
    expected_file_count: 32,
    expected_line_total: 1000
  },
  {
    name: "single-line additions and deletions count as files but not lines",
    files: [
      { filename: "src/added-import.ts", additions: 1, deletions: 0 },
      { filename: "src/removed-import.ts", additions: 0, deletions: 1 },
      { filename: "src/real-change.ts", additions: 2, deletions: 0 }
    ],
    expected: "pass",
    expected_file_count: 3,
    expected_line_total: 2
  },
  {
    name: "zero-line file change still counts",
    files: [
      { filename: "src/mode-only-change.ts", additions: 0, deletions: 0 }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 0
  },
  {
    name: "rename into allowlisted path still counts previous non-allowlisted path",
    files: Array.from({ length: 31 }, (_, index) => ({
      filename: `docs/renamed-import-${index}.md`,
      previous_filename: `src/renamed-import-${index}.ts`,
      additions: 0,
      deletions: 0
    })),
    expected: "fail",
    expected_file_count: 31,
    expected_line_total: 0
  },
  {
    name: "root tests are allowlisted",
    files: [
      {
        filename: "tests/human-review.test.mjs",
        additions: 1500,
        deletions: 0
      },
      { filename: "src/server/human-review.ts", additions: 5, deletions: 0 }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 5
  },
  {
    name: "browser specs are allowlisted",
    files: [
      {
        filename: "tests/browser/legal-pages.spec.ts",
        additions: 1500,
        deletions: 0
      },
      { filename: "app/page.tsx", additions: 5, deletions: 0 }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 5
  },
  {
    name: "Go CLI tests are allowlisted",
    files: [
      {
        filename: "cli/internal/command/doctor_test.go",
        additions: 1500,
        deletions: 0
      },
      { filename: "cli/internal/command/doctor.go", additions: 5, deletions: 0 }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 5
  },
  {
    name: "generated public API docs JSON is allowlisted",
    files: [
      {
        filename: "src/shared/api-docs.generated.json",
        additions: 1500,
        deletions: 0
      },
      {
        filename: "src/shared/public-api-contract.ts",
        additions: 5,
        deletions: 0
      }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 5
  },
  {
    name: "generated Go system contract is allowlisted",
    files: [
      {
        filename: "cli/internal/foundation/system_contract_generated.go",
        additions: 1500,
        deletions: 0
      },
      {
        filename: "cli/internal/foundation/contract.go",
        additions: 5,
        deletions: 0
      }
    ],
    expected: "pass",
    expected_file_count: 1,
    expected_line_total: 5
  }
];

const tmpDir = join(repoRoot, "tmp", `megachange-eval-test-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });

try {
  for (const row of realDiffFixtures) {
    total += 1;
    const fixturePath = join(tmpDir, `fixture-${total}.jsonl`);
    writeFileSync(
      fixturePath,
      row.files.map((file) => JSON.stringify(file)).join("\n") + "\n",
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [
        evalScript,
        "--allowlist",
        "scripts/policy-gates/megachange-allowlist.txt",
        "--files-jsonl",
        fixturePath,
        "--max-files",
        "30",
        "--max-lines",
        "1000"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );
    if (result.status !== 0) {
      process.stderr.write(
        `FIXTURE ERROR: ${row.name} — script exited ${result.status}\n${result.stderr}\n`
      );
      failures += 1;
      continue;
    }

    const data = JSON.parse(result.stdout);
    if (
      data.verdict !== row.expected ||
      data.file_count !== row.expected_file_count ||
      data.line_total !== row.expected_line_total
    ) {
      process.stderr.write(
        `FIXTURE MISMATCH: ${JSON.stringify(row.name)} ` +
          `expected=${row.expected}/${row.expected_file_count}/${row.expected_line_total} ` +
          `actual=${data.verdict}/${data.file_count}/${data.line_total} ` +
          `reason=${JSON.stringify(data.reason)}\n`
      );
      failures += 1;
    }
  }
} finally {
  rmSync(tmpDir, { force: true, recursive: true });
}

if (failures > 0) {
  process.stderr.write(`${failures}/${total} megachange fixtures failed\n`);
  process.exit(1);
}

process.stdout.write(`All ${total} megachange fixtures passed.\n`);
