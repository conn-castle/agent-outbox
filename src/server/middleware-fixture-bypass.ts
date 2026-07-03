import { callerConnectClerkFixtureEnabled } from "./caller-connect-clerk-fixture.ts";
import { humanBrowserFixtureEnabled } from "./human-review-fixture-gate.ts";

const CALLER_CONNECT_FIXTURE_ROUTES = [
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

export function middlewareFixtureBypassEnabled(pathname: string) {
  if (
    humanBrowserFixtureEnabled() &&
    (pathname === "/human" || pathname.startsWith("/human/"))
  ) {
    return true;
  }

  return (
    callerConnectClerkFixtureEnabled() &&
    CALLER_CONNECT_FIXTURE_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`)
    )
  );
}
