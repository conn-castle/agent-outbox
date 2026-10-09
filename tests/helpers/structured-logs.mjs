/**
 * @param {() => unknown | Promise<unknown>} callback
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function captureStructuredLogs(callback) {
  const originals = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];

  console.error = (line) => {
    lines.push(JSON.parse(String(line)));
  };
  console.log = (line) => {
    lines.push(JSON.parse(String(line)));
  };
  console.warn = (line) => {
    lines.push(JSON.parse(String(line)));
  };

  try {
    await callback();
  } finally {
    console.error = originals.error;
    console.log = originals.log;
    console.warn = originals.warn;
  }

  return lines;
}
