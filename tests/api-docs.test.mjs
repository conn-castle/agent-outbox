import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { limitErrorMetadata } from "../src/server/limits.ts";
import { PUBLIC_CALLER_API_ERRORS } from "../src/shared/public-api-contract.ts";
import { SYSTEM_CONTRACT } from "../src/shared/system-contract.ts";

const repositoryRoot = new URL("../", import.meta.url);
/** @type {any} */
const openapi = JSON.parse(
  readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8")
);
/** @type {any} */
const generatedDocs = JSON.parse(
  readFileSync(
    new URL("../src/shared/api-docs.generated.json", import.meta.url),
    "utf8"
  )
);

const expectedRoutes = [
  "GET /api/account/status",
  "GET /api/caller/status",
  "GET /api/output/check",
  "GET /api/output/{output_result_id}/files/{file_id}",
  "POST /api/input/delete",
  "POST /api/input/replace",
  "POST /api/input/send",
  "POST /api/output/read-all",
  "POST /api/output/{output_result_id}/ack",
  "POST /api/output/{output_result_id}/read"
];

test("public OpenAPI document exposes only the caller data plane", () => {
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(
    openapi.jsonSchemaDialect,
    "https://json-schema.org/draft/2020-12/schema"
  );
  assert.deepEqual(openapi.servers, [{ url: "https://app.agent-outbox.dev" }]);

  const routeKeys = Object.entries(openapi.paths)
    .flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
    )
    .sort();
  assert.deepEqual(routeKeys, expectedRoutes);

  const serialized = JSON.stringify(openapi.paths);
  for (const forbidden of [
    "/billing/",
    "/caller/connect/",
    "/caller/rotate/",
    "/caller/revoke/",
    "/client-events",
    "/contact",
    "/human/",
    "/runtime/",
    "/webhook"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  assert.ok(openapi.paths["/api/input/send"].post.responses["500"]);
  assert.ok(openapi.paths["/api/input/replace"].post.responses["500"]);
  const components = JSON.stringify(openapi.components.schemas);
  assert.equal(components.includes('"anyOf"'), false);
  assert.ok(components.includes('"oneOf"'));
  assert.ok(components.includes('"discriminator"'));
  assert.equal(
    "discriminator" in openapi.components.schemas.ActionResponse,
    false
  );
  assert.deepEqual(
    openapi.components.schemas.ActionResponse.oneOf
      .filter(
        (/** @type {any} */ schema) =>
          schema.properties.kind.const === "date_picker"
      )
      .map((/** @type {any} */ schema) => schema.properties.mode.const),
    ["date", "datetime"]
  );
  assert.deepEqual(openapi.components.schemas.InputAction.dependentRequired, {
    tone: ["style"],
    style: ["tone"]
  });
});

test("public OpenAPI operations are described, secured, and locally resolvable", () => {
  const operationIds = new Set();
  for (const item of Object.values(openapi.paths)) {
    for (const operation of Object.values(item)) {
      assert.ok(operation.summary.length >= 12);
      assert.ok(operation.description.length >= 80);
      assert.deepEqual(operation.security, [{ callerBearer: [] }]);
      assert.equal(operationIds.has(operation.operationId), false);
      operationIds.add(operation.operationId);
    }
  }

  for (const reference of collectReferences(openapi)) {
    assert.match(reference, /^#\//);
    assert.doesNotThrow(() => resolveJsonPointer(openapi, reference));
  }
});

test("public retention error status matches the runtime limit response", () => {
  const documented = PUBLIC_CALLER_API_ERRORS.find(
    (error) => error.code === "retention_limit_exceeded"
  );
  const runtime = limitErrorMetadata(
    "hosted-free",
    "unacknowledged_output_timeout_days"
  );

  assert.equal(documented?.status, 429);
  assert.equal(documented?.status, runtime.status);
  assert.equal(runtime.code, "retention_limit_exceeded");
});

test("branded docs bundle has curated guides and generated reference", () => {
  assert.equal(generatedDocs.schemaVersion, 2);
  assert.match(generatedDocs.sourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    generatedDocs.documents.map((/** @type {any} */ document) => document.slug),
    ["quickstart", "concepts", "capabilities", "ui", "reliability", "reference"]
  );
  assert.equal(
    generatedDocs.documents.find(
      (/** @type {any} */ document) => document.slug === "reference"
    ).generated,
    true
  );
  assert.equal(generatedDocs.operations.length, expectedRoutes.length);

  const quickstart = generatedDocs.documents.find(
    (/** @type {any} */ document) => document.slug === "quickstart"
  ).source;
  assert.doesNotMatch(quickstart, /brew install/);
  assert.match(quickstart, /public CLI installer is not published yet/);
  assert.ok(
    quickstart.includes(`${SYSTEM_CONTRACT.hostedWebsiteBaseUrl}/contact`)
  );
  assert.match(quickstart, /Request test CLI access/);

  const uiGuide = generatedDocs.documents.find(
    (/** @type {any} */ document) => document.slug === "ui"
  ).source;
  assert.match(uiGuide, /OpenAPI 3\.1 document/);
  assert.match(uiGuide, /Never ship it in browser JavaScript/);
  assert.match(uiGuide, /ready_count.*already read/s);

  const reference = generatedDocs.documents.find(
    (/** @type {any} */ document) => document.slug === "reference"
  ).source;
  assert.match(reference, /pending_content_conflict/);
  assert.match(reference, /answered_unacknowledged/);
  assert.match(reference, /internal_error/);
});

test("contract, guide examples, route parity, and generated artifacts are current", () => {
  execFileSync("./node_modules/.bin/tsx", ["scripts/api-docs.ts", "check"], {
    cwd: new URL(".", repositoryRoot),
    stdio: "pipe"
  });
});

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function collectReferences(value) {
  if (Array.isArray(value)) return value.flatMap(collectReferences);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "$ref" && typeof entry === "string"
      ? [entry]
      : collectReferences(entry)
  );
}

/**
 * @param {any} document
 * @param {string} reference
 */
function resolveJsonPointer(document, reference) {
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      assert.ok(current && typeof current === "object" && part in current);
      return current[part];
    }, document);
}
