import {
  CLIENT_EVENT_BATCH_LIMIT,
  CLIENT_EVENT_BODY_BYTE_LIMIT,
  type ClientEvent,
  type ClientEventName
} from "../shared/client-events-contract.ts";

const HYDRATION_ERROR_CODES = ["418", "419", "421", "422", "423", "425"];
const HYDRATION_MINIFIED_ERROR_PATTERN = new RegExp(
  `Minified React error #(?:${HYDRATION_ERROR_CODES.join("|")})\\b`
);
// Buffer several batches so a burst of events within the flush debounce is not
// dropped at the per-flush batch size; flushClientEvents drains the queue across
// multiple rescheduled batches. This bounds memory independently of the batch size.
const CLIENT_EVENT_QUEUE_LIMIT = CLIENT_EVENT_BATCH_LIMIT * 8;
const queue: ClientEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
const installedErrorTargets = new WeakSet<Window>();

export function emitClientEvent(name: ClientEventName) {
  try {
    const event: ClientEvent = { name };
    if (queue.length >= CLIENT_EVENT_QUEUE_LIMIT) {
      return;
    }
    queue.push(event);
    scheduleClientEventFlush();
  } catch {
    // Frontend telemetry must never affect product flows.
  }
}

function registerClientEventFlushListeners(target: Window) {
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
}

/**
 * Install browser failure telemetry before React hydration, from
 * instrumentation-client.ts. Once per Window in this module instance, register
 * capture listeners for uncaught errors/rejections and pagehide/hidden-visibility
 * flush listeners. Registrations last for the page lifetime; no disposer is
 * returned.
 *
 * Ignore resource error events without an error object. Classify uncaught errors
 * and rejections, then enqueue name-only telemetry in the shared bounded queue.
 */
export function installClientErrorEvents(target: Window) {
  if (installedErrorTargets.has(target)) {
    return;
  }
  installedErrorTargets.add(target);

  target.addEventListener(
    "error",
    (event) => {
      // Resource load failures dispatch error events without an error object.
      if (event.error != null) {
        emitUncaughtErrorEvent(event.error);
      }
    },
    { capture: true }
  );
  target.addEventListener(
    "unhandledrejection",
    (event) => {
      emitUncaughtErrorEvent(event.reason);
    },
    { capture: true }
  );
  registerClientEventFlushListeners(target);
}

/**
 * Classify an error or rejection with classifyReactError and enqueue only the
 * name hydration_error or client_error, never the exception itself.
 */
export function emitUncaughtErrorEvent(error: unknown) {
  emitClientEvent(
    classifyReactError(error) === "hydration"
      ? "hydration_error"
      : "client_error"
  );
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
  const encoder = new TextEncoder();
  while (bounded.length > 0) {
    const body = JSON.stringify({ events: bounded });
    if (encoder.encode(body).byteLength <= CLIENT_EVENT_BODY_BYTE_LIMIT) {
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
  flushClientEvents,
  queue
};
