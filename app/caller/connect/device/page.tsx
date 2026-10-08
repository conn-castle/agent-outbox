import { redirect } from "next/navigation";

import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectDeviceApprovalPreview } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import { previewDeviceConnect } from "../../approval-actions";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../../src/server/caller-connect-clerk-fixture";
import {
  firstParam,
  fixtureClerkUserIdParam,
  requiredCallerConnectSessionConfiguration,
  runCallerPageTransaction
} from "../session";
import { ConnectErrorPage, ConnectPageShell, DeviceCodeEntryCard } from "../ui";
import { DeviceApprovalView } from "../views";

export const dynamic = "force-dynamic";

export default async function CallerConnectDevicePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const userCode = firstParam(params?.user_code) ?? "";
  const fixtureClerkUserId = fixtureClerkUserIdParam(params);

  if (!userCode) {
    return (
      <ConnectPageShell
        title="Enter your device code"
        description="Use the code shown in the terminal where you started the connection."
      >
        <DeviceCodeEntryCard
          formId="enter-device-code"
          action={previewDeviceConnect}
          fixtureClerkUserId={fixtureClerkUserId}
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

  const page = await runCallerPageTransaction(
    {
      requestId: createCorrelationId("caller_connect_device_page_req"),
      fixtureClerkUserId,
      route: "/caller/connect/device",
      operation: "caller_connect_device_approval_preview",
      unavailableMessage: "Caller connect approval is temporarily unavailable.",
      missingSessionMessage:
        "Human session is required after device approval setup."
    },
    (query, session) =>
      getConnectDeviceApprovalPreview(query, {
        userCode,
        accountId: session.accountId
      })
  );
  const errorCopy = {
    title: "We couldn't load this request",
    description: "The device connection request could not be verified."
  };
  if (!page.ok) {
    return <ConnectErrorPage {...errorCopy} error={page.error} />;
  }
  if (!page.data.ok) {
    return <ConnectErrorPage {...errorCopy} error={page.data.error} />;
  }
  const preview = page.data.data;

  if (preview.status === "approved" || preview.status === "exchanged") {
    const query = new URLSearchParams({
      flow: "device",
      setup_request_id: preview.setup_request_id
    });
    if (fixtureClerkUserId) {
      query.set(CALLER_CONNECT_FIXTURE_USER_ID_PARAM, fixtureClerkUserId);
    }
    redirect(`/caller/connect/success?${query.toString()}`);
  }

  return (
    <DeviceApprovalView
      preview={preview}
      session={page.session}
      fixtureClerkUserId={fixtureClerkUserId}
      userCode={userCode}
    />
  );
}
