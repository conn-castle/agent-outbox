/**
 * @param {readonly string[]} patterns
 * @returns {(request: Request & { nextUrl?: URL }) => boolean}
 */
export function createRouteMatcher(patterns) {
  return (request) => {
    const pathname = request.nextUrl?.pathname ?? new URL(request.url).pathname;

    return patterns.some((pattern) => {
      if (pattern.endsWith("(.*)")) {
        const base = pattern.slice(0, -4);
        return pathname === base || pathname.startsWith(`${base}/`);
      }

      return pathname === pattern;
    });
  };
}

export const clerkMiddlewareMock = { signedOut: false };

let clerkMiddlewareCalls = 0;

export function resetClerkMiddlewareCalls() {
  clerkMiddlewareCalls = 0;
}

export function clerkMiddlewareCallCount() {
  return clerkMiddlewareCalls;
}

/**
 * @param {(auth: { protect: (options: { unauthenticatedUrl: string }) => Promise<void> }, request: Request) => unknown} handler
 * @returns {(request: Request) => unknown}
 */
export function clerkMiddleware(handler) {
  return async (request) => {
    clerkMiddlewareCalls += 1;
    try {
      return await handler(
        {
          protect: async ({ unauthenticatedUrl }) => {
            if (clerkMiddlewareMock.signedOut) {
              throw Response.redirect(unauthenticatedUrl, 307);
            }
            throw new Error(
              "Unexpected Clerk auth path in middleware missing-configuration test."
            );
          }
        },
        request
      );
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };
}
