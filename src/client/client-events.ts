import {
  CLIENT_EVENT_BATCH_LIMIT,
  CLIENT_EVENT_BODY_BYTE_LIMIT,
  type ClientEvent,
  type ClientEventCategory,
  type ClientEventName
} from "../shared/client-events-contract.ts";

const HYDRATION_ERROR_CODES = ["418", "422", "423", "425"];
const HYDRATION_MINIFIED_ERROR_PATTERN = new RegExp(
  `Minified React error #(?:${HYDRATION_ERROR_CODES.join("|")})\\b`
);
const queue: ClientEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

export function emitClientEvent(
  name: ClientEventName,
  category?: ClientEventCategory
) {
  try {
    const event: ClientEvent = { name };
    if (category) {
      event.category = category;
    }
    if (queue.length >= CLIENT_EVENT_BATCH_LIMIT) {
      return;
    }
    queue.push(event);
    scheduleClientEventFlush();
  } catch {
    // Frontend telemetry must never affect product flows.
  }
}

export function registerClientEventFlushListeners(target: Window) {
  const flush = () => {
    void flushClientEvents();
  };
  const flushWhenHidden = () => {
    if (target.document.visibilityState === "hidden") {
      void flushClientEvents();
    }
  };

  target.addEventListener("pagehide", flush);
  target.document.addEventListener("visibilitychange", flushWhenHidden);

  return () => {
    target.removeEventListener("pagehide", flush);
    target.document.removeEventListener("visibilitychange", flushWhenHidden);
  };
}

export function classifyReactError(error: unknown): "hydration" | "other" {
  const values = errorStringValues(error);
  for (const value of values) {
    if (reactHydrationCode(value) || /hydration|hydrated/i.test(value)) {
      return "hydration";
    }
  }
  return "other";
}

function scheduleClientEventFlush() {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushClientEvents();
  }, 50);
}

async function flushClientEvents() {
  if (flushing || queue.length === 0 || typeof fetch !== "function") {
    return;
  }

  flushing = true;
  const events = queue.splice(0, CLIENT_EVENT_BATCH_LIMIT);
  try {
    const body = boundedClientEventBody(events);
    if (!body) {
      return;
    }
    await fetch("/api/client-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    });
  } catch {
    // Best-effort signal only.
  } finally {
    flushing = false;
    if (queue.length > 0) {
      scheduleClientEventFlush();
    }
  }
}

function boundedClientEventBody(events: ClientEvent[]) {
  const bounded = events.slice();
  while (bounded.length > 0) {
    const body = JSON.stringify({ events: bounded });
    if (
      new TextEncoder().encode(body).byteLength <= CLIENT_EVENT_BODY_BYTE_LIMIT
    ) {
      return body;
    }
    bounded.pop();
  }
  return null;
}

function errorStringValues(error: unknown): string[] {
  if (!error) {
    return [];
  }
  if (typeof error === "string") {
    return [error];
  }
  if (typeof error !== "object") {
    return [];
  }

  const record = error as Record<string, unknown>;
  return ["digest", "message", "stack", "name"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
}

function reactHydrationCode(value: string) {
  if (HYDRATION_MINIFIED_ERROR_PATTERN.test(value)) {
    return true;
  }
  const invariant = /[?&]invariant=(\d+)\b/.exec(value)?.[1];
  return Boolean(invariant && HYDRATION_ERROR_CODES.includes(invariant));
}

export const clientEventsTestInternals = {
  boundedClientEventBody,
  flushClientEvents,
  queue
};
