import Link from "next/link";

import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectTerminalSetupState } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  firstParam,
  fixtureClerkUserIdParam,
  requiredCallerConnectSessionConfiguration,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "../session";
import {
  AccountSummary,
  ConnectActions,
  ConnectErrorPanel,
  ConnectPageShell
} from "../ui";

export const dynamic = "force-dynamic";

export default async function CallerConnectErrorPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
  const status = firstParam(params?.status) ?? "400";
  const code = firstParam(params?.code) ?? "invalid_request";
  const message =
    firstParam(params?.message) ??
    "Caller connect approval could not continue.";
  const setupRequestId = firstParam(params?.setup_request_id);
  const missing = requiredCallerConnectSessionConfiguration();

  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Caller connect route is not configured"
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId("caller_connect_error_page_req");
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }
  if (code === "setup_denied" && setupRequestId) {
    let setupState: Awaited<ReturnType<typeof getConnectTerminalSetupState>>;
    try {
      setupState = await runCallerConnectHumanTransaction(
        session,
        requestId,
        (query) =>
          getConnectTerminalSetupState(query, {
            setupRequestId,
            accountId: session.accountId,
            statuses: ["denied"]
          })
      );
    } catch {
      setupState = {
        ok: false,
        error: {
          status: 503,
          code: "temporary_unavailable",
          message: "Caller connect error is temporarily unavailable."
        }
      };
    }
    if (setupState.ok) {
      const setup = setupState.data;
      const callerDisplayName =
        setup.caller?.display_name ?? setup.display_name;

      return (
        <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
          <AccountSummary session={session} />
          <section className="connect-card" aria-label="Approval error">
            <dl className="connect-kv">
              <div>
                <dt>Status</dt>
                <dd>
                  <code>{setup.status}</code>
                </dd>
              </div>
              <div>
                <dt>Code</dt>
                <dd>
                  <code>setup_denied</code>
                </dd>
              </div>
              <div>
                <dt>Caller</dt>
                <dd>{callerDisplayName}</dd>
              </div>
              <div>
                <dt>Setup request</dt>
                <dd>
                  <code>{setup.setup_request_id}</code>
                </dd>
              </div>
            </dl>
            <p>Caller setup was canceled.</p>
            <ConnectActions>
              <Link className="button secondary" href="/caller/connect/device">
                Enter device code
              </Link>
            </ConnectActions>
          </section>
        </ConnectPageShell>
      );
    }

    return (
      <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
        <ConnectErrorPanel error={setupState.error} />
      </ConnectPageShell>
    );
  }

  return (
    <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
      <ConnectErrorPanel
        error={{
          status,
          code,
          message
        }}
      />
    </ConnectPageShell>
  );
}
