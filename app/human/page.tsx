import { auth, currentUser } from "@clerk/nextjs/server";

import { MissingConfigurationPanel } from "../../src/server/ui";

export const dynamic = "force-dynamic";

export default async function HumanPlaceholderPage() {
  const missing = ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"].filter(
    (name) => !process.env[name]
  );
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Protected human route is not configured"
        missing={missing}
      />
    );
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const user = await currentUser();

  return (
    <main className="main">
      <p className="eyebrow">Protected human placeholder</p>
      <h1 className="title">Review queue shell</h1>
      <section className="panel">
        <h2>Server-side Clerk lookup</h2>
        <ul className="status-list">
          <li>
            <span>Session user</span>
            <code>{session.userId}</code>
          </li>
          <li>
            <span>User object resolved</span>
            <code>{user ? "yes" : "no"}</code>
          </li>
        </ul>
      </section>
    </main>
  );
}
