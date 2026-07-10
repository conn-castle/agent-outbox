import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

import { LegalAcknowledgement } from "../../../src/components/legal/LegalDocument";
import {
  browserFixtureSignupHref,
  humanBrowserFixtureEnabled
} from "../../../src/server/human-review-fixture";
import { MissingConfigurationPanel } from "../../../src/server/ui";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  if (humanBrowserFixtureEnabled()) {
    return (
      <main className="main">
        <section className="panel">
          <p className="eyebrow">Public signup</p>
          <h1>Browser fixture signup</h1>
          <p>
            This deterministic test path represents Clerk-hosted signup in the
            browser harness and lands on the protected review queue.
          </p>
          <Link className="button" href={browserFixtureSignupHref()}>
            Create test account
          </Link>
          <LegalAcknowledgement action="continuing" />
        </section>
      </main>
    );
  }

  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    return (
      <MissingConfigurationPanel
        title="Clerk sign-up is not configured"
        missing={["CLERK_PUBLISHABLE_KEY"]}
      />
    );
  }

  return (
    <main className="main auth-main">
      <SignUp routing="path" path="/sign-up" fallbackRedirectUrl="/human" />
      <LegalAcknowledgement action="continuing" />
    </main>
  );
}
