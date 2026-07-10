import { SignIn } from "@clerk/nextjs";

import { LegalAcknowledgement } from "../../../src/components/legal/LegalDocument";
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
    <main className="main auth-main">
      <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/human" />
      <LegalAcknowledgement action="continuing" />
    </main>
  );
}
