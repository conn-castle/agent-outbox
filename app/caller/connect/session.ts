import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import {
  CALLER_CONNECT_FIXTURE_USER_ID_HEADER,
  CALLER_CONNECT_FIXTURE_USER_ID_PARAM,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../../../src/server/caller-connect-clerk-fixture";
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

type CallerApprovalPageInput = {
  requestId: string;
  fixtureClerkUserId?: string | null;
  route: string;
  operation: string;
  unavailableMessage: string;
};

type CallerApprovalPageResult<TResult> =
  | { ok: true; session: HumanAccountSession; data: TResult }
  | { ok: false; error: { status: number; code: string; message: string } };

type CallerApprovalPageCallback<TResult> = (
  query: ProductTransactionQuery,
  session: HumanAccountSession
) => Promise<TResult>;

// Recovers any unexpected page failure as a 503 page error. Pages that cannot
// render without a session pass missingSessionMessage to throw that message
// after reporting failures that happen before one exists.
export async function runCallerApprovalPageTransaction<TResult>(
  input: CallerApprovalPageInput & { missingSessionMessage?: string },
  callback: CallerApprovalPageCallback<TResult>
): Promise<CallerApprovalPageResult<TResult>> {
  const startedAtMs = Date.now();
  let activeSession: HumanAccountSession | undefined;
  try {
    return await runCallerApprovalTransaction(input, (query, session) => {
      activeSession = session;
      return callback(query, session);
    });
  } catch (error) {
    unstable_rethrow(error);
    reportCallerApprovalPageFailure(error, input, activeSession, startedAtMs);
    if (!activeSession && input.missingSessionMessage) {
      throw new Error(input.missingSessionMessage);
    }
    return callerApprovalPageUnavailable(input);
  }
}

// Recovers only callback failures, inside a savepoint, as a 503 result in the
// page data so the account bootstrap still commits. Session and transaction
// failures propagate to the route boundary.
export async function runCallerApprovalTerminalTransaction<TResult>(
  input: CallerApprovalPageInput,
  callback: CallerApprovalPageCallback<TResult>
): Promise<
  CallerApprovalPageResult<
    TResult | ReturnType<typeof callerApprovalPageUnavailable>
  >
> {
  return runCallerApprovalTransaction(input, async (query, session) => {
    const startedAtMs = Date.now();
    try {
      return await withSavepoint(query, "caller_connect_terminal_state", () =>
        callback(query, session)
      );
    } catch (error) {
      reportCallerApprovalPageFailure(error, input, session, startedAtMs);
      return callerApprovalPageUnavailable(input);
    }
  });
}

async function runCallerApprovalTransaction<TResult>(
  input: CallerApprovalPageInput,
  callback: CallerApprovalPageCallback<TResult>
): Promise<CallerApprovalPageResult<TResult>> {
  const transaction = await runCallerConnectHumanTransaction(
    {
      requestId: input.requestId,
      fixtureClerkUserId: input.fixtureClerkUserId,
      route: input.route,
      method: "GET"
    },
    callback
  );
  return transaction.ok
    ? { ok: true, session: transaction.session, data: transaction.data }
    : { ok: false, error: transaction };
}

function reportCallerApprovalPageFailure(
  error: unknown,
  input: CallerApprovalPageInput,
  session: HumanAccountSession | undefined,
  startedAtMs: number
) {
  reportCallerApprovalFailure(error, {
    requestId: input.requestId,
    route: input.route,
    method: "GET",
    operation: input.operation,
    session,
    startedAtMs
  });
}

function callerApprovalPageUnavailable(input: CallerApprovalPageInput) {
  return {
    ok: false as const,
    error: {
      status: 503 as const,
      code: "temporary_unavailable" as const,
      message: input.unavailableMessage
    }
  };
}

export function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function fixtureClerkUserIdParam(
  params: Record<string, string | string[] | undefined> | undefined
) {
  return firstParam(params?.[CALLER_CONNECT_FIXTURE_USER_ID_PARAM]);
}
