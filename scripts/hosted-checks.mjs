/**
 * @param {string} name
 * @param {"pass" | "fail" | "action_required"} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export function check(name, status, code, message, details = {}) {
  return { name, status, code, message, ...details };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} fallback
 */
export function responseCode(body, fallback) {
  const nestedError =
    body.error && typeof body.error === "object"
      ? /** @type {Record<string, unknown>} */ (body.error)
      : {};
  return String(body.code ?? nestedError.code ?? fallback);
}

/**
 * @param {unknown} error
 */
export function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "request failed";
}

/**
 * @param {Array<{ status: string }>} checks
 */
export function exitCodeForChecks(checks) {
  if (checks.some((entry) => entry.status === "fail")) {
    return 1;
  }
  if (checks.some((entry) => entry.status === "action_required")) {
    return 2;
  }
  return 0;
}

/**
 * @param {Array<{ status: string }>} checks
 */
export function checksSummary(checks) {
  return {
    ok: checks.every((entry) => entry.status === "pass"),
    action_required: checks.some((entry) => entry.status === "action_required"),
    checks
  };
}

/**
 * @param {string} name
 * @param {() => Promise<{ ok: boolean, status: number, json(): Promise<any> }>} send
 * @param {string} nonJsonMessage
 * @param {(response: { ok: boolean, status: number }, body: Record<string, unknown>) => ReturnType<typeof check>} evaluate
 */
export async function fetchJsonCheck(name, send, nonJsonMessage, evaluate) {
  try {
    const response = await send();
    /** @type {Record<string, unknown>} */
    let body;
    try {
      body = await response.json();
    } catch {
      return check(name, "fail", "invalid_json_response", nonJsonMessage, {
        status_code: response.status
      });
    }
    return evaluate(response, body);
  } catch (error) {
    return check(name, "fail", "request_failed", safeErrorMessage(error));
  }
}

/**
 * @param {() => Map<string, string>} readEnv
 * @param {(env: Map<string, string>) => Promise<Array<ReturnType<typeof check>>>} runChecks
 */
export async function runChecksCli(readEnv, runChecks) {
  let env;
  try {
    env = readEnv();
  } catch (error) {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const checks = await runChecks(env);
  const summary = checksSummary(checks);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = exitCodeForChecks(checks);
}
