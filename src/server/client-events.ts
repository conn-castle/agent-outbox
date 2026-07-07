import { createCorrelationId } from "./correlation.ts";
import { durationSinceMs, emitRuntimeLog } from "./logging.ts";

export const CLIENT_EVENT_BODY_BYTE_LIMIT = 8_192;
const CLIENT_EVENT_BATCH_LIMIT = 8;

const CLIENT_EVENT_NAMES = new Set([
  "client_error",
  "hydration_error",
  "human_action_failed",
  "file_upload_failed",
  "ui_state_inconsistent"
]);
const CLIENT_EVENT_CATEGORIES = new Set([
  "browser_exception",
  "hydration",
  "network",
  "submission",
  "upload",
  "state"
]);

export type ClientEventProcessResult = {
  accepted: number;
  dropped: number;
};

type ClientEvent = {
  name: string;
  category?: string;
};

type ClientEventsRequestContext = {
  requestId: string;
  correlationId: string;
  route: "/api/client-events";
  method: string;
  startedAtMs: number;
};

export async function handleClientEventsRequest(
  request: Request
): Promise<ClientEventProcessResult> {
  const context = clientEventsRequestContext(request);
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      return { accepted: 0, dropped: 0 };
    }

    const body = await readClientEventBody(request);
    if (!body.ok) {
      emitClientEventDrop(context, body.reason);
      return { accepted: 0, dropped: 1 };
    }

    const parsed = parseClientEventBatch(body.value);
    if (!parsed.ok) {
      emitClientEventDrop(context, parsed.reason);
      return { accepted: 0, dropped: parsed.dropped };
    }

    for (const event of parsed.events) {
      emitRuntimeLog({
        level: event.name === "client_error" ? "error" : "warn",
        error_id: createCorrelationId("client"),
        request_id: context.requestId,
        surface: "app",
        route: context.route,
        method: request.method,
        status_code: 204,
        duration_ms: durationSinceMs(context.startedAtMs),
        operation: `client_event.${event.name}`,
        client_event_name: event.name,
        client_event_category: event.category,
        event_count: parsed.events.length,
        message: "client event received"
      });
    }

    return { accepted: parsed.events.length, dropped: parsed.dropped };
  } catch {
    return { accepted: 0, dropped: 1 };
  }
}

async function readClientEventBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason:
        | "content_type"
        | "declared_body_too_large"
        | "body_too_large"
        | "invalid_json";
    }
> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return { ok: false, reason: "content_type" };
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > CLIENT_EVENT_BODY_BYTE_LIMIT
  ) {
    return { ok: false, reason: "declared_body_too_large" };
  }

  const body = await readBodyTextWithLimit(request);
  if (!body.ok) {
    return { ok: false, reason: "body_too_large" };
  }

  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

async function readBodyTextWithLimit(
  request: Request
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > CLIENT_EVENT_BODY_BYTE_LIMIT) {
      return { ok: false };
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { ok: true, text };
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
  if (typeof input.name !== "string" || !CLIENT_EVENT_NAMES.has(input.name)) {
    return null;
  }

  const category =
    typeof input.category === "string" &&
    CLIENT_EVENT_CATEGORIES.has(input.category)
      ? input.category
      : undefined;

  return {
    name: input.name,
    category
  };
}

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
