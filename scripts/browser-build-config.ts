export function browserBuildConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  const enabled = environment.AGENT_OUTBOX_BROWSER_BUILD === "1";
  if (enabled) {
    if (environment.APP_ENV !== "test") {
      throw new Error("Browser builds require APP_ENV=test.");
    }
    for (const name of ["APP_BASE_URL", "PUBLIC_APP_BASE_URL"] as const) {
      const value = environment[name];
      if (!value || !URL.canParse(value)) {
        throw new Error(`Browser builds require a loopback HTTP ${name}.`);
      }
      const url = new URL(value);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error(`Browser builds require a loopback HTTP ${name}.`);
      }
    }
  }
  return {
    distDir: enabled ? ".next-browser" : ".next",
    typescript: {
      tsconfigPath: enabled ? "tsconfig.browser.json" : "tsconfig.json"
    },
    // Next replaces this reference at compile time, including in server code.
    // Never derive it from a runtime environment variable of the same name.
    env: { AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE: enabled ? "1" : "0" }
  };
}

export function browserBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    NODE_ENV: "production",
    APP_ENV: "test",
    AGENT_OUTBOX_BROWSER_BUILD: "1",
    AGENT_OUTBOX_BROWSER_FIXTURE: "1",
    AGENT_OUTBOX_BROWSER_COVERAGE_FIXTURE: "1",
    AGENT_OUTBOX_CONNECT_CLERK_FIXTURE: "1",
    // Next must not inherit a developer database, including from .env, during
    // prerendering. The runtime server supplies its disposable URL separately.
    DATABASE_APP_ROLE_URL: ""
  };
}
