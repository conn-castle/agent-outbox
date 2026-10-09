import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { CALLER_CONNECT_CLERK_FIXTURE_FLAG } from "../src/server/caller-connect-clerk-fixture.ts";
import {
  clerkMiddlewareConfigurationComplete,
  shouldFailClosedForMissingClerkConfiguration
} from "../src/server/middleware-clerk-readiness.ts";
import { middlewareFixtureBypassEnabled } from "../src/server/middleware-fixture-bypass.ts";
import { humanReviewCardHref } from "../src/shared/human-review-view.ts";
import { signInReturnHref } from "../src/shared/sign-in-return.ts";
import {
  clerkMiddlewareCallCount,
  clerkMiddlewareMock,
  resetClerkMiddlewareCalls
} from "./fixtures/clerk-nextjs-server-mock.mjs";
import { withProcessEnv } from "./helpers/process-env.mjs";

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

const productionWithoutClerk = {
  NODE_ENV: "production",
  APP_ENV: "production",
  CLERK_SECRET_KEY: undefined,
  CLERK_PUBLISHABLE_KEY: undefined
};

test("middleware bypasses lantern before host redirects and Clerk", async () => {
  await withProcessEnv(
    {
      NODE_ENV: "production",
      APP_ENV: "production",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test"
    },
    async () => {
      resetClerkMiddlewareCalls();

      for (const host of ["agent-outbox.dev", "app.agent-outbox.dev"]) {
        const response = await middleware(
          new NextRequest(`https://${host}/lantern/e/`, { headers: { host } }),
          /** @type {any} */ ({})
        );
        assert(response);
        assert.equal(response.headers.get("x-middleware-next"), "1", host);
      }
      assert.equal(clerkMiddlewareCallCount(), 0);
    }
  );
});

test("middleware fixture bypass keeps browser fixture off caller approval pages until explicitly enabled", () => {
  withProcessEnv(
    {
      NODE_ENV: "test",
      APP_ENV: "test",
      AGENT_OUTBOX_BROWSER_FIXTURE: "1",
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: undefined
    },
    () => {
      assert.equal(middlewareFixtureBypassEnabled("/human"), true);
      assert.equal(middlewareFixtureBypassEnabled("/upgrade"), true);
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

      process.env[CALLER_CONNECT_CLERK_FIXTURE_FLAG] = "1";

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
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/connect/error"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/rotate/approve"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/rotate/device"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/rotate/success"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/rotate/error"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/revoke/approve"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/revoke/device"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/revoke/success"),
        true
      );
      assert.equal(
        middlewareFixtureBypassEnabled("/caller/revoke/error"),
        true
      );
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
    }
  );
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
  await withProcessEnv(
    {
      ...productionWithoutClerk,
      AGENT_OUTBOX_BROWSER_FIXTURE: undefined,
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: undefined
    },
    async () => {
      const response = await middlewareResponse(
        "https://app.example.test/human"
      );

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(await response.text(), "Service unavailable.");
    }
  );
});

test("middleware passes through unprotected routes when Clerk config is missing", async () => {
  await withProcessEnv(
    {
      ...productionWithoutClerk,
      AGENT_OUTBOX_BROWSER_FIXTURE: undefined,
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: undefined
    },
    async () => {
      const response = await middlewareResponse(
        "https://app.example.test/public"
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-middleware-next"), "1");
    }
  );
});

test("middleware sends website-host app paths to the app origin", async () => {
  await withProcessEnv(productionWithoutClerk, async () => {
    const response = await middlewareResponse(
      "https://agent-outbox.dev/sign-up"
    );
    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get("location"),
      "https://app.agent-outbox.dev/sign-up"
    );
  });
});

test("middleware keeps the marketing page on the website root", async () => {
  await withProcessEnv(productionWithoutClerk, async () => {
    const response = await middlewareResponse("https://agent-outbox.dev/");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  });
});

test("middleware sends the app origin root to the review queue", async () => {
  await withProcessEnv(productionWithoutClerk, async () => {
    const response = await middlewareResponse("https://app.agent-outbox.dev/");
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://app.agent-outbox.dev/human"
    );
  });
});

test("middleware fixture bypass passes through protected routes before Clerk", async () => {
  await withProcessEnv(
    {
      NODE_ENV: "test",
      APP_ENV: "test",
      AGENT_OUTBOX_BROWSER_FIXTURE: "1",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      [CALLER_CONNECT_CLERK_FIXTURE_FLAG]: undefined
    },
    async () => {
      const response = await middlewareResponse(
        "https://app.example.test/human"
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-middleware-next"), "1");
    }
  );
});

test("signed-out card visits preserve arbitrary IDs through the sign-in redirect", async () => {
  await withProcessEnv(
    {
      APP_ENV: "production",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      AGENT_OUTBOX_BROWSER_FIXTURE: undefined
    },
    async () => {
      try {
        clerkMiddlewareMock.signedOut = true;
        const destination = humanReviewCardHref(
          "caller-one",
          "email:thread /?#&+% café 東京"
        );
        const response = await middlewareResponse(
          `https://app.example.test${destination}`
        );
        assert.equal(response.status, 307);
        const location = response.headers.get("location");
        assert.ok(location);
        const signIn = new URL(location);
        assert.equal(signIn.origin, "https://app.example.test");
        assert.equal(signIn.pathname, "/sign-in");
        assert.equal(signIn.searchParams.get("redirect_url"), destination);
        assert.equal(
          signInReturnHref(
            signIn.searchParams.get("redirect_url") ?? undefined
          ),
          destination
        );
      } finally {
        clerkMiddlewareMock.signedOut = false;
      }
    }
  );
});

test("signed-out caller approval and upgrade visits return to the same page after sign-in", async () => {
  await withProcessEnv(
    {
      APP_ENV: "production",
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      AGENT_OUTBOX_BROWSER_FIXTURE: undefined
    },
    async () => {
      try {
        clerkMiddlewareMock.signedOut = true;
        for (const destination of [
          `/caller/connect/approve?setup_request_id=${crypto.randomUUID()}`,
          `/caller/rotate/approve?setup_request_id=${crypto.randomUUID()}`,
          `/caller/revoke/approve?setup_request_id=${crypto.randomUUID()}`,
          "/caller/connect/device?user_code=ABCD-EFGH",
          "/upgrade",
          "/upgrade?checkout=success"
        ]) {
          const response = await middlewareResponse(
            `https://app.example.test${destination}`
          );
          assert.equal(response.status, 307, destination);
          const location = response.headers.get("location");
          assert.ok(location, destination);
          const signIn = new URL(location);
          assert.equal(signIn.pathname, "/sign-in");
          assert.equal(
            signInReturnHref(
              signIn.searchParams.get("redirect_url") ?? undefined
            ),
            destination
          );
        }
      } finally {
        clerkMiddlewareMock.signedOut = false;
      }
    }
  );
});

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
