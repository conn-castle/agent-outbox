export const RUNTIME_PROOF_SOURCE_DIRS = ["app", "src"];
export const RUNTIME_PROOF_SOURCE_FILES = [
  "instrumentation.ts",
  "middleware.ts"
];

const FORBIDDEN_RUNTIME_PROOF_PATH_PATTERNS = [
  /^app\/api\/(?:checkout|stripe)\//,
  /^app\/api\/account\/(?!status(?:\/|$))/,
  /^app\/api\/caller\/(?!(?:status\/route\.ts|connect\/(?:browser\/start|device\/start|device\/poll|exchange|activate|abort)\/route\.ts|rotate\/(?:browser\/start|device\/start|device\/poll|exchange|activate|abort)\/route\.ts|revoke\/(?:browser\/start|device\/start|device\/poll|confirm)\/route\.ts)$)/,
  /^app\/api\/input\/\[/,
  /^app\/api\/human\//,
  /^app\/human\/(?:queue|review|items?)\//,
  /^src\/cli\//,
  /^src\/.*(?:steward|email)/i,
  /^cli\//,
  /^cmd\//
];

const FORBIDDEN_RUNTIME_PROOF_TOKENS = [
  "create table",
  "alter table",
  "drop table",
  "create index",
  "uploadthing",
  "supabase.storage",
  "gmail",
  "classifier"
];

export const PHASE3_FOUNDATION_SOURCE_FILES = [
  "src/server/accounting.ts",
  "src/server/authorization.ts",
  "src/server/caller-auth.ts",
  "src/server/cleanup.ts",
  "src/server/database.ts",
  "src/server/limits.ts",
  "db/migrations/V20260630000000__initial_schema.sql"
];

export const PHASE4_CONTRACT_DOC_FILES = [
  "docs/spec/README.md",
  "docs/spec/http-api.md",
  "docs/spec/input-schema.md",
  "docs/spec/output-schema.md",
  "docs/spec/errors.md"
];

const HTTP_ROUTE_METHOD_PATTERN =
  /^\s*export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/gm;
const HTTP_DOC_ROUTE_LINE_PATTERN =
  /^```http\s*\n(GET|POST|PUT|PATCH|DELETE)\s+([^\s\n]+)(?:[^\n]*)\n```/gm;

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function validateRuntimeProofScope(sourceContentsByPath) {
  const failures = [];

  for (const [relativePath, content] of Object.entries(sourceContentsByPath)) {
    for (const pattern of FORBIDDEN_RUNTIME_PROOF_PATH_PATTERNS) {
      if (pattern.test(relativePath)) {
        failures.push(
          `${relativePath} is unrelated later-phase implementation scope, not current caller API scope`
        );
      }
    }

    const lowered = content.toLowerCase();
    for (const token of FORBIDDEN_RUNTIME_PROOF_TOKENS) {
      if (lowered.includes(token)) {
        failures.push(`${relativePath} contains out-of-scope token: ${token}`);
      }
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function validatePhase4ContractDocContents(sourceContentsByPath) {
  const failures = [];
  const httpApiContent = sourceContentsByPath["docs/spec/http-api.md"];
  if (httpApiContent === undefined) {
    failures.push(
      "docs/spec/http-api.md is missing from Phase 4 contract docs"
    );
    return failures;
  }

  const documentedRouteMarkers =
    extractDocumentedHttpContractRouteMarkers(httpApiContent);
  const markers =
    extractImplementedHttpContractRouteMarkers(sourceContentsByPath);

  for (const marker of markers) {
    if (!documentedRouteMarkers.includes(marker)) {
      failures.push(
        `docs/spec/http-api.md is missing implemented HTTP route contract: ${marker}`
      );
    }
  }

  return failures;
}

/**
 * @param {Record<string, string>} sourceContentsByPath
 * @returns {string[]}
 */
export function extractImplementedHttpContractRouteMarkers(
  sourceContentsByPath
) {
  const markers = [];

  for (const [relativePath, content] of Object.entries(sourceContentsByPath)) {
    if (
      !relativePath.startsWith("app/api/") ||
      !relativePath.endsWith("/route.ts") ||
      relativePath.startsWith("app/api/runtime/")
    ) {
      continue;
    }

    const routePath = `/${relativePath
      .replace(/^app\//, "")
      .replace(/\/route\.ts$/, "")
      .replaceAll("[", "{")
      .replaceAll("]", "}")}`;

    for (const match of content.matchAll(HTTP_ROUTE_METHOD_PATTERN)) {
      markers.push(`${match[1]} ${routePath}`);
    }
  }

  return markers.sort();
}

/**
 * @param {string} httpApiContent
 * @returns {string[]}
 */
export function extractDocumentedHttpContractRouteMarkers(httpApiContent) {
  return [...httpApiContent.matchAll(HTTP_DOC_ROUTE_LINE_PATTERN)]
    .map((match) => `${match[1]} ${match[2].split("?")[0]}`)
    .sort();
}
