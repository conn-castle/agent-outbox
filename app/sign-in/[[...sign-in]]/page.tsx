import { SignIn } from "@clerk/nextjs";

import { LegalAcknowledgement } from "../../../src/components/legal/LegalDocument";
import { GitHubSignInButton } from "../../../src/components/auth/GitHubSignInButton";
import { MissingConfigurationPanel } from "../../../src/server/ui";
import { firstSearchParam } from "../../../src/shared/human-review-view";
import { signInReturnHref } from "../../../src/shared/sign-in-return";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnHref = signInReturnHref(firstSearchParam(params?.redirect_url));
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
        <GitHubSignInButton redirectUrl={returnHref} />
        <SignIn
          routing="path"
          path="/sign-in"
          fallbackRedirectUrl="/human"
          forceRedirectUrl={returnHref}
          appearance={{
            elements: {
              socialButtonsBlockButton: { display: "none" },
              socialButtonsIconButton: { display: "none" },
              dividerRow: { display: "none" }
            }
          }}
        />
      </div>
      <LegalAcknowledgement action="continuing" />
    </main>
  );
}
