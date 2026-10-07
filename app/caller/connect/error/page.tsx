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
import { ConnectErrorPage } from "../ui";
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
    const page = await runCallerApprovalTerminalTransaction(
      {
        requestId,
        fixtureClerkUserId,
        route: "/caller/connect/error",
        operation: "caller_connect_terminal_denied",
        unavailableMessage: "Caller connect error is temporarily unavailable."
      },
      (query, session) =>
        getSetupRequestTerminalState(query, {
          operation: "connect",
          setupRequestId,
          accountId: session.accountId,
          statuses: ["denied"]
        })
    );

    if (!page.ok) {
      return (
        <ConnectErrorPage
          title="We couldn't confirm the result"
          description="The declined request could not be loaded."
          tone="canceled"
          error={page.error}
        />
      );
    }

    if (page.data.ok) {
      return (
        <ConnectionDeclinedView setup={page.data.data} session={page.session} />
      );
    }

    return (
      <ConnectErrorPage
        title="We couldn't confirm the result"
        description="The declined request could not be verified."
        tone="canceled"
        error={page.data.error}
      />
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
      <ConnectErrorPage
        title="Connection failed"
        description="The request could not be completed."
        tone="canceled"
        error={session}
      />
    );
  }

  return (
    <ConnectErrorPage
      title="Connection failed"
      description="The request could not be completed."
      tone="canceled"
      error={{ status, code, message }}
    />
  );
}
