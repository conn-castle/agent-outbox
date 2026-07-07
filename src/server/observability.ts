const SAFE_PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_RELEASE_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const SAFE_SENTRY_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function runtimeRelease() {
  return firstSafeValue(process.env.SENTRY_RELEASE, process.env.GITHUB_SHA);
}

export function sentryReleaseUploadEnabled() {
  const uploadConfig = sentryReleaseUploadConfig();

  return (
    process.env.APP_ENV === "production" &&
    process.env.AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD === "1" &&
    process.env.AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH === "1" &&
    Boolean(process.env.SENTRY_AUTH_TOKEN) &&
    Boolean(uploadConfig) &&
    Boolean(runtimeRelease())
  );
}

export function sentryReleaseUploadConfig() {
  const org = safeSentrySlug(process.env.SENTRY_ORG);
  const project = safeSentrySlug(process.env.SENTRY_PROJECT);

  if (!org || !project) {
    return null;
  }

  return { org, project };
}

export function cloudflareWebAnalyticsToken() {
  if (process.env.APP_ENV !== "production") {
    return null;
  }

  const token = process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN?.trim();
  if (!token || !SAFE_PUBLIC_TOKEN_PATTERN.test(token)) {
    return null;
  }

  return token;
}

function firstSafeValue(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && SAFE_RELEASE_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

function safeSentrySlug(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || !SAFE_SENTRY_SLUG_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}
