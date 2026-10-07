import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectBrowserApprovalPreview } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  firstParam,
  fixtureClerkUserIdParam,
  requiredCallerConnectSessionConfiguration,
  runCallerApprovalPageTransaction
} from "../session";
import { ConnectErrorPage, MISSING_SETUP_REQUEST_ERROR } from "../ui";
import { BrowserApprovalView } from "../views";

export const dynamic = "force-dynamic";

export default async function CallerConnectApprovePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const setupRequestId = firstParam(params?.setup_request_id);
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);

  if (!setupRequestId) {
    return (
      <ConnectErrorPage
        title="This connection request is incomplete"
        description="The request is missing the information needed to continue."
        error={MISSING_SETUP_REQUEST_ERROR}
      />
    );
  }

  const missing = requiredCallerConnectSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Caller connect route is not configured"
        missing={missing}
      />
    );
  }

  const page = await runCallerApprovalPageTransaction(
    {
      requestId: createCorrelationId("caller_connect_approve_page_req"),
      fixtureClerkUserId,
      route: "/caller/connect/approve",
      operation: "caller_connect_browser_approval_preview",
      unavailableMessage: "Caller connect approval is temporarily unavailable.",
      missingSessionMessage:
        "Human session is required after caller approval setup."
    },
    (query) => getConnectBrowserApprovalPreview(query, { setupRequestId })
  );
  if (!page.ok) {
    return (
      <ConnectErrorPage
        title="We couldn't load this request"
        description="The connection request could not be verified."
        error={page.error}
      />
    );
  }
  if (!page.data.ok) {
    return (
      <ConnectErrorPage
        title="We couldn't load this request"
        description="The connection request could not be verified."
        error={page.data.error}
      />
    );
  }

  return (
    <BrowserApprovalView
      preview={page.data.data}
      session={page.session}
      fixtureClerkUserId={fixtureClerkUserId}
    />
  );
}
