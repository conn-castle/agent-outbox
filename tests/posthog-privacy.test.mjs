import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeAnalyticsEvent,
  sanitizedAnalyticsUrl
} from "../src/client/posthog-privacy.ts";

const origin = "https://agent-outbox.dev";

test("PostHog URL sanitization keeps direct referrers while removing private URL data", () => {
  assert.equal(sanitizedAnalyticsUrl("$direct", origin), "$direct");
  assert.equal(
    sanitizedAnalyticsUrl(
      "https://referrer.example/path?campaign=secret#fragment",
      origin
    ),
    "https://referrer.example/"
  );
  assert.equal(
    sanitizedAnalyticsUrl(
      "/caller/connect/device?user_code=secret#hash",
      origin
    ),
    "https://agent-outbox.dev/caller"
  );
});

test("PostHog collapses external private-looking paths to the origin root", () => {
  for (const prefix of [
    "/api",
    "/human",
    "/caller",
    "/sign-in",
    "/sign-up",
    "/upgrade"
  ]) {
    for (const suffix of ["", "/private-id"]) {
      for (const external of [
        "https://external.example",
        "https://agent-outbox.dev.evil.example",
        "https://agent-outbox.dev:8443"
      ]) {
        assert.equal(
          sanitizedAnalyticsUrl(
            `${external}${prefix}${suffix}?secret=value#fragment`,
            origin
          ),
          `${external}/`
        );
      }
      assert.equal(
        sanitizedAnalyticsUrl(
          `//external.example${prefix}${suffix}?secret=value#fragment`,
          origin
        ),
        "https://external.example/"
      );
    }
  }
});

test("PostHog preserves internal private-route prefixes across current and hosted origins", () => {
  for (const current of [
    origin,
    "https://app.agent-outbox.dev",
    "http://127.0.0.1:39010"
  ]) {
    for (const internal of new Set([
      current,
      origin,
      "https://app.agent-outbox.dev"
    ])) {
      for (const prefix of [
        "/api",
        "/human",
        "/caller",
        "/sign-in",
        "/sign-up",
        "/upgrade"
      ]) {
        for (const suffix of ["", "/private-id"]) {
          assert.equal(
            sanitizedAnalyticsUrl(
              `${internal}${prefix}${suffix}?secret=value#fragment`,
              current
            ),
            `${internal}${prefix}`
          );
        }
      }
    }
    assert.equal(
      sanitizedAnalyticsUrl("/human/private-id?secret=value#fragment", current),
      `${current}/human`
    );
  }
});

test("PostHog removes external private-looking paths from events and heatmap keys", () => {
  const event = sanitizeAnalyticsEvent(
    {
      properties: {
        $referrer: "https://external.example/api/private-id?secret=value",
        $heatmap_data: {
          "https://external.example/human/private-a": [[1, 2]],
          "https://external.example/caller/private-b": [[3, 4]]
        }
      },
      $set: {
        $current_url: "https://external.example/sign-in/private-id#fragment"
      },
      $set_once: {
        $initial_referrer: "https://external.example/upgrade/private-id"
      }
    },
    origin
  );

  assert.equal(event.properties.$referrer, "https://external.example/");
  assert.equal(event.$set.$current_url, "https://external.example/");
  assert.equal(event.$set_once.$initial_referrer, "https://external.example/");
  assert.deepEqual(event.properties.$heatmap_data, {
    "https://external.example/": [
      [1, 2],
      [3, 4]
    ]
  });
});

test("PostHog sanitizes heatmap URL keys and combines collapsed points", () => {
  const event = sanitizeAnalyticsEvent(
    {
      properties: {
        $heatmap_data: {
          "https://agent-outbox.dev/human?item=private-a": [[1, 2]],
          "https://agent-outbox.dev/human?item=private-b#answer": [[3, 4]]
        }
      },
      $set_once: {
        $initial_referrer: "$direct",
        $initial_current_url:
          "https://agent-outbox.dev/human?user_code=private#hash"
      }
    },
    origin
  );

  assert.deepEqual(event.properties?.$heatmap_data, {
    "https://agent-outbox.dev/human": [
      [1, 2],
      [3, 4]
    ]
  });
  assert.equal(event.$set_once?.$initial_referrer, "$direct");
  assert.equal(
    event.$set_once?.$initial_current_url,
    "https://agent-outbox.dev/human"
  );
});

test("PostHog drops DOM attribution and redacts pathnames and embedded link URLs", () => {
  const event = sanitizeAnalyticsEvent(
    {
      properties: {
        $pathname: "/caller/connect/private-secret",
        $initial_pathname: "/human/private-item",
        $elements_chain: 'a:nth-child="1"href="/caller?user_code=private-code"',
        $web_vitals_INP_event: {
          attribution: {
            interactionTarget: "#review-row-private-id",
            inputDelay: 12
          }
        },
        $web_vitals_LCP_event: {
          attribution: {
            target: "#review-detail-private-id",
            url: "https://example.com/file?secret=value"
          }
        },
        $current_url: "https://[invalid]?secret=value"
      }
    },
    origin
  );
  const sent = JSON.stringify(event);
  for (const secret of [
    "private-secret",
    "private-item",
    "private-code",
    "private-id",
    "secret=value"
  ])
    assert(!sent.includes(secret), secret);
  assert.equal(event.properties.$pathname, "/caller");
  assert.equal(
    event.properties.$web_vitals_INP_event.attribution.inputDelay,
    12
  );
  assert.equal(event.properties.$current_url, "[redacted]");
  assert.equal(
    sanitizedAnalyticsUrl("mailto:private@example.com", origin),
    "[redacted]"
  );
});

test("PostHog preserves both hosted origins but strips API identifiers and URL credentials", () => {
  for (const current of [
    origin,
    "https://app.agent-outbox.dev",
    "http://127.0.0.1:39010"
  ]) {
    for (const hosted of [origin, "https://app.agent-outbox.dev"]) {
      assert.equal(
        sanitizedAnalyticsUrl(
          `${hosted}/docs/api/row-anatomy?q=private#secret`,
          current
        ),
        `${hosted}/docs/api/row-anatomy`
      );
      assert.equal(
        sanitizedAnalyticsUrl(
          `${hosted}/api/output/private-output/files/private-file`,
          current
        ),
        `${hosted}/api`
      );
      assert.equal(
        sanitizedAnalyticsUrl(`${hosted}/api`, current),
        `${hosted}/api`
      );
      assert.equal(
        sanitizedAnalyticsUrl(`${hosted}/api-reference`, current),
        `${hosted}/api-reference`
      );
    }
    assert.equal(
      sanitizedAnalyticsUrl(
        "https://user:password@agent-outbox.dev/docs?secret=1#secret",
        current
      ),
      `${origin}/docs`
    );
    assert.equal(
      sanitizedAnalyticsUrl(
        "https://user:password@external.example/path",
        current
      ),
      "https://external.example/"
    );
    assert.equal(
      sanitizedAnalyticsUrl(
        "https://agent-outbox.dev.evil.example/docs",
        current
      ),
      "https://agent-outbox.dev.evil.example/"
    );
  }
});

test("sensitive content retains its ph-no-capture wrappers", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "app/caller/layout.tsx",
    "app/sign-in/layout.tsx",
    "app/sign-up/layout.tsx",
    "app/upgrade/page.tsx",
    "src/components/human/ReviewWorkspace.tsx"
  ]) {
    assert.match(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
      /className="[^"]*\bph-no-capture\b[^"]*"/,
      file
    );
  }
  for (const file of ["app/human/page.tsx", "app/sign-out/page.tsx"]) {
    const source = await readFile(
      new URL(`../${file}`, import.meta.url),
      "utf8"
    );
    assert.match(
      source,
      /<div className="ph-no-capture">\s*<MissingConfigurationPanel[\s\S]*?\/>\s*<\/div>/,
      file
    );
    if (file.includes("sign-out"))
      assert.match(source, /<main className="main auth-main ph-no-capture">/);
  }
});
