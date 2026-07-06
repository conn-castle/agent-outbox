"use client";

import { CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";

type BillingInterval = "monthly" | "yearly";
type BillingAction = BillingInterval | "portal";

export function UpgradeActions({ canOpenPortal }: { canOpenPortal: boolean }) {
  const [pending, setPending] = useState<BillingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(interval: BillingInterval) {
    setPending(interval);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval })
      });
      await handleBillingResponse(response);
    } catch (caught) {
      setPending(null);
      setError(
        caught instanceof Error ? caught.message : "Billing action failed."
      );
    }
  }

  async function startPortal() {
    setPending("portal");
    setError(null);
    try {
      const response = await fetch("/api/billing/portal", {
        method: "POST"
      });
      await handleBillingResponse(response);
    } catch (caught) {
      setPending(null);
      setError(
        caught instanceof Error ? caught.message : "Billing action failed."
      );
    }
  }

  async function handleBillingResponse(response: Response) {
    const body = await response.json().catch(() => null);
    if (
      !response.ok ||
      body?.ok !== true ||
      typeof body.data?.url !== "string"
    ) {
      throw new Error(
        typeof body?.error?.message === "string"
          ? body.error.message
          : "Billing action failed."
      );
    }
    window.location.assign(body.data.url);
  }

  return (
    <section className="panel" aria-labelledby="billing-actions">
      <h2 id="billing-actions">Billing actions</h2>
      <div className="actions">
        <button
          className="button"
          type="button"
          onClick={() => void startCheckout("monthly")}
          disabled={pending !== null}
        >
          <CreditCard aria-hidden="true" size={18} />
          {pending === "monthly" ? "Starting $5/mo..." : "Start $5/mo checkout"}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => void startCheckout("yearly")}
          disabled={pending !== null}
        >
          <CreditCard aria-hidden="true" size={18} />
          {pending === "yearly"
            ? "Starting $50/year..."
            : "Start $50/year checkout"}
        </button>
        {canOpenPortal ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => void startPortal()}
            disabled={pending !== null}
          >
            <ExternalLink aria-hidden="true" size={18} />
            {pending === "portal" ? "Opening..." : "Open billing portal"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
