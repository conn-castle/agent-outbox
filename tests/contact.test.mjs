import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTACT_BODY_BYTE_LIMIT,
  CONTACT_DESTINATION,
  CONTACT_SENDER,
  handleContactRequest
} from "../src/server/contact.ts";

/** @typedef {import("../src/server/contact.ts").ContactEmailBinding} ContactEmailBinding */

/**
 * @typedef {{
 *   headers?: Record<string, string>,
 * }} ContactRequestOptions
 */

/**
 * @typedef {{
 *   rateLimitSuccess?: boolean,
 *   rateLimitError?: Error,
 *   sendError?: Error,
 * }} ContactDependencyOptions
 */

const VALID_SUBMISSION = {
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  topic: "Caller access",
  message: "I would like caller access for my first agent.",
  company: ""
};

/**
 * @param {Record<string, string>} [body]
 * @param {ContactRequestOptions} [options]
 */
function contactRequest(body = VALID_SUBMISSION, options = {}) {
  return new Request("https://app.agent-outbox.dev/api/contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.agent-outbox.dev",
      "cf-connecting-ip": "203.0.113.27",
      ...options.headers
    },
    body: JSON.stringify(body)
  });
}

/** @param {ContactDependencyOptions} [options] */
function contactDependencies(options = {}) {
  /** @type {Parameters<ContactEmailBinding["send"]>[0][]} */
  const sent = [];
  const dependencies = {
    rateLimit: {
      async limit(/** @type {{ key: string }} */ { key }) {
        assert.equal(key, "203.0.113.27");
        if (options.rateLimitError) throw options.rateLimitError;
        return { success: options.rateLimitSuccess ?? true };
      }
    },
    email: {
      async send(
        /** @type {Parameters<ContactEmailBinding["send"]>[0]} */ message
      ) {
        sent.push(message);
        if (options.sendError) throw options.sendError;
        return { messageId: "message_123" };
      }
    }
  };
  return { sent, dependencies: async () => dependencies };
}

/**
 * Captures structured runtime logs written while `run` executes.
 *
 * @template T
 * @param {() => Promise<T>} run
 */
async function captureRuntimeLogs(run) {
  /** @type {{ level: string, text: string, event: Record<string, unknown> }[]} */
  const logs = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log
  };
  for (const level of /** @type {const} */ (["error", "warn", "log"])) {
    console[level] = (/** @type {unknown} */ line) => {
      const text = String(line);
      logs.push({ level, text, event: JSON.parse(text) });
    };
  }
  try {
    return { result: await run(), logs };
  } finally {
    Object.assign(console, original);
  }
}

const SEND_FAILED_BODY = {
  ok: false,
  code: "send_failed",
  message: "Your message was not sent. Please try again shortly."
};

/**
 * @param {{ text: string }[]} logs
 */
function assertNoSubmissionContent(logs) {
  const text = logs.map((log) => log.text).join("\n");
  for (const value of [
    VALID_SUBMISSION.name,
    VALID_SUBMISSION.email.toLowerCase(),
    VALID_SUBMISSION.message
  ]) {
    assert.equal(text.toLowerCase().includes(value.toLowerCase()), false);
  }
}

test("contact submissions send a bounded message to the studio inbox", async () => {
  const { dependencies, sent } = contactDependencies();
  const response = await handleContactRequest(contactRequest(), dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    to: CONTACT_DESTINATION,
    from: CONTACT_SENDER,
    replyTo: "ada@example.com",
    subject: "Agent Outbox contact — Caller access",
    text: [
      "New Agent Outbox website message",
      "",
      "Name: Ada Lovelace",
      "Email: ada@example.com",
      "Topic: Caller access",
      "",
      "I would like caller access for my first agent."
    ].join("\n")
  });
});

test("contact submissions accept every field at its maximum length in any script", async () => {
  // "あ" is three UTF-8 bytes; "\u0001" is six bytes once JSON-escaped.
  for (const character of ["あ", "\u0001"]) {
    const submission = {
      name: character.repeat(80),
      email: `${character.repeat(250)}@${character}.${character}`,
      topic: "Product question",
      message: character.repeat(4_000),
      company: ""
    };
    const { dependencies, sent } = contactDependencies();
    const response = await handleContactRequest(
      contactRequest(submission),
      dependencies
    );

    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyTo, submission.email);
    assert.equal(sent[0].text.endsWith(`\n\n${submission.message}`), true);
  }
});

test("contact submissions reject bodies over the byte limit", async () => {
  const body = JSON.stringify(VALID_SUBMISSION);
  const oversized =
    body + " ".repeat(CONTACT_BODY_BYTE_LIMIT + 1 - body.length);
  const declared = new Request("https://app.agent-outbox.dev/api/contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(CONTACT_BODY_BYTE_LIMIT + 1),
      origin: "https://app.agent-outbox.dev"
    },
    body
  });
  const streamedInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.agent-outbox.dev"
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      }
    }),
    duplex: "half"
  };
  const streamed = new Request(
    "https://app.agent-outbox.dev/api/contact",
    streamedInit
  );

  for (const request of [declared, streamed]) {
    const { dependencies, sent } = contactDependencies();
    const response = await handleContactRequest(request, dependencies);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_request");
    assert.equal(sent.length, 0);
  }
});

test("contact submissions reject cross-origin and malformed input", async () => {
  const crossOriginDependencies = contactDependencies();
  const crossOrigin = await handleContactRequest(
    contactRequest(VALID_SUBMISSION, {
      headers: { origin: "https://malicious.example" }
    }),
    crossOriginDependencies.dependencies
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOriginDependencies.sent.length, 0);

  for (const body of [
    { ...VALID_SUBMISSION, name: "A" },
    { ...VALID_SUBMISSION, email: "not-an-email" },
    { ...VALID_SUBMISSION, topic: "Injected subject" },
    { ...VALID_SUBMISSION, message: "Too short" },
    { ...VALID_SUBMISSION, company: "spam" }
  ]) {
    const { dependencies, sent } = contactDependencies();
    const response = await handleContactRequest(
      contactRequest(body),
      dependencies
    );
    assert.equal(response.status, 400);
    assert.equal(sent.length, 0);
  }
});

test("contact submissions report rate limits", async () => {
  const limited = contactDependencies({ rateLimitSuccess: false });
  const limitedResponse = await handleContactRequest(
    contactRequest(),
    limited.dependencies
  );
  assert.equal(limitedResponse.status, 429);
  assert.equal((await limitedResponse.json()).code, "rate_limited");
  assert.equal(limited.sent.length, 0);
});

test("contact delivery failures return send_failed and emit one safe error log", async () => {
  // The provider error echoes submission content to prove it never reaches logs.
  const failed = contactDependencies({
    sendError: new Error(`rejected reply-to ${VALID_SUBMISSION.email}`)
  });
  const { result: response, logs } = await captureRuntimeLogs(() =>
    handleContactRequest(contactRequest(), failed.dependencies)
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), SEND_FAILED_BODY);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].event.operation, "contact_send");
  assert.equal(logs[0].event.route, "/api/contact");
  assert.equal(logs[0].event.method, "POST");
  assert.equal(logs[0].event.status_code, 503);
  assert.equal(typeof logs[0].event.error_id, "string");
  assertNoSubmissionContent(logs);
});

test("contact rate-limit binding failures return send_failed instead of rejecting", async () => {
  const failed = contactDependencies({
    rateLimitError: new Error("binding down")
  });
  const { result: response, logs } = await captureRuntimeLogs(() =>
    handleContactRequest(contactRequest(), failed.dependencies)
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), SEND_FAILED_BODY);
  assert.equal(failed.sent.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].event.operation, "contact_rate_limit");
  assert.equal(logs[0].event.status_code, 503);
  assertNoSubmissionContent(logs);
});

test("contact configuration failures return send_failed and emit an error log", async () => {
  const unavailable = await captureRuntimeLogs(() =>
    handleContactRequest(contactRequest(), async () => {
      throw new Error("Cloudflare context unavailable");
    })
  );
  assert.equal(unavailable.result.status, 503);
  assert.deepEqual(await unavailable.result.json(), SEND_FAILED_BODY);
  assert.equal(unavailable.logs.length, 1);
  assert.equal(unavailable.logs[0].level, "error");
  assert.equal(unavailable.logs[0].event.operation, "contact_configuration");

  const { sent, dependencies } = contactDependencies();
  const { email } = await dependencies();
  const missing = await captureRuntimeLogs(() =>
    handleContactRequest(contactRequest(), async () => ({ email }))
  );
  assert.equal(missing.result.status, 503);
  assert.deepEqual(await missing.result.json(), SEND_FAILED_BODY);
  assert.equal(sent.length, 0);
  assert.equal(missing.logs.length, 1);
  assert.equal(missing.logs[0].level, "error");
  assert.equal(missing.logs[0].event.operation, "contact_configuration");
  assert.equal(missing.logs[0].event.status_code, 503);
  assert.equal(missing.logs[0].event.sentry_captured, false);
});

test("contact submissions treat an aborted request body as invalid input", async () => {
  const abortedInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.agent-outbox.dev"
    },
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error("client aborted upload"));
      }
    }),
    duplex: "half"
  };
  const request = new Request(
    "https://app.agent-outbox.dev/api/contact",
    abortedInit
  );
  const { sent, dependencies } = contactDependencies();
  const { result: response, logs } = await captureRuntimeLogs(() =>
    handleContactRequest(request, dependencies)
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_request");
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 0);
});

test("expected contact outcomes do not emit runtime logs", async () => {
  for (const [request, options, status] of [
    [contactRequest(), {}, 200],
    [contactRequest({ ...VALID_SUBMISSION, name: "A" }), {}, 400],
    [
      contactRequest(VALID_SUBMISSION, {
        headers: { origin: "https://malicious.example" }
      }),
      {},
      403
    ],
    [contactRequest(), { rateLimitSuccess: false }, 429]
  ]) {
    const { dependencies } = contactDependencies(
      /** @type {ContactDependencyOptions} */ (options)
    );
    const { result: response, logs } = await captureRuntimeLogs(() =>
      handleContactRequest(/** @type {Request} */ (request), dependencies)
    );
    assert.equal(response.status, status);
    assert.equal(logs.length, 0);
  }
});
