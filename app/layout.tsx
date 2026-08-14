import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";

import { ClientEventsInit } from "../src/components/observability/ClientEventsInit";
import { SiteFooter } from "../src/components/SiteFooter";
import { SiteHeader } from "../src/components/SiteHeader";
import { humanBrowserFixtureEnabled } from "../src/server/human-review-fixture-gate";
import { cloudflareWebAnalyticsToken } from "../src/server/observability";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Outbox",
  description: "An asynchronous human review queue for AI agents."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const browserFixtureEnabled = humanBrowserFixtureEnabled();
  const webAnalyticsToken = cloudflareWebAnalyticsToken();
  const content = (
    <div className="shell">
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  );

  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <ClientEventsInit />
        {webAnalyticsToken ? (
          <Script
            src="https://static.cloudflareinsights.com/beacon.min.js"
            defer
            strategy="afterInteractive"
            data-cf-beacon={JSON.stringify({ token: webAnalyticsToken })}
          />
        ) : null}
        {process.env.CLERK_PUBLISHABLE_KEY && !browserFixtureEnabled ? (
          <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
            {content}
          </ClerkProvider>
        ) : (
          content
        )}
      </body>
    </html>
  );
}
