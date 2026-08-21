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
    re: /\bALTER\s+COLUMN\b\s+(?:"[^"]+"|\S+)\s+(?:SET\s+DATA\s+)?\bTYPE\b/i
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
 * Strip `--` and block comments while preserving newlines and string/identifier
 * literals. This closes comment-based DEFAULT bypasses without a full SQL
 * tokenizer.
 *
 * @param {string} sql
 * @returns {string}
 */
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      out += c;
      if (c === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (c === "'") {
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') {
        inDouble = false;
      }
      i += 1;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function columnNameKey(raw) {
  return raw.replaceAll('"', "").toLowerCase();
}

/**
 * True when at least one `ALTER COLUMN ... SET NOT NULL` lacks `SET DEFAULT`
 * on that same column in the same statement.
 *
 * @param {string} statementText
 * @returns {boolean}
 */
function hasSetNotNullWithoutSameColumnDefault(statementText) {
  /** @type {Set<string>} */
  const notNullColumns = new Set();
  /** @type {Set<string>} */
  const defaultColumns = new Set();
  const clauseRe =
    /\bALTER\s+COLUMN\s+("[^"]+"|\S+)([\s\S]*?)(?=\bALTER\s+COLUMN\b|$)/gi;
  for (const match of statementText.matchAll(clauseRe)) {
    const column = columnNameKey(match[1] ?? "");
    const body = match[2] ?? "";
    if (/\bSET\s+NOT\s+NULL\b/i.test(body)) {
      notNullColumns.add(column);
    }
    if (/\bSET\s+DEFAULT\b/i.test(body)) {
      defaultColumns.add(column);
    }
  }
  if (notNullColumns.size === 0) {
    return SET_NOT_NULL.re.test(statementText);
  }
  for (const column of notNullColumns) {
    if (!defaultColumns.has(column)) {
      return true;
    }
  }
  return false;
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

  if (hasSetNotNullWithoutSameColumnDefault(statementText)) {
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
  const lines = stripSqlComments(sql).split(/\r?\n/);
  /** @type {MigrationViolation[]} */
  const violations = [];
  let statementText = "";
  /** @type {StatementLine[]} */
  let statementLines = [];

  const flush = () => {
    violations.push(...scanStatement(statementText, statementLines, filePath));
    statementText = "";
    statementLines = [];
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const segments = line.split(";");
    for (const [segIndex, segment] of segments.entries()) {
      const isLast = segIndex === segments.length - 1;
      statementText += isLast ? `${segment}\n` : `${segment};`;
      statementLines.push({
        lineNumber,
        text: isLast ? segment : `${segment};`
      });
      if (!isLast) {
        flush();
      }
    }
  }

  flush();
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
