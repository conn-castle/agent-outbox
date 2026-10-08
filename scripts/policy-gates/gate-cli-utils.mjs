/**
 * Shared CLI helpers for policy-gate scripts that accept the standard
 * `--paths-file PATH [--label-present]` or `--fixtures PATH` mutex argument
 * shape.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * @param {string} scriptName
 * @param {string[]} argv
 * @returns {{ pathsFile: string, fixturesPath: string, labelPresent: boolean }}
 */
function parsePolicyGateArgs(scriptName, argv) {
  const args = { pathsFile: "", fixturesPath: "", labelPresent: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--paths-file":
        args.pathsFile = requireFlagValue(scriptName, arg, argv[i + 1]);
        i += 1;
        break;
      case "--fixtures":
        args.fixturesPath = requireFlagValue(scriptName, arg, argv[i + 1]);
        i += 1;
        break;
      case "--label-present":
        args.labelPresent = true;
        break;
      case "-h":
      case "--help":
        printUsageAndExit(scriptName);
        break;
      default:
        console.error(`${scriptName}: unknown argument: ${arg}`);
        printUsageAndExit(scriptName);
    }
  }

  const hasPathsFile = args.pathsFile !== "";
  const hasFixtures = args.fixturesPath !== "";
  if (hasPathsFile && hasFixtures) {
    console.error(
      `${scriptName}: --paths-file and --fixtures are mutually exclusive`
    );
    printUsageAndExit(scriptName);
  }
  if (!hasPathsFile && !hasFixtures) {
    console.error(
      `${scriptName}: one of --paths-file or --fixtures is required`
    );
    printUsageAndExit(scriptName);
  }
  return args;
}

/**
 * @param {string} scriptName
 * @param {string} flag
 * @param {string | undefined} value
 * @returns {string}
 */
function requireFlagValue(scriptName, flag, value) {
  if (value === undefined || value === "" || value.startsWith("-")) {
    console.error(`${scriptName}: ${flag} requires a value`);
    printUsageAndExit(scriptName);
  }
  return value;
}

/**
 * @param {string} scriptName
 * @returns {never}
 */
function printUsageAndExit(scriptName) {
  console.error(`Usage:
  ${scriptName} --paths-file PATH [--label-present]
  ${scriptName} --fixtures PATH`);
  process.exit(64);
}

/**
 * @param {string} pathsFile
 * @returns {string[]}
 */
export function readChangedFiles(pathsFile) {
  const text = fs.readFileSync(pathsFile, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} fixturesPath
 * @returns {Record<string, unknown>[]}
 */
function parseFixtureRows(fixturesPath) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const text = fs.readFileSync(fixturesPath, "utf8");
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${fixturesPath}:${index + 1}: invalid JSON: ${message}`);
    }
  }
  return rows;
}

/**
 * Self-validates a gate against JSONL fixture rows. A row passes when it has
 * no findings or carries `label_present`, and must match its `expected`.
 *
 * @param {string} fixturesPath
 * @param {string} label
 * @param {(row: Record<string, unknown>) => { findings: unknown[], detail: string }} evaluate
 * @returns {number}
 */
function runFixturesMode(fixturesPath, label, evaluate) {
  const rows = parseFixtureRows(fixturesPath);
  let failures = 0;

  for (const row of rows) {
    const { findings, detail } = evaluate(row);
    const expected = String(row.expected ?? "");
    const actual =
      findings.length === 0 || Boolean(row.label_present) ? "pass" : "fail";
    if (actual !== expected) {
      failures += 1;
      console.error(
        `FIXTURE MISMATCH: ${row.name ?? "<unnamed>"} expected=${expected} actual=${actual}`
      );
      console.error(`  ${detail}`);
    }
  }

  if (failures > 0) {
    console.error(`${failures}/${rows.length} ${label} fixture(s) failed.`);
    return 1;
  }
  console.log(`All ${rows.length} ${label} fixture(s) passed.`);
  return 0;
}

/**
 * @param {{
 *   scriptName: string,
 *   fixtureLabel: string,
 *   runPathsMode: (pathsFile: string, labelPresent: boolean) => number,
 *   evaluateFixture: (row: Record<string, unknown>) => { findings: unknown[], detail: string }
 * }} config
 */
export function dispatchPolicyGate({
  scriptName,
  fixtureLabel,
  runPathsMode,
  evaluateFixture
}) {
  const args = parsePolicyGateArgs(scriptName, process.argv.slice(2));
  const exitCode = args.fixturesPath
    ? runFixturesMode(
        path.normalize(args.fixturesPath),
        fixtureLabel,
        evaluateFixture
      )
    : runPathsMode(path.normalize(args.pathsFile), args.labelPresent);
  process.exit(exitCode);
}
