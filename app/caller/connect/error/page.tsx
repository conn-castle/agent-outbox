import Link from "next/link";

import { createCorrelationId } from "../../../../src/server/correlation";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  connectTerminalSetupState,
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
  if (code === "setup_denied" && setupRequestId) {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId,
        fixtureClerkUserId,
        route: "/caller/connect/error",
        method: "GET"
      },
      (query, humanSession) =>
        connectTerminalSetupState(query, {
          session: humanSession,
          requestId,
          setupRequestId,
          statuses: ["denied"],
          route: "/caller/connect/error",
          method: "GET",
          operation: "caller_connect_terminal_denied",
          unavailableMessage: "Caller connect error is temporarily unavailable."
        })
    );

    if (!transaction.ok) {
      return (
        <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
          <ConnectErrorPanel error={transaction} />
        </ConnectPageShell>
      );
    }

    const terminalState = transaction.data;
    if (terminalState.ok) {
      const setup = terminalState.data;
      const callerDisplayName =
        setup.caller?.display_name ?? setup.display_name;

      return (
        <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
          <AccountSummary session={transaction.session} />
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
        <ConnectErrorPanel error={terminalState.error} />
      </ConnectPageShell>
    );
  }

  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: "/caller/connect/error",
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Connect failed">
        <ConnectErrorPanel error={session} />
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
