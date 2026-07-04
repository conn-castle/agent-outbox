import assert from "node:assert/strict";
import test from "node:test";

import {
  trustedClientIpAddress,
  TRUSTED_CLIENT_IP_HEADER
} from "../src/server/trusted-client-ip.ts";

test("trusted client IP accepts only a valid Cloudflare client IP header", () => {
  assert.equal(
    trustedClientIpAddress(
      new Request("https://app.agent-outbox.dev/api/caller/connect", {
        headers: {
          [TRUSTED_CLIENT_IP_HEADER]: " 203.0.113.10 "
        }
      })
    ),
    "203.0.113.10"
  );

  assert.equal(
    trustedClientIpAddress(
      new Request("https://app.agent-outbox.dev/api/caller/connect", {
        headers: {
          "x-forwarded-for": "198.51.100.10"
        }
      })
    ),
    null
  );

  assert.equal(
    trustedClientIpAddress(
      new Request("https://app.agent-outbox.dev/api/caller/connect", {
        headers: {
          [TRUSTED_CLIENT_IP_HEADER]: "not-an-ip",
          "x-forwarded-for": "198.51.100.11"
        }
      })
    ),
    null
  );
});
