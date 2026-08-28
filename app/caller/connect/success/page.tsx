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
import { ConnectionSuccessView } from "../views";

export const dynamic = "force-dynamic";

export default async function CallerConnectSuccessPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);
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

  const requestId = createCorrelationId("caller_connect_success_page_req");
  if (!setupRequestId) {
    const session = await resolveCallerConnectHumanSession({
      requestId,
      fixtureClerkUserId,
      route: "/caller/connect/success",
      method: "GET"
    });
    if (!session.ok) {
      return (
        <ConnectPageShell
          title="We couldn't confirm this connection"
          description="The completed request could not be loaded."
        >
          <ConnectErrorPanel error={session} />
        </ConnectPageShell>
      );
    }

    return (
      <ConnectPageShell
        title="We couldn't confirm this connection"
        description="The completed request is missing its reference."
      >
        <ConnectErrorPanel
          error={{
            status: 400,
            code: "invalid_request",
            message: "Missing setup request."
          }}
        />
      </ConnectPageShell>
    );
  }

  const transaction = await runCallerConnectHumanTransaction(
    {
      requestId,
      fixtureClerkUserId,
      route: "/caller/connect/success",
      method: "GET"
    },
    (query, humanSession) =>
      connectTerminalSetupState(query, {
        session: humanSession,
        requestId,
        setupRequestId,
        statuses: ["approved", "exchanged"],
        route: "/caller/connect/success",
        method: "GET",
        operation: "caller_connect_terminal_success",
        unavailableMessage: "Caller connect success is temporarily unavailable."
      })
  );
  if (!transaction.ok) {
    return (
      <ConnectPageShell
        title="We couldn't confirm this connection"
        description="The completed request could not be loaded."
      >
        <ConnectErrorPanel error={transaction} />
      </ConnectPageShell>
    );
  }

  const setupState = transaction.data;

  if (!setupState.ok) {
    return (
      <ConnectPageShell
        title="We couldn't confirm this connection"
        description="The completed request could not be verified."
      >
        <ConnectErrorPanel error={setupState.error} />
      </ConnectPageShell>
    );
  }

  return (
    <ConnectionSuccessView
      setup={setupState.data}
      session={transaction.session}
    />
  );
}
