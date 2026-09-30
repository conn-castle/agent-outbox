import { SignOutButton } from "@clerk/nextjs";

import { MissingConfigurationPanel } from "../../src/server/ui";

export const dynamic = "force-dynamic";

export default function SignOutPage() {
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="ph-no-capture">
        <MissingConfigurationPanel
          title="Clerk sign-out is not configured"
          missing={["CLERK_PUBLISHABLE_KEY"]}
        />
      </div>
    );
  }

  return (
    <main className="main auth-main ph-no-capture">
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
