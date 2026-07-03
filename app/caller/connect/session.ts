import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";

import {
  CALLER_CONNECT_FIXTURE_USER_ID_HEADER,
  CALLER_CONNECT_FIXTURE_USER_ID_PARAM,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../../../src/server/caller-connect-clerk-fixture";
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

export function requiredCallerConnectSessionConfiguration() {
  if (!callerConnectClerkFixtureEnabled()) {
    return requiredHumanSessionConfiguration();
  }

  return process.env.DATABASE_APP_ROLE_URL ? [] : ["DATABASE_APP_ROLE_URL"];
}

export async function resolveCallerConnectHumanSession(input: {
  requestId: string;
  fixtureClerkUserId?: string | null;
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
      requestId: input.requestId
    });
  }

  const session = await auth.protect({
    unauthenticatedUrl: "/sign-in"
  });

  return resolveHumanAccountSession({
    clerkUserId: session.userId,
    requestId: input.requestId
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

export function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function fixtureClerkUserIdParam(
  params: Record<string, string | string[] | undefined> | undefined
) {
  return firstParam(params?.[CALLER_CONNECT_FIXTURE_USER_ID_PARAM]);
}
