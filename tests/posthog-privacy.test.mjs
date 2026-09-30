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
