import { IncomingMessage } from "node:http";

import {
  apiErrorResponse,
  apiRequestContext
} from "../src/server/api-errors.ts";

export const NODE_REQUEST_BODY_BYTE_LIMIT = 10 * 1024 * 1024;

/**
 * Only the hydrated mutation route and review-page server action transports
 * need the raised Next copy ceiling. This selects transport, not authorization;
 * Next still runs its middleware and enforces the route/server-action limits.
 * @param {IncomingMessage} request
 */
export function allowsLargeHumanBody(request) {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url ?? "/", "http://node-ingress").pathname;
  if (pathname === "/human/mutations" || pathname === "/human/mutations/") {
    return true;
  }
  if (pathname !== "/human" && pathname !== "/human/") return false;
  const contentType = request.headers["content-type"];
  // Mirror Next's possible-action transport detection on the review page only.
  return (
    typeof request.headers["next-action"] === "string" ||
    contentType === "application/x-www-form-urlencoded" ||
    Boolean(contentType?.startsWith("multipart/form-data"))
  );
}

/**
 * Gates the Node public boundary before Next can clone a body. HTTP framing
 * bounds valid declarations; unknown-length bodies are collected only up to
 * 10 MiB before Next sees them. Accepted chunks are replayed without concat or
 * byte copies through a native IncomingMessage, preserving its socket/headers.
 * @param {IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {(request: IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>} handle
 */
export async function handleNodeIngress(request, response, handle) {
  if (allowsLargeHumanBody(request)) return handle(request, response);

  const length = request.headers["content-length"];
  if (length !== undefined && /^\d+$/.test(length)) {
    if (Number(length) > NODE_REQUEST_BODY_BYTE_LIMIT) {
      return rejectOversizedNodeBody(request, response);
    }
    return handle(request, response);
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  // Do not let iterator cleanup destroy the socket before a 413 is written.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > NODE_REQUEST_BODY_BYTE_LIMIT) {
      return rejectOversizedNodeBody(request, response);
    }
    chunks.push(chunk);
  }

  const forwarded = new IncomingMessage(request.socket);
  forwarded.method = request.method;
  forwarded.url = request.url;
  forwarded.headers = request.headers;
  forwarded.rawHeaders = request.rawHeaders;
  forwarded.trailers = request.trailers;
  forwarded.rawTrailers = request.rawTrailers;
  forwarded.httpVersion = request.httpVersion;
  forwarded.httpVersionMajor = request.httpVersionMajor;
  forwarded.httpVersionMinor = request.httpVersionMinor;
  forwarded.complete = request.complete;
  forwarded._read = function () {
    this.push(chunks.shift() ?? null);
  };
  return handle(forwarded, response);
}

/** @param {IncomingMessage} request @param {import("node:http").ServerResponse} response */
async function rejectOversizedNodeBody(request, response) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const rejected = apiErrorResponse(
    {
      ...apiRequestContext(
        new Request("http://node-ingress", { headers }),
        "node_ingress"
      ),
      method: request.method
    },
    {
      status: 413,
      code: "request_too_large",
      message: `Request body exceeds the ${NODE_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte Node ingress limit.`,
      limit: {
        limit_name: "node_ingress_body_bytes",
        limit_reason_code: "node_ingress_too_large",
        limit_reason: "Request body exceeds the Node ingress byte ceiling.",
        limit_resets_at: null
      }
    }
  );
  request.pause();
  response.statusCode = rejected.status;
  rejected.headers.forEach((value, name) => response.setHeader(name, value));
  // Send the JSON rejection, then close instead of draining an unbounded upload.
  response.setHeader("Connection", "close");
  response.end(await rejected.text());
}
