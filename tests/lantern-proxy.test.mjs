import assert from "node:assert/strict";
import test from "node:test";

import {
  GET,
  POST,
  posthogProxyTarget
} from "../app/lantern/[[...path]]/route.ts";

test("lantern uses the fixed US asset and ingest origins while preserving paths and queries", () => {
  assert.deepEqual(
    posthogProxyTarget(
      new Request(
        "https://agent-outbox.dev/lantern/static/array.js?ver=123#ignored"
      )
    ),
    {
      assetRequest: true,
      target: new URL("https://us-assets.i.posthog.com/static/array.js?ver=123")
    }
  );
  assert.deepEqual(
    posthogProxyTarget(
      new Request("https://app.agent-outbox.dev/lantern/e/?ip=1")
    ),
    {
      assetRequest: false,
      target: new URL("https://us.i.posthog.com/e/?ip=1")
    }
  );
  assert.deepEqual(
    posthogProxyTarget(new Request("https://agent-outbox.dev/lantern/array/x")),
    {
      assetRequest: true,
      target: new URL("https://us-assets.i.posthog.com/array/x")
    }
  );
});

test("lantern rejects proxy-shaped and traversal path variants", () => {
  for (const path of [
    "/lantern//evil.example/x",
    "/lantern/%2F%2Fevil.example/x",
    "/lantern/static/..%2fsecret",
    "/lantern/static/%2e%2e%5csecret",
    "/lantern/static/%ZZ",
    "/lantern/\\evil.example/x"
  ]) {
    assert.equal(
      posthogProxyTarget(new Request(`https://app.agent-outbox.dev${path}`)),
      null,
      path
    );
  }

  // These encoded separators survive WHATWG normalization and reach the
  // handler's decoded-segment traversal checks under the actual route prefix.
  const traversal = new Request(
    "https://app.agent-outbox.dev/lantern/static/..%2fsecret"
  );
  assert.equal(new URL(traversal.url).pathname, "/lantern/static/..%2fsecret");
  assert.equal(posthogProxyTarget(traversal), null);
});

test("lantern forwards a binary request with only safe headers and trusted Cloudflare IP", async () => {
  const previousFetch = globalThis.fetch;
  /** @type {Request | undefined} */
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response("accepted", {
      status: 202,
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": "999",
        "set-cookie": "upstream-session=secret"
      }
    });
  };

  try {
    const body = new Uint8Array([0, 1, 2, 255]);
    const response = await POST(
      new Request("https://app.agent-outbox.dev/lantern/e/?v=1", {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-language": "en-US",
          "content-type": "application/octet-stream",
          "user-agent": "test-agent",
          cookie: "__session=secret",
          authorization: "Bearer secret",
          referer: "https://app.agent-outbox.dev/human?answer=private",
          host: "app.agent-outbox.dev",
          "cf-ray": "private",
          "x-forwarded-for": "198.51.100.10",
          "cf-connecting-ip": "203.0.113.10"
        },
        body
      })
    );

    assert(upstreamRequest);
    assert.equal(upstreamRequest.url, "https://us.i.posthog.com/e/?v=1");
    assert.equal(
      upstreamRequest.headers.get("x-forwarded-for"),
      "203.0.113.10"
    );
    for (const name of [
      "authorization",
      "cookie",
      "referer",
      "host",
      "cf-ray",
      "forwarded",
      "x-real-ip"
    ]) {
      assert.equal(upstreamRequest.headers.get(name), null, name);
    }
    assert.deepEqual(
      [...new Uint8Array(await upstreamRequest.arrayBuffer())],
      [...body]
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "accepted");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("lantern drops spoofed forwarding headers and preserves cacheable asset responses", async () => {
  const previousFetch = globalThis.fetch;
  /** @type {Request | undefined} */
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response("asset", {
      headers: { "cache-control": "public, max-age=86400", etag: "asset-tag" }
    });
  };

  try {
    const response = await GET(
      new Request("https://agent-outbox.dev/lantern/static/array.js", {
        headers: {
          "x-forwarded-for": "198.51.100.10",
          "cf-connecting-ip": "not-an-ip"
        }
      })
    );
    assert(upstreamRequest);
    assert.equal(upstreamRequest.headers.get("x-forwarded-for"), null);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=86400"
    );
    assert.equal(response.headers.get("etag"), "asset-tag");
    assert.equal(await response.text(), "asset");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("lantern propagates upstream errors and returns a safe 502 for network failures", async () => {
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  globalThis.fetch = async () =>
    new Response("limited", {
      status: 429,
      headers: { "content-type": "text/plain" }
    });
  try {
    const upstreamFailure = await POST(
      new Request("https://agent-outbox.dev/lantern/e/", {
        method: "POST",
        body: "x"
      })
    );
    assert.equal(upstreamFailure.status, 429);
    assert.equal(await upstreamFailure.text(), "limited");

    console.error = () => {};
    globalThis.fetch = async () => {
      throw new Error("unreachable private upstream detail");
    };
    const networkFailure = await POST(
      new Request("https://agent-outbox.dev/lantern/e/", {
        method: "POST",
        body: "x"
      })
    );
    assert.equal(networkFailure.status, 502);
    assert.equal(networkFailure.headers.get("cache-control"), "no-store");
    assert.equal(
      await networkFailure.text(),
      "Analytics upstream unavailable."
    );
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
  }
});

test("lantern forwards asset validators and preserves a bodyless 304", async () => {
  const previousFetch = globalThis.fetch;
  const validators = {
    "if-none-match": '"asset-v1"',
    "if-modified-since": "Tue, 29 Sep 2026 12:00:00 GMT"
  };
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(validators)) {
      assert.equal(headers.get(name), value);
    }
    return new Response(null, {
      status: 304,
      headers: {
        etag: validators["if-none-match"],
        "cache-control": "public, max-age=60"
      }
    });
  };
  try {
    for (const path of ["static/array.js", "array/project/config.js"]) {
      const response = await GET(
        new Request(`https://agent-outbox.dev/lantern/${path}`, {
          headers: validators
        })
      );
      assert.equal(response.status, 304);
      assert.equal(response.body, null);
      assert.equal(response.headers.get("etag"), validators["if-none-match"]);
      assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    }
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      for (const name of Object.keys(validators))
        assert.equal(headers.get(name), null);
      return new Response("{}");
    };
    assert.equal(
      (
        await POST(
          new Request("https://agent-outbox.dev/lantern/e/", {
            method: "POST",
            headers: validators,
            body: "{}"
          })
        )
      ).status,
      200
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("compiled browser fixtures never forward analytics, including unload beacons", async () => {
  const previousFlag = process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE = "1";
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Fixture must not contact PostHog");
  };
  try {
    for (const { handler, method, path } of [
      { handler: GET, method: "GET", path: "static/array.js" },
      { handler: POST, method: "POST", path: "e/" }
    ]) {
      const response = await handler(
        new Request(`http://127.0.0.1/lantern/${path}`, {
          method,
          ...(method === "POST"
            ? { body: JSON.stringify({ event: "$pageleave" }), keepalive: true }
            : {})
        })
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {});
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFlag === undefined)
      delete process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE;
    else process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE = previousFlag;
  }
});
