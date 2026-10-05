import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { handleNodeIngress } from "../scripts/node-ingress.mjs";

const ceiling = 10_485_760;

/** @param {import("node:test").TestContext} context */
async function boundary(context) {
  const state = { calls: 0 };
  // Real HTTP framing and IncomingMessage replay; the consumer stands in for
  // Next. Installed Next clone behavior is separately exercised over loopback.
  const server = createServer((request, response) => {
    void handleNodeIngress(request, response, async (forwarded, result) => {
      state.calls++;
      let bytes = 0;
      const hash = createHash("sha256");
      for await (const chunk of forwarded) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      result.setHeader("Content-Type", "application/json");
      result.end(
        JSON.stringify({
          bytes,
          digest: hash.digest("hex"),
          method: forwarded.method,
          url: forwarded.url,
          marker: forwarded.headers["x-ingress-marker"],
          trailers: forwarded.trailers
        })
      );
    }).catch((error) => response.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, state };
}

/**
 * @param {string} origin
 * @param {string} path
 * @param {Buffer} body
 * @param {{ declared?: number, headers?: Record<string, string>, method?: string, trailers?: Record<string, string> }} [options]
 */
function send(origin, path, body, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.declared !== undefined)
      headers["Content-Length"] = String(options.declared);
    const client = httpRequest(
      new URL(path, origin),
      {
        method: options.method ?? "POST",
        headers
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
            headers: response.headers
          })
        );
      }
    );
    client.setTimeout(10_000, () =>
      client.destroy(new Error("Ingress HTTP test timed out"))
    );
    client.once("error", reject);
    let offset = 0;
    function write() {
      while (offset < body.length) {
        const end = Math.min(offset + 65_536, body.length);
        const ready = client.write(body.subarray(offset, end));
        offset = end;
        if (!ready) {
          client.once("drain", write);
          return;
        }
      }
      if (options.trailers) client.addTrailers(options.trailers);
      client.end();
    }
    write();
  });
}

test("Node ingress rejects oversized declarations before invoking Next or waiting for the declared body", async (context) => {
  const { origin, state } = await boundary(context);
  for (const path of ["/api/input/send", "/api/caller/connect/device/poll"]) {
    const result = await send(origin, path, Buffer.from("small prefix"), {
      declared: 40_497_152
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, "request_too_large");
  }
  assert.equal(state.calls, 0);
});

test("Node ingress stops finite unknown-length overflow before invoking Next", async (context) => {
  const { origin, state } = await boundary(context);
  for (const path of ["/api/input/send", "/api/caller/connect/device/poll"]) {
    const result = await send(origin, path, Buffer.alloc(ceiling + 65_536));
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, "request_too_large");
  }
  assert.equal(state.calls, 0);
});

test("Node ingress replays an exact-ceiling chunked body intact with request metadata and trailers", async (context) => {
  const { origin } = await boundary(context);
  const body = Buffer.alloc(ceiling, 97);
  const result = await send(origin, "/api/input/send?view=pending", body, {
    headers: { "x-ingress-marker": "preserved", Trailer: "x-final-marker" },
    trailers: { "x-final-marker": "complete" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    bytes: ceiling,
    digest: createHash("sha256").update(body).digest("hex"),
    method: "POST",
    url: "/api/input/send?view=pending",
    marker: "preserved",
    trailers: { "x-final-marker": "complete" }
  });
});

test("Node ingress passes valid declared bodies intact", async (context) => {
  const { origin } = await boundary(context);
  const body = Buffer.from("meaningful declared body");
  const result = await send(origin, "/api/input/send", body, {
    declared: body.length
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.bytes, body.length);
  assert.equal(
    result.body.digest,
    createHash("sha256").update(body).digest("hex")
  );
});

test("Node ingress permits mutation POST spellings and review-page action transports above 10 MiB", async (context) => {
  const { origin } = await boundary(context);
  const body = Buffer.alloc(ceiling + 1);
  /** @type {Array<[string, Record<string, string>]>} */
  const transports = [
    ["/human/mutations", {}],
    ["/human/mutations/", {}],
    ["/human", { "next-action": "action-id", "content-type": "text/plain" }],
    ["/human/", { "content-type": "multipart/form-data; boundary=action" }],
    ["/human", { "content-type": "application/x-www-form-urlencoded" }]
  ];
  for (const [path, headers] of transports) {
    const result = await send(origin, path, body, { headers });
    assert.equal(result.status, 200, path);
    assert.equal(result.body.bytes, body.length, path);
  }
});

test("Node ingress never grants action-header headroom to unrelated routes or non-POST mutations", async (context) => {
  const { origin, state } = await boundary(context);
  for (const [path, method] of [
    ["/api/input/send", "POST"],
    ["/human/storyboard", "POST"],
    ["/human/mutations", "PUT"],
    ["/human", "PUT"],
    ["/human/%6dutati%6fns", "POST"]
  ]) {
    const result = await send(origin, path, Buffer.alloc(0), {
      method,
      declared: ceiling + 1,
      headers: {
        "next-action": "untrusted-action-id",
        "content-type": "multipart/form-data; boundary=action"
      }
    });
    assert.equal(result.status, 413, path);
    assert.equal(result.body.error.code, "request_too_large");
  }
  assert.equal(state.calls, 0);
});
