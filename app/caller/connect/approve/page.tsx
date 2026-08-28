import { unstable_rethrow } from "next/navigation";

import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectBrowserApprovalPreview } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import type { HumanAccountSession } from "../../../../src/server/human-session";
import {
  firstParam,
  fixtureClerkUserIdParam,
  reportCallerApprovalFailure,
  requiredCallerConnectSessionConfiguration,
  runCallerConnectHumanTransaction
} from "../session";
import { ConnectErrorPanel, ConnectPageShell } from "../ui";
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
      <ConnectPageShell
        title="This connection request is incomplete"
        description="The request is missing the information needed to continue."
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

  const missing = requiredCallerConnectSessionConfiguration();
  if (missing.length > 0) {
    return (
      <MissingConfigurationPanel
        title="Caller connect route is not configured"
        missing={missing}
      />
    );
  }

  const requestId = createCorrelationId("caller_connect_approve_page_req");
  let session: HumanAccountSession | undefined;
  let preview: Awaited<ReturnType<typeof getConnectBrowserApprovalPreview>>;
  const previewStartedAtMs = Date.now();
  try {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId,
        fixtureClerkUserId,
        route: "/caller/connect/approve",
        method: "GET"
      },
      (query, humanSession) => {
        session = humanSession;
        return getConnectBrowserApprovalPreview(query, { setupRequestId });
      }
    );
    if (!transaction.ok) {
      return (
        <ConnectPageShell
          title="We couldn't load this request"
          description="The connection request could not be verified."
        >
          <ConnectErrorPanel error={transaction} />
        </ConnectPageShell>
      );
    }
    session = transaction.session;
    preview = transaction.data;
  } catch (error) {
    unstable_rethrow(error);
    reportCallerApprovalFailure(error, {
      requestId,
      route: "/caller/connect/approve",
      method: "GET",
      operation: "caller_connect_browser_approval_preview",
      session,
      startedAtMs: previewStartedAtMs
    });
    preview = {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: "Caller connect approval is temporarily unavailable."
      }
    };
  }

  if (!session) {
    throw new Error("Human session is required after caller approval setup.");
  }

  return preview.ok ? (
    <BrowserApprovalView
      preview={preview.data}
      session={session}
      fixtureClerkUserId={fixtureClerkUserId}
    />
  ) : (
    <ConnectPageShell
      title="We couldn't load this request"
      description="The connection request could not be verified."
    >
      <ConnectErrorPanel error={preview.error} />
    </ConnectPageShell>
  );
}
