"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import {
  approveConnectBrowserSetupRequest,
  approveConnectDeviceSetupRequest,
  denyConnectSetupRequest
} from "../../src/server/caller-connect";
import { CALLER_CONNECT_FIXTURE_USER_ID_PARAM } from "../../src/server/caller-connect-clerk-fixture";
import {
  approveCredentialOperationBrowserSetupRequest,
  approveCredentialOperationDeviceSetupRequest,
  denyCredentialOperationSetupRequest
} from "../../src/server/caller-credential-operations";
import type { SetupResult } from "../../src/server/caller-setup-requests";
import { createCorrelationId } from "../../src/server/correlation";
import type { ProductTransactionQuery } from "../../src/server/database";
import type { HumanAccountSession } from "../../src/server/human-session";
import {
  reportCallerApprovalFailure,
  runCallerConnectHumanTransaction
} from "./connect/session";

type ApprovalOperation = "connect" | "rotate" | "revoke";

type ApprovalError = { status: number; code: string; message: string };

type ApprovalHandlers = {
  approveBrowser(
    query: ProductTransactionQuery,
    input: { setupRequestId: string; accountId: string; userId: string }
  ): Promise<
    SetupResult<{
      setup_request_id: string;
      setup_code?: string;
      callback_url?: string;
    }>
  >;
  /** Resolves to the success page's query parameters. */
  approveDevice(
    query: ProductTransactionQuery,
    input: { userCode: string; accountId: string; userId: string }
  ): Promise<SetupResult<Record<string, string>>>;
  deny(
    query: ProductTransactionQuery,
    input: { setupRequestId: string; accountId: string }
  ): Promise<SetupResult<{ setup_request_id: string }>>;
  deniedMessage: string;
};

const APPROVAL_HANDLERS: Record<ApprovalOperation, ApprovalHandlers> = {
  connect: {
    approveBrowser: approveConnectBrowserSetupRequest,
    async approveDevice(query, input) {
      const result = await approveConnectDeviceSetupRequest(query, input);
      return result.ok
        ? {
            ok: true,
            data: {
              flow: "device",
              setup_request_id: result.data.setup_request_id,
              caller: result.data.caller.display_name
            }
          }
        : result;
    },
    deny: denyConnectSetupRequest,
    deniedMessage: "Caller setup was canceled."
  },
  rotate: credentialOperationHandlers("rotate"),
  revoke: credentialOperationHandlers("revoke")
};

const MISSING_FIELD_MESSAGES = {
  setupRequestId: "Missing setup request.",
  userCode: "Missing device code."
};

export async function approveBrowserConnect(formData: FormData) {
  await approveBrowser("connect", formData);
}

export async function previewDeviceConnect(formData: FormData) {
  await previewDevice("connect", formData);
}

export async function approveDeviceConnect(formData: FormData) {
  await approveDevice("connect", formData);
}

export async function denyBrowserConnect(formData: FormData) {
  await deny("connect", "approve", formData);
}

export async function denyDeviceConnect(formData: FormData) {
  await deny("connect", "device", formData);
}

export async function approveRotateBrowser(formData: FormData) {
  await approveBrowser("rotate", formData);
}

export async function approveRevokeBrowser(formData: FormData) {
  await approveBrowser("revoke", formData);
}

export async function previewRotateDevice(formData: FormData) {
  await previewDevice("rotate", formData);
}

export async function previewRevokeDevice(formData: FormData) {
  await previewDevice("revoke", formData);
}

export async function approveRotateDevice(formData: FormData) {
  await approveDevice("rotate", formData);
}

export async function approveRevokeDevice(formData: FormData) {
  await approveDevice("revoke", formData);
}

export async function denyRotateBrowser(formData: FormData) {
  await deny("rotate", "approve", formData);
}

export async function denyRevokeBrowser(formData: FormData) {
  await deny("revoke", "approve", formData);
}

export async function denyRotateDevice(formData: FormData) {
  await deny("rotate", "device", formData);
}

export async function denyRevokeDevice(formData: FormData) {
  await deny("revoke", "device", formData);
}

function credentialOperationHandlers(
  operation: "rotate" | "revoke"
): ApprovalHandlers {
  return {
    approveBrowser: (query, input) =>
      approveCredentialOperationBrowserSetupRequest(query, {
        operation,
        ...input
      }),
    async approveDevice(query, input) {
      const result = await approveCredentialOperationDeviceSetupRequest(query, {
        operation,
        ...input
      });
      return result.ok
        ? { ok: true, data: { setup_request_id: result.data.setup_request_id } }
        : result;
    },
    deny: (query, input) =>
      denyCredentialOperationSetupRequest(query, { operation, ...input }),
    deniedMessage: `Caller ${operation} was canceled.`
  };
}

async function approveBrowser(
  operation: ApprovalOperation,
  formData: FormData
) {
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  const setupRequestId = requiredField(
    operation,
    formData,
    "setupRequestId",
    fixtureClerkUserId
  );
  const data = await runApproval(
    operation,
    {
      requestId: createCorrelationId(`caller_${operation}_approve_req`),
      route: `/caller/${operation}/approve`,
      operation: `caller_${operation}_browser_approval`
    },
    (query, session) =>
      APPROVAL_HANDLERS[operation].approveBrowser(query, {
        setupRequestId,
        accountId: session.accountId,
        userId: session.userId
      }),
    fixtureClerkUserId
  );

  const callbackUrl = new URL(data.callback_url!);
  callbackUrl.searchParams.set("status", "approved");
  callbackUrl.searchParams.set("setup_request_id", data.setup_request_id);
  callbackUrl.searchParams.set("setup_code", data.setup_code!);
  redirect(callbackUrl.toString());
}

async function previewDevice(operation: ApprovalOperation, formData: FormData) {
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  const userCode = requiredField(
    operation,
    formData,
    "userCode",
    fixtureClerkUserId
  );
  const query = queryWithFixture({ user_code: userCode }, fixtureClerkUserId);
  redirect(`/caller/${operation}/device?${query}`);
}

async function approveDevice(operation: ApprovalOperation, formData: FormData) {
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  const userCode = requiredField(
    operation,
    formData,
    "userCode",
    fixtureClerkUserId
  );
  const successParams = await runApproval(
    operation,
    {
      requestId: createCorrelationId(`caller_${operation}_device_req`),
      route: `/caller/${operation}/device`,
      operation: `caller_${operation}_device_approval`
    },
    (query, session) =>
      APPROVAL_HANDLERS[operation].approveDevice(query, {
        userCode,
        accountId: session.accountId,
        userId: session.userId
      }),
    fixtureClerkUserId
  );

  const query = queryWithFixture(successParams, fixtureClerkUserId);
  redirect(`/caller/${operation}/success?${query}`);
}

async function deny(
  operation: ApprovalOperation,
  page: "approve" | "device",
  formData: FormData
) {
  const fixtureClerkUserId = fixtureClerkUserIdField(formData);
  const setupRequestId = requiredField(
    operation,
    formData,
    "setupRequestId",
    fixtureClerkUserId
  );
  const data = await runApproval(
    operation,
    {
      requestId: createCorrelationId(`caller_${operation}_deny_req`),
      route: `/caller/${operation}/${page}`,
      operation: `caller_${operation}_deny`
    },
    (query, session) =>
      APPROVAL_HANDLERS[operation].deny(query, {
        setupRequestId,
        accountId: session.accountId
      }),
    fixtureClerkUserId
  );

  redirect(
    errorPath(
      operation,
      {
        status: 200,
        code: "setup_denied",
        message: APPROVAL_HANDLERS[operation].deniedMessage
      },
      fixtureClerkUserId,
      data.setup_request_id
    )
  );
}

function requiredField(
  operation: ApprovalOperation,
  formData: FormData,
  key: keyof typeof MISSING_FIELD_MESSAGES,
  fixtureClerkUserId: string
) {
  const value = textField(formData, key);
  if (!value) {
    redirect(
      errorPath(
        operation,
        {
          status: 400,
          code: "invalid_request",
          message: MISSING_FIELD_MESSAGES[key]
        },
        fixtureClerkUserId
      )
    );
  }
  return value;
}

function textField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fixtureClerkUserIdField(formData: FormData) {
  return textField(formData, CALLER_CONNECT_FIXTURE_USER_ID_PARAM);
}

/**
 * Runs `callback` in the caller-connect human transaction and returns its
 * data, redirecting to the operation's error page on any session, domain, or
 * unexpected failure.
 */
async function runApproval<TData>(
  operation: ApprovalOperation,
  reportContext: { requestId: string; route: string; operation: string },
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<SetupResult<TData>>,
  fixtureClerkUserId: string
): Promise<TData> {
  const startedAtMs = Date.now();
  let activeSession: HumanAccountSession | undefined;
  let transaction;
  try {
    transaction = await runCallerConnectHumanTransaction(
      {
        requestId: reportContext.requestId,
        fixtureClerkUserId,
        route: reportContext.route,
        method: "POST"
      },
      (query, session) => {
        activeSession = session;
        return callback(query, session);
      }
    );
  } catch (error) {
    unstable_rethrow(error);
    reportCallerApprovalFailure(error, {
      ...reportContext,
      method: "POST",
      session: activeSession,
      startedAtMs
    });
    redirect(
      errorPath(
        operation,
        {
          status: 503,
          code: "temporary_unavailable",
          message: `Caller ${operation} approval is temporarily unavailable.`
        },
        fixtureClerkUserId
      )
    );
  }

  if (!transaction.ok) {
    redirect(errorPath(operation, transaction, fixtureClerkUserId));
  }
  if (!transaction.data.ok) {
    redirect(errorPath(operation, transaction.data.error, fixtureClerkUserId));
  }
  return transaction.data.data;
}

function errorPath(
  operation: ApprovalOperation,
  error: ApprovalError,
  fixtureClerkUserId: string,
  setupRequestId?: string
) {
  const query = queryWithFixture(
    { status: String(error.status), code: error.code, message: error.message },
    fixtureClerkUserId
  );
  if (setupRequestId) {
    query.set("setup_request_id", setupRequestId);
  }
  return `/caller/${operation}/error?${query}`;
}

function queryWithFixture(
  params: Record<string, string>,
  fixtureClerkUserId: string
) {
  const query = new URLSearchParams(params);
  if (fixtureClerkUserId) {
    query.set(CALLER_CONNECT_FIXTURE_USER_ID_PARAM, fixtureClerkUserId);
  }
  return query;
}
