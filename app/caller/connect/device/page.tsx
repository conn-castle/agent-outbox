import { redirect, unstable_rethrow } from "next/navigation";

import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectDeviceApprovalPreview } from "../../../../src/server/caller-connect";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import type { HumanAccountSession } from "../../../../src/server/human-session";
import { previewDeviceConnect } from "../actions";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../../src/server/caller-connect-clerk-fixture";
import {
  firstParam,
  fixtureClerkUserIdParam,
  reportCallerApprovalFailure,
  requiredCallerConnectSessionConfiguration,
  runCallerConnectHumanTransaction
} from "../session";
import { ConnectActions, ConnectErrorPanel, ConnectPageShell } from "../ui";
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
        <section className="connect-card" aria-labelledby="device-code-heading">
          <h2 id="device-code-heading">Enter the CLI code</h2>
          <form
            id="enter-device-code"
            action={previewDeviceConnect}
            className="form-stack"
          >
            <label className="field">
              <span>User code</span>
              <input
                name="userCode"
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="ABCD-EFGH"
                required
              />
            </label>
            {fixtureClerkUserId ? (
              <input
                type="hidden"
                name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                value={fixtureClerkUserId}
              />
            ) : null}
          </form>
          <ConnectActions>
            <button className="button" form="enter-device-code" type="submit">
              Continue
            </button>
          </ConnectActions>
        </section>
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

  const requestId = createCorrelationId("caller_connect_device_page_req");
  let session: HumanAccountSession | undefined;
  let preview: Awaited<ReturnType<typeof getConnectDeviceApprovalPreview>>;
  const previewStartedAtMs = Date.now();
  try {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId,
        fixtureClerkUserId,
        route: "/caller/connect/device",
        method: "GET"
      },
      (query, humanSession) => {
        session = humanSession;
        return getConnectDeviceApprovalPreview(query, {
          userCode,
          accountId: humanSession.accountId
        });
      }
    );
    if (!transaction.ok) {
      return (
        <ConnectPageShell
          title="We couldn't load this request"
          description="The device connection request could not be verified."
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
      route: "/caller/connect/device",
      method: "GET",
      operation: "caller_connect_device_approval_preview",
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
    throw new Error("Human session is required after device approval setup.");
  }

  if (
    preview.ok &&
    (preview.data.status === "approved" || preview.data.status === "exchanged")
  ) {
    const query = new URLSearchParams({
      flow: "device",
      setup_request_id: preview.data.setup_request_id
    });
    if (fixtureClerkUserId) {
      query.set(CALLER_CONNECT_FIXTURE_USER_ID_PARAM, fixtureClerkUserId);
    }
    redirect(`/caller/connect/success?${query.toString()}`);
  }

  return preview.ok ? (
    <DeviceApprovalView
      preview={preview.data}
      session={session}
      fixtureClerkUserId={fixtureClerkUserId}
      userCode={userCode}
    />
  ) : (
    <ConnectPageShell
      title="We couldn't load this request"
      description="The device connection request could not be verified."
    >
      <ConnectErrorPanel error={preview.error} />
    </ConnectPageShell>
  );
}
