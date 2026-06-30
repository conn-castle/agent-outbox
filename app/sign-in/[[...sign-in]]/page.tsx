import { SignIn } from "@clerk/nextjs";

import { MissingConfigurationPanel } from "../../../src/server/ui";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <MissingConfigurationPanel
        title="Clerk sign-in is not configured"
        missing={["CLERK_PUBLISHABLE_KEY"]}
      />
    );
  }

  return (
    <main className="main">
      <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/human" />
    </main>
  );
}
