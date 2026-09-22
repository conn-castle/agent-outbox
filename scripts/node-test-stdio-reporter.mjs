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
 * @property {{ error?: { stack?: string, message?: string } }} [details]
 */

/**
 * @typedef {object} TestEvent
 * @property {string} type
 * @property {TestEventData} [data]
 */

/**
 * Short stdout view. The spec file keeps the full transcript.
 * Ordinary passes are omitted. stdout, stderr, and diagnostics are not filtered.
 *
 * @param {AsyncIterable<TestEvent>} source
 */
export default async function* nodeTestStdioReporter(source) {
  let atLineStart = true;
  /** @type {boolean | undefined} */
  let success;
  let closed = false;

  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      const message = data.message ?? "";
      if (message.length > 0) {
        yield message;
        atLineStart = message.endsWith("\n");
      }
      continue;
    }

    /** @type {string} */
    let text = "";
    if (event.type === "test:diagnostic") {
      const level = data.level ?? "info";
      const message = data.message ?? "";
      text = level === "info" ? message : `${level} ${message}`;
      if (!text.endsWith("\n")) {
        text += "\n";
      }
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      const skipped = data.skip !== undefined && data.skip !== false;
      const todo = data.todo !== undefined && data.todo !== false;
      if (event.type === "test:pass" && !skipped && !todo) {
        continue;
      }
      const label = todo ? "todo" : skipped ? "skip" : "fail";
      const reason = label === "skip" ? data.skip : data.todo;
      const suffix =
        typeof reason === "string" && reason.length > 0 ? ` # ${reason}` : "";
      const where =
        label === "fail" && data.file
          ? ` (${path.relative(process.cwd(), data.file)})`
          : "";
      text = `${label} ${data.name ?? ""}${where}${suffix}\n`;
      if (event.type === "test:fail") {
        const detail =
          data.details?.error?.stack || data.details?.error?.message || "";
        if (detail.length > 0) {
          text += detail.endsWith("\n") ? detail : `${detail}\n`;
        }
      }
    } else if (event.type === "test:summary" && data.file == null) {
      success = data.success;
      continue;
    } else if (event.type === "test:interrupted") {
      text = "outcome interrupted\n";
      closed = true;
    } else {
      continue;
    }

    if (!atLineStart) {
      yield "\n";
    }
    yield text;
    atLineStart = text.endsWith("\n");
  }

  if (!closed) {
    const outcome =
      success === true ? "pass" : success === false ? "fail" : "incomplete";
    if (!atLineStart) {
      yield "\n";
    }
    yield `outcome ${outcome}\n`;
  }
}
