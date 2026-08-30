import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  extractDocumentedHttpContractRouteMarkers,
  extractImplementedHttpContractRouteMarkers,
  validatePhase4ContractDocContents,
  validateRuntimeProofScope
} from "../scripts/foundation/source-contracts.mjs";
import {
  validateWranglerCronSchedule,
  validateWranglerRequiredSecrets
} from "../scripts/foundation/wrangler-contracts.mjs";
import { RUNTIME_CRON_SCHEDULE } from "../src/server/scheduled.ts";

const phase4ContractDocContents = Object.fromEntries(
  [
    "docs/spec/README.md",
    "docs/spec/http-api.md",
    "docs/spec/input-schema.md",
    "docs/spec/output-schema.md",
    "docs/spec/errors.md"
  ].map((relativePath) => [
    relativePath,
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
  ])
);

const callerFacingRouteContents = Object.fromEntries(
  [
    "app/api/account/status/route.ts",
    "app/api/caller/status/route.ts",
    "app/api/input/delete/route.ts",
    "app/api/input/list/route.ts",
    "app/api/input/read/route.ts",
    "app/api/input/replace/route.ts",
    "app/api/input/send/route.ts",
    "app/api/output/[output_result_id]/ack/route.ts",
    "app/api/output/[output_result_id]/files/[file_id]/route.ts",
    "app/api/output/[output_result_id]/read/route.ts",
    "app/api/output/check/route.ts",
    "app/api/output/read-all/route.ts",
    "app/api/runtime/canary/route.ts"
  ].map((relativePath) => [
    relativePath,
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
  ])
);

test("wrangler required secrets stay limited to true Worker secrets", () => {
  const wranglerConfig = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );

  assert.deepEqual(validateWranglerRequiredSecrets(wranglerConfig), []);
  assert.deepEqual(
    validateWranglerRequiredSecrets(
      `{
        "secrets": {
          "required": ["DATABASE_APP_ROLE_URL", "APP_ENV"]
        }
      }`
    ),
    [
      "wrangler.jsonc secrets.required missing CLERK_SECRET_KEY",
      "wrangler.jsonc secrets.required missing SENTRY_DSN",
      "wrangler.jsonc secrets.required missing CALLER_KEY_HASH_SECRET",
      "wrangler.jsonc secrets.required missing SMOKE_OR_CLEANUP_TOKEN",
      "wrangler.jsonc secrets.required missing STRIPE_SECRET_KEY",
      "wrangler.jsonc secrets.required missing STRIPE_WEBHOOK_SECRET",
      "wrangler.jsonc secrets.required must not include non-Worker secret or config DATABASE_APP_ROLE_URL",
      "wrangler.jsonc secrets.required must not include non-Worker secret or config APP_ENV"
    ]
  );
});
test("validateRuntimeProofScope rejects runtime schema mutation and later-phase routes", () => {
  const failures = validateRuntimeProofScope({
    "app/human/queue/page.tsx": "export default function Queue() {}",
    "src/server/schema.ts":
      "await sql`create table agent_outbox_input_items ();`"
  });

  assert.deepEqual(failures, [
    "app/human/queue/page.tsx is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/schema.ts contains out-of-scope token: create table"
  ]);
});
test("validateRuntimeProofScope allows implemented caller API route paths", () => {
  const failures = validateRuntimeProofScope({
    "app/api/input/send/route.ts": "export async function POST() {}",
    "app/api/input/replace/route.ts": "export async function POST() {}",
    "app/api/input/delete/route.ts": "export async function POST() {}",
    "app/api/input/list/route.ts": "export async function GET() {}",
    "app/api/input/read/route.ts": "export async function POST() {}",
    "app/api/output/check/route.ts": "export async function GET() {}",
    "app/api/output/[output_result_id]/read/route.ts":
      "export async function POST() {}",
    "app/api/output/read-all/route.ts": "export async function POST() {}",
    "app/api/output/[output_result_id]/ack/route.ts":
      "export async function POST() {}",
    "app/api/output/[output_result_id]/files/[file_id]/route.ts":
      "export async function GET() {}",
    "app/api/caller/status/route.ts": "export async function GET() {}",
    "app/api/caller/connect/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/exchange/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/activate/route.ts":
      "export async function POST() {}",
    "app/api/caller/connect/abort/route.ts": "export async function POST() {}",
    "app/api/caller/rotate/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/exchange/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/activate/route.ts":
      "export async function POST() {}",
    "app/api/caller/rotate/abort/route.ts": "export async function POST() {}",
    "app/api/caller/revoke/browser/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/device/start/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/device/poll/route.ts":
      "export async function POST() {}",
    "app/api/caller/revoke/confirm/route.ts": "export async function POST() {}",
    "app/api/account/status/route.ts": "export async function GET() {}",
    "app/api/billing/checkout/route.ts": "export async function POST() {}",
    "app/api/billing/portal/route.ts": "export async function POST() {}",
    "app/api/billing/webhook/route.ts": "export async function POST() {}",
    "src/server/billing.ts": "await stripe.checkout.sessions.create({});"
  });

  assert.deepEqual(failures, []);
});
test("validateRuntimeProofScope allows Phase 3 product foundation identifiers", () => {
  const failures = validateRuntimeProofScope({
    "src/server/accounting.ts":
      "const table = 'agent_outbox_input_items'; const output = 'agent_outbox_output_results';"
  });

  assert.deepEqual(failures, []);
});
test("validateRuntimeProofScope rejects later-phase storage and source drift", () => {
  const failures = validateRuntimeProofScope({
    "app/api/account/portal/route.ts": "export async function POST() {}",
    "app/api/account/delete/route.ts": "export async function POST() {}",
    "app/api/caller/rotate/route.ts": "export async function POST() {}",
    "app/api/caller/revoke/route.ts": "export async function POST() {}",
    "app/api/caller/list/route.ts": "export async function POST() {}",
    "app/api/input/[caller_item_id]/route.ts":
      "export async function DELETE() {}",
    "app/api/human/answer/route.ts": "export async function POST() {}",
    "src/components/human/Queue.tsx": "export function Queue() {}",
    "src/cli/main.ts": "export function main() {}",
    "src/server/steward-email.ts": "export const source = 'email';",
    "src/server/email-source.ts": "export const source = 'email';",
    "src/server/files.ts": "await supabase.storage.from('files');",
    "src/server/source.ts": "const source = 'gmail classifier';"
  });

  assert.deepEqual(failures, [
    "app/api/account/portal/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/account/delete/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/rotate/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/revoke/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/caller/list/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/input/[caller_item_id]/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "app/api/human/answer/route.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/cli/main.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/steward-email.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/email-source.ts is unrelated later-phase implementation scope, not current caller API scope",
    "src/server/files.ts contains out-of-scope token: supabase.storage",
    "src/server/source.ts contains out-of-scope token: gmail",
    "src/server/source.ts contains out-of-scope token: classifier"
  ]);
});
test("validateRuntimeProofScope allows current product boundary copy", () => {
  assert.deepEqual(
    validateRuntimeProofScope({
      "app/page.tsx":
        "A protected human review queue UI, caller registration, billing, and paid file-upload workflows are current functionality. Steward-specific integration remains outside the generic product boundary."
    }),
    []
  );
});
test("validatePhase4ContractDocContents requires documented HTTP routes for implemented caller APIs", () => {
  assert.deepEqual(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      ...callerFacingRouteContents
    }),
    []
  );
  assert.ok(
    validatePhase4ContractDocContents({}).includes(
      "docs/spec/http-api.md is missing from Phase 4 contract docs"
    )
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "app/api/output/read-all/route.ts": "export async function POST() {}",
      "docs/spec/http-api.md":
        "Human Answer Boundary\n```http\nPOST /api/input/send\n```\n```http\nGET /api/output/check\n```\n```http\nGET /api/caller/status\n```\n"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/read-all"
    )
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "app/api/output/custom/route.ts": "export async function POST() {}",
      "app/api/runtime/custom/route.ts": "export async function GET() {}"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/custom"
    )
  );
});
test("documented HTTP route markers require exact http code-block method paths", () => {
  assert.deepEqual(
    extractDocumentedHttpContractRouteMarkers(`
\`\`\`http
GET /api/output/check?limit=25
\`\`\`
\`\`\`http
POST /api/output/read-all
\`\`\`
GET /api/output/check
`),
    ["GET /api/output/check", "POST /api/output/read-all"]
  );
  assert.ok(
    validatePhase4ContractDocContents({
      ...phase4ContractDocContents,
      "docs/spec/http-api.md":
        "Human Answer Boundary\n```http\nPOST /api/output/read-all-extra\n```\n",
      "app/api/output/read-all/route.ts": "export async function POST() {}"
    }).includes(
      "docs/spec/http-api.md is missing implemented HTTP route contract: POST /api/output/read-all"
    )
  );
});
test("implemented HTTP route markers derive from caller-facing route files", () => {
  assert.deepEqual(
    extractImplementedHttpContractRouteMarkers({
      "app/api/output/read-all/route.ts": "export async function POST() {}",
      "app/api/output/[output_result_id]/files/[file_id]/route.ts":
        "export async function GET() {}",
      "app/api/output/commented/route.ts": `
        // export async function GET() {}
        const sample = "export async function DELETE";
        export async function POST() {}
      `,
      "app/api/runtime/canary/route.ts": "export async function GET() {}"
    }),
    [
      "GET /api/output/{output_result_id}/files/{file_id}",
      "POST /api/output/commented",
      "POST /api/output/read-all"
    ]
  );
});
test("worker cron schedule stays aligned with runtime scheduled canary", () => {
  const wranglerConfig = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const workerEntry = readFileSync(
    new URL("../worker/entry.mjs", import.meta.url),
    "utf8"
  );

  assert.deepEqual(
    validateWranglerCronSchedule(wranglerConfig, RUNTIME_CRON_SCHEDULE),
    []
  );
  assert.match(workerEntry, /runScheduledCanary/);
  assert.match(workerEntry, /runScheduledCleanup/);
  assert.match(workerEntry, /context\.waitUntil\(cleanup\)/);
  assert.deepEqual(
    validateWranglerCronSchedule(
      `{
        // Wrangler accepts JSONC comments.
        "triggers": {
          "crons": ["17 * * * *"],
        },
        "note": "commas inside strings, ] and } stay intact"
      }`,
      RUNTIME_CRON_SCHEDULE
    ),
    []
  );
  assert.deepEqual(
    validateWranglerCronSchedule(
      '{ "triggers": { "crons": ["42 * * * *"] } }',
      RUNTIME_CRON_SCHEDULE
    ),
    [
      "wrangler.jsonc triggers.crons must include runtime scheduled canary 17 * * * *"
    ]
  );
});
