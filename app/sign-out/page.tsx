import { SignOutButton } from "@clerk/nextjs";

import { MissingConfigurationPanel } from "../../src/server/ui";

export const dynamic = "force-dynamic";

export default function SignOutPage() {
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <MissingConfigurationPanel
        title="Clerk sign-out is not configured"
        missing={["CLERK_PUBLISHABLE_KEY"]}
      />
    );
  }

  return (
    <main className="main auth-main">
      <section className="panel">
        <h1>Sign out</h1>
        <p>End the current Clerk-backed human session.</p>
        <SignOutButton redirectUrl="/">
          <button className="button" type="button">
            Sign out
          </button>
        </SignOutButton>
      </section>
    </main>
  );
}
