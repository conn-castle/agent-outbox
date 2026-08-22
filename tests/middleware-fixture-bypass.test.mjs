import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { CALLER_CONNECT_CLERK_FIXTURE_FLAG } from "../src/server/caller-connect-clerk-fixture.ts";
import {
  clerkMiddlewareConfigurationComplete,
  shouldFailClosedForMissingClerkConfiguration
} from "../src/server/middleware-clerk-readiness.ts";
import { middlewareFixtureBypassEnabled } from "../src/server/middleware-fixture-bypass.ts";

/** @type {import("node:module").ResolveHookSync} */
const resolveMiddlewareTestSpecifier = (specifier, context, nextResolve) => {
  if (specifier === "@clerk/nextjs/server") {
    return nextResolve(
      new URL("./fixtures/clerk-nextjs-server-mock.mjs", import.meta.url).href,
      context
    );
  }

  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }

  if (
    context.parentURL?.endsWith("/middleware.ts") &&
    specifier.startsWith("./src/")
  ) {
    return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href);
  }

  return nextResolve(specifier, context);
};

registerHooks({ resolve: resolveMiddlewareTestSpecifier });

const { NextRequest } = await import("next/server.js");
const { default: middleware } = await import("../middleware.ts");

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

test("middleware Clerk readiness fails closed unless app env explicitly permits missing Clerk config", () => {
  assert.equal(
    clerkMiddlewareConfigurationComplete({
      APP_ENV: "production",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test"
    }),
    true
  );
  assert.equal(
    clerkMiddlewareConfigurationComplete({
      APP_ENV: "production",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: undefined
    }),
    false
  );

  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: { APP_ENV: "production" },
      protectedRoute: true
    }),
    true
  );
  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: { APP_ENV: "development" },
      protectedRoute: true
    }),
    false
  );
  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: { APP_ENV: "test" },
      protectedRoute: true
    }),
    false
  );
  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: {},
      protectedRoute: true
    }),
    true
  );
  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: { APP_ENV: "preview" },
      protectedRoute: true
    }),
    true
  );
  assert.equal(
    shouldFailClosedForMissingClerkConfiguration({
      environment: { APP_ENV: "production" },
      protectedRoute: false
    }),
    false
  );
});

test("middleware returns non-cacheable 503 for protected routes when production Clerk config is missing", async () => {
  const previous = captureMiddlewareEnv();

  try {
    setEnv("NODE_ENV", "production");
    setEnv("APP_ENV", "production");
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.AGENT_OUTBOX_BROWSER_FIXTURE;
    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];

    const response = await middlewareResponse("https://app.example.test/human");

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "Service unavailable.");
  } finally {
    restoreEnv(previous);
  }
});

test("middleware passes through unprotected routes when Clerk config is missing", async () => {
  const previous = captureMiddlewareEnv();

  try {
    setEnv("NODE_ENV", "production");
    setEnv("APP_ENV", "production");
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.AGENT_OUTBOX_BROWSER_FIXTURE;
    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];

    const response = await middlewareResponse(
      "https://app.example.test/public"
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    restoreEnv(previous);
  }
});

test("middleware sends website-host app paths to the app origin", async () => {
  const previous = captureMiddlewareEnv();
  try {
    setEnv("NODE_ENV", "production");
    setEnv("APP_ENV", "production");
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const response = await middlewareResponse(
      "https://agent-outbox.dev/sign-up"
    );
    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get("location"),
      "https://app.agent-outbox.dev/sign-up"
    );
  } finally {
    restoreEnv(previous);
  }
});

test("middleware keeps the marketing page on the website root", async () => {
  const previous = captureMiddlewareEnv();
  try {
    setEnv("NODE_ENV", "production");
    setEnv("APP_ENV", "production");
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const response = await middlewareResponse("https://agent-outbox.dev/");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    restoreEnv(previous);
  }
});

test("middleware sends the app origin root to the review queue", async () => {
  const previous = captureMiddlewareEnv();
  try {
    setEnv("NODE_ENV", "production");
    setEnv("APP_ENV", "production");
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    const response = await middlewareResponse("https://app.agent-outbox.dev/");
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://app.agent-outbox.dev/human"
    );
  } finally {
    restoreEnv(previous);
  }
});

test("middleware fixture bypass passes through protected routes before Clerk", async () => {
  const previous = captureMiddlewareEnv();

  try {
    setEnv("NODE_ENV", "test");
    setEnv("APP_ENV", "test");
    setEnv("AGENT_OUTBOX_BROWSER_FIXTURE", "1");
    setEnv("CLERK_SECRET_KEY", "sk_test");
    setEnv("CLERK_PUBLISHABLE_KEY", "pk_test");
    delete process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG];

    const response = await middlewareResponse("https://app.example.test/human");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    restoreEnv(previous);
  }
});

function captureMiddlewareEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
    AGENT_OUTBOX_BROWSER_FIXTURE: process.env.AGENT_OUTBOX_BROWSER_FIXTURE,
    [CALLER_CONNECT_CLERK_FIXTURE_FLAG]:
      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG]
  };
}

/**
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function middlewareResponse(url) {
  const parsed = new URL(url);
  const result = await middleware(
    new NextRequest(url, {
      headers: {
        host: parsed.host
      }
    }),
    /** @type {import("next/server").NextFetchEvent} */ ({})
  );

  assert.ok(result instanceof Response);
  return result;
}

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
