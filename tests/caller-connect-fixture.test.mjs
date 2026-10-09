import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLER_CONNECT_CLERK_FIXTURE_FLAG,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../src/server/caller-connect-clerk-fixture.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

test("caller connect Clerk fixture requires the dedicated non-production test gate", () => {
  withProcessEnv(
    {
      APP_ENV: undefined,
      AGENT_OUTBOX_BROWSER_FIXTURE: undefined,
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: undefined
    },
    () => {
      assert.equal(callerConnectClerkFixtureEnabled(), false);

      process.env.APP_ENV = "test";
      process.env.AGENT_OUTBOX_BROWSER_FIXTURE = "1";
      assert.equal(callerConnectClerkFixtureEnabled(), false);

      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG] = "1";
      assert.equal(callerConnectClerkFixtureEnabled(), true);

      withProcessEnv({ NODE_ENV: "production" }, () => {
        assert.equal(callerConnectClerkFixtureEnabled(), false);
      });
    }
  );
});

test("caller connect fixture injects only safe Clerk user ids while gated", () => {
  withProcessEnv(
    {
      NODE_ENV: "test",
      APP_ENV: "test",
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: "1"
    },
    () => {
      assert.equal(
        callerConnectFixtureClerkUserId(" user_fixture-123 "),
        "user_fixture-123"
      );
      assert.equal(callerConnectFixtureClerkUserId(""), null);
      assert.equal(callerConnectFixtureClerkUserId("user with spaces"), null);

      delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];
      assert.equal(callerConnectFixtureClerkUserId("user_fixture-123"), null);
    }
  );
});
