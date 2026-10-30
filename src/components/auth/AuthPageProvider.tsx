import { ClerkProvider } from "@clerk/nextjs";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { humanBrowserFixtureEnabled } from "../../server/human-review-fixture-gate.ts";
import { classifyHost } from "../../shared/hosted-origins.ts";

export default async function AuthPageProvider({
  children
}: {
  children: ReactNode;
}) {
  const websiteHost =
    classifyHost((await headers()).get("host") ?? "") === "website";

  // Auth catch-all paths containing dots skip the middleware's asset matcher.
  // They still need context on the website host, where the root omits it.
  return process.env.CLERK_PUBLISHABLE_KEY &&
    !humanBrowserFixtureEnabled() &&
    websiteHost ? (
    <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
      {children}
    </ClerkProvider>
  ) : (
    children
  );
}
