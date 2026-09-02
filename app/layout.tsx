import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import "sonner/dist/styles.css";

import { AppActionProvider } from "../src/components/actions/AppActionProvider";
import { ClientEventsInit } from "../src/components/observability/ClientEventsInit";
import { SiteFooter } from "../src/components/SiteFooter";
import { SiteHeader } from "../src/components/SiteHeader";
import { humanBrowserFixtureEnabled } from "../src/server/human-review-fixture-gate";
import { cloudflareWebAnalyticsToken } from "../src/server/observability";
import "./globals.css";
import "./review-workspace.css";

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
        <Script
          id="agent-outbox-immediate-action-feedback"
          src="/immediate-action-feedback.js"
          strategy="beforeInteractive"
        />
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
            <AppActionProvider>{content}</AppActionProvider>
          </ClerkProvider>
        ) : (
          <AppActionProvider>{content}</AppActionProvider>
        )}
      </body>
    </html>
  );
}
