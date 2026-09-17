export function humanBrowserFixtureEnabled() {
  return (
    (process.env.NODE_ENV !== "production" ||
      process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE === "1") &&
    process.env.APP_ENV === "test" &&
    process.env.AGENT_OUTBOX_BROWSER_FIXTURE === "1"
  );
}
