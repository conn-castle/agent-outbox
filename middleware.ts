import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

// OpenNext Cloudflare 1.20 rejects Next 16's Node.js proxy build output.
// Keep middleware.ts until this pinned adapter supports proxy.ts.
const isProtectedRoute = createRouteMatcher(["/human(.*)"]);

const protectedMiddleware = clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) {
    await auth.protect({
      unauthenticatedUrl: new URL("/sign-in", request.url).toString()
    });
  }
});

export default function middleware(
  request: NextRequest,
  event: NextFetchEvent
) {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    return NextResponse.next();
  }

  return protectedMiddleware(request, event);
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"]
};
