"use client";

import { CreditCard, ExternalLink } from "lucide-react";
import { useState } from "react";

import { installImmediateActionFeedback } from "../actions/immediate-action-feedback";

installImmediateActionFeedback();

type BillingInterval = "monthly" | "yearly";
type BillingAction = BillingInterval | "portal";

export function UpgradeActions({ canOpenPortal }: { canOpenPortal: boolean }) {
  const [pending, setPending] = useState<BillingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  function schedulePending(action: BillingAction) {
    let settled = false;
    window.setTimeout(() => {
      if (settled) return;
      setPending(action);
      setError(null);
    }, 0);
    return () => {
      settled = true;
    };
  }

  async function startCheckout(interval: BillingInterval) {
    const settle = schedulePending(interval);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval })
      });
      await handleBillingResponse(response);
    } catch (caught) {
      settle();
      setPending(null);
      setError(
        caught instanceof Error ? caught.message : "Billing action failed."
      );
    }
  }

  async function startPortal() {
    const settle = schedulePending("portal");
    try {
      const response = await fetch("/api/billing/portal", {
        method: "POST"
      });
      await handleBillingResponse(response);
    } catch (caught) {
      settle();
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
      typeof body.data.url !== "string"
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
    <section
      className="billing-actions-panel"
      aria-labelledby="billing-actions"
    >
      <header>
        <p>Hosted paid</p>
        <h2 id="billing-actions">One plan, two ways to pay</h2>
      </header>
      <div className="billing-options">
        <button
          className="billing-option"
          type="button"
          onClick={() => void startCheckout("monthly")}
          disabled={pending !== null}
          data-immediate-action-label="Starting..."
          aria-label={
            pending === "monthly" ? "Starting $5/mo..." : "Start $5/mo checkout"
          }
        >
          <span>Monthly</span>
          <strong>
            $5 <small>/ month</small>
          </strong>
          <span>Simple month-to-month billing</span>
          <span className="billing-option-action">
            <CreditCard aria-hidden="true" size={16} />
            <span
              key={pending ?? error ?? "idle"}
              data-immediate-action-feedback
              suppressHydrationWarning
            >
              {pending === "monthly" ? "Starting..." : "Choose monthly"}
            </span>
          </span>
        </button>
        <button
          className="billing-option featured"
          type="button"
          onClick={() => void startCheckout("yearly")}
          disabled={pending !== null}
          data-immediate-action-label="Starting..."
          aria-label={
            pending === "yearly"
              ? "Starting $50/year..."
              : "Start $50/year checkout"
          }
        >
          <span>Yearly · save $10</span>
          <strong>
            $50 <small>/ year</small>
          </strong>
          <span>One annual payment</span>
          <span className="billing-option-action">
            <CreditCard aria-hidden="true" size={16} />
            <span
              key={pending ?? error ?? "idle"}
              data-immediate-action-feedback
              suppressHydrationWarning
            >
              {pending === "yearly" ? "Starting..." : "Choose yearly"}
            </span>
          </span>
        </button>
      </div>
      {canOpenPortal ? (
        <div className="billing-portal-row">
          <div>
            <strong>Already subscribed?</strong>
            <span>Update payment details or manage your subscription.</span>
          </div>
          <button
            className="button secondary"
            type="button"
            onClick={() => void startPortal()}
            disabled={pending !== null}
            data-immediate-action-label="Opening..."
          >
            <ExternalLink aria-hidden="true" size={18} />
            <span
              key={pending ?? error ?? "idle"}
              data-immediate-action-feedback
              suppressHydrationWarning
            >
              {pending === "portal" ? "Opening..." : "Open billing portal"}
            </span>
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
