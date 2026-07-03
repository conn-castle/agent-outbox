import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLER_CONNECT_CLERK_FIXTURE_FLAG,
  callerConnectClerkFixtureEnabled,
  callerConnectFixtureClerkUserId
} from "../src/server/caller-connect-clerk-fixture.ts";

test("caller connect Clerk fixture requires the dedicated non-production test gate", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    AGENT_OUTBOX_BROWSER_FIXTURE: process.env.AGENT_OUTBOX_BROWSER_FIXTURE,
    [CALLER_CONNECT_CLERK_FIXTURE_FLAG]:
      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG]
  };

  try {
    delete process.env.APP_ENV;
    delete process.env.AGENT_OUTBOX_BROWSER_FIXTURE;
    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];
    assert.equal(callerConnectClerkFixtureEnabled(), false);

    process.env.APP_ENV = "test";
    process.env.AGENT_OUTBOX_BROWSER_FIXTURE = "1";
    assert.equal(callerConnectClerkFixtureEnabled(), false);

    process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG] = "1";
    assert.equal(callerConnectClerkFixtureEnabled(), true);

    setEnv("NODE_ENV", "production");
    assert.equal(callerConnectClerkFixtureEnabled(), false);
  } finally {
    restoreEnv(previous);
  }
});

test("caller connect fixture injects only safe Clerk user ids while gated", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    [CALLER_CONNECT_CLERK_FIXTURE_FLAG]:
      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG]
  };

  try {
    setEnv("NODE_ENV", "test");
    setEnv("APP_ENV", "test");
    process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG] = "1";

    assert.equal(
      callerConnectFixtureClerkUserId(" user_fixture-123 "),
      "user_fixture-123"
    );
    assert.equal(callerConnectFixtureClerkUserId(""), null);
    assert.equal(callerConnectFixtureClerkUserId("user with spaces"), null);

    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];
    assert.equal(callerConnectFixtureClerkUserId("user_fixture-123"), null);
  } finally {
    restoreEnv(previous);
  }
});

/**
 * @param {Record<string, string | undefined>} previous
 */
function restoreEnv(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/**
 * @param {string} name
 * @param {string} value
 */
function setEnv(name, value) {
  process.env[name] = value;
}
