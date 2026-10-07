import { getSetupRequestTerminalState } from "../../../../src/server/caller-setup-requests";
import { createCorrelationId } from "../../../../src/server/correlation";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  firstParam,
  fixtureClerkUserIdParam,
  requiredCallerConnectSessionConfiguration,
  resolveCallerConnectHumanSession,
  runCallerApprovalTerminalTransaction
} from "../session";
import { ConnectErrorPage, MISSING_SETUP_REQUEST_ERROR } from "../ui";
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
        <ConnectErrorPage
          title="We couldn't confirm this connection"
          description="The completed request could not be loaded."
          error={session}
        />
      );
    }

    return (
      <ConnectErrorPage
        title="We couldn't confirm this connection"
        description="The completed request is missing its reference."
        error={MISSING_SETUP_REQUEST_ERROR}
      />
    );
  }

  const page = await runCallerApprovalTerminalTransaction(
    {
      requestId,
      fixtureClerkUserId,
      route: "/caller/connect/success",
      operation: "caller_connect_terminal_success",
      unavailableMessage: "Caller connect success is temporarily unavailable."
    },
    (query, session) =>
      getSetupRequestTerminalState(query, {
        operation: "connect",
        setupRequestId,
        accountId: session.accountId,
        statuses: ["approved", "exchanged"]
      })
  );
  if (!page.ok) {
    return (
      <ConnectErrorPage
        title="We couldn't confirm this connection"
        description="The completed request could not be loaded."
        error={page.error}
      />
    );
  }

  if (!page.data.ok) {
    return (
      <ConnectErrorPage
        title="We couldn't confirm this connection"
        description="The completed request could not be verified."
        error={page.data.error}
      />
    );
  }

  return (
    <ConnectionSuccessView setup={page.data.data} session={page.session} />
  );
}
