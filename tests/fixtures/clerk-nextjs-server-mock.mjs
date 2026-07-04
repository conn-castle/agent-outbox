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

/**
 * @param {(auth: { protect: () => Promise<void> }, request: Request) => unknown} handler
 * @returns {(request: Request) => unknown}
 */
export function clerkMiddleware(handler) {
  return (request) =>
    handler(
      {
        protect: async () => {
          throw new Error(
            "Unexpected Clerk auth path in middleware missing-configuration test."
          );
        }
      },
      request
    );
}
