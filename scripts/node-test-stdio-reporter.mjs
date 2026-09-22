import path from "node:path";

/**
 * @typedef {object} TestEventData
 * @property {string} [name]
 * @property {string} [file]
 * @property {string | boolean} [skip]
 * @property {string | boolean} [todo]
 * @property {string} [level]
 * @property {string} [message]
 * @property {boolean} [success]
 * @property {Array<{ name?: string }>} [tests]
 * @property {{ error?: { stack?: string, message?: string } }} [details]
 */

/**
 * @typedef {object} TestEvent
 * @property {string} type
 * @property {TestEventData} [data]
 */

/**
 * @typedef {object} LineCursor
 * @property {boolean} atLineStart
 */

/**
 * @param {string} text
 * @param {LineCursor} cursor
 * @param {boolean} raw
 * @returns {string}
 */
function place(text, cursor, raw) {
  if (text.length === 0) {
    return "";
  }
  const out = raw || cursor.atLineStart ? text : `\n${text}`;
  cursor.atLineStart = out.endsWith("\n");
  return out;
}

/**
 * @param {"skip" | "todo" | "fail"} label
 * @param {TestEventData} data
 * @returns {string}
 */
function statusLine(label, data) {
  const reason = label === "skip" ? data.skip : data.todo;
  const suffix =
    typeof reason === "string" && reason.length > 0 ? ` # ${reason}` : "";
  return `${label} ${data.name ?? ""}${suffix}\n`;
}

/**
 * @param {TestEventData} data
 * @returns {string}
 */
function errorText(data) {
  const error = data.details?.error;
  const detail = error?.stack || error?.message || "";
  if (detail.length === 0) {
    return "";
  }
  return detail.endsWith("\n") ? detail : `${detail}\n`;
}

/**
 * @param {TestEventData} data
 * @returns {string}
 */
function failLine(data) {
  const where = data.file
    ? ` (${path.relative(process.cwd(), data.file)})`
    : "";
  return `${statusLine("fail", data).trimEnd()}${where}\n`;
}

/**
 * @param {string} outcome
 * @param {string} logFile
 * @returns {string}
 */
function outcomeBlock(outcome, logFile) {
  const stderrFile = process.env.AGENT_OUTBOX_NODE_TEST_STDERR ?? "";
  return `outcome ${outcome}\nlog ${logFile}\nstderr ${stderrFile}\n`;
}

/**
 * Stdout side of `node --test`. Spec-to-file keeps the full transcript.
 * Ordinary passes are omitted. stdout, stderr, and diagnostics are not filtered.
 *
 * @param {AsyncIterable<TestEvent>} source
 */
export default async function* nodeTestStdioReporter(source) {
  const logFile = process.env.AGENT_OUTBOX_NODE_TEST_LOG ?? "";
  const cursor = { atLineStart: true };
  /** @type {boolean | undefined} */
  let success;
  let closed = false;

  for await (const event of source) {
    const data = event.data ?? {};
    switch (event.type) {
      case "test:stdout":
      case "test:stderr":
        if (typeof data.message === "string") {
          yield place(data.message, cursor, true);
        }
        break;
      case "test:diagnostic": {
        const level = data.level ?? "info";
        const message = String(data.message ?? "");
        const line = level === "info" ? message : `${level} ${message}`;
        yield place(line.endsWith("\n") ? line : `${line}\n`, cursor, false);
        break;
      }
      case "test:pass":
        if (data.skip !== undefined && data.skip !== false) {
          yield place(statusLine("skip", data), cursor, false);
        } else if (data.todo !== undefined && data.todo !== false) {
          yield place(statusLine("todo", data), cursor, false);
        }
        break;
      case "test:fail":
        if (data.todo !== undefined && data.todo !== false) {
          yield place(
            statusLine("todo", data) + errorText(data),
            cursor,
            false
          );
        } else {
          yield place(failLine(data) + errorText(data), cursor, false);
        }
        break;
      case "test:summary":
        if (data.file == null) {
          success = data.success;
        }
        break;
      case "test:interrupted": {
        let text = "interrupted\n";
        for (const item of data.tests ?? []) {
          text += `interrupted ${item.name ?? ""}\n`;
        }
        text += outcomeBlock("interrupted", logFile);
        yield place(text, cursor, false);
        closed = true;
        break;
      }
      default:
        break;
    }
  }

  if (!closed) {
    const outcome =
      success === true ? "pass" : success === false ? "fail" : "incomplete";
    yield place(outcomeBlock(outcome, logFile), cursor, false);
  }
}
