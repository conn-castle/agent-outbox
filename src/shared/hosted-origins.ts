import { SYSTEM_CONTRACT } from "./system-contract.ts";

export type HostedOriginKind = "website" | "app" | "local";

const WEBSITE_PREFIXES = [
  "/docs",
  "/contact",
  "/privacy-policy",
  "/terms-of-service"
];

const APP_PREFIXES = [
  "/human",
  "/sign-in",
  "/sign-up",
  "/sign-out",
  "/caller",
  "/upgrade",
  "/api"
];

function hostnameFromHostHeader(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(":")[0] ?? "";
}

function hostnameOf(origin: string): string {
  return new URL(origin).hostname;
}

export function classifyHost(hostHeader: string): HostedOriginKind {
  const host = hostnameFromHostHeader(hostHeader);
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === ""
  ) {
    return "local";
  }
  if (host === hostnameOf(SYSTEM_CONTRACT.hostedWebsiteBaseUrl)) {
    return "website";
  }
  if (host === hostnameOf(SYSTEM_CONTRACT.hostedAppBaseUrl)) {
    return "app";
  }
  return "local";
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function pathBelongsOnWebsite(pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  return WEBSITE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function pathBelongsOnApp(pathname: string): boolean {
  if (pathname === "/api/contact" || pathname.startsWith("/api/contact/")) {
    return false;
  }
  return APP_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

export function hostedHostRedirect(
  requestUrl: string | URL,
  hostHeader: string
): URL | null {
  const kind = classifyHost(hostHeader);
  if (kind === "local") {
    return null;
  }
  const url = new URL(requestUrl);
  if (kind === "website" && pathBelongsOnApp(url.pathname)) {
    return new URL(
      `${url.pathname}${url.search}`,
      SYSTEM_CONTRACT.hostedAppBaseUrl
    );
  }
  if (kind === "app") {
    if (url.pathname === "/") {
      return new URL(`/human${url.search}`, SYSTEM_CONTRACT.hostedAppBaseUrl);
    }
    if (pathBelongsOnWebsite(url.pathname)) {
      return new URL(
        `${url.pathname}${url.search}`,
        SYSTEM_CONTRACT.hostedWebsiteBaseUrl
      );
    }
  }
  return null;
}

export function hrefOnOrigin(
  target: Exclude<HostedOriginKind, "local">,
  path: string,
  currentHost: string
): string {
  const current = classifyHost(currentHost);
  if (current === "local" || current === target) {
    return path;
  }
  const origin =
    target === "website"
      ? SYSTEM_CONTRACT.hostedWebsiteBaseUrl
      : SYSTEM_CONTRACT.hostedAppBaseUrl;
  return new URL(path, origin).toString();
}
