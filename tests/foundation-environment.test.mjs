import assert from "node:assert/strict";
import test from "node:test";

import {
  missingEnvNames,
  validateRequiredEnvExample
} from "../scripts/foundation/environment.mjs";

test("missingEnvNames reports names without exposing configured secret values", () => {
  const example =
    "DATABASE_URL=\nAWS_PROFILE=conn\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";
  const actual =
    "DATABASE_URL=postgres://user:password@example/db\nAWS_PROFILE=conn\nCALLER_KEY_HASH_SECRET=\nAPP_BASE_URL=http://localhost:3000\n";

  assert.deepEqual(missingEnvNames(example, actual), [
    "CALLER_KEY_HASH_SECRET"
  ]);
});
test("validateRequiredEnvExample allows optional local development names", () => {
  const template =
    "APP_ENV=development\nPORT=38000\nAPP_BASE_URL=http://localhost:38000\nPUBLIC_APP_BASE_URL=http://localhost:38000\nSUPABASE_PROJECT_REF=\nDATABASE_URL=\nDATABASE_APP_ROLE_URL=\nDATABASE_MIGRATION_URL=\nCLERK_SECRET_KEY=\nCLERK_PUBLISHABLE_KEY=\nSTRIPE_ACCOUNT_ID=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PAID_MONTHLY_PRICE_ID=\nSTRIPE_PAID_YEARLY_PRICE_ID=\nSTRIPE_BILLING_PORTAL_CONFIGURATION_ID=\nSENTRY_DSN=\nSENTRY_BROWSER_DSN=\nSENTRY_RELEASE=\nSENTRY_ORG=\nSENTRY_PROJECT=\nSENTRY_AUTH_TOKEN=\nAGENT_OUTBOX_SENTRY_RELEASE_UPLOAD=\nAGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH=\nNEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN=\nCALLER_KEY_HASH_SECRET=\nSMOKE_OR_CLEANUP_TOKEN=\nAWS_PROFILE=conn\nCLOUDFLARE_DNS_API_TOKEN=\nCLOUDFLARE_WAF_API_TOKEN=\nAGENT_OUTBOX_BASE_URL=\nAGENT_OUTBOX_CONFIG_PATH=\nAGENT_OUTBOX_CALLER=\n";

  assert.deepEqual(validateRequiredEnvExample(template), []);
});
test("validateRequiredEnvExample rejects missing and unknown names", () => {
  const failures = validateRequiredEnvExample(
    "APP_ENV=development\nAPP_BASE_URL=http://localhost:3000\nEXTRA_SECRET=\n"
  );

  assert.ok(
    failures.includes(".env.example missing required name DATABASE_URL")
  );
  assert.ok(
    failures.includes(".env.example contains unknown name EXTRA_SECRET")
  );
});
