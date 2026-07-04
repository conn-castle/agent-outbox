type ClerkReadinessEnvironment = Readonly<
  Partial<
    Record<
      "APP_ENV" | "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY",
      string | undefined
    >
  >
>;

export function clerkMiddlewareConfigurationComplete(
  environment: ClerkReadinessEnvironment = process.env as ClerkReadinessEnvironment
) {
  return Boolean(
    environment.CLERK_SECRET_KEY && environment.CLERK_PUBLISHABLE_KEY
  );
}

export function shouldFailClosedForMissingClerkConfiguration(input: {
  readonly environment?: ClerkReadinessEnvironment;
  readonly protectedRoute: boolean;
}) {
  const environment =
    input.environment ?? (process.env as ClerkReadinessEnvironment);

  return (
    input.protectedRoute &&
    !appEnvExplicitlyAllowsMissingClerkConfiguration(environment.APP_ENV)
  );
}

function appEnvExplicitlyAllowsMissingClerkConfiguration(
  appEnv: string | undefined
) {
  return appEnv === "development" || appEnv === "test";
}
