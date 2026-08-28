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
import { ConnectErrorPanel, ConnectPageShell } from "../ui";
import { ConnectionDeclinedView } from "../views";

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
        <ConnectPageShell
          title="We couldn't confirm the result"
          description="The declined request could not be loaded."
          tone="canceled"
        >
          <ConnectErrorPanel error={transaction} />
        </ConnectPageShell>
      );
    }

    const terminalState = transaction.data;
    if (terminalState.ok) {
      return (
        <ConnectionDeclinedView
          setup={terminalState.data}
          session={transaction.session}
        />
      );
    }

    return (
      <ConnectPageShell
        title="We couldn't confirm the result"
        description="The declined request could not be verified."
        tone="canceled"
      >
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
      <ConnectPageShell
        title="Connection failed"
        description="The request could not be completed."
        tone="canceled"
      >
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }

  return (
    <ConnectPageShell
      title="Connection failed"
      description="The request could not be completed."
      tone="canceled"
    >
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
