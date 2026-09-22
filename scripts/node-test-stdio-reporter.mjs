import path from "node:path";

// Node's aggregate count lines are also delivered as root info diagnostics.
// The summary event is the structured copy; these exact lines are not warnings.
const AGGREGATE_SUMMARY_TOKENS = new Set([
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
  "duration_ms"
]);

/**
 * @param {string | undefined} logFile
 * @returns {string}
 */
function displayPath(logFile) {
  if (!logFile) {
    return "unavailable";
  }
  const relative = path.relative(process.cwd(), logFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return logFile;
  }
  return relative;
}

/**
 * @param {{ file?: string, line?: number, column?: number }} data
 * @returns {string}
 */
function location(data) {
  if (!data.file) {
    return "";
  }
  const relative = path.relative(process.cwd(), data.file);
  return ` (${relative}:${data.line ?? ""}:${data.column ?? ""})`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function withNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Root info diagnostics whose message is `<token> <value>` duplicate test:summary.
 * Any other diagnostic, including an unknown level, is kept.
 *
 * @param {{ level?: string, file?: string, message?: string }} data
 * @returns {boolean}
 */
function isAggregateSummaryDiagnostic(data) {
  if (data.level !== "info" || data.file != null) {
    return false;
  }
  const message = String(data.message ?? "");
  const space = message.indexOf(" ");
  if (space <= 0 || message.indexOf(" ", space + 1) !== -1) {
    return false;
  }
  return AGGREGATE_SUMMARY_TOKENS.has(message.slice(0, space));
}

/**
 * @param {{ level?: string, file?: string, line?: number, column?: number, message?: string }} data
 * @returns {string}
 */
function formatDiagnostic(data) {
  const level = data.level ?? "diagnostic";
  const where = data.file
    ? `${path.relative(process.cwd(), data.file)}:${data.line ?? ""}:${data.column ?? ""} `
    : "";
  return withNewline(`${level} ${where}${String(data.message ?? "")}`);
}

/**
 * @param {{ name?: string, skip?: string | boolean, todo?: string | boolean, file?: string, line?: number, column?: number }} data
 * @param {"skip" | "todo"} label
 * @returns {string}
 */
function formatAnnotated(data, label) {
  const reason = data[label];
  const suffix =
    typeof reason === "string" && reason.length > 0 ? ` # ${reason}` : "";
  return `${label} ${data.name ?? ""}${location(data)}${suffix}\n`;
}

/**
 * @param {{ details?: { error?: { stack?: string, message?: string, cause?: { stack?: string, message?: string } } } }} data
 * @returns {string}
 */
function errorDetail(data) {
  const error = data.details?.error;
  const cause = error?.cause;
  return cause?.stack || error?.stack || cause?.message || error?.message || "";
}

/**
 * @param {string} detail
 * @returns {string}
 */
function indentDetail(detail) {
  if (!detail) {
    return "";
  }
  const indented = detail
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
  return withNewline(indented);
}

/**
 * @param {{ name?: string, file?: string, line?: number, column?: number, details?: { error?: { failureType?: string, stack?: string, message?: string, cause?: { stack?: string, message?: string } } } }} data
 * @returns {string}
 */
function formatFailure(data) {
  const error = data.details?.error;
  if (error?.failureType === "subtestsFailed") {
    return `fail ${data.name ?? ""}${location(data)} (subtests failed)\n`;
  }
  const detail = errorDetail(data) || "failed";
  return `fail ${data.name ?? ""}${location(data)}\n${withNewline(detail)}`;
}

/**
 * @param {{ success?: boolean, duration_ms?: number, counts?: { tests?: number, suites?: number, passed?: number, failed?: number, cancelled?: number, skipped?: number, todo?: number } }} data
 * @param {string | undefined} logFile
 * @returns {string}
 */
function formatSummary(data, logFile) {
  const counts = data.counts ?? {};
  return [
    `tests ${counts.tests}`,
    `suites ${counts.suites}`,
    `pass ${counts.passed}`,
    `fail ${counts.failed}`,
    `cancelled ${counts.cancelled}`,
    `skipped ${counts.skipped}`,
    `todo ${counts.todo}`,
    `duration_ms ${data.duration_ms}`,
    `outcome ${data.success ? "pass" : "fail"}`,
    `log ${displayPath(logFile)}`,
    ""
  ].join("\n");
}

/**
 * Concise stdio reporter for `node --test`.
 * Passing test names are omitted. Diagnostics, failures, skips, todos, and the
 * complete test stdout/stderr stream are not filtered by text matching.
 *
 * @param {AsyncIterable<{ type: string, data?: Record<string, any> }>} source
 */
export default async function* nodeTestStdioReporter(source) {
  const logFile = process.env.AGENT_OUTBOX_NODE_TEST_LOG;
  // Fail closed if this reporter is used without the wrapper's log path.
  // The wrapper does not load it when log creation already failed.
  if (!logFile) {
    process.exitCode = 1;
  }
  let rootSummary;
  let summaryEmitted = false;
  let endedWithNewline = true;
  /** @type {string[]} */
  const aggregateLines = [];
  /**
   * @param {string} text
   * @returns {string}
   */
  const track = (text) => {
    endedWithNewline = text.endsWith("\n");
    return text;
  };
  // Raw stdout/stderr is forwarded unchanged. Structured records start on
  // their own line when that raw output has no trailing newline.
  /**
   * @param {string} text
   * @returns {string}
   */
  const trackStructured = (text) =>
    track(endedWithNewline ? text : `\n${text}`);
  // Emit the path before any event so an interruption still names the log.
  yield track(`log ${displayPath(logFile)}\n`);
  for await (const event of source) {
    const data = event.data ?? {};
    switch (event.type) {
      case "test:diagnostic":
        if (isAggregateSummaryDiagnostic(data)) {
          aggregateLines.push(formatDiagnostic(data));
          break;
        }
        yield trackStructured(formatDiagnostic(data));
        break;
      case "test:stdout":
      case "test:stderr":
        if (typeof data.message === "string" && data.message.length > 0) {
          yield track(data.message);
        }
        break;
      case "test:fail":
        if (data.todo !== undefined && data.todo !== false) {
          // A todo failure does not increment fail N. Keep the error, but do
          // not label it with the fail token.
          yield trackStructured(
            formatAnnotated(data, "todo") + indentDetail(errorDetail(data))
          );
          break;
        }
        yield trackStructured(formatFailure(data));
        break;
      case "test:pass":
        if (data.skip !== undefined && data.skip !== false) {
          yield trackStructured(formatAnnotated(data, "skip"));
        } else if (data.todo !== undefined && data.todo !== false) {
          yield trackStructured(formatAnnotated(data, "todo"));
        }
        break;
      case "test:summary":
        if (data.file == null) {
          rootSummary = data;
        }
        break;
      case "test:interrupted":
        yield trackStructured("interrupted\n");
        for (const test of data.tests ?? []) {
          yield trackStructured(
            `interrupted ${test.name ?? ""}${location(test)}\n`
          );
        }
        if (!summaryEmitted) {
          summaryEmitted = true;
          if (rootSummary) {
            yield trackStructured(formatSummary(rootSummary, logFile));
          } else {
            yield trackStructured(
              aggregateLines.join("") +
                `outcome interrupted\nlog ${displayPath(logFile)}\n`
            );
          }
        }
        break;
      default:
        // test:coverage is retained in the spec log. Ordinary commands do not
        // enable coverage, and stdio does not render that table.
        break;
    }
  }

  if (summaryEmitted) {
    return;
  }
  if (!endedWithNewline) {
    yield "\n";
  }
  if (rootSummary) {
    yield formatSummary(rootSummary, logFile);
    return;
  }
  process.exitCode = 1;
  yield aggregateLines.join("") +
    `outcome incomplete\nlog ${displayPath(logFile)}\n`;
}
