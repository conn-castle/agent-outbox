import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  apiErrorResponse,
  apiRequestContext,
  apiSuccessResponse
} from "../src/server/api-errors.ts";
import { authenticateCallerApiRequest } from "../src/server/caller-api-auth.ts";
import {
  callerApiKeySecretDigest,
  callerCredentialLookupStatement,
  formatCallerApiKey,
  generateCallerApiKeyMaterial,
  parseCallerApiKey,
  parseCallerBearerApiKey,
  storedCallerCredentialDigestFromLookupRow,
  validateCallerBearer
} from "../src/server/caller-auth.ts";
import {
  activeLimitBlockMetadata,
  auditSafeLifecycleEvent,
  consumesMonthlyCallerApiRequestQuota,
  quotaWindowKey,
  storedByteAccounting
} from "../src/server/accounting.ts";
import {
  InsecureServerEnvironmentError,
  MissingServerEnvironmentError
} from "../src/server/env.ts";
import {
  accountLimitStatusMetadata,
  doctorLimitMetadata,
  fileUploadEnabled,
  getLimitDefinition,
  limitErrorMetadata,
  MONTHLY_CALLER_API_REQUEST_QUOTA_OPERATION_KINDS
} from "../src/server/limits.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";

const initialMigration = readFileSync(
  new URL(
    "../db/migrations/V20260630000000__initial_schema.sql",
    import.meta.url
  ),
  "utf8"
);

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
          name: "malformed expiry timestamp",
          apiKey: material.plaintextApiKey,
          credential: {
            ...baseCredential,
            expiresAt: "not-a-timestamp"
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
test("validateCallerBearer accepts only the configured smoke token", () => {
  assert.deepEqual(validateCallerBearer(null, "smoke-token"), {
    ok: false,
    status: 401,
    code: "missing_authorization"
  });
  assert.deepEqual(validateCallerBearer("Basic smoke-token", "smoke-token"), {
    ok: false,
    status: 401,
    code: "invalid_authorization_scheme"
  });
  assert.deepEqual(validateCallerBearer("Bearer wrong", "smoke-token"), {
    ok: false,
    status: 403,
    code: "invalid_bearer_token"
  });
  assert.deepEqual(
    validateCallerBearer(" bearer smoke-token ", "smoke-token"),
    {
      ok: true,
      callerId: "runtime-smoke-caller"
    }
  );
});
test("caller API key helpers create display-once material and lookup metadata", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE }, () => {
    const material = generateCallerApiKeyMaterial();
    const parsed = parseCallerApiKey(material.plaintextApiKey);

    assert.equal(parsed.ok, true);
    assert.equal(material.keyId, parsed.ok ? parsed.keyId : null);
    assert.match(material.plaintextApiKey, /^aob_live_[a-z2-7]+_[a-z2-7]+$/);
    assert.notEqual(material.secretDigest, material.plaintextApiKey);
    assert.equal(material.secretDigest.length, 64);
    assert.match(
      initialMigration,
      /secret_hmac_sha256 text not null,\n  status text not null/
    );
    assert.match(
      initialMigration,
      /check \(secret_hmac_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/
    );
    assert.match(
      initialMigration,
      /create or replace function public\.agent_outbox_lookup_caller_credential\(p_key_id text\)/
    );

    assert.deepEqual(callerCredentialLookupStatement(material.keyId), {
      sql: "select * from public.agent_outbox_lookup_caller_credential($1)",
      values: [material.keyId]
    });
    assert.deepEqual(
      storedCallerCredentialDigestFromLookupRow({
        account_id: "account-123",
        caller_id: "caller-123",
        key_id: material.keyId,
        secret_hmac_sha256: material.secretDigest,
        status: "active",
        revoked_at: null,
        expires_at: "2099-01-01T00:00:00.000Z"
      }),
      {
        accountId: "account-123",
        callerId: "caller-123",
        keyId: material.keyId,
        secretDigest: material.secretDigest,
        expiresAt: "2099-01-01T00:00:00.000Z",
        revokedAt: null,
        status: "active"
      }
    );
    assert.deepEqual(parseCallerBearerApiKey("Bearer malformed"), {
      ok: false,
      status: 401,
      code: "invalid_caller_api_key"
    });
    assert.equal(
      parseCallerBearerApiKey(`bEaReR ${material.plaintextApiKey}`).ok,
      true
    );
  });
});
test("caller key digest fails loud when the server hash secret is missing", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: undefined }, () => {
    assert.throws(
      () => callerApiKeySecretDigest("caller-secret"),
      (error) => {
        assert.ok(error instanceof MissingServerEnvironmentError);
        assert.equal(error.missingName, "CALLER_KEY_HASH_SECRET");
        assert.doesNotMatch(error.message, /caller-secret/);
        return true;
      }
    );
  });
});
test("caller key digest rejects a hash secret weaker than the minimum length", () => {
  withProcessEnv({ CALLER_KEY_HASH_SECRET: "short-secret" }, () => {
    assert.throws(
      () => callerApiKeySecretDigest("caller-secret"),
      (error) => {
        assert.ok(error instanceof InsecureServerEnvironmentError);
        assert.equal(error.insecureName, "CALLER_KEY_HASH_SECRET");
        assert.doesNotMatch(error.message, /caller-secret/);
        return true;
      }
    );
  });
});
test("limits metadata uses explicit disabled states and maps self-hosted to paid without Stripe state", () => {
  const freeStatus = accountLimitStatusMetadata("hosted-free");
  const paidStatus = accountLimitStatusMetadata("hosted-paid");
  const selfHostedStatus = accountLimitStatusMetadata("self-hosted");
  /**
   * @param {import("../src/server/limits.ts").AccountLimitStatusMetadata} status
   * @param {import("../src/server/limits.ts").LimitName} limitName
   */
  const limitStatus = (status, limitName) => {
    const limit = status.limits.find((entry) => entry.limitName === limitName);
    assert.ok(limit, limitName);
    return limit;
  };

  assert.equal(fileUploadEnabled("hosted-free"), false);
  assert.equal(fileUploadEnabled("hosted-paid"), true);
  assert.equal(fileUploadEnabled("self-hosted"), true);
  assert.equal(freeStatus.stripeBillingState, "not_applicable");
  assert.equal(paidStatus.stripeBillingState, "required");
  assert.equal(selfHostedStatus.stripeBillingState, "not_applicable");
  assert.equal(selfHostedStatus.effectiveTier, "paid");
  assert.equal(
    doctorLimitMetadata("hosted-free").length,
    freeStatus.limits.length
  );

  for (const status of [freeStatus, paidStatus, selfHostedStatus]) {
    assert.deepEqual(
      limitStatus(status, "input_send_replace_requests_per_account_per_minute")
        .setting,
      { mode: "enabled", value: 600 }
    );
    assert.deepEqual(
      limitStatus(status, "input_delete_requests_per_account_per_minute")
        .setting,
      { mode: "enabled", value: 600 }
    );
    assert.deepEqual(
      limitStatus(
        status,
        "output_file_download_requests_per_account_per_minute"
      ).setting,
      { mode: "enabled", value: 60 }
    );
    assert.equal(
      limitStatus(
        status,
        "authenticated_caller_api_requests_per_calendar_month"
      ).setting.mode,
      status.profileId === "hosted-free" ? "enabled" : "disabled"
    );
  }

  assert.deepEqual(
    doctorLimitMetadata("hosted-free")
      .filter((entry) =>
        [
          "input_send_replace_requests_per_account_per_minute",
          "input_delete_requests_per_account_per_minute",
          "output_file_download_requests_per_account_per_minute"
        ].includes(entry.limitName)
      )
      .map((entry) => entry.checkName),
    [
      "limits.input_send_replace.minute",
      "limits.input_delete.minute",
      "limits.output_file_download.minute"
    ]
  );
});
test("limit error and active block metadata derive reason fields from the limits catalog", () => {
  assert.deepEqual(
    limitErrorMetadata(
      "hosted-free",
      "output_check_read_requests_per_account_per_minute",
      {
        usedUnits: 121,
        limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
      }
    ),
    {
      status: 429,
      code: "rate_limit_exceeded",
      limitName: "output_check_read_requests_per_account_per_minute",
      limitReasonCode: "output_check_read_rate_limited",
      limitReason: "Output check/read requests are temporarily rate limited.",
      limitResetsAt: "2026-06-30T12:01:00.000Z",
      usedUnits: 121,
      limitUnits: 120,
      unit: "requests"
    }
  );

  assert.deepEqual(
    [
      limitErrorMetadata(
        "hosted-free",
        "input_send_replace_requests_per_account_per_minute",
        {
          usedUnits: 601,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      ),
      limitErrorMetadata(
        "hosted-free",
        "input_delete_requests_per_account_per_minute",
        {
          usedUnits: 601,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      ),
      limitErrorMetadata(
        "hosted-free",
        "output_file_download_requests_per_account_per_minute",
        {
          usedUnits: 61,
          limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
        }
      )
    ],
    [
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "input_send_replace_requests_per_account_per_minute",
        limitReasonCode: "input_send_replace_rate_limited",
        limitReason:
          "Input send/replace requests are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 601,
        limitUnits: 600,
        unit: "requests"
      },
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "input_delete_requests_per_account_per_minute",
        limitReasonCode: "input_delete_rate_limited",
        limitReason: "Input delete requests are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 601,
        limitUnits: 600,
        unit: "requests"
      },
      {
        status: 429,
        code: "rate_limit_exceeded",
        limitName: "output_file_download_requests_per_account_per_minute",
        limitReasonCode: "output_file_download_rate_limited",
        limitReason: "Output file downloads are temporarily rate limited.",
        limitResetsAt: "2026-06-30T12:01:00.000Z",
        usedUnits: 61,
        limitUnits: 60,
        unit: "requests"
      }
    ]
  );

  assert.deepEqual(
    activeLimitBlockMetadata({
      selector: "hosted-free",
      accountId: "account_a",
      operationKind: "output_check_read",
      limitName: "output_check_read_requests_per_account_per_minute",
      usedUnits: 121,
      limitResetsAt: new Date("2026-06-30T12:01:00.000Z")
    }),
    {
      account_id: "account_a",
      operation_kind: "output_check_read",
      limit_name: "output_check_read_requests_per_account_per_minute",
      limit_reason_code: "output_check_read_rate_limited",
      limit_reason: "Output check/read requests are temporarily rate limited.",
      limit_resets_at: "2026-06-30T12:01:00.000Z",
      used_units: 121,
      limit_units: 120
    }
  );
  assert.deepEqual(
    getLimitDefinition("input_send_replace_requests_per_account_per_minute")
      .operationKinds,
    ["input_send_replace"]
  );
  assert.deepEqual(
    getLimitDefinition("input_delete_requests_per_account_per_minute")
      .operationKinds,
    ["input_delete"]
  );
  assert.deepEqual(
    getLimitDefinition("output_file_download_requests_per_account_per_minute")
      .operationKinds,
    ["output_file_download"]
  );
  assert.throws(
    () =>
      activeLimitBlockMetadata({
        selector: "hosted-free",
        accountId: "account_a",
        operationKind: "output_ack",
        limitName: "output_check_read_requests_per_account_per_minute"
      }),
    /does not apply/
  );
});
test("accounting helpers keep audit data content-safe and use quota windows for flow limits", () => {
  const unsafeAuditInput = /** @type {any} */ ({
    eventType: "input_answered",
    accountAuditId: "account_audit",
    callerAuditId: "caller_audit",
    inputItemId: "input_id",
    outputResultId: "output_id",
    itemStatus: "answered",
    responseKind: "free_text",
    nonFileBytes: 120,
    callerItemIdHash: "hash_only",
    metadata: {
      revision: 2,
      caller_display: "raw caller name",
      safe_string: "looks safe but is still untrusted"
    },
    // Runtime callers may accidentally pass raw content; the helper must not keep it.
    titleHtml: "<strong>private</strong>",
    freeTextAnswer: "private text",
    callerDisplayName: "raw caller name"
  });
  const auditEvent = auditSafeLifecycleEvent(unsafeAuditInput);

  assert.deepEqual(auditEvent, {
    event_type: "input_answered",
    account_audit_id: "account_audit",
    caller_audit_id: "caller_audit",
    input_item_id: "input_id",
    output_result_id: "output_id",
    item_status: "answered",
    response_kind: "free_text",
    non_file_bytes: 120,
    caller_item_id_hash: "hash_only",
    metadata: { revision: 2 }
  });
  assert.deepEqual(
    quotaWindowKey(
      "authenticated_caller_api_requests_per_calendar_month",
      new Date("2026-06-30T12:34:56.789Z")
    ),
    {
      metric: "authenticated_caller_api_requests_per_calendar_month",
      windowKind: "calendar_month",
      windowStartUtc: "2026-06-01T00:00:00.000Z"
    }
  );
  assert.equal(consumesMonthlyCallerApiRequestQuota("output_check_read"), true);
  assert.deepEqual(
    storedByteAccounting({
      inputPayloadBytes: 100,
      outputPayloadBytes: 25,
      fileBytes: 900
    }),
    {
      nonFileQueuePayloadBytes: 125,
      fileBytes: 900,
      overallStoredAccountDataBytes: 1025
    }
  );
  assert.throws(
    () =>
      auditSafeLifecycleEvent({
        eventType: "input_deleted",
        accountAuditId: "account_audit",
        nonFileBytes: -1
      }),
    /nonFileBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      auditSafeLifecycleEvent({
        eventType: "file_deleted",
        accountAuditId: "account_audit",
        fileBytes: Number.NaN
      }),
    /fileBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      storedByteAccounting({
        inputPayloadBytes: Number.MAX_SAFE_INTEGER,
        outputPayloadBytes: 1
      }),
    /nonFileQueuePayloadBytes must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      storedByteAccounting({
        inputPayloadBytes: 1,
        outputPayloadBytes: 1,
        fileBytes: 0.5
      }),
    /fileBytes must be a non-negative safe integer/
  );
});
