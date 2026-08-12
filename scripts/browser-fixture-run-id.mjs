const BROWSER_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** @param {string} value */
export function validateBrowserFixtureRunId(value) {
  if (!BROWSER_RUN_ID_PATTERN.test(value)) {
    throw new Error(
      "AGENT_OUTBOX_BROWSER_RUN_ID must contain only letters, digits, underscores, periods, and hyphens."
    );
  }
  return value;
}
