import { createCorrelationId } from "../../../../src/server/correlation";
import { getConnectDeviceApprovalPreview } from "../../../../src/server/caller-connect";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../../src/server/caller-connect-clerk-fixture";
import { MissingConfigurationPanel } from "../../../../src/server/ui";
import {
  approveDeviceConnect,
  denyDeviceConnect,
  previewDeviceConnect
} from "../actions";
import {
  firstParam,
  fixtureClerkUserIdParam,
  reportCallerApprovalFailure,
  requiredCallerConnectSessionConfiguration,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "../session";
import {
  AccountSummary,
  ApprovalSummary,
  ConnectActions,
  ConnectErrorPanel,
  ConnectPageShell
} from "../ui";

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
      <ConnectPageShell eyebrow="Caller connect" title="Verify device code">
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
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: "/caller/connect/device",
    method: "GET"
  });

  if (!session.ok) {
    return (
      <ConnectPageShell eyebrow="Caller connect" title="Verify device code">
        <ConnectErrorPanel error={session} />
      </ConnectPageShell>
    );
  }

  let preview: Awaited<ReturnType<typeof getConnectDeviceApprovalPreview>>;
  const previewStartedAtMs = Date.now();
  try {
    preview = await runCallerConnectHumanTransaction(
      session,
      requestId,
      (query) => getConnectDeviceApprovalPreview(query, { userCode })
    );
  } catch (error) {
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

  return (
    <ConnectPageShell eyebrow="Caller connect" title="Verify device code">
      <AccountSummary session={session} />
      {preview.ok ? (
        <>
          <ApprovalSummary preview={preview.data} />
          <section className="connect-card" aria-labelledby="device-approve">
            <h2 id="device-approve">Approve this caller</h2>
            <form
              id="approve-device-connect"
              action={approveDeviceConnect}
              className="form-stack"
            >
              <label className="field">
                <span>User code</span>
                <input
                  name="userCode"
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="ABCD-EFGH"
                  defaultValue={userCode}
                  readOnly
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
            <form id="deny-device-connect" action={denyDeviceConnect}>
              <input
                type="hidden"
                name="setupRequestId"
                value={preview.data.setup_request_id}
              />
              {fixtureClerkUserId ? (
                <input
                  type="hidden"
                  name={CALLER_CONNECT_FIXTURE_USER_ID_PARAM}
                  value={fixtureClerkUserId}
                />
              ) : null}
            </form>
            <ConnectActions>
              <button
                className="button"
                form="approve-device-connect"
                type="submit"
              >
                Approve caller
              </button>
              <button
                className="button secondary"
                form="deny-device-connect"
                type="submit"
              >
                Cancel setup
              </button>
            </ConnectActions>
          </section>
        </>
      ) : (
        <ConnectErrorPanel error={preview.error} />
      )}
    </ConnectPageShell>
  );
}
