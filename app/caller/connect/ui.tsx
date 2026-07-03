import type { ReactNode } from "react";

import type { HumanAccountSession } from "../../../src/server/human-session";

type ConnectPageError = {
  status: number | string;
  code: string;
  message: string;
};

type ApprovalPreview = {
  operation: string;
  local_caller_name: string;
  display_name: string;
  expires_at: string;
  current_credential?: {
    key_id: string;
    last_chars: string;
  } | null;
};

export function ConnectPageShell({
  eyebrow,
  title,
  children
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="connect-main">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="connect-title">{title}</h1>
      {children}
    </main>
  );
}

export function ConnectErrorPanel({ error }: { error: ConnectPageError }) {
  return (
    <section className="connect-card" aria-labelledby="connect-error">
      <h2 id="connect-error">Connect approval unavailable</h2>
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
      <p>{error.message}</p>
    </section>
  );
}

export function AccountSummary({ session }: { session: HumanAccountSession }) {
  return (
    <section className="connect-card" aria-label="Account">
      <dl className="connect-kv">
        <div>
          <dt>Account</dt>
          <dd>{session.account.label ?? session.account.accountId}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{session.role}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{session.account.tier}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ApprovalSummary({ preview }: { preview: ApprovalPreview }) {
  return (
    <section className="connect-card" aria-label="Caller setup request">
      <dl className="connect-kv">
        <div>
          <dt>Operation</dt>
          <dd>{preview.operation}</dd>
        </div>
        <div>
          <dt>Caller name</dt>
          <dd>{preview.local_caller_name}</dd>
        </div>
        <div>
          <dt>Display name</dt>
          <dd>{preview.display_name}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{preview.expires_at}</dd>
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
    </section>
  );
}

export function ConnectActions({ children }: { children: ReactNode }) {
  return <div className="connect-actions">{children}</div>;
}
