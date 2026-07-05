import { auth } from "@clerk/nextjs/server";

import { UpgradeActions } from "../../src/components/billing/UpgradeActions";
import { createCorrelationId } from "../../src/server/correlation";
import {
  requiredHumanSessionConfiguration,
  resolveHumanAccountSession
} from "../../src/server/human-session";
import { MissingConfigurationPanel } from "../../src/server/ui";

export const dynamic = "force-dynamic";

export default async function UpgradePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const checkout = Array.isArray(params?.checkout)
    ? params.checkout[0]
    : params?.checkout;
  const missing = requiredHumanSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Billing route is not configured"
        missing={missing}
      />
    );
  }

  const session = await auth.protect({ unauthenticatedUrl: "/sign-in" });
  const humanSession = await resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId: createCorrelationId("upgrade_req")
  });

  if (!humanSession.ok) {
    return (
      <main className="main">
        <section className="panel">
          <h1>Billing unavailable</h1>
          <p>{humanSession.message}</p>
        </section>
      </main>
    );
  }

  const canOpenPortal = humanSession.account.billingStatus !== "not_applicable";

  return (
    <main className="main">
      <p className="eyebrow">Billing</p>
      <h1 className="title">Upgrade Agent Outbox</h1>
      <p className="lede">
        Move this account to the hosted paid tier for paid limits and billing
        management.
      </p>
      {checkout ? (
        <section className="panel" role="status">
          <h2>Checkout {checkout === "success" ? "completed" : "cancelled"}</h2>
          <p>
            Account billing status updates after Stripe sends the matching
            webhook event.
          </p>
        </section>
      ) : null}
      <UpgradeActions canOpenPortal={canOpenPortal} />
    </main>
  );
}
