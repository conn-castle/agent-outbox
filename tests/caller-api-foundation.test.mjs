import assert from "node:assert/strict";
import test from "node:test";

import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../src/server/api-errors.ts";
import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import {
  callerApiKeySecretDigest,
  formatCallerApiKey,
  generateCallerApiKeyMaterial,
  parseCallerApiKey
} from "../src/server/caller-auth.ts";
import { consumesMonthlyCallerApiRequestQuota } from "../src/server/accounting.ts";
import {
  getLimitDefinition,
  limitErrorMetadata,
  MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS
} from "../src/server/limits.ts";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";

/**
 * @template TResult
 * @param {Record<string, string | undefined>} values
 * @param {() => TResult | Promise<TResult>} callback
 * @returns {Promise<TResult>}
 */
async function withProcessEnv(values, callback) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("API response helpers emit documented envelopes and limit retry metadata", async () => {
  const request = new Request("https://app.agent-outbox.dev/api/output/check", {
    headers: {
      "X-Request-ID": "caller-req_123"
    }
  });
  const context = apiRequestContext(request);

  assert.equal(context.requestId, "caller-req_123");
  assert.match(context.correlationId, /^corr_/);

  const success = apiSuccessResponse(context, { ready_count: 0 });
  assert.equal(success.headers.get("X-Request-ID"), "caller-req_123");
  assert.equal(success.headers.get("X-Correlation-ID"), context.correlationId);
  assert.deepEqual(await success.json(), {
    ok: true,
    request_id: "caller-req_123",
    correlation_id: context.correlationId,
    data: { ready_count: 0 }
  });

  const error = apiErrorResponse(context, {
    status: 429,
    code: "rate_limit_exceeded",
    message: "Output check/read requests are temporarily rate limited.",
    retryAfterSeconds: 17,
    limit: limitErrorMetadata(
      "hosted-free",
      "output_check_read_requests_per_account_per_minute",
      {
        usedUnits: 121,
        limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
      }
    )
  });

  assert.equal(error.status, 429);
  assert.equal(error.headers.get("Retry-After"), "17");
  assert.deepEqual(await error.json(), {
    ok: false,
    request_id: "caller-req_123",
    correlation_id: context.correlationId,
    error: {
      code: "rate_limit_exceeded",
      message: "Output check/read requests are temporarily rate limited.",
      retry_after_seconds: 17,
      limit: {
        limit_name: "output_check_read_requests_per_account_per_minute",
        limit_reason_code: "output_check_read_rate_limited",
        limit_reason:
          "Output check/read requests are temporarily rate limited.",
        limit_resets_at: "2026-06-30T12:01:00.000Z"
      }
    }
  });
});

test("caller API auth masks invalid credentials and lifecycle failures from clients", async () => {
  await withProcessEnv(
    { CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE },
    async () => {
      const material = generateCallerApiKeyMaterial();
      const otherMaterial = generateCallerApiKeyMaterial();
      const materialParsed = parseCallerApiKey(material.plaintextApiKey);
      const otherParsed = parseCallerApiKey(otherMaterial.plaintextApiKey);

      assert.equal(materialParsed.ok, true);
      assert.equal(otherParsed.ok, true);
      const materialSecret = materialParsed.ok ? materialParsed.secret : "";
      const wrongSecret = otherParsed.ok ? otherParsed.secret : "";
      const wrongApiKey = formatCallerApiKey({
        keyId: material.keyId,
        secret: wrongSecret
      });
      /** @type {import("../src/server/caller-auth.ts").StoredCallerCredentialDigest} */
      const baseCredential = {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        status: "active"
      };

      /** @type {{ name: string, apiKey: string, credential: import("../src/server/caller-auth.ts").StoredCallerCredentialDigest | null, expectedInternal?: import("../src/server/caller-api-auth.ts").CallerApiAuthFailure["internal"] }[]} */
      const cases = [
        {
          name: "not found",
          apiKey: material.plaintextApiKey,
          credential: null,
          expectedInternal: {
            reason: "credential_not_found",
            keyId: material.keyId,
            credentialStatus: undefined,
            secretDigestCompared: true,
            secretMatched: false
          }
        },
        {
          name: "wrong secret",
          apiKey: wrongApiKey,
          credential: baseCredential
        },
        {
          name: "revoked",
          apiKey: material.plaintextApiKey,
          credential: { ...baseCredential, status: "revoked" }
        },
        {
          name: "expired",
          apiKey: material.plaintextApiKey,
          credential: { ...baseCredential, status: "expired" }
        },
        {
          name: "expired by timestamp",
          apiKey: material.plaintextApiKey,
          credential: {
            ...baseCredential,
            expiresAt: "2000-01-01T00:00:00.000Z"
          },
          expectedInternal: {
            reason: "credential_expired",
            keyId: material.keyId,
            credentialStatus: "active",
            secretDigestCompared: true,
            secretMatched: true
          }
        },
        {
          name: "pending",
          apiKey: material.plaintextApiKey,
          credential: { ...baseCredential, status: "pending_activation" },
          expectedInternal: {
            reason: "credential_not_active",
            keyId: material.keyId,
            credentialStatus: "pending_activation",
            secretDigestCompared: true,
            secretMatched: true
          }
        },
        {
          name: "key id mismatch",
          apiKey: material.plaintextApiKey,
          credential: { ...baseCredential, keyId: otherMaterial.keyId },
          expectedInternal: {
            reason: "credential_key_id_mismatch",
            keyId: material.keyId,
            credentialStatus: "active",
            secretDigestCompared: true,
            secretMatched: true
          }
        },
        {
          name: "invalid stored digest",
          apiKey: material.plaintextApiKey,
          credential: { ...baseCredential, secretDigest: "not-a-digest" },
          expectedInternal: {
            reason: "invalid_stored_digest",
            keyId: material.keyId,
            credentialStatus: "active",
            secretDigestCompared: false,
            secretMatched: null
          }
        }
      ];
      const results = [];

      for (const authCase of cases) {
        /** @type {string[]} */
        const lookedUpKeyIds = [];
        const result = await authenticateCallerApiRequest(
          new Request("https://app.agent-outbox.dev/api/input/send", {
            headers: { authorization: `Bearer ${authCase.apiKey}` }
          }),
          async (keyId) => {
            lookedUpKeyIds.push(keyId);
            return authCase.credential;
          },
          { now: new Date("2026-06-30T12:00:00.000Z") }
        );

        assert.deepEqual(lookedUpKeyIds, [material.keyId], authCase.name);
        assert.equal(result.ok, false, authCase.name);
        if (authCase.expectedInternal) {
          assert.deepEqual(result.internal, authCase.expectedInternal);
        }
        results.push(result);
      }

      for (const result of results) {
        assert.equal(result.ok, false);
        assert.deepEqual(result.clientError, {
          status: 401,
          code: "invalid_caller_credentials",
          message: "Caller credentials are invalid or no longer usable."
        });
      }

      const bodies = await Promise.all(
        results.map((result) => {
          assert.equal(result.ok, false);
          return apiErrorResponse(
            { requestId: "req-test", correlationId: "corr-test" },
            result.clientError
          ).json();
        })
      );

      assert.equal(new Set(bodies.map((body) => JSON.stringify(body))).size, 1);
      assert.doesNotMatch(
        JSON.stringify(bodies[0]),
        /revoked|expired|pending|mismatch|not_active/
      );

      const revokedWrongSecret = await authenticateCallerApiRequest(
        new Request("https://app.agent-outbox.dev/api/input/send", {
          headers: { authorization: `Bearer ${wrongApiKey}` }
        }),
        async () => ({ ...baseCredential, status: "revoked" }),
        { now: new Date("2026-06-30T12:00:00.000Z") }
      );

      assert.equal(revokedWrongSecret.ok, false);
      assert.deepEqual(revokedWrongSecret.internal, {
        reason: "credential_revoked",
        keyId: material.keyId,
        credentialStatus: "revoked",
        secretDigestCompared: true,
        secretMatched: false
      });

      const active = await authenticateCallerApiRequest(
        new Request("https://app.agent-outbox.dev/api/input/send", {
          headers: { authorization: `Bearer ${material.plaintextApiKey}` }
        }),
        async () => baseCredential,
        { now: new Date("2026-06-30T12:00:00.000Z") }
      );

      assert.deepEqual(active, {
        ok: true,
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: callerApiKeySecretDigest(materialSecret),
        keyPrefix: material.keyPrefix,
        keyLastCharacters: material.keyLastCharacters
      });
    }
  );
});

test("monthly caller API request quota classifier matches the Phase 4 boundary", () => {
  assert.deepEqual(MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS, [
    "caller_api_request",
    "input_send_replace",
    "input_submission",
    "output_check_read",
    "output_file_download",
    "status"
  ]);

  /** @type {import("../src/server/limits.ts").LimitOperationKind[]} */
  const consumingOperations = [
    ...MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS
  ];
  for (const operationKind of consumingOperations) {
    assert.equal(
      consumesMonthlyCallerApiRequestQuota(operationKind),
      true,
      operationKind
    );
  }

  /** @type {import("../src/server/limits.ts").LimitOperationKind[]} */
  const exemptOperations = [
    "cleanup",
    "input_delete",
    "output_ack",
    "billing",
    "storage_write",
    "file_upload",
    "human_answer_submission"
  ];
  for (const operationKind of exemptOperations) {
    assert.equal(
      consumesMonthlyCallerApiRequestQuota(operationKind),
      false,
      operationKind
    );
  }

  assert.equal(
    consumesMonthlyCallerApiRequestQuota("input_send_replace"),
    true
  );
  assert.equal(consumesMonthlyCallerApiRequestQuota("input_delete"), false);
  assert.equal(consumesMonthlyCallerApiRequestQuota("output_ack"), false);
  assert.equal(
    consumesMonthlyCallerApiRequestQuota("output_file_download"),
    true
  );
  assert.deepEqual(
    getLimitDefinition("authenticated_caller_api_requests_per_calendar_month")
      .operationKinds,
    MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS
  );
});
