import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

export type AnalyticsEvent = {
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

function isAnalyticsUrl(value: string) {
  return value.startsWith("/") || /^https?:\/\//i.test(value);
}

export function sanitizedAnalyticsUrl(value: string, origin: string) {
  if (value === "$direct" || value === "") return value;
  if (!isAnalyticsUrl(value)) return "[redacted]";

  try {
    const url = new URL(value, origin);
    const internal = [
      origin,
      SYSTEM_CONTRACT.hostedWebsiteBaseUrl,
      SYSTEM_CONTRACT.hostedAppBaseUrl
    ].includes(url.origin);
    const privatePath = [
      "/api",
      "/human",
      "/caller",
      "/sign-in",
      "/sign-up",
      "/upgrade"
    ].some(
      (prefix) =>
        url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
    );

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (!internal) {
      url.pathname = "/";
    } else if (privatePath) {
      url.pathname = url.pathname.split("/").slice(0, 2).join("/") || "/";
    }
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

function sanitizeHeatmapData(value: unknown, origin: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.entries(value).reduce<Record<string, unknown>>(
    (sanitized, [url, points]) => {
      const key = sanitizedAnalyticsUrl(url, origin);
      const existing = sanitized[key];
      sanitized[key] =
        Array.isArray(existing) && Array.isArray(points)
          ? [...existing, ...points]
          : points;
      return sanitized;
    },
    {}
  );
}

function sanitizeAnalyticsProperties(
  value: unknown,
  origin: string,
  key = ""
): unknown {
  if (key === "$elements_chain" && typeof value === "string") {
    return value.replace(
      /((?:attr__)?href=)"(?:\\.|[^"\\])*"/g,
      '$1"[redacted]"'
    );
  }
  if (key === "$heatmap_data") return sanitizeHeatmapData(value, origin);
  if (typeof value === "string" && /pathname/i.test(key)) {
    const sanitized = sanitizedAnalyticsUrl(value, origin);
    return sanitized === "[redacted]"
      ? sanitized
      : new URL(sanitized, origin).pathname;
  }
  if (typeof value === "string" && /(?:url|href|referrer)/i.test(key)) {
    return sanitizedAnalyticsUrl(value, origin);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAnalyticsProperties(item, origin, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([childKey]) =>
            !["target", "interactionTarget", "largestShiftTarget"].includes(
              childKey
            )
        )
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeAnalyticsProperties(childValue, origin, childKey)
        ])
    );
  }
  return value;
}

export function sanitizeAnalyticsEvent<T extends AnalyticsEvent | null>(
  event: T,
  origin: string
): T {
  if (event) {
    for (const key of ["properties", "$set", "$set_once"] as const) {
      if (event[key]) {
        event[key] = sanitizeAnalyticsProperties(event[key], origin) as Record<
          string,
          unknown
        >;
      }
    }
  }
  return event;
}
