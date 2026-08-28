export const CONTACT_BODY_BYTE_LIMIT = 8_192;
export const CONTACT_DESTINATION = "contact@agent-outbox.dev";
export const CONTACT_SENDER = "contact-form@agent-outbox.dev";

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
  email: ContactEmailBinding;
  rateLimit: ContactRateLimitBinding;
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

function normalizedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validEmailAddress(value: string) {
  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

function parseContactSubmission(value: unknown): ContactParseResult {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Complete every field and try again." };
  }

  const record = value as Record<string, unknown>;
  const name = normalizedString(record.name);
  const email = normalizedString(record.email).toLowerCase();
  const topic = normalizedString(record.topic);
  const message = normalizedString(record.message);
  const company = normalizedString(record.company);

  if (company) {
    return { ok: false, message: "We could not accept that message." };
  }
  if (name.length < 2 || name.length > 80 || /[\r\n]/.test(name)) {
    return { ok: false, message: "Enter your name." };
  }
  if (!validEmailAddress(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (!CONTACT_TOPICS.includes(topic as ContactTopic)) {
    return { ok: false, message: "Choose what you would like to discuss." };
  }
  if (message.length < 20 || message.length > 4_000) {
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

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > CONTACT_BODY_BYTE_LIMIT) return null;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return JSON.parse(text) as unknown;
  } catch {
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
  dependencies: ContactDependencies
) {
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
  const rateLimit = await dependencies.rateLimit.limit({ key: clientKey });
  if (!rateLimit.success) {
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
    await dependencies.email.send({
      to: CONTACT_DESTINATION,
      from: CONTACT_SENDER,
      replyTo: parsed.data.email,
      subject: `Agent Outbox contact — ${parsed.data.topic}`,
      text: contactEmailText(parsed.data)
    });
  } catch {
    return jsonResponse(
      {
        ok: false,
        code: "send_failed",
        message: "Your message was not sent. Please try again shortly."
      },
      503
    );
  }

  return jsonResponse({ ok: true }, 200);
}

export const contactTestInternals = {
  parseContactSubmission,
  contactEmailText
};
