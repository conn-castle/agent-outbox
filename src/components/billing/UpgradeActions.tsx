"use client";

import { CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";

type BillingAction = "checkout" | "portal";

export function UpgradeActions({ canOpenPortal }: { canOpenPortal: boolean }) {
  const [pending, setPending] = useState<BillingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(action: BillingAction) {
    setPending(action);
    setError(null);
    try {
      const response = await fetch(`/api/billing/${action}`, {
        method: "POST"
      });
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
    } catch (caught) {
      setPending(null);
      setError(
        caught instanceof Error ? caught.message : "Billing action failed."
      );
    }
  }

  return (
    <section className="panel" aria-labelledby="billing-actions">
      <h2 id="billing-actions">Billing actions</h2>
      <div className="actions">
        <button
          className="button"
          type="button"
          onClick={() => void start("checkout")}
          disabled={pending !== null}
        >
          <CreditCard aria-hidden="true" size={18} />
          {pending === "checkout" ? "Starting..." : "Start checkout"}
        </button>
        {canOpenPortal ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => void start("portal")}
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
