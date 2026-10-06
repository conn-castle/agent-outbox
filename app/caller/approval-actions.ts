"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import {
  approveConnectBrowserSetupRequest,
  approveConnectDeviceSetupRequest,
  denyConnectSetupRequest,
  type ConnectDeviceApprovalData
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

type ApprovalData = ConnectDeviceApprovalData & {
  callback_url?: string;
  setup_code?: string;
};

type ApprovalError = { status: number; code: string; message: string };

const MISSING_FIELD_MESSAGES = {
  setupRequestId: "Missing setup request.",
  userCode: "Missing device code."
};

export async function approveBrowserConnect(formData: FormData) {
  await approve("connect", "browser", formData);
}

export async function previewDeviceConnect(formData: FormData) {
  await previewDevice("connect", formData);
}

export async function approveDeviceConnect(formData: FormData) {
  await approve("connect", "device", formData);
}

export async function denyBrowserConnect(formData: FormData) {
  await deny("connect", "approve", formData);
}

export async function denyDeviceConnect(formData: FormData) {
  await deny("connect", "device", formData);
}

export async function approveRotateBrowser(formData: FormData) {
  await approve("rotate", "browser", formData);
}

export async function approveRevokeBrowser(formData: FormData) {
  await approve("revoke", "browser", formData);
}

export async function previewRotateDevice(formData: FormData) {
  await previewDevice("rotate", formData);
}

export async function previewRevokeDevice(formData: FormData) {
  await previewDevice("revoke", formData);
}

export async function approveRotateDevice(formData: FormData) {
  await approve("rotate", "device", formData);
}

export async function approveRevokeDevice(formData: FormData) {
  await approve("revoke", "device", formData);
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

/**
 * Browser success returns to the approved callback. Device success stays local:
 * connect includes flow and caller; rotate/revoke include only the request ID.
 */
async function approve(
  operation: ApprovalOperation,
  flow: "browser" | "device",
  formData: FormData
) {
  const { value, fixtureClerkUserId } = approvalInput(
    operation,
    formData,
    flow === "browser" ? "setupRequestId" : "userCode"
  );
  const page = flow === "browser" ? "approve" : "device";
  const data = await runApproval<ApprovalData>(
    operation,
    {
      requestId: createCorrelationId(`caller_${operation}_${page}_req`),
      route: `/caller/${operation}/${page}`,
      operation: `caller_${operation}_${flow}_approval`
    },
    (query, session) => {
      const input = { accountId: session.accountId, userId: session.userId };
      if (flow === "browser") {
        const browserInput = { setupRequestId: value, ...input };
        return operation === "connect"
          ? approveConnectBrowserSetupRequest(query, browserInput)
          : approveCredentialOperationBrowserSetupRequest(query, {
              operation,
              ...browserInput
            });
      }
      const deviceInput = { userCode: value, ...input };
      return operation === "connect"
        ? approveConnectDeviceSetupRequest(query, deviceInput)
        : approveCredentialOperationDeviceSetupRequest(query, {
            operation,
            ...deviceInput
          });
    },
    fixtureClerkUserId
  );

  if (flow === "browser") {
    const callbackUrl = new URL(data.callback_url!);
    callbackUrl.searchParams.set("status", "approved");
    callbackUrl.searchParams.set("setup_request_id", data.setup_request_id);
    callbackUrl.searchParams.set("setup_code", data.setup_code!);
    redirect(callbackUrl.toString());
  }
  const successParams: Record<string, string> =
    operation === "connect"
      ? {
          flow: "device",
          setup_request_id: data.setup_request_id,
          caller: data.caller.display_name
        }
      : { setup_request_id: data.setup_request_id };
  const query = queryWithFixture(successParams, fixtureClerkUserId);
  redirect(`/caller/${operation}/success?${query}`);
}

/** Previews the trimmed device code without opening a transaction. */
async function previewDevice(operation: ApprovalOperation, formData: FormData) {
  const { value: userCode, fixtureClerkUserId } = approvalInput(
    operation,
    formData,
    "userCode"
  );
  const query = queryWithFixture({ user_code: userCode }, fixtureClerkUserId);
  redirect(`/caller/${operation}/device?${query}`);
}

/** Denial uses its originating page for session/report context and the domain-returned request ID. */
async function deny(
  operation: ApprovalOperation,
  page: "approve" | "device",
  formData: FormData
) {
  const { value: setupRequestId, fixtureClerkUserId } = approvalInput(
    operation,
    formData,
    "setupRequestId"
  );
  const data = await runApproval(
    operation,
    {
      requestId: createCorrelationId(`caller_${operation}_deny_req`),
      route: `/caller/${operation}/${page}`,
      operation: `caller_${operation}_deny`
    },
    (query, session) => {
      const input = {
        setupRequestId,
        accountId: session.accountId
      };
      return operation === "connect"
        ? denyConnectSetupRequest(query, input)
        : denyCredentialOperationSetupRequest(query, { operation, ...input });
    },
    fixtureClerkUserId
  );

  redirect(
    errorPath(
      operation,
      {
        status: 200,
        code: "setup_denied",
        message:
          operation === "connect"
            ? "Caller setup was canceled."
            : `Caller ${operation} was canceled.`
      },
      fixtureClerkUserId,
      data.setup_request_id
    )
  );
}

/** Validates before session/domain work; retains the fixture identity for redirects. */
function approvalInput(
  operation: ApprovalOperation,
  formData: FormData,
  key: keyof typeof MISSING_FIELD_MESSAGES
) {
  const value = textField(formData, key);
  const fixtureClerkUserId = textField(
    formData,
    CALLER_CONNECT_FIXTURE_USER_ID_PARAM
  );
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
  return { value, fixtureClerkUserId };
}

function textField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Runs `callback` in the caller-connect human transaction and returns its
 * successful domain data. Session and domain errors redirect without reporting;
 * framework control flow is rethrown before unexpected failures are reported.
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

/** Error query order is status, code, message, fixture identity, then request ID. */
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

/** Appends fixture identity after the supplied parameters, preserving their order. */
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
