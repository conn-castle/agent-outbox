"use server";

import { redirect } from "next/navigation";

import {
  approveCredentialOperationBrowserSetupRequest,
  approveCredentialOperationDeviceSetupRequest,
  denyCredentialOperationSetupRequest
} from "../../src/server/caller-credential-operations";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../src/server/caller-connect-clerk-fixture";
import { createCorrelationId } from "../../src/server/correlation";
import {
  reportCallerApprovalFailure,
  resolveCallerConnectHumanSession,
  runCallerConnectHumanTransaction
} from "./connect/session";

type CredentialOperation = "rotate" | "revoke";

export async function approveRotateBrowser(formData: FormData) {
  await approveBrowserOperation("rotate", formData);
}

export async function approveRevokeBrowser(formData: FormData) {
  await approveBrowserOperation("revoke", formData);
}

export async function previewRotateDevice(formData: FormData) {
  await previewDeviceOperation("rotate", formData);
}

export async function previewRevokeDevice(formData: FormData) {
  await previewDeviceOperation("revoke", formData);
}

export async function approveRotateDevice(formData: FormData) {
  await approveDeviceOperation("rotate", formData);
}

export async function approveRevokeDevice(formData: FormData) {
  await approveDeviceOperation("revoke", formData);
}

export async function denyRotateBrowser(formData: FormData) {
  await denyOperation("rotate", formData, "/caller/rotate/approve");
}

export async function denyRevokeBrowser(formData: FormData) {
  await denyOperation("revoke", formData, "/caller/revoke/approve");
}

export async function denyRotateDevice(formData: FormData) {
  await denyOperation("rotate", formData, "/caller/rotate/device");
}

export async function denyRevokeDevice(formData: FormData) {
  await denyOperation("revoke", formData, "/caller/revoke/device");
}

async function approveBrowserOperation(
  operation: CredentialOperation,
  formData: FormData
) {
  const setupRequestId = textField(formData, "setupRequestId");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!setupRequestId) {
    redirect(
      operationErrorPath(
        operation,
        400,
        "invalid_request",
        "Missing setup request.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_approve_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/approve`,
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      operationErrorPath(
        operation,
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
      route: `/caller/${operation}/approve`,
      method: "POST",
      operation: `caller_${operation}_browser_approval`,
      session
    },
    operation,
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        approveCredentialOperationBrowserSetupRequest(query, {
          operation,
          setupRequestId,
          accountId: session.accountId,
          userId: session.userId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      operationErrorPath(
        operation,
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  const callbackUrl = new URL(result.data.callback_url!);
  callbackUrl.searchParams.set("status", "approved");
  callbackUrl.searchParams.set(
    "setup_request_id",
    result.data.setup_request_id
  );
  callbackUrl.searchParams.set("setup_code", result.data.setup_code!);
  redirect(callbackUrl.toString());
}

async function previewDeviceOperation(
  operation: CredentialOperation,
  formData: FormData
) {
  const userCode = textField(formData, "userCode");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!userCode) {
    redirect(
      operationErrorPath(
        operation,
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
  redirect(`/caller/${operation}/device?${query.toString()}`);
}

async function approveDeviceOperation(
  operation: CredentialOperation,
  formData: FormData
) {
  const userCode = textField(formData, "userCode");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!userCode) {
    redirect(
      operationErrorPath(
        operation,
        400,
        "invalid_request",
        "Missing device code.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_device_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route: `/caller/${operation}/device`,
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      operationErrorPath(
        operation,
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
      route: `/caller/${operation}/device`,
      method: "POST",
      operation: `caller_${operation}_device_approval`,
      session
    },
    operation,
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        approveCredentialOperationDeviceSetupRequest(query, {
          operation,
          userCode,
          accountId: session.accountId,
          userId: session.userId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      operationErrorPath(
        operation,
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  const query = new URLSearchParams({
    setup_request_id: result.data.setup_request_id
  });
  appendFixtureClerkUserId(query, fixtureClerkUserId);
  redirect(`/caller/${operation}/success?${query.toString()}`);
}

async function denyOperation(
  operation: CredentialOperation,
  formData: FormData,
  route: string
) {
  const setupRequestId = textField(formData, "setupRequestId");
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  if (!setupRequestId) {
    redirect(
      operationErrorPath(
        operation,
        400,
        "invalid_request",
        "Missing setup request.",
        fixtureClerkUserId
      )
    );
  }

  const requestId = createCorrelationId(`caller_${operation}_deny_req`);
  const session = await resolveCallerConnectHumanSession({
    requestId,
    fixtureClerkUserId,
    route,
    method: "POST"
  });
  if (!session.ok) {
    redirect(
      operationErrorPath(
        operation,
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
      operation: `caller_${operation}_deny`,
      session
    },
    operation,
    () =>
      runCallerConnectHumanTransaction(session, requestId, (query) =>
        denyCredentialOperationSetupRequest(query, {
          operation,
          setupRequestId,
          accountId: session.accountId
        })
      ),
    fixtureClerkUserId
  );

  if (!result.ok) {
    redirect(
      operationErrorPath(
        operation,
        result.error.status,
        result.error.code,
        result.error.message,
        fixtureClerkUserId
      )
    );
  }

  redirect(
    operationErrorPath(
      operation,
      200,
      "setup_denied",
      `Caller ${operation} was canceled.`,
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
  operation: CredentialOperation,
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
      operationErrorPath(
        operation,
        503,
        "temporary_unavailable",
        `Caller ${operation} approval is temporarily unavailable.`,
        fixtureClerkUserId
      )
    );
  }
}

function operationErrorPath(
  operation: CredentialOperation,
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
  return `/caller/${operation}/error?${query.toString()}`;
}

function appendFixtureClerkUserId(
  query: URLSearchParams,
  fixtureClerkUserId?: string
) {
  if (fixtureClerkUserId) {
    query.set(CALLER_CONNECT_FIXTURE_USER_ID_PARAM, fixtureClerkUserId);
  }
}
