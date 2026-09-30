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
    "/lantern/\\evil.example/x"
  ]) {
    assert.equal(
      posthogProxyTarget(new Request(`https://app.agent-outbox.dev${path}`)),
      null,
      path
    );
  }

  // WHATWG URL normalization resolves encoded dot segments before a route
  // handler receives the Request. It can only produce the fixed ingest origin,
  // never an attacker-controlled origin.
  assert.deepEqual(
    posthogProxyTarget(
      new Request("https://app.agent-outbox.dev/lantern/%2e%2e/secret")
    ),
    {
      assetRequest: false,
      target: new URL("https://us.i.posthog.com/")
    }
  );
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
