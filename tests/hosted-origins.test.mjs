import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyHost,
  hrefOnOrigin,
  hostedHostRedirect,
  pathBelongsOnApp,
  pathBelongsOnWebsite
} from "../src/shared/hosted-origins.ts";
import { SYSTEM_CONTRACT } from "../src/shared/system-contract.ts";

test("hosted origins keep local development on one origin", () => {
  assert.equal(classifyHost("127.0.0.1:38000"), "local");
  assert.equal(classifyHost("localhost"), "local");
  assert.equal(classifyHost("[::1]:38000"), "local");
  assert.equal(
    hostedHostRedirect("http://127.0.0.1:38000/human", "127.0.0.1:38000"),
    null
  );
  assert.equal(hrefOnOrigin("app", "/sign-in", "localhost:38000"), "/sign-in");
  assert.equal(
    hrefOnOrigin("website", "/#pricing", "127.0.0.1:38000"),
    "/#pricing"
  );
});

test("hosted origins send marketing-root app paths to the app origin", () => {
  assert.equal(classifyHost("agent-outbox.dev"), "website");
  assert.equal(pathBelongsOnApp("/human"), true);
  assert.equal(pathBelongsOnApp("/api/input/send"), true);
  assert.equal(pathBelongsOnApp("/api/contact"), false);
  assert.equal(
    hostedHostRedirect(
      "https://agent-outbox.dev/human?item=1",
      "agent-outbox.dev"
    )?.href,
    "https://app.agent-outbox.dev/human?item=1"
  );
  assert.equal(
    hostedHostRedirect("https://agent-outbox.dev/sign-up", "agent-outbox.dev")
      ?.href,
    "https://app.agent-outbox.dev/sign-up"
  );
  assert.equal(
    hostedHostRedirect(
      "https://agent-outbox.dev/api/contact",
      "agent-outbox.dev"
    ),
    null
  );
  assert.equal(
    hrefOnOrigin("app", "/sign-up", "agent-outbox.dev"),
    "https://app.agent-outbox.dev/sign-up"
  );
});

test("hosted origins keep the marketing page on the website root", () => {
  assert.equal(pathBelongsOnWebsite("/"), true);
  assert.equal(pathBelongsOnWebsite("/docs/api"), true);
  assert.equal(
    hostedHostRedirect("https://agent-outbox.dev/", "agent-outbox.dev"),
    null
  );
  assert.equal(
    hostedHostRedirect("https://app.agent-outbox.dev/", "app.agent-outbox.dev")
      ?.href,
    "https://app.agent-outbox.dev/human"
  );
  assert.equal(
    hostedHostRedirect(
      "https://app.agent-outbox.dev/docs/api",
      "app.agent-outbox.dev"
    )?.href,
    "https://agent-outbox.dev/docs/api"
  );
  assert.equal(
    hrefOnOrigin("website", "/#installation", "app.agent-outbox.dev"),
    `${SYSTEM_CONTRACT.hostedWebsiteBaseUrl}/#installation`
  );
});
