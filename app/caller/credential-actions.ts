"use server";

import { redirect } from "next/navigation";

import {
  approveCredentialOperationBrowserSetupRequest,
  approveCredentialOperationDeviceSetupRequest,
  denyCredentialOperationSetupRequest
} from "../../src/server/caller-credential-operations";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../src/server/caller-connect-clerk-fixture";
import { createCorrelationId } from "../../src/server/correlation";
import type { ProductTransactionQuery } from "../../src/server/database";
import type { HumanAccountSession } from "../../src/server/human-session";
import {
  reportCallerApprovalFailure,
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
  const result = await runApprovalTransaction(
    {
      requestId,
      route: `/caller/${operation}/approve`,
      method: "POST",
      operation: `caller_${operation}_browser_approval`
    },
    operation,
    (query, session) =>
      approveCredentialOperationBrowserSetupRequest(query, {
        operation,
        setupRequestId,
        accountId: session.accountId,
        userId: session.userId
      }),
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
  const result = await runApprovalTransaction(
    {
      requestId,
      route: `/caller/${operation}/device`,
      method: "POST",
      operation: `caller_${operation}_device_approval`
    },
    operation,
    (query, session) =>
      approveCredentialOperationDeviceSetupRequest(query, {
        operation,
        userCode,
        accountId: session.accountId,
        userId: session.userId
      }),
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
  const result = await runApprovalTransaction(
    {
      requestId,
      route,
      method: "POST",
      operation: `caller_${operation}_deny`
    },
    operation,
    (query, session) =>
      denyCredentialOperationSetupRequest(query, {
        operation,
        setupRequestId,
        accountId: session.accountId
      }),
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

async function runApprovalTransaction<TResult>(
  reportContext: {
    requestId: string;
    route: string;
    method: string;
    operation: string;
  },
  operation: CredentialOperation,
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<TResult>,
  fixtureClerkUserId: string
): Promise<TResult> {
  const startedAtMs = Date.now();
  let activeSession: HumanAccountSession | undefined;
  let transaction;
  try {
    transaction = await runCallerConnectHumanTransaction(
      {
        requestId: reportContext.requestId,
        fixtureClerkUserId,
        route: reportContext.route,
        method: reportContext.method
      },
      (query, session) => {
        activeSession = session;
        return callback(query, session);
      }
    );
  } catch (error) {
    reportCallerApprovalFailure(error, {
      ...reportContext,
      session: activeSession,
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

  if (!transaction.ok) {
    redirect(
      operationErrorPath(
        operation,
        transaction.status,
        transaction.code,
        transaction.message,
        fixtureClerkUserId
      )
    );
  }
  return transaction.data;
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
