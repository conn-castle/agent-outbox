import { trustedClientIpAddress } from "../../../src/server/trusted-client-ip.ts";

const POSTHOG_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";
const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com";
const REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "accept-language",
  "content-encoding",
  "content-type",
  "user-agent"
] as const;
const RESPONSE_HEADER_ALLOWLIST = [
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "vary"
] as const;

function pathIsSafe(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return false;
  }
  return path.split("/").every((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return (
        decoded !== "." &&
        decoded !== ".." &&
        !decoded.includes("/") &&
        !decoded.includes("\\")
      );
    } catch {
      return false;
    }
  });
}

export function posthogProxyTarget(request: Request) {
  const url = new URL(request.url);
  const suffix = url.pathname.slice("/lantern".length) || "/";
  if (!pathIsSafe(suffix)) return null;

  const assetRequest =
    suffix.startsWith("/static/") || suffix.startsWith("/array/");
  const origin = assetRequest ? POSTHOG_ASSETS_ORIGIN : POSTHOG_INGEST_ORIGIN;
  const target = new URL(`${origin}${suffix}${url.search}`);
  if (target.origin !== origin) return null;

  return { assetRequest, target };
}

function forwardedRequestHeaders(request: Request) {
  const headers = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const clientIp = trustedClientIpAddress(request);
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
}

function forwardedResponseHeaders(response: Response, assetRequest: boolean) {
  const headers = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!assetRequest) headers.set("cache-control", "no-store");
  return headers;
}

async function proxy(request: Request) {
  const destination = posthogProxyTarget(request);
  if (!destination) {
    return new Response("Invalid analytics proxy path.", {
      status: 400,
      headers: { "cache-control": "no-store" }
    });
  }

  try {
    const response = await fetch(destination.target, {
      method: request.method,
      headers: forwardedRequestHeaders(request),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      redirect: "manual"
    });
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedResponseHeaders(response, destination.assetRequest)
    });
  } catch {
    console.error("PostHog proxy request failed.", {
      method: request.method,
      upstream: destination.assetRequest ? "assets" : "ingest"
    });
    return new Response("Analytics upstream unavailable.", {
      status: 502,
      headers: { "cache-control": "no-store" }
    });
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const POST = proxy;
