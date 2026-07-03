export const CALLER_CONNECT_CLERK_FIXTURE_FLAG =
  "AGENT_OUTBOX_CONNECT_CLERK_FIXTURE";
export const CALLER_CONNECT_FIXTURE_USER_ID_PARAM = "fixture_clerk_user_id";
export const CALLER_CONNECT_FIXTURE_USER_ID_HEADER =
  "x-agent-outbox-fixture-clerk-user-id";

const SAFE_FIXTURE_CLERK_USER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function callerConnectClerkFixtureEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.APP_ENV === "test" &&
    process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG] === "1"
  );
}

export function callerConnectFixtureClerkUserId(
  value: string | null | undefined
) {
  if (!callerConnectClerkFixtureEnabled()) {
    return null;
  }

  const trimmed = value?.trim();
  if (!trimmed || !SAFE_FIXTURE_CLERK_USER_ID.test(trimmed)) {
    return null;
  }

  return trimmed;
}
