import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { transactionContextCanaryStatements as databaseCanaryStatements } from "../src/server/database.ts";
import {
  absoluteHttpOrigin,
  InsecureServerEnvironmentError,
  MissingServerEnvironmentError,
  runtimeConfigStatus
} from "../src/server/env.ts";
import { applicationSecurityHeaders } from "../src/server/http-security.ts";
import { runtimeCanaryResponseBody } from "../src/server/runtime-canary.ts";
import { sentryCaptureEnabled } from "../src/server/sentry.ts";
import { withProcessEnv } from "./helpers/process-env.mjs";

const HASH_SECRET_FIXTURE = "0123456789abcdef0123456789abcdef";

test("runtimeConfigStatus reports missing provider values without exposing values", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: undefined,
      DATABASE_APP_ROLE_URL: undefined,
      SENTRY_DSN: undefined,
      SMOKE_OR_CLEANUP_TOKEN: undefined,
      CALLER_KEY_HASH_SECRET: undefined
    },
    () => {
      const status = runtimeConfigStatus();

      assert.equal(status.configured, false);
      assert.deepEqual(status.missing, [
        "CLERK_PUBLISHABLE_KEY",
        "DATABASE_APP_ROLE_URL",
        "SENTRY_DSN",
        "SMOKE_OR_CLEANUP_TOKEN",
        "CALLER_KEY_HASH_SECRET"
      ]);
      assert.deepEqual(status.insecure, []);
    }
  );
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: "pk_test_secret",
      DATABASE_APP_ROLE_URL: "postgresql://example",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      CALLER_KEY_HASH_SECRET: "short-secret"
    },
    () => {
      const status = runtimeConfigStatus();

      assert.equal(status.configured, false);
      assert.deepEqual(status.missing, []);
      assert.deepEqual(status.insecure, ["CALLER_KEY_HASH_SECRET"]);
    }
  );
});
test("absoluteHttpOrigin accepts only an origin-safe HTTP(S) URL", () => {
  assert.equal(
    absoluteHttpOrigin("https://app.example.test"),
    "https://app.example.test"
  );
  assert.equal(
    absoluteHttpOrigin("http://127.0.0.1:38000/"),
    "http://127.0.0.1:38000"
  );
  for (const invalid of [
    undefined,
    "not-a-url",
    "mailto:operator@example.test",
    "https://user:secret@app.example.test",
    "https://app.example.test/path",
    "https://app.example.test/?mode=test",
    "https://app.example.test/#fragment"
  ]) {
    assert.equal(absoluteHttpOrigin(invalid), null);
  }
});
test("application security headers add HSTS only in production", () => {
  const development = applicationSecurityHeaders("development");
  assert.deepEqual(development, [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()"
    }
  ]);
  assert.deepEqual(applicationSecurityHeaders("production"), [
    ...development,
    { key: "Strict-Transport-Security", value: "max-age=31536000" }
  ]);
  assert.deepEqual(applicationSecurityHeaders("test", true), [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()"
    }
  ]);

  const nextConfig = readFileSync(
    new URL("../next.config.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    nextConfig,
    /source: "\/:path\*"[\s\S]*headers: applicationSecurityHeaders\([\s\S]*process\.env\.APP_ENV,[\s\S]*process\.env\.AGENT_OUTBOX_BROWSER_FIXTURE === "1"[\s\S]*\)/,
    "Next.js must apply the security-header policy to every application path"
  );
});
test("runtime canary keeps configuration detail behind smoke bearer auth", () => {
  withProcessEnv(
    {
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
      CLERK_SECRET_KEY: "sk_test_secret",
      CLERK_PUBLISHABLE_KEY: "pk_test_secret",
      DATABASE_APP_ROLE_URL: "postgresql://example",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "release-sha",
      SMOKE_OR_CLEANUP_TOKEN: "smoke-token",
      CALLER_KEY_HASH_SECRET: HASH_SECRET_FIXTURE
    },
    () => {
      const publicBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        null
      );

      assert.equal(publicBody.ok, true);
      assert.equal(publicBody.code, "runtime_canary_ok");
      assert.equal(publicBody.origin, "https://example.test");
      assert.equal(publicBody.one_app_api_origin, true);
      assert.equal(Object.hasOwn(publicBody, "environment"), false);
      assert.equal(Object.hasOwn(publicBody, "postgres_driver"), false);
      assert.equal(Object.hasOwn(publicBody, "out_of_scope"), false);

      const rejectedBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "Bearer wrong-token"
      );
      assert.equal(Object.hasOwn(rejectedBody, "environment"), false);

      withProcessEnv({ SMOKE_OR_CLEANUP_TOKEN: undefined }, () => {
        const unsetTokenBody = runtimeCanaryResponseBody(
          "https://example.test/api/runtime/canary",
          "Bearer smoke-token"
        );
        assert.equal(Object.hasOwn(unsetTokenBody, "environment"), false);
        assert.equal(Object.hasOwn(unsetTokenBody, "postgres_driver"), false);
        assert.equal(Object.hasOwn(unsetTokenBody, "out_of_scope"), false);
      });

      const smokeBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "Bearer smoke-token"
      );
      const trimmedSmokeBody = runtimeCanaryResponseBody(
        "https://example.test/api/runtime/canary",
        "  Bearer smoke-token  "
      );

      assert("environment" in smokeBody);
      assert("environment" in trimmedSmokeBody);
      assert("postgres_driver" in smokeBody);
      assert("out_of_scope" in smokeBody);
      assert.equal(smokeBody.environment.configured, true);
      assert.deepEqual(smokeBody.environment.missing, []);
      assert.deepEqual(smokeBody.environment.insecure, []);
      assert.equal(smokeBody.environment.appEnv, "development");
      assert.equal(smokeBody.environment.release, "release-sha");
      assert.deepEqual(smokeBody.postgres_driver, {
        package: "pg",
        client: "function"
      });
      assert.deepEqual(smokeBody.out_of_scope, [
        "full_human_review_queue_ui",
        "caller_registration",
        "steward_behavior"
      ]);
    }
  );
});
test("sentryCaptureEnabled only allows production runtime capture", () => {
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      SENTRY_RELEASE: "agent-outbox@2026.07.07",
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), true)
  );
  withProcessEnv(
    {
      APP_ENV: "development",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: "true",
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
      CI: undefined,
      NODE_ENV: "test"
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
  withProcessEnv(
    {
      APP_ENV: "production",
      SENTRY_DSN: undefined,
      CI: undefined,
      NODE_ENV: undefined
    },
    () => assert.equal(sentryCaptureEnabled(), false)
  );
});
test("database canary statements keep transaction context scoped to one transaction", () => {
  assert.deepEqual(databaseCanaryStatements("request-123"), [
    { sql: "begin" },
    {
      sql: "select set_config($1, $2, true)",
      values: ["agent_outbox.request_id", "request-123"]
    },
    {
      sql: "select current_setting($1, true) as request_id",
      values: ["agent_outbox.request_id"]
    },
    {
      sql: "select current_user as role_name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit from pg_catalog.pg_roles r where r.rolname = current_user"
    },
    { sql: "rollback" }
  ]);
});
