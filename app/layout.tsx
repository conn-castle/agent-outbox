import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import type { ReactNode } from "react";

import { ClientEventsInit } from "../src/components/observability/ClientEventsInit";
import { humanBrowserFixtureEnabled } from "../src/server/human-review-fixture-gate";
import { cloudflareWebAnalyticsToken } from "../src/server/observability";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Outbox",
  description: "Human review queue for agent-prepared work."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const browserFixtureEnabled = humanBrowserFixtureEnabled();
  const webAnalyticsToken = cloudflareWebAnalyticsToken();
  const content = (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          Agent Outbox
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/human">Human</Link>
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up">Sign up</Link>
        </nav>
      </header>
      {children}
      <footer className="site-footer">
        <p>&copy; {new Date().getUTCFullYear()} Conn Castle Studios.</p>
        <nav className="footer-nav" aria-label="Legal and support">
          <Link href="/contact">Contact</Link>
          <Link href="/privacy-policy">Privacy</Link>
          <Link href="/terms-of-service">Terms</Link>
          <a href="https://github.com/conn-castle/agent-outbox/blob/main/LICENSE">
            Software license
          </a>
        </nav>
      </footer>
    </div>
  );

  return (
    <html lang="en">
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
