import assert from "node:assert/strict";
import test from "node:test";

import { CALLER_CONNECT_CLERK_FIXTURE_FLAG } from "../src/server/caller-connect-clerk-fixture.ts";
import { middlewareFixtureBypassEnabled } from "../src/server/middleware-fixture-bypass.ts";

test("middleware fixture bypass keeps browser fixture off caller approval pages until explicitly enabled", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    AGENT_OUTBOX_BROWSER_FIXTURE: process.env.AGENT_OUTBOX_BROWSER_FIXTURE,
    [CALLER_CONNECT_CLERK_FIXTURE_FLAG]:
      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG]
  };

  try {
    setEnv("NODE_ENV", "test");
    setEnv("APP_ENV", "test");
    setEnv("AGENT_OUTBOX_BROWSER_FIXTURE", "1");
    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];

    assert.equal(middlewareFixtureBypassEnabled("/human"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/approve"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/device"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/success"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/error"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/rotate/approve"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/revoke/device"),
      false
    );

    setEnv(CALLER_CONNECT_CLERK_FIXTURE_FLAG, "1");

    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/approve"),
      true
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/device"),
      true
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/connect/success"),
      true
    );
    assert.equal(middlewareFixtureBypassEnabled("/caller/connect/error"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/rotate/approve"),
      true
    );
    assert.equal(middlewareFixtureBypassEnabled("/caller/rotate/device"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/rotate/success"),
      true
    );
    assert.equal(middlewareFixtureBypassEnabled("/caller/rotate/error"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/revoke/approve"),
      true
    );
    assert.equal(middlewareFixtureBypassEnabled("/caller/revoke/device"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/caller/revoke/success"),
      true
    );
    assert.equal(middlewareFixtureBypassEnabled("/caller/revoke/error"), true);
    assert.equal(
      middlewareFixtureBypassEnabled("/api/caller/connect/browser/start"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/api/caller/rotate/browser/start"),
      false
    );
    assert.equal(
      middlewareFixtureBypassEnabled("/api/caller/revoke/device/start"),
      false
    );
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
