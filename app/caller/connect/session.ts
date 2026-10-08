import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import {
  CALLER_CONNECT_FIXTURE_USER_ID_HEADER,
  CALLER_CONNECT_FIXTURE_USER_ID_PARAM,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../../../src/server/caller-connect-clerk-fixture";
import {
  getSetupRequestTerminalState,
  type SetupTerminalStatus
} from "../../../src/server/caller-setup-requests";
import { createCorrelationId } from "../../../src/server/correlation";
import {
  type ProductTransactionQuery,
  withSavepoint
} from "../../../src/server/database";
import {
  type HumanAccountSession,
  type HumanAccountSessionResult,
  requiredHumanSessionConfiguration,
  resolveHumanAccountSession,
  runHumanAccountTransaction
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
  const clerkUserId = await callerConnectClerkUserId(input.fixtureClerkUserId);
  return resolveHumanAccountSession({
    clerkUserId,
    requestId: input.requestId,
    route: input.route,
    method: input.method
  });
}

export async function runCallerConnectHumanTransaction<TResult>(
  input: {
    requestId: string;
    fixtureClerkUserId?: string | null;
    route: string;
    method: string;
  },
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<TResult>
) {
  const clerkUserId = await callerConnectClerkUserId(input.fixtureClerkUserId);
  return runHumanAccountTransaction(
    {
      clerkUserId,
      requestId: input.requestId,
      route: input.route,
      method: input.method
    },
    callback
  );
}

export async function runCallerPageTransaction<TResult>(
  input: {
    requestId: string;
    fixtureClerkUserId?: string | null;
    route: string;
    operation: string;
    unavailableMessage: string;
    missingSessionMessage?: string;
  },
  callback: (
    query: ProductTransactionQuery,
    session: HumanAccountSession
  ) => Promise<TResult>
): Promise<
  | { ok: true; session: HumanAccountSession; data: TResult }
  | { ok: false; error: { status: number; code: string; message: string } }
> {
  const startedAtMs = Date.now();
  let activeSession: HumanAccountSession | undefined;
  try {
    const transaction = await runCallerConnectHumanTransaction(
      {
        requestId: input.requestId,
        fixtureClerkUserId: input.fixtureClerkUserId,
        route: input.route,
        method: "GET"
      },
      (query, session) => {
        activeSession = session;
        return callback(query, session);
      }
    );
    if (!transaction.ok) {
      return { ok: false, error: transaction };
    }
    return {
      ok: true,
      session: transaction.session,
      data: transaction.data
    };
  } catch (error) {
    unstable_rethrow(error);
    reportCallerApprovalFailure(error, {
      requestId: input.requestId,
      route: input.route,
      method: "GET",
      operation: input.operation,
      session: activeSession,
      startedAtMs
    });
    if (!activeSession && input.missingSessionMessage) {
      throw new Error(input.missingSessionMessage);
    }
    return {
      ok: false,
      error: {
        status: 503,
        code: "temporary_unavailable",
        message: input.unavailableMessage
      }
    };
  }
}

async function callerConnectClerkUserId(
  inputFixtureClerkUserId?: string | null
) {
  const headerFixtureClerkUserId = callerConnectFixtureClerkUserId(
    (await headers()).get(CALLER_CONNECT_FIXTURE_USER_ID_HEADER)
  );
  const fixtureClerkUserId =
    callerConnectFixtureClerkUserId(inputFixtureClerkUserId) ??
    headerFixtureClerkUserId;

  if (fixtureClerkUserId) {
    return fixtureClerkUserId;
  }

  const session = await auth.protect({
    unauthenticatedUrl: "/sign-in"
  });

  return session.userId;
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

export async function connectTerminalSetupState(
  query: ProductTransactionQuery,
  input: {
    session: HumanAccountSession;
    requestId: string;
    setupRequestId: string;
    statuses: readonly [SetupTerminalStatus, ...SetupTerminalStatus[]];
    route: string;
    method: string;
    operation: string;
    unavailableMessage: string;
  }
) {
  const startedAtMs = Date.now();
  try {
    return await withSavepoint(query, "caller_connect_terminal_state", () =>
      getSetupRequestTerminalState(query, {
        operation: "connect",
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
