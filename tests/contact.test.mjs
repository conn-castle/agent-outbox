import assert from "node:assert/strict";
import test from "node:test";

import {
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
 *   sendError?: Error,
 * }} ContactDependencyOptions
 */

const VALID_SUBMISSION = {
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  topic: "Product question",
  message: "I would like to understand how team review works.",
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
  return {
    sent,
    dependencies: {
      rateLimit: {
        async limit(/** @type {{ key: string }} */ { key }) {
          assert.equal(key, "203.0.113.27");
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
    }
  };
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
    subject: "Agent Outbox contact — Product question",
    text: [
      "New Agent Outbox website message",
      "",
      "Name: Ada Lovelace",
      "Email: ada@example.com",
      "Topic: Product question",
      "",
      "I would like to understand how team review works."
    ].join("\n")
  });
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

test("contact submissions report rate limits and delivery failures", async () => {
  const limited = contactDependencies({ rateLimitSuccess: false });
  const limitedResponse = await handleContactRequest(
    contactRequest(),
    limited.dependencies
  );
  assert.equal(limitedResponse.status, 429);
  assert.equal((await limitedResponse.json()).code, "rate_limited");
  assert.equal(limited.sent.length, 0);

  const failed = contactDependencies({ sendError: new Error("unavailable") });
  const failedResponse = await handleContactRequest(
    contactRequest(),
    failed.dependencies
  );
  assert.equal(failedResponse.status, 503);
  assert.deepEqual(await failedResponse.json(), {
    ok: false,
    code: "send_failed",
    message: "Your message was not sent. Please try again shortly."
  });
});
