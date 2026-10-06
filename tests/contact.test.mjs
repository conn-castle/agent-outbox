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
 * @param {Record<string, unknown>} [body]
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
 * @param {string} body
 * @param {"declared" | "streamed"} transport
 */
function contactBodyRequest(body, transport) {
  const template = contactRequest();
  const headers = new Headers(template.headers);
  const bytes = new TextEncoder().encode(body);
  if (transport === "declared") {
    headers.set("content-length", String(bytes.byteLength));
  }
  const init = {
    method: "POST",
    headers,
    body:
      transport === "declared"
        ? body
        : new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 17));
              controller.enqueue(bytes.slice(17));
              controller.close();
            }
          }),
    duplex: "half"
  };
  return new Request(template.url, init);
}

/**
 * @param {Request} request
 * @param {{ name: string, email: string, topic: string, message: string }} expected
 */
async function assertContactAcceptance(request, expected) {
  const { dependencies, sent } = contactDependencies();
  const response = await handleContactRequest(request, dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    to: CONTACT_DESTINATION,
    from: CONTACT_SENDER,
    replyTo: expected.email,
    subject: `Agent Outbox contact — ${expected.topic}`,
    text: [
      "New Agent Outbox website message",
      "",
      `Name: ${expected.name}`,
      `Email: ${expected.email}`,
      `Topic: ${expected.topic}`,
      "",
      expected.message
    ].join("\n")
  });
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
  for (const character of ["あ", "\u0001", "😀"]) {
    const submission = {
      name: character.repeat(80 / character.length),
      email: `${character.repeat((252 - 2 * character.length) / character.length)}@${character}.${character}`,
      topic: "Product question",
      message: character.repeat(4_000 / character.length),
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

test("contact submissions accept maximum normalized fields even when every string is JSON-escaped", async () => {
  const submission = {
    name: ` ${"あ".repeat(80)} `,
    email: ` ${"a".repeat(250)}@a.b `,
    topic: " Product question ",
    message: ` ${"あ".repeat(4_000)} `,
    company: "\u3000".repeat(128)
  };
  // Escape every UTF-16 code unit, including whitespace and property names.
  const escapedString = (/** @type {string} */ value) =>
    `"${value
      .split("")
      .map(
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
      .join("")}"`;
  const body = `{${Object.entries(submission)
    .map(([key, value]) => `${escapedString(key)}:${escapedString(value)}`)
    .join(",")}}`;
  const request = new Request(contactRequest(), {
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      origin: "https://app.agent-outbox.dev",
      "cf-connecting-ip": "203.0.113.27"
    },
    body
  });
  const { dependencies, sent } = contactDependencies();
  const response = await handleContactRequest(request, dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, submission.email.trim());
  assert.equal(sent[0].subject, "Agent Outbox contact — Product question");
  assert.equal(
    sent[0].text.includes(`Name: ${submission.name.trim()}\n`),
    true
  );
  assert.equal(sent[0].text.endsWith(`\n\n${submission.message.trim()}`), true);
});

test("contact submissions preserve trimming before normalized field limits", async (t) => {
  const maximumFields = {
    name: "a".repeat(80),
    email: `${"A".repeat(250)}@A.B`,
    topic: "Product question",
    message: "a".repeat(4_000)
  };
  for (const [field, value] of Object.entries(maximumFields)) {
    for (const [padding, rawValue] of [
      ["leading", ` ${value}`],
      ["trailing", `${value} `],
      ["both", ` \t${value}\t `]
    ]) {
      const submission = { ...VALID_SUBMISSION, [field]: rawValue };
      const expected = {
        ...VALID_SUBMISSION,
        email: "ada@example.com",
        [field]: field === "email" ? value.toLowerCase() : value
      };
      for (const transport of /** @type {const} */ (["declared", "streamed"])) {
        await t.test(
          `${field}, ${padding} whitespace, ${transport}`,
          async () => {
            await assertContactAcceptance(
              contactBodyRequest(JSON.stringify(submission), transport),
              expected
            );
          }
        );
      }
    }
  }

  for (const transport of /** @type {const} */ (["declared", "streamed"])) {
    await t.test(`combined maximum fields, ${transport}`, async () => {
      await assertContactAcceptance(
        contactBodyRequest(
          JSON.stringify({
            ...VALID_SUBMISSION,
            ...Object.fromEntries(
              Object.entries(maximumFields).map(([field, value]) => [
                field,
                ` ${value} `
              ])
            )
          }),
          transport
        ),
        { ...maximumFields, email: maximumFields.email.toLowerCase() }
      );
    });
  }
});

test("contact submissions preserve empty company normalization and ignored properties", async (t) => {
  const { company: _company, ...withoutCompany } = VALID_SUBMISSION;
  const cases = [
    {
      label: "129 company spaces",
      submission: { ...VALID_SUBMISSION, company: " ".repeat(129) }
    },
    {
      label: "1000 company spaces",
      submission: { ...VALID_SUBMISSION, company: " ".repeat(1_000) }
    },
    {
      label: "null company",
      submission: { ...VALID_SUBMISSION, company: null }
    },
    {
      label: "object company",
      submission: { ...VALID_SUBMISSION, company: { padding: " ".repeat(128) } }
    },
    {
      label: "boolean company",
      submission: { ...VALID_SUBMISSION, company: true }
    },
    {
      label: "number company",
      submission: { ...VALID_SUBMISSION, company: 42 }
    },
    {
      label: "array company",
      submission: { ...VALID_SUBMISSION, company: ["ignored"] }
    },
    { label: "omitted company", submission: withoutCompany },
    {
      label: "extra string",
      submission: { ...VALID_SUBMISSION, extra: "ignored" }
    },
    {
      label: "extra object",
      submission: { ...VALID_SUBMISSION, extra: { padding: " ".repeat(128) } }
    }
  ];
  for (const { label, submission } of cases) {
    for (const transport of /** @type {const} */ (["declared", "streamed"])) {
      await t.test(`${label}, ${transport}`, async () => {
        await assertContactAcceptance(
          contactBodyRequest(JSON.stringify(submission), transport),
          { ...VALID_SUBMISSION, email: "ada@example.com" }
        );
      });
    }
  }
});

test("contact submissions accept JSON formatting and ignored properties at the byte limit", async () => {
  assert.equal(CONTACT_BODY_BYTE_LIMIT, 27_124);
  const body = JSON.stringify({
    ...VALID_SUBMISSION,
    extra: { ignored: true }
  });
  const padded = body + " ".repeat(CONTACT_BODY_BYTE_LIMIT - body.length);
  for (const transport of /** @type {const} */ (["declared", "streamed"])) {
    await assertContactAcceptance(contactBodyRequest(padded, transport), {
      ...VALID_SUBMISSION,
      email: "ada@example.com"
    });
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
        controller.enqueue(new TextEncoder().encode(body));
        controller.enqueue(
          new TextEncoder().encode(oversized.slice(body.length))
        );
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
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "invalid_request",
      message: "Complete every field and try again."
    });
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
    { ...VALID_SUBMISSION, name: ` ${"a".repeat(81)} ` },
    { ...VALID_SUBMISSION, name: "Ada\nLovelace" },
    { ...VALID_SUBMISSION, email: "not-an-email" },
    { ...VALID_SUBMISSION, email: ` ${"a".repeat(251)}@a.b ` },
    { ...VALID_SUBMISSION, topic: "Injected subject" },
    { ...VALID_SUBMISSION, message: "Too short" },
    { ...VALID_SUBMISSION, message: ` ${"a".repeat(4_001)} ` },
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
