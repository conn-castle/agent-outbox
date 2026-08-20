#!/usr/bin/env node
import fs from "node:fs";

import {
  dispatchPolicyGate,
  parseFixtureRows,
  readChangedFiles
} from "./gate-cli-utils.mjs";

const OPERATIONS = [
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "RENAME COLUMN", re: /\bRENAME\s+COLUMN\b/i },
  {
    name: "RENAME TABLE",
    re: /\b(?:RENAME\s+TABLE|ALTER\s+TABLE[\s\S]*?RENAME\s+TO)\b/i
  },
  {
    name: "ALTER COLUMN TYPE",
    re: /\bALTER\s+COLUMN\b\s+(?:"[^"]+"|\S+)\s+\bTYPE\b/i
  },
  { name: "DROP INDEX", re: /\bDROP\s+INDEX\b/i }
];

const SET_NOT_NULL = {
  name: "ALTER COLUMN SET NOT NULL",
  re: /\bALTER\s+COLUMN\b\s+(?:"[^"]+"|\S+)\s+\bSET\s+NOT\s+NULL\b/i
};

/**
 * @typedef {{ filePath: string, lineNumber: number, operation: string, text: string }} MigrationViolation
 * @typedef {{ lineNumber: number, text: string }} StatementLine
 */

/**
 * @param {string} line
 * @returns {string}
 */
function stripFullLineComment(line) {
  return line.trimStart().startsWith("--") ? "" : line;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function hasTerminator(line) {
  return line.includes(";");
}

/**
 * @param {StatementLine[]} statementLines
 * @param {RegExp} re
 * @returns {StatementLine}
 */
function findLine(statementLines, re) {
  return statementLines.find((line) => re.test(line.text)) ?? statementLines[0];
}

/**
 * @param {string} statementText
 * @param {StatementLine[]} statementLines
 * @param {string} filePath
 * @returns {MigrationViolation[]}
 */
function scanStatement(statementText, statementLines, filePath) {
  /** @type {MigrationViolation[]} */
  const violations = [];
  if (statementText.trim() === "") return violations;

  for (const operation of OPERATIONS) {
    if (operation.re.test(statementText)) {
      const line = findLine(statementLines, operation.re);
      violations.push({
        filePath,
        lineNumber: line.lineNumber,
        operation: operation.name,
        text: line.text.trim()
      });
    }
  }

  if (
    SET_NOT_NULL.re.test(statementText) &&
    !/\bDEFAULT\b/i.test(statementText)
  ) {
    const line = findLine(statementLines, SET_NOT_NULL.re);
    violations.push({
      filePath,
      lineNumber: line.lineNumber,
      operation: SET_NOT_NULL.name,
      text: line.text.trim()
    });
  }

  return violations;
}

/**
 * @param {string} sql
 * @param {string} filePath
 * @returns {MigrationViolation[]}
 */
function scanSql(sql, filePath) {
  const lines = sql.split(/\r?\n/);
  /** @type {MigrationViolation[]} */
  const violations = [];
  let statementText = "";
  /** @type {StatementLine[]} */
  let statementLines = [];

  for (const [index, rawLine] of lines.entries()) {
    const text = stripFullLineComment(rawLine);
    statementText += `${text}\n`;
    statementLines.push({ lineNumber: index + 1, text });

    if (hasTerminator(text)) {
      violations.push(
        ...scanStatement(statementText, statementLines, filePath)
      );
      statementText = "";
      statementLines = [];
    }
  }

  violations.push(...scanStatement(statementText, statementLines, filePath));
  return violations;
}

/**
 * @param {string} pathsFile
 * @param {boolean} labelPresent
 * @returns {number}
 */
function runPathsMode(pathsFile, labelPresent) {
  const files = readChangedFiles(pathsFile);
  /** @type {MigrationViolation[]} */
  const violations = [];
  let existingFileCount = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    existingFileCount += 1;
    const sql = fs.readFileSync(file, "utf8");
    violations.push(...scanSql(sql, file));
  }

  console.log(`Scanned ${existingFileCount} changed migration file(s).`);
  if (violations.length === 0) {
    console.log("OK: no destructive migration operations detected.");
    return 0;
  }

  const annotation = labelPresent ? "warning" : "error";
  for (const violation of violations) {
    const message =
      `${violation.operation} in ${violation.filePath}:${violation.lineNumber}` +
      (violation.text ? ` (${violation.text})` : "");
    console.error(
      `::${annotation} file=${violation.filePath},line=${violation.lineNumber}::${message}`
    );
  }

  if (labelPresent) {
    console.log(
      "migration-destructive-approved label is present; destructive migration operations are allowed."
    );
    return 0;
  }

  console.error(
    "Destructive migration operations require the migration-destructive-approved label."
  );
  return 1;
}

/**
 * @param {string} fixturesPath
 * @returns {number}
 */
function runFixturesMode(fixturesPath) {
  const rows = parseFixtureRows(fixturesPath);
  let failures = 0;

  for (const row of rows) {
    const sql = String(row.sql ?? "");
    const labelPresent = Boolean(row.label_present);
    const expected = String(row.expected ?? "");
    const violations = scanSql(sql, `fixture:${row.name ?? "unnamed"}.sql`);
    const actual = violations.length === 0 || labelPresent ? "pass" : "fail";
    if (actual !== expected) {
      failures += 1;
      console.error(
        `FIXTURE MISMATCH: ${row.name ?? "<unnamed>"} expected=${expected} actual=${actual}`
      );
      console.error(
        `  violations=${violations.map((v) => v.operation).join(",") || "<none>"}`
      );
    }
  }

  if (failures > 0) {
    console.error(
      `${failures}/${rows.length} migration discipline fixture(s) failed.`
    );
    return 1;
  }
  console.log(`All ${rows.length} migration discipline fixture(s) passed.`);
  return 0;
}

dispatchPolicyGate({
  scriptName: "migration-discipline-scan.mjs",
  runPathsMode,
  runFixturesMode
});
