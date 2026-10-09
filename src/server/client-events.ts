import {
  CLIENT_EVENT_BATCH_LIMIT,
  CLIENT_EVENT_BODY_BYTE_LIMIT,
  CLIENT_EVENT_CATEGORY_BY_NAME,
  isClientEventName,
  type ClientEvent,
  type ClientEventName
} from "../shared/client-events-contract.ts";
import { createCorrelationId } from "./correlation.ts";
import { durationSinceMs, emitRuntimeLog } from "./logging.ts";
import { readJsonRequestBody } from "./request-body.ts";
import { reportRuntimeFailure } from "./sentry.ts";

export type ClientEventProcessResult = {
  accepted: number;
  dropped: number;
};

type ClientEventsRequestContext = {
  requestId: string;
  correlationId: string;
  route: "/api/client-events";
  method: string;
  startedAtMs: number;
};

type ClientEventProducer = "browser" | "server_action";

const ALERTABLE_BROWSER_EVENT_NAMES = new Set<ClientEventName>([
  "github_sign_in_not_ready",
  "github_sign_in_clerk_error",
  "github_sign_in_clerk_timeout",
  "github_sign_in_same_page_stall"
]);
// This endpoint is intentionally unauthenticated and Origin is forgeable by
// non-browser clients. Bound capture attempts across every alertable browser
// event so attacker-selected event names cannot permanently suppress one
// operation or create an unlimited Sentry/error-alert ingest path.
const BROWSER_SENTRY_CAPTURE_INTERVAL_MS = 60_000;
let nextBrowserSentryCaptureAtMs = 0;

export function emitClientEventLog(
  event: ClientEvent,
  context: {
    requestId: string;
    route: string;
    producer: ClientEventProducer;
    method?: string;
    statusCode?: number;
    durationMs?: number;
    eventCount?: number;
  }
) {
  const errorId = createCorrelationId("client");
  const category = CLIENT_EVENT_CATEGORY_BY_NAME[event.name];
  const eventFields = {
    request_id: context.requestId,
    surface: "app" as const,
    route: context.route,
    method: context.method,
    status_code: context.statusCode,
    duration_ms: context.durationMs,
    operation: `client_event.${event.name}`,
    operation_kind: context.producer,
    client_event_name: event.name,
    client_event_category: category,
    event_count: context.eventCount,
    message: "client event received"
  };

  if (isAlertableBrowserEvent(event, context.producer)) {
    const now = Date.now();
    if (now >= nextBrowserSentryCaptureAtMs) {
      nextBrowserSentryCaptureAtMs = now + BROWSER_SENTRY_CAPTURE_INTERVAL_MS;
      const report = reportRuntimeFailure(new Error("Browser client failure"), {
        ...eventFields,
        errorId
      });
      return report.log;
    }

    return emitRuntimeLog({
      ...eventFields,
      level: "warn",
      error_id: errorId,
      sentry_captured: false,
      sentry_capture_rate_limited: true
    });
  }

  return emitRuntimeLog({
    ...eventFields,
    level: "warn",
    error_id: errorId
  });
}

function isAlertableBrowserEvent(
  event: ClientEvent,
  producer: ClientEventProducer
) {
  return (
    producer === "browser" && ALERTABLE_BROWSER_EVENT_NAMES.has(event.name)
  );
}

export async function handleClientEventsRequest(
  request: Request
): Promise<ClientEventProcessResult> {
  const context = clientEventsRequestContext(request);
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      return { accepted: 0, dropped: 0 };
    }

    const body = await readJsonRequestBody(
      request,
      CLIENT_EVENT_BODY_BYTE_LIMIT
    );
    if (!body.ok) {
      // An unreadable (aborted) upload is an unlogged drop.
      if (body.reason !== "unreadable") {
        emitClientEventDrop(context, body.reason);
      }
      return { accepted: 0, dropped: 1 };
    }

    const parsed = parseClientEventBatch(body.value);
    if (!parsed.ok) {
      emitClientEventDrop(context, parsed.reason);
      return { accepted: 0, dropped: parsed.dropped };
    }

    for (const event of parsed.events) {
      emitClientEventLog(event, {
        requestId: context.requestId,
        route: context.route,
        producer: "browser",
        method: request.method,
        statusCode: 204,
        durationMs: durationSinceMs(context.startedAtMs),
        eventCount: parsed.events.length
      });
    }

    return { accepted: parsed.events.length, dropped: parsed.dropped };
  } catch {
    return { accepted: 0, dropped: 1 };
  }
}

function parseClientEventBatch(
  value: unknown
):
  | { ok: true; events: ClientEvent[]; dropped: number }
  | { ok: false; dropped: number; reason: string } {
  if (!value || typeof value !== "object" || !("events" in value)) {
    return { ok: false, dropped: 1, reason: "invalid_shape" };
  }

  const eventsValue = (value as { events: unknown }).events;
  if (!Array.isArray(eventsValue)) {
    return { ok: false, dropped: 1, reason: "invalid_shape" };
  }

  const bounded = eventsValue.slice(0, CLIENT_EVENT_BATCH_LIMIT);
  const events: ClientEvent[] = [];
  for (const entry of bounded) {
    const event = parseClientEvent(entry);
    if (event) {
      events.push(event);
    }
  }

  const dropped = eventsValue.length - events.length;
  if (events.length === 0) {
    return { ok: false, dropped, reason: "no_allowed_events" };
  }

  return { ok: true, events, dropped };
}

function parseClientEvent(entry: unknown): ClientEvent | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const input = entry as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name : null;
  if (!name || !isClientEventName(name)) {
    return null;
  }

  return {
    name
  };
}

export const clientEventServerTestInternals = {
  resetBrowserSentryCaptureLimiter() {
    nextBrowserSentryCaptureAtMs = 0;
  }
};

function emitClientEventDrop(
  context: ClientEventsRequestContext,
  reason: string
) {
  emitRuntimeLog({
    level: "warn",
    error_id: context.correlationId,
    request_id: context.requestId,
    surface: "app",
    route: context.route,
    method: context.method,
    status_code: 204,
    duration_ms: durationSinceMs(context.startedAtMs),
    operation: "client_event.dropped",
    drop_reason: reason,
    message: "client event dropped"
  });
}

function clientEventsRequestContext(
  request: Request
): ClientEventsRequestContext {
  return {
    requestId: createCorrelationId("req"),
    correlationId: createCorrelationId("corr"),
    route: "/api/client-events",
    method: request.method,
    startedAtMs: Date.now()
  };
}
