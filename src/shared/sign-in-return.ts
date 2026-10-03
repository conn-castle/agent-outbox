// Pages that require a signed-in user. Middleware protects these paths and
// sign-in returns only to one of them, so a signed-out visit resumes where the
// user started.
export const SIGNED_IN_PAGE_PATHS = [
  "/human",
  "/upgrade",
  "/caller/connect/approve",
  "/caller/connect/device",
  "/caller/connect/success",
  "/caller/connect/error",
  "/caller/rotate/approve",
  "/caller/rotate/device",
  "/caller/rotate/success",
  "/caller/rotate/error",
  "/caller/revoke/approve",
  "/caller/revoke/device",
  "/caller/revoke/success",
  "/caller/revoke/error"
];

export function signInReturnHref(value: string | undefined) {
  if (!value?.startsWith("/")) return undefined;
  try {
    const origin = "https://return.invalid";
    const url = new URL(value, origin);
    return url.origin === origin && SIGNED_IN_PAGE_PATHS.includes(url.pathname)
      ? `${url.pathname}${url.search}`
      : undefined;
  } catch {
    return undefined;
  }
}
