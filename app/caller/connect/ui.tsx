import type { ReactNode } from "react";

import { ActionSubmitButton } from "../../../src/components/actions/ActionSubmitButton";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../src/server/caller-connect-clerk-fixture";
import type { HumanAccountSession } from "../../../src/server/human-session";
import { LocalExpiry } from "./LocalExpiry";

type ConnectPageError = {
  status: number | string;
  code: string;
  message: string;
};

type ConnectPageShellProps = {
  title: string;
  description?: string;
  tone?: "default" | "success" | "canceled";
  dense?: boolean;
  children: ReactNode;
};

export type FormAction = (formData: FormData) => void | Promise<void>;

export const MISSING_SETUP_REQUEST_ERROR: ConnectPageError = {
  status: 400,
  code: "invalid_request",
  message: "Missing setup request."
};

type ApprovalPreview = {
  setup_request_id: string;
  operation: string;
  local_caller_name: string;
  display_name: string;
  expires_at: string;
  current_credential?: {
    key_id: string;
    last_chars: string;
  } | null;
};

function titleCase(value: string) {
  return value
    .replace(/^hosted_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function StatusIcon({ tone }: { tone: "default" | "success" | "canceled" }) {
  if (tone === "success") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7.5 12.5 3 3 6-7" />
      </svg>
    );
  }

  if (tone === "canceled") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m8.5 8.5 7 7m0-7-7 7" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="3" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 14.5 14.5 9" />
      <path d="M7.5 16.5H6a4 4 0 0 1 0-8h3" />
      <path d="M16.5 7.5H18a4 4 0 1 1 0 8h-3" />
    </svg>
  );
}

export function ConnectPageShell({
  title,
  description = "Confirm the request before your local caller can continue.",
  tone = "default",
  dense = false,
  children
}: ConnectPageShellProps) {
  return (
    <main className="connect-main">
      <article
        className={`connect-surface connect-surface-${tone}${dense ? " connect-surface-dense" : ""}`}
      >
        <header className="connect-intro">
          <span className="connect-status-icon">
            <StatusIcon tone={tone} />
          </span>
          <h1 className="connect-title">{title}</h1>
          <p>{description}</p>
        </header>
        <div className="connect-content">{children}</div>
      </article>
      <p className="connect-footer-note">Secure connection · Agent Outbox</p>
    </main>
  );
}

export function ConnectErrorPanel({ error }: { error: ConnectPageError }) {
  return (
    <section
      className="connect-card connect-error-card"
      aria-labelledby="connect-error"
    >
      <h2 id="connect-error">This request is unavailable</h2>
      <p>{error.message}</p>
      <details className="connect-technical-details">
        <summary>Technical details</summary>
        <dl className="connect-kv">
          <div>
            <dt>Status</dt>
            <dd>{error.status}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>
              <code>{error.code}</code>
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export function ConnectErrorPage({
  error,
  ...shell
}: Omit<ConnectPageShellProps, "children"> & { error: ConnectPageError }) {
  return (
    <ConnectPageShell {...shell}>
      <ConnectErrorPanel error={error} />
    </ConnectPageShell>
  );
}

export function FixtureIdentity({ value }: { value?: string | null }) {
  return value ? (
    <input
      type="hidden"
      name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
      value={value}
    />
  ) : null;
}

export function DeviceCodeEntryCard({
  formId,
  action,
  fixtureClerkUserId
}: {
  formId: string;
  action: FormAction;
  fixtureClerkUserId?: string | null;
}) {
  return (
    <section className="connect-card" aria-labelledby="device-code-heading">
      <h2 id="device-code-heading">Enter the CLI code</h2>
      <form id={formId} action={action} className="form-stack">
        <label className="field">
          <span>User code</span>
          <input
            name="userCode"
            autoComplete="one-time-code"
            inputMode="text"
            placeholder="ABCD-EFGH"
            required
          />
        </label>
        <FixtureIdentity value={fixtureClerkUserId} />
        <ConnectActions>
          <ActionSubmitButton
            className="button"
            pendingChildren="Checking code…"
          >
            Continue
          </ActionSubmitButton>
        </ConnectActions>
      </form>
    </section>
  );
}

export function AccountSummary({ session }: { session: HumanAccountSession }) {
  const accountName = session.account.label ?? session.account.accountId;

  return (
    <div
      className="connect-identity-row connect-account-row"
      aria-label="Account"
    >
      <span
        className="connect-identity-icon connect-account-mark"
        aria-hidden="true"
      >
        <img src="/agent-outbox-mark.svg" alt="" width="24" height="24" />
      </span>
      <div>
        <span className="connect-identity-label">Connect to</span>
        <strong>{accountName}</strong>
        <p>
          {titleCase(session.role)} · {titleCase(session.account.tier)} plan
        </p>
      </div>
    </div>
  );
}

export function ApprovalSummary({
  preview,
  showCredentialDetails = false
}: {
  preview: ApprovalPreview;
  showCredentialDetails?: boolean;
}) {
  return (
    <>
      <div className="connect-identity-row connect-caller-row">
        <span className="connect-identity-icon" aria-hidden="true">
          <LinkIcon />
        </span>
        <div>
          <span className="connect-identity-label">App requesting access</span>
          <strong>{preview.display_name}</strong>
          <p>CLI name · {preview.local_caller_name}</p>
        </div>
      </div>
      {showCredentialDetails ? (
        <div
          className="connect-credential-details"
          aria-label="Credential operation details"
        >
          <div className="connect-expiry-row">
            <LocalExpiry value={preview.expires_at} />
          </div>
          <dl className="connect-kv">
            <div>
              <dt>Operation</dt>
              <dd>{titleCase(preview.operation)}</dd>
            </div>
            {preview.current_credential ? (
              <div>
                <dt>Current key</dt>
                <dd>
                  <code>{preview.current_credential.key_id}</code> ending{" "}
                  <code>{preview.current_credential.last_chars}</code>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </>
  );
}

export function ConnectionSummary({
  preview,
  session
}: {
  preview: ApprovalPreview & { flow: "browser" | "device" };
  session: HumanAccountSession;
}) {
  return (
    <section
      className="connect-identity-panel"
      aria-label="Caller setup request"
    >
      <div className="connect-flow-context">
        <strong>
          {preview.flow === "browser"
            ? "Browser approval"
            : "Device-code approval"}
        </strong>
        <span>
          {preview.flow === "browser"
            ? "Opened by your CLI in this browser. No device code is used."
            : "Use the code above to verify this is the terminal you started."}
        </span>
      </div>
      <ApprovalSummary preview={preview} />
      <span className="connect-identity-connector" aria-hidden="true" />
      <AccountSummary session={session} />
      <div className="connect-expiry-row">
        <LocalExpiry value={preview.expires_at} />
      </div>
      <details className="connect-inline-details">
        <summary>View request details</summary>
        <dl>
          <div>
            <dt>Request</dt>
            <dd>
              <code>{preview.setup_request_id}</code>
            </dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{titleCase(preview.operation)}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export function OutcomeSummary({
  callerName,
  session
}: {
  callerName: string;
  session: HumanAccountSession;
}) {
  return (
    <div className="connect-outcome-summary" aria-label="Connection summary">
      <span>
        <strong>{callerName}</strong> was requesting access to
      </span>
      <AccountSummary session={session} />
    </div>
  );
}

export function ConnectFlowCard({
  label,
  tone,
  children
}: {
  label: string;
  tone?: "success" | "error";
  children: ReactNode;
}) {
  return (
    <section
      className={`connect-card connect-flow-card${tone ? ` connect-flow-card-${tone}` : ""}`}
      aria-label={label}
    >
      {children}
    </section>
  );
}

export function ConnectActions({ children }: { children: ReactNode }) {
  return <div className="connect-actions">{children}</div>;
}
