import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";

import { getConnectTerminalSetupState } from "../../../src/server/caller-connect";
import {
  CALLER_CONNECT_FIXTURE_USER_ID_HEADER,
  CALLER_CONNECT_FIXTURE_USER_ID_PARAM,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../../../src/server/caller-connect-clerk-fixture";
import { createCorrelationId } from "../../../src/server/correlation";
import {
  runProductTransaction,
  type ProductTransactionQuery
} from "../../../src/server/database";
import {
  type HumanAccountSession,
  type HumanAccountSessionResult,
  requiredHumanSessionConfiguration,
  resolveHumanAccountSession
} from "../../../src/server/human-session";
import { durationSinceMs } from "../../../src/server/logging";
import { reportRuntimeFailure } from "../../../src/server/sentry";

export function requiredCallerConnectSessionConfiguration() {
  if (!callerConnectClerkFixtureEnabled()) {
    return requiredHumanSessionConfiguration();
  }

  return process.env.DATABASE_APP_ROLE_URL ? [] : ["DATABASE_APP_ROLE_URL"];
}

export async function resolveCallerConnectHumanSession(input: {
  requestId: string;
  fixtureClerkUserId?: string | null;
  route?: string;
  method?: string;
}): Promise<HumanAccountSessionResult> {
  const headerFixtureClerkUserId = callerConnectFixtureClerkUserId(
    (await headers()).get(CALLER_CONNECT_FIXTURE_USER_ID_HEADER)
  );
  const fixtureClerkUserId =
    callerConnectFixtureClerkUserId(input.fixtureClerkUserId) ??
    headerFixtureClerkUserId;

  if (fixtureClerkUserId) {
    return resolveHumanAccountSession({
      clerkUserId: fixtureClerkUserId,
      requestId: input.requestId,
      route: input.route,
      method: input.method
    });
  }

  const session = await auth.protect({
    unauthenticatedUrl: "/sign-in"
  });

  return resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId: input.requestId,
    route: input.route,
    method: input.method
  });
}

export async function runCallerConnectHumanTransaction<TResult>(
  session: HumanAccountSession,
  requestId: string,
  callback: (query: ProductTransactionQuery) => Promise<TResult>
) {
  const connectionString = process.env.DATABASE_APP_ROLE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_APP_ROLE_URL is required after session setup.");
  }

  return runProductTransaction(
    connectionString,
    {
      requestId,
      authSurface: "human",
      accountId: session.accountId,
      userId: session.userId
    },
    callback
  );
}

export function reportCallerApprovalFailure(
  error: unknown,
  input: {
    requestId: string;
    route: string;
    method: string;
    operation: string;
    session?: Pick<HumanAccountSession, "accountId">;
    startedAtMs?: number;
  }
) {
  return reportRuntimeFailure(error, {
    errorId: createCorrelationId("caller_approval"),
    request_id: input.requestId,
    surface: "app",
    route: input.route,
    method: input.method,
    status_code: 503,
    duration_ms: durationSinceMs(input.startedAtMs),
    operation: input.operation,
    account_id: input.session?.accountId,
    message: "Caller approval flow failed unexpectedly."
  });
}

type ConnectTerminalStatus = "approved" | "exchanged" | "denied";

export async function connectTerminalSetupState(input: {
  session: HumanAccountSession;
  requestId: string;
  setupRequestId: string;
  statuses: readonly ConnectTerminalStatus[];
  route: string;
  method: string;
  operation: string;
  unavailableMessage: string;
}) {
  const startedAtMs = Date.now();
  try {
    return await runCallerConnectHumanTransaction(
      input.session,
      input.requestId,
      (query) =>
        getConnectTerminalSetupState(query, {
          setupRequestId: input.setupRequestId,
          accountId: input.session.accountId,
          statuses: input.statuses
        })
    );
  } catch (error) {
    reportCallerApprovalFailure(error, {
      requestId: input.requestId,
      route: input.route,
      method: input.method,
      operation: input.operation,
      session: input.session,
      startedAtMs
    });
    return {
      ok: false as const,
      error: {
        status: 503 as const,
        code: "temporary_unavailable" as const,
        message: input.unavailableMessage
      }
    };
  }
}

export function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function fixtureClerkUserIdParam(
  params: Record<string, string | string[] | undefined> | undefined
) {
  return firstParam(params?.[CALLER_CONNECT_FIXTURE_USER_ID_PARAM]);
}
