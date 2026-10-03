import { apiRequestContext, type ApiRequestContext } from "./api-errors.ts";
import { durationSinceMs, emitRuntimeLog } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";

export const CONTACT_DESTINATION = "contact@agent-outbox.dev";
export const CONTACT_SENDER = "contact-form@agent-outbox.dev";
const CONTACT_ROUTE = "/api/contact";

const CONTACT_TOPICS = [
  "Caller access",
  "Product question",
  "Billing",
  "Partnership",
  "Privacy",
  "Support",
  "Something else"
] as const;

type ContactTopic = (typeof CONTACT_TOPICS)[number];

const CONTACT_FIELD_MAX_LENGTHS = {
  name: 80,
  email: 254,
  topic: Math.max(...CONTACT_TOPICS.map((topic) => topic.length)),
  message: 4_000,
  company: 128
} as const;

// JSON can spend up to six bytes per UTF-16 code unit, including escaped
// whitespace. Raw field limits keep trimming from hiding unbounded input.
// The extra kilobyte covers company (768 bytes), escaped keys and punctuation
// (189 bytes), and formatting. Arbitrary JSON padding still hits the body cap.
export const CONTACT_BODY_BYTE_LIMIT =
  6 *
    (CONTACT_FIELD_MAX_LENGTHS.name +
      CONTACT_FIELD_MAX_LENGTHS.email +
      CONTACT_FIELD_MAX_LENGTHS.topic +
      CONTACT_FIELD_MAX_LENGTHS.message) +
  1_024;

export type ContactSubmission = {
  name: string;
  email: string;
  topic: ContactTopic;
  message: string;
};

export type ContactEmailMessageBuilder = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
};

export type ContactEmailBinding = {
  send(message: ContactEmailMessageBuilder): Promise<{ messageId: string }>;
};

export type ContactRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type ContactDependencies = {
  email?: ContactEmailBinding;
  rateLimit?: ContactRateLimitBinding;
};

type ContactErrorCode = "invalid_request" | "rate_limited" | "send_failed";

type ContactParseResult =
  { ok: true; data: ContactSubmission } | { ok: false; message: string };

function jsonResponse(
  body: { ok: true } | { ok: false; code: ContactErrorCode; message: string },
  status: number
) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function sendFailedResponse() {
  return jsonResponse(
    {
      ok: false,
      code: "send_failed",
      message: "Your message was not sent. Please try again shortly."
    },
    503
  );
}

function contactFailureLogFields(
  context: ApiRequestContext,
  operation: string,
  message: string
) {
  return {
    request_id: context.requestId,
    surface: "api" as const,
    route: CONTACT_ROUTE,
    method: context.method,
    status_code: 503,
    duration_ms: durationSinceMs(context.startedAtMs),
    operation,
    message
  };
}

function reportContactFailure(
  error: unknown,
  context: ApiRequestContext,
  operation: string,
  message: string
) {
  reportRuntimeFailure(error, {
    errorId: context.correlationId,
    ...contactFailureLogFields(context, operation, message)
  });
}

function normalizedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength
    ? value.trim()
    : null;
}

function validEmailAddress(value: string) {
  return (
    value.length <= CONTACT_FIELD_MAX_LENGTHS.email &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

function parseContactSubmission(value: unknown): ContactParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Complete every field and try again." };
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !Object.hasOwn(CONTACT_FIELD_MAX_LENGTHS, key)
    )
  ) {
    return { ok: false, message: "Complete every field and try again." };
  }
  const name =
    normalizedString(record.name, CONTACT_FIELD_MAX_LENGTHS.name) ?? "";
  const email =
    normalizedString(
      record.email,
      CONTACT_FIELD_MAX_LENGTHS.email
    )?.toLowerCase() ?? "";
  const topic =
    normalizedString(record.topic, CONTACT_FIELD_MAX_LENGTHS.topic) ?? "";
  const message =
    normalizedString(record.message, CONTACT_FIELD_MAX_LENGTHS.message) ?? "";
  const company =
    record.company === undefined
      ? ""
      : normalizedString(record.company, CONTACT_FIELD_MAX_LENGTHS.company);

  if (company !== "") {
    return { ok: false, message: "We could not accept that message." };
  }
  if (
    name.length < 2 ||
    name.length > CONTACT_FIELD_MAX_LENGTHS.name ||
    /[\r\n]/.test(name)
  ) {
    return { ok: false, message: "Enter your name." };
  }
  if (!validEmailAddress(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (!CONTACT_TOPICS.includes(topic as ContactTopic)) {
    return { ok: false, message: "Choose what you would like to discuss." };
  }
  if (
    message.length < 20 ||
    message.length > CONTACT_FIELD_MAX_LENGTHS.message
  ) {
    return {
      ok: false,
      message: "Write a message between 20 and 4,000 characters."
    };
  }

  return {
    ok: true,
    data: { name, email, topic: topic as ContactTopic, message }
  };
}

async function readJsonBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > CONTACT_BODY_BYTE_LIMIT
  ) {
    return null;
  }

  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CONTACT_BODY_BYTE_LIMIT) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    return JSON.parse(text) as unknown;
  } catch {
    // An aborted or truncated upload is an unreadable client body, not a
    // delivery failure.
    return null;
  }
}

function requestOriginIsValid(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function contactEmailText(submission: ContactSubmission) {
  return [
    "New Agent Outbox website message",
    "",
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Topic: ${submission.topic}`,
    "",
    submission.message
  ].join("\n");
}

export async function handleContactRequest(
  request: Request,
  loadDependencies: () => Promise<ContactDependencies>
) {
  const context = apiRequestContext(request, CONTACT_ROUTE);
  let dependencies: ContactDependencies;
  try {
    dependencies = await loadDependencies();
  } catch (error) {
    reportContactFailure(
      error,
      context,
      "contact_configuration",
      "Contact bindings could not be loaded."
    );
    return sendFailedResponse();
  }
  const { email, rateLimit } = dependencies;
  if (!email || !rateLimit) {
    emitRuntimeLog({
      level: "error",
      error_id: context.correlationId,
      sentry_captured: false,
      ...contactFailureLogFields(
        context,
        "contact_configuration",
        "Contact bindings are not configured."
      )
    });
    return sendFailedResponse();
  }

  if (!requestOriginIsValid(request)) {
    return jsonResponse(
      {
        ok: false,
        code: "invalid_request",
        message: "Refresh the page and try again."
      },
      403
    );
  }

  const parsed = parseContactSubmission(await readJsonBody(request));
  if (!parsed.ok) {
    return jsonResponse(
      { ok: false, code: "invalid_request", message: parsed.message },
      400
    );
  }

  const clientKey =
    request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  let rateLimitResult: { success: boolean };
  try {
    rateLimitResult = await rateLimit.limit({ key: clientKey });
  } catch (error) {
    reportContactFailure(
      error,
      context,
      "contact_rate_limit",
      "Contact rate limit check failed unexpectedly."
    );
    return sendFailedResponse();
  }
  if (!rateLimitResult.success) {
    return jsonResponse(
      {
        ok: false,
        code: "rate_limited",
        message: "Too many messages were sent. Please try again in a minute."
      },
      429
    );
  }

  try {
    await email.send({
      to: CONTACT_DESTINATION,
      from: CONTACT_SENDER,
      replyTo: parsed.data.email,
      subject: `Agent Outbox contact — ${parsed.data.topic}`,
      text: contactEmailText(parsed.data)
    });
  } catch (error) {
    reportContactFailure(
      error,
      context,
      "contact_send",
      "Contact email delivery failed unexpectedly."
    );
    return sendFailedResponse();
  }

  return jsonResponse({ ok: true }, 200);
}

export const contactTestInternals = {
  parseContactSubmission,
  contactEmailText
};
