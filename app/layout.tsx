import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Outbox",
  description: "Human review queue for agent-prepared work."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const content = (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          Agent Outbox
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/human">Human</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>
      {children}
    </div>
  );

  return (
    <html lang="en">
      <body>
        {process.env.CLERK_PUBLISHABLE_KEY ? (
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
