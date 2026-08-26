import { SignIn } from "@clerk/nextjs";

import { LegalAcknowledgement } from "../../../src/components/legal/LegalDocument";
import { GitHubSignInButton } from "../../../src/components/auth/GitHubSignInButton";
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
      <div className="auth-clerk-stack">
        <GitHubSignInButton />
        <SignIn
          routing="path"
          path="/sign-in"
          fallbackRedirectUrl="/human"
          appearance={{
            elements: {
              socialButtonsBlockButton: { display: "none" },
              dividerRow: { display: "none" }
            }
          }}
        />
      </div>
      <LegalAcknowledgement action="continuing" />
    </main>
  );
}
