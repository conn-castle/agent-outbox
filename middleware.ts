import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  clerkMiddlewareConfigurationComplete,
  shouldFailClosedForMissingClerkConfiguration
} from "./src/server/middleware-clerk-readiness";
import { middlewareFixtureBypassEnabled } from "./src/server/middleware-fixture-bypass";
import { hostedHostRedirect } from "./src/shared/hosted-origins";
import { SIGNED_IN_PAGE_PATHS } from "./src/shared/sign-in-return";

// OpenNext Cloudflare 1.20.4 has experimental proxy.ts support. Keep
// middleware.ts until the platform verification gate proves proxy.ts parity.
const isProtectedRoute = createRouteMatcher(
  SIGNED_IN_PAGE_PATHS.map((path) => `${path}(.*)`)
);

const protectedMiddleware = clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set(
      "redirect_url",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );
    await auth.protect({
      unauthenticatedUrl: signInUrl.toString()
    });
  }
});

export default function middleware(
  request: NextRequest,
  event: NextFetchEvent
) {
  if (
    request.nextUrl.pathname === "/lantern" ||
    request.nextUrl.pathname.startsWith("/lantern/")
  ) {
    return NextResponse.next();
  }

  const hostRedirect = hostedHostRedirect(
    request.url,
    request.headers.get("host") ?? ""
  );
  if (hostRedirect) {
    const sameOrigin = hostRedirect.origin === new URL(request.url).origin;
    return NextResponse.redirect(hostRedirect, sameOrigin ? 307 : 308);
  }

  if (middlewareFixtureBypassEnabled(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (!clerkMiddlewareConfigurationComplete()) {
    if (
      shouldFailClosedForMissingClerkConfiguration({
        protectedRoute: isProtectedRoute(request)
      })
    ) {
      return new NextResponse("Service unavailable.", {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }

    return NextResponse.next();
  }

  return protectedMiddleware(request, event);
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"]
};
