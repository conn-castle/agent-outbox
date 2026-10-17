#!/usr/bin/env node
import fs from "node:fs";

import { dispatchPolicyGate, readChangedFiles } from "./gate-cli-utils.mjs";

// PostgreSQL scan.l accepts high-bit bytes in both identifier positions. For
// UTF-8 SQL, accept every non-ASCII UTF-16 unit, including surrogate pairs.
// Keep regexes Unicode-unaware: /iu would fold long s into ASCII SQL keywords.
const IDENTIFIER_START = String.raw`[A-Za-z_\u0080-\uFFFF]`;
const IDENTIFIER_CONTINUATION = String.raw`[A-Za-z_0-9$\u0080-\uFFFF]`;
const IDENTIFIER_CHARACTER = new RegExp(IDENTIFIER_CONTINUATION);
const KEYWORD_END = String.raw`(?!${IDENTIFIER_CONTINUATION})`;
// Quotes delimit tokens without whitespace. Unquoted names must end at a real
// identifier boundary so backtracking cannot turn xTYPE or xSET into actions.
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|${IDENTIFIER_START}${IDENTIFIER_CONTINUATION}*${KEYWORD_END})`;
const QUALIFIED_NAME = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})*`;
const ALTER_TABLE_HEADER = new RegExp(
  String.raw`\bALTER\s+(?:FOREIGN\s+)?TABLE${KEYWORD_END}\s*(?:IF\s+EXISTS${KEYWORD_END}\s*)?` +
    String.raw`(?:ONLY${KEYWORD_END}\s*\(\s*${QUALIFIED_NAME}\s*\)|(?:ONLY${KEYWORD_END}\s*)?${QUALIFIED_NAME})(?:\s*\*)?`,
  "i"
);
// Foreign-table renames must be the action immediately after the relation.
// Accept opaque U& spellings here without decoding their names or UESCAPE.
const FOREIGN_RENAME_IDENTIFIER = String.raw`(?:U&"(?:[^"]|"")+"(?:\s+UESCAPE${KEYWORD_END}\s*'[^']')?|${IDENTIFIER})`;
const FOREIGN_RENAME_NAME = String.raw`${FOREIGN_RENAME_IDENTIFIER}(?:\s*\.\s*${FOREIGN_RENAME_IDENTIFIER})*`;
const FOREIGN_TABLE_RENAME = new RegExp(
  String.raw`\bALTER\s+FOREIGN\s+TABLE${KEYWORD_END}\s*(?:IF\s+EXISTS${KEYWORD_END}\s*)?` +
    String.raw`(?:ONLY${KEYWORD_END}\s*\(\s*${FOREIGN_RENAME_NAME}\s*\)|(?:ONLY${KEYWORD_END}\s*)?${FOREIGN_RENAME_NAME})(?:\s*\*)?` +
    String.raw`\s*RENAME\s+TO${KEYWORD_END}`,
  "i"
);
// Keep conservative explicit coverage of opaque names (including U& forms).
// The \S+ fallback requires whitespace afterward to avoid splitting suffixes.
const OPERATIONS = [
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  {
    name: "DROP TABLE",
    re: new RegExp(String.raw`\bDROP\s+(?:FOREIGN\s+)?TABLE${KEYWORD_END}`, "i")
  },
  { name: "RENAME COLUMN", re: /\bRENAME\s+COLUMN\b/i },
  {
    name: "RENAME TABLE",
    re: new RegExp(
      String.raw`\b(?:RENAME\s+TABLE${KEYWORD_END}|ALTER\s+TABLE${KEYWORD_END}[\s\S]*?RENAME\s+TO${KEYWORD_END})`,
      "i"
    )
  },
  {
    name: "ALTER COLUMN TYPE",
    re: new RegExp(
      String.raw`\bALTER\s+COLUMN${KEYWORD_END}\s*(?:${IDENTIFIER}\s*|\S+\s+)(?:SET\s+DATA\s+)?TYPE${KEYWORD_END}`,
      "i"
    )
  },
  { name: "DROP INDEX", re: /\bDROP\s+INDEX\b/i }
];

// PostgreSQL makes COLUMN optional in regular and foreign ALTER TABLE actions.
// Anchor these patterns to top-level actions to cover DROP x, RENAME x TO y,
// and ALTER x without treating nested options or constraint actions as columns.
const IMPLICIT_COLUMN_OPERATIONS = [
  {
    name: "DROP COLUMN",
    re: new RegExp(
      String.raw`^\s*DROP${KEYWORD_END}\s*(?!(?:COLUMN|CONSTRAINT)${KEYWORD_END})${IDENTIFIER}`,
      "i"
    )
  },
  {
    name: "RENAME COLUMN",
    re: new RegExp(
      String.raw`^\s*RENAME${KEYWORD_END}\s*(?!(?:TO|COLUMN|CONSTRAINT)${KEYWORD_END})${IDENTIFIER}\s*TO${KEYWORD_END}`,
      "i"
    )
  },
  {
    name: "ALTER COLUMN TYPE",
    re: new RegExp(
      String.raw`^\s*ALTER${KEYWORD_END}\s*(?!(?:COLUMN|CONSTRAINT)${KEYWORD_END})${IDENTIFIER}` +
        String.raw`\s*(?:SET\s+DATA\s+)?TYPE${KEYWORD_END}`,
      "i"
    )
  }
];
const ALTER_COLUMN_ACTION = new RegExp(
  String.raw`^\s*ALTER${KEYWORD_END}\s*(?:COLUMN${KEYWORD_END}\s*)?(?!(?:COLUMN|CONSTRAINT)${KEYWORD_END})` +
    String.raw`(${IDENTIFIER})\s*([\s\S]*)$`,
  "i"
);

const SET_NOT_NULL = {
  name: "ALTER COLUMN SET NOT NULL",
  re: new RegExp(
    String.raw`\bALTER\s+COLUMN${KEYWORD_END}\s*(?:${IDENTIFIER}\s*|\S+\s+)SET\s+NOT\s+NULL${KEYWORD_END}`,
    "i"
  )
};

/**
 * @typedef {{ filePath: string, lineNumber: number, operation: string, text: string }} MigrationViolation
 * @typedef {{ lineNumber: number, text: string }} StatementLine
 * @typedef {{ text: string, offset: number }} StatementAction
 */

/**
 * Read one quoted fragment at a time, retaining E-string mode for newline
 * continuations. PostgreSQL's quotecontinue rule permits whitespace and line
 * comments between fragments. Ordinary strings and identifiers only double
 * their delimiter; backslash escape pairs belong to E/e strings alone.
 *
 * @param {string} sql
 * @returns {(start: number) => number} Exclusive end of the quoted fragment.
 */
function createQuoteReader(sql) {
  let escapeContinuation = -1;
  const continuation =
    /[ \t\f\v]*(?:--[^\r\n]*)?[\r\n](?:[ \t\f\v\r\n]|--[^\r\n]*[\r\n])*'/y;
  return (start) => {
    const quote = sql[start];
    const escapes =
      quote === "'" &&
      (start === escapeContinuation ||
        (/[eE]/.test(sql[start - 1] ?? "") &&
          !IDENTIFIER_CHARACTER.test(sql[start - 2] ?? "")));
    escapeContinuation = -1;
    for (let i = start + 1; i < sql.length; i += 1) {
      if (escapes && sql[i] === "\\") {
        i += 1;
      } else if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          i += 1;
          continue;
        }
        if (escapes) {
          continuation.lastIndex = i + 1;
          const match = continuation.exec(sql);
          if (match) escapeContinuation = continuation.lastIndex - 1;
        }
        return i + 1;
      }
    }
    return sql.length;
  };
}

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
  const readQuote = createQuoteReader(sql);
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      const end = readQuote(i);
      out += sql.slice(i, end);
      i = end;
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
 * Fold ASCII in unquoted UTF-8 identifiers; quoted identifiers stay exact.
 *
 * @param {string} raw
 * @returns {string}
 */
function columnNameKey(raw) {
  return raw.startsWith('"')
    ? raw.slice(1, -1).replaceAll('""', '"')
    : raw.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Split text on commas outside parentheses and string/identifier literals.
 *
 * @param {string} text
 * @returns {StatementAction[]}
 */
function splitTopLevelActions(text) {
  /** @type {StatementAction[]} */
  const actions = [];
  let start = 0;
  /** @param {number} end */
  const append = (end) => {
    const raw = text.slice(start, end);
    const trimmed = raw.trimStart();
    actions.push({
      text: trimmed,
      offset: start + raw.length - trimmed.length
    });
  };
  let depth = 0;
  const readQuote = createQuoteReader(text);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = readQuote(i) - 1;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
    } else if (c === "," && depth === 0) {
      append(i);
      start = i + 1;
      continue;
    }
  }
  append(text.length);
  return actions;
}

/**
 * Top-level actions after the `ALTER [FOREIGN] TABLE` header, or the statement as
 * one action list when no header is present.
 *
 * @param {string} statementText
 * @returns {{ hasHeader: boolean, actions: StatementAction[] }}
 */
function statementActions(statementText) {
  const header = ALTER_TABLE_HEADER.exec(statementText);
  const offset = header ? header.index + header[0].length : 0;
  const actionText = statementText.slice(offset);
  return {
    hasHeader: header !== null,
    actions: splitTopLevelActions(actionText).map((action) => ({
      text: action.text,
      offset: offset + action.offset
    }))
  };
}

/**
 * Find the first `ALTER [COLUMN] ... SET NOT NULL` action lacking a
 * `SET DEFAULT` action on that same column in the same statement.
 *
 * @param {StatementAction[]} actions
 * @param {string} statementText
 * @returns {StatementAction | undefined}
 */
function findSetNotNullWithoutSameColumnDefault(actions, statementText) {
  /** @type {{ column: string, action: StatementAction }[]} */
  const notNullActions = [];
  /** @type {Set<string>} */
  const defaultColumns = new Set();
  for (const action of actions) {
    const match = ALTER_COLUMN_ACTION.exec(action.text);
    if (!match) continue;
    const column = columnNameKey(match[1] ?? "");
    const body = match[2] ?? "";
    if (/^SET\s+NOT\s+NULL\b/i.test(body)) {
      notNullActions.push({ column, action });
    }
    if (/^SET\s+DEFAULT\b/i.test(body)) {
      defaultColumns.add(column);
    }
  }
  if (notNullActions.length === 0) {
    const match = SET_NOT_NULL.re.exec(statementText);
    return match ? { text: match[0], offset: match.index } : undefined;
  }
  return notNullActions.find(({ column }) => !defaultColumns.has(column))
    ?.action;
}

/**
 * @param {string} statementText
 * @param {StatementLine[]} statementLines
 * @param {number} offset
 * @returns {StatementLine}
 */
function findLineAtOffset(statementText, statementLines, offset) {
  const index = statementText.slice(0, offset).split("\n").length - 1;
  return statementLines[index];
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
  /**
   * @param {string} operation
   * @param {number} offset
   */
  const record = (operation, offset) => {
    const line = findLineAtOffset(statementText, statementLines, offset);
    violations.push({
      filePath,
      lineNumber: line.lineNumber,
      operation,
      text: line.text.trim()
    });
  };

  for (const operation of OPERATIONS) {
    const match = operation.re.exec(statementText);
    if (match) record(operation.name, match.index);
  }
  const foreignRename = FOREIGN_TABLE_RENAME.exec(statementText);
  if (foreignRename) record("RENAME TABLE", foreignRename.index);

  const { hasHeader, actions } = statementActions(statementText);
  if (hasHeader) {
    for (const operation of IMPLICIT_COLUMN_OPERATIONS) {
      const action = actions.find((action) => operation.re.test(action.text));
      if (action) record(operation.name, action.offset);
    }
  }

  const notNullAction = findSetNotNullWithoutSameColumnDefault(
    actions,
    statementText
  );
  if (notNullAction) record(SET_NOT_NULL.name, notNullAction.offset);

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

dispatchPolicyGate({
  scriptName: "migration-discipline-scan.mjs",
  fixtureLabel: "migration discipline",
  runPathsMode,
  evaluateFixture(row) {
    const violations = scanSql(
      String(row.sql ?? ""),
      `fixture:${row.name ?? "unnamed"}.sql`
    );
    return {
      findings: violations,
      detail: `violations=${violations.map((v) => v.operation).join(",") || "<none>"}`
    };
  }
});
