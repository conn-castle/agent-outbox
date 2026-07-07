"use server";

import { redirect } from "next/navigation";

import { createCorrelationId } from "../../../src/server/correlation";
import {
  approveConnectBrowserSetupRequest,
  approveConnectDeviceSetupRequest,
  denyConnectSetupRequest
} from "../../../src/server/caller-connect";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../../src/server/caller-connect-clerk-fixture";
import {
  reportCallerApprovalFailure,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "./session";

export async function approveBrowserConnect(formData: FormData) {
  const setupRequestId = textField(formData, "setupRequestId");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!setupRequestId) {
    redirect(
      connectErrorPath(
        400,
        "invalid_request",
        "Missing setup request.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId("caller_connect_approve_req");
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: "/caller/connect/approve",
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      connectErrorPath(
        session.status,
        session.code,
        session.message,
        fixtureClerkUserId
      )
    );
  }

  const result = await withApprovalErrorPage(
    {
      requestId,
      route: "/caller/connect/approve",
      method: "POST",
      operation: "caller_connect_browser_approval",
      session
    },
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        approveConnectBrowserSetupRequest(query, {
          setupRequestId,
          accountId: session.accountId,
          userId: session.userId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      connectErrorPath(
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  const callbackUrl = new URL(result.data.callback_url);
  callbackUrl.searchParams.set("status", "approved");
  callbackUrl.searchParams.set(
    "setup_request_id",
    result.data.setup_request_id
  );
  callbackUrl.searchParams.set("setup_code", result.data.setup_code);
  redirect(callbackUrl.toString());
}

export async function previewDeviceConnect(formData: FormData) {
  const userCode = textField(formData, "userCode");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!userCode) {
    redirect(
      connectErrorPath(
        400,
        "invalid_request",
        "Missing device code.",
        fixtureClerkUserId
      )
    );
  }

  const query = new URLSearchParams({
    user_code: userCode
  });
  appendFixtureClerkUserId(query, fixtureClerkUserId);
  redirect(`/caller/connect/device?${query.toString()}`);
}

export async function approveDeviceConnect(formData: FormData) {
  const userCode = textField(formData, "userCode");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!userCode) {
    redirect(
      connectErrorPath(
        400,
        "invalid_request",
        "Missing device code.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId("caller_connect_device_req");
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: "/caller/connect/device",
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      connectErrorPath(
        session.status,
        session.code,
        session.message,
        fixtureClerkUserId
      )
    );
  }

  const result = await withApprovalErrorPage(
    {
      requestId,
      route: "/caller/connect/device",
      method: "POST",
      operation: "caller_connect_device_approval",
      session
    },
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        approveConnectDeviceSetupRequest(query, {
          userCode,
          accountId: session.accountId,
          userId: session.userId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      connectErrorPath(
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  const query = new URLSearchParams({
    flow: "device",
    setup_request_id: result.data.setup_request_id,
    caller: result.data.caller.display_name
  });
  appendFixtureClerkUserId(query, fixtureClerkUserId);
  redirect(`/caller/connect/success?${query.toString()}`);
}

export async function denyBrowserConnect(formData: FormData) {
  await denyConnect(formData, "/caller/connect/approve");
}

export async function denyDeviceConnect(formData: FormData) {
  await denyConnect(formData, "/caller/connect/device");
}

async function denyConnect(formData: FormData, route: string) {
  const setupRequestId = textField(formData, "setupRequestId");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!setupRequestId) {
    redirect(
      connectErrorPath(
        400,
        "invalid_request",
        "Missing setup request.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId("caller_connect_deny_req");
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route,
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      connectErrorPath(
        session.status,
        session.code,
        session.message,
        fixtureClerkUserId
      )
    );
  }

  const result = await withApprovalErrorPage(
    {
      requestId,
      route,
      method: "POST",
      operation: "caller_connect_deny",
      session
    },
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        denyConnectSetupRequest(query, {
          setupRequestId,
          accountId: session.accountId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      connectErrorPath(
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  redirect(
    connectErrorPath(
      200,
      "setup_denied",
      "Caller setup was canceled.",
      fixtureClerkUserId,
      result.data.setup_request_id
    )
  );
}

function textField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fixtureClerkUserIdField(formData: FormData) {
  return textField(formData, CALLER_CONNECT_FIXTURE_USER_ID_PARAM);
}

async function withApprovalErrorPage<TResult>(
  reportContext: Parameters<typeof reportCallerApprovalFailure>[1],
  callback: () => Promise<TResult>,
  fixtureClerkUserId: string
): Promise<TResult> {
  const startedAtMs = Date.now();
  try {
    return await callback();
  } catch (error) {
    reportCallerApprovalFailure(error, {
      ...reportContext,
      startedAtMs
    });
    redirect(
      connectErrorPath(
        503,
        "temporary_unavailable",
        "Caller connect approval is temporarily unavailable.",
        fixtureClerkUserId
      )
    );
  }
}

function connectErrorPath(
  status: number,
  code: string,
  message: string,
  fixtureClerkUserId?: string,
  setupRequestId?: string
) {
  const query = new URLSearchParams({
    status: String(status),
    code,
    message
  });
  appendFixtureClerkUserId(query, fixtureClerkUserId);
  if (setupRequestId) {
    query.set("setup_request_id", setupRequestId);
  }
  return `/caller/connect/error?${query.toString()}`;
}

function appendFixtureClerkUserId(
  query: URLSearchParams,
  fixtureClerkUserId?: string
) {
  if (fixtureClerkUserId) {
    query.set(CALLER_CONNECT_FIXTURE_USER_ID_PARAM, fixtureClerkUserId);
  }
}
