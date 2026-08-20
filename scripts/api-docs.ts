import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format } from "prettier";

import {
  PUBLIC_API_EXAMPLES,
  PUBLIC_API_OPERATIONS,
  PUBLIC_API_SCHEMAS,
  PUBLIC_CALLER_API_ERRORS,
  publicSchemaMatches,
  validatePublicApiContract
} from "../src/shared/public-api-contract.ts";
import { SYSTEM_CONTRACT } from "../src/shared/system-contract.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const applicationVersion = JSON.parse(
  readFileSync(`${repositoryRoot}package.json`, "utf8")
).version as string;
const bundleOutputPath = new URL(
  "../src/shared/api-docs.generated.json",
  import.meta.url
);
const openApiOutputPath = new URL("../docs/openapi.json", import.meta.url);

const guideDocuments = [
  { slug: "quickstart", sourcePath: "docs/spec/public-api.md" },
  {
    slug: "concepts",
    sourcePath: "docs/spec/public-api-concepts.md"
  },
  {
    slug: "capabilities",
    sourcePath: "docs/spec/public-api-capabilities.md"
  },
  {
    slug: "ui",
    sourcePath: "docs/spec/public-api-ui.md"
  },
  {
    slug: "reliability",
    sourcePath: "docs/spec/public-api-reliability.md"
  }
] as const;

type JsonObject = Record<string, unknown>;

export function publicOpenApiDocument() {
  validatePublicApiContract();
  validateImplementedRoutes();
  const paths: JsonObject = {};

  for (const operation of PUBLIC_API_OPERATIONS) {
    const operationObject: JsonObject = {
      operationId: operation.id,
      tags: [operation.group],
      summary: operation.summary,
      description: [
        operation.description,
        "",
        ...operation.behavior.map((item) => `- ${item}`)
      ].join("\n"),
      security: [{ callerBearer: [] }],
      responses: operationResponses(operation.id)
    };

    const parameters: JsonObject[] = [];
    for (const parameter of operation.pathParameters ?? []) {
      parameters.push({
        name: parameter.name,
        in: "path",
        required: true,
        description: parameter.description,
        schema: { type: "string", minLength: 1 }
      });
    }
    for (const parameter of operation.query ?? []) {
      parameters.push({
        name: parameter.name,
        in: "query",
        required: false,
        description: parameter.description,
        schema: openApiSchema(parameter.schema)
      });
    }
    if (parameters.length > 0) operationObject.parameters = parameters;

    if (operation.requestSchema) {
      operationObject.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: schemaReference(operation.requestSchema),
            ...(operation.exampleKey
              ? { example: PUBLIC_API_EXAMPLES[operation.exampleKey] }
              : {})
          }
        }
      };
    }

    const pathItem = (paths[operation.path] ?? {}) as JsonObject;
    pathItem[operation.method] = operationObject;
    paths[operation.path] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Outbox Caller API",
      version: applicationVersion,
      summary: "Durable human decisions for software agents",
      description:
        "Send structured work to a person, continue asynchronously, and retrieve a typed decision when it is ready. This document intentionally includes only the caller-facing data plane and status operations."
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: [{ url: SYSTEM_CONTRACT.hostedAppBaseUrl }],
    tags: [
      {
        name: "Inputs",
        description: "Create, replace, and remove pending human review work."
      },
      {
        name: "Outputs",
        description: "Check, read, download, and acknowledge human decisions."
      },
      {
        name: "Status",
        description:
          "Inspect non-secret caller, account, storage, and limit state."
      }
    ],
    paths,
    components: {
      securitySchemes: {
        callerBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Agent Outbox caller key",
          description:
            "A display-once caller credential. Keep it out of source control, request bodies, logs, and model prompts."
        }
      },
      schemas: Object.fromEntries(
        Object.entries(PUBLIC_API_SCHEMAS).map(([name, schema]) => [
          name,
          openApiSchema(schema)
        ])
      )
    }
  };
}

export function generatedApiDocsText() {
  const openapi = publicOpenApiDocument();
  const documents = [
    ...guideDocuments.map(({ slug, sourcePath }) => {
      const source = normalizedSource(
        readFileSync(`${repositoryRoot}${sourcePath}`, "utf8")
      );
      validateGuideExamples(sourcePath, source);
      return { slug, sourcePath, source, generated: false };
    }),
    {
      slug: "reference",
      sourcePath: "docs/openapi.json",
      source: renderReferenceMarkdown(openapi),
      generated: true
    }
  ];
  const sourceHash = createHash("sha256")
    .update(
      [
        ...documents.map(
          ({ sourcePath, source }) => `${sourcePath}\0${source}`
        ),
        `openapi\0${stableJson(openapi)}`
      ].join("\0")
    )
    .digest("hex");

  return `${JSON.stringify(
    {
      schemaVersion: 2,
      sourceHash,
      operations: PUBLIC_API_OPERATIONS.map(
        ({ id, method, path, group, summary }) => ({
          id,
          method,
          path,
          group,
          summary
        })
      ),
      documents
    },
    null,
    2
  )}\n`;
}

export async function generatedOpenApiText() {
  return format(`${stableJson(publicOpenApiDocument())}\n`, {
    parser: "json",
    filepath: fileURLToPath(openApiOutputPath)
  });
}

export async function generateApiDocs() {
  writeFileSync(bundleOutputPath, generatedApiDocsText(), "utf8");
  writeFileSync(openApiOutputPath, await generatedOpenApiText(), "utf8");
}

export async function checkApiDocs() {
  checkGeneratedFile(
    bundleOutputPath,
    generatedApiDocsText(),
    "Generated API documentation bundle"
  );
  checkGeneratedFile(
    openApiOutputPath,
    await generatedOpenApiText(),
    "Generated OpenAPI document"
  );
}

function operationResponses(operationId: string) {
  const operation = PUBLIC_API_OPERATIONS.find(
    (candidate) => candidate.id === operationId
  );
  if (!operation)
    throw new Error(`Unknown public API operation: ${operationId}`);
  if (operation.id !== "downloadOutputFile" && !operation.responseSchema) {
    throw new Error(
      `Public API operation has no success schema: ${operationId}`
    );
  }

  const success =
    operation.id === "downloadOutputFile"
      ? {
          description: "Authenticated file bytes.",
          headers: {
            "Content-Disposition": {
              description: "Attachment disposition with a sanitized filename.",
              schema: { type: "string" }
            },
            "X-Request-ID": {
              description: "Request identifier for support and tracing.",
              schema: { type: "string" }
            },
            "X-Correlation-ID": {
              description: "Server correlation identifier.",
              schema: { type: "string" }
            }
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" }
            }
          }
        }
      : {
          description: "Successful operation.",
          content: {
            "application/json": {
              schema: schemaReference(operation.responseSchema!),
              ...(operation.responseExampleKey
                ? {
                    example: PUBLIC_API_EXAMPLES[operation.responseExampleKey]
                  }
                : {})
            }
          }
        };

  return Object.fromEntries([
    ["200", success],
    ...operation.errorStatuses.map((status) => [
      String(status),
      errorResponse(errorDescription(status))
    ])
  ]);
}

type PublicErrorStatus =
  (typeof PUBLIC_API_OPERATIONS)[number]["errorStatuses"][number];

function errorDescription(status: PublicErrorStatus) {
  return {
    400: "The request is malformed.",
    401: "The caller credential is missing or unusable.",
    402: "The requested capability requires an upgrade.",
    404: "The live resource is unavailable to this caller.",
    409: "The request conflicts with current lifecycle state.",
    413: "The request body exceeds its byte limit.",
    422: "The request failed field or content validation.",
    429: "A rate, quota, concurrency, or storage limit blocked the request.",
    500: "An unexpected server error occurred.",
    503: "The operation is temporarily unavailable."
  }[status];
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: schemaReference("ErrorEnvelope")
      }
    }
  };
}

function schemaReference(name: keyof typeof PUBLIC_API_SCHEMAS) {
  return { $ref: `#/components/schemas/${name}` };
}

function openApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openApiSchema);
  if (!schema || typeof schema !== "object") return schema;

  return Object.fromEntries(
    Object.entries(schema as JsonObject)
      .filter(([key]) => key !== "$id")
      .map(([key, value]) => [
        key === "anyOf" ? "oneOf" : key,
        openApiSchema(value)
      ])
  );
}

function validateImplementedRoutes() {
  for (const operation of PUBLIC_API_OPERATIONS) {
    const routePath = operation.path
      .replace(/^\//, "")
      .replaceAll(/{([^}]+)}/g, "[$1]");
    const sourcePath = `app/${routePath}/route.ts`;
    let source: string;
    try {
      source = readFileSync(`${repositoryRoot}${sourcePath}`, "utf8");
    } catch {
      throw new Error(
        `Public API contract points to a missing route: ${operation.method.toUpperCase()} ${operation.path} (${sourcePath}).`
      );
    }
    const methodPattern = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${operation.method.toUpperCase()}\\s*\\(`
    );
    if (!methodPattern.test(source)) {
      throw new Error(
        `Public API route does not export ${operation.method.toUpperCase()}: ${sourcePath}.`
      );
    }
  }
}

function validateGuideExamples(sourcePath: string, source: string) {
  const jsonFences = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)];
  const markers = [
    ...source.matchAll(
      /<!-- contract-example:([A-Za-z0-9]+) -->\n\s*```json\n([\s\S]*?)\n```/g
    )
  ];
  if (jsonFences.length !== markers.length) {
    throw new Error(
      `${sourcePath} contains an unvalidated JSON example. Prefix every JSON fence with <!-- contract-example:SchemaName -->.`
    );
  }

  for (const marker of markers) {
    const schemaName = marker[1];
    const json = marker[2];
    if (!schemaName || !json || !(schemaName in PUBLIC_API_SCHEMAS)) {
      throw new Error(`${sourcePath} uses an unknown contract example schema.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error(`${sourcePath} contains an invalid JSON example.`);
    }
    if (
      !publicSchemaMatches(schemaName as keyof typeof PUBLIC_API_SCHEMAS, value)
    ) {
      throw new Error(
        `${sourcePath} example does not match public schema ${schemaName}.`
      );
    }
  }

  for (const curlBody of source.matchAll(/--data '(\{[\s\S]*?\})'/g)) {
    let value: unknown;
    try {
      value = JSON.parse(curlBody[1] ?? "");
    } catch {
      throw new Error(`${sourcePath} contains invalid curl request JSON.`);
    }
    if (!publicSchemaMatches("InputSubmission", value)) {
      throw new Error(
        `${sourcePath} curl request does not match public schema InputSubmission.`
      );
    }
  }
}

function renderReferenceMarkdown(
  openapi: ReturnType<typeof publicOpenApiDocument>
) {
  const lines = [
    "# API reference",
    "",
    "This reference is generated from the same executable schemas used to check public examples and runtime request structure. Human-written guides explain when and why to use each operation; this page records the exact HTTP contract.",
    "",
    "[Download the OpenAPI 3.1 document](openapi.json)",
    "",
    "## Common request rules",
    "",
    `All hosted routes use \`${SYSTEM_CONTRACT.hostedAppBaseUrl}/api\`. Caller operations require \`Authorization: Bearer <caller_api_key>\`; JSON bodies require \`Content-Type: application/json\`.`,
    "",
    "JSON responses include `request_id` and `correlation_id`. Successful downloads return raw bytes with the same ids in response headers.",
    ""
  ];

  for (const group of ["Inputs", "Outputs", "Status"] as const) {
    lines.push(`## ${group}`, "");
    for (const operation of PUBLIC_API_OPERATIONS.filter(
      (candidate) => candidate.group === group
    )) {
      lines.push(
        `### \`${operation.method.toUpperCase()} ${operation.path}\``,
        "",
        `**${operation.summary}.** ${operation.description}`,
        ""
      );
      for (const behavior of operation.behavior) lines.push(`- ${behavior}`);
      if (operation.behavior.length > 0) lines.push("");

      if (operation.pathParameters?.length) {
        lines.push(
          "Path parameters:",
          "",
          "| Name | Meaning |",
          "| --- | --- |"
        );
        for (const parameter of operation.pathParameters) {
          lines.push(`| \`${parameter.name}\` | ${parameter.description} |`);
        }
        lines.push("");
      }
      if (operation.query?.length) {
        lines.push(
          "Query parameters:",
          "",
          "| Name | Meaning |",
          "| --- | --- |"
        );
        for (const parameter of operation.query) {
          lines.push(`| \`${parameter.name}\` | ${parameter.description} |`);
        }
        lines.push("");
      }
      if (operation.requestSchema) {
        lines.push(
          `Request body: [\`${operation.requestSchema}\`](#schema-${operation.requestSchema.toLowerCase()})`,
          ""
        );
      }
      if (operation.exampleKey) {
        lines.push(
          "```json",
          JSON.stringify(PUBLIC_API_EXAMPLES[operation.exampleKey], null, 2),
          "```",
          ""
        );
      }
      lines.push(
        operation.id === "downloadOutputFile"
          ? "Success: authenticated raw bytes with attachment, content type, content length, no-store, request id, and correlation id headers."
          : operation.responseSchema
            ? `Success envelope: [\`${operation.responseSchema}\`](#schema-${operation.responseSchema.toLowerCase()})`
            : "Success: documented by the generated OpenAPI response.",
        ""
      );
      if (operation.responseExampleKey) {
        lines.push(
          "```json",
          JSON.stringify(
            PUBLIC_API_EXAMPLES[operation.responseExampleKey],
            null,
            2
          ),
          "```",
          ""
        );
      }
    }
  }

  lines.push(
    "## Error codes",
    "",
    "Branch on the stable `error.code`, not the human-readable message or HTTP status alone. `error.fields` identifies invalid paths; retry, limit, upgrade, and support metadata appear only when relevant.",
    "",
    "| Code | Status | Meaning | Caller recovery |",
    "| --- | ---: | --- | --- |",
    ...PUBLIC_CALLER_API_ERRORS.map(
      ({ code, status, meaning, recovery }) =>
        `| \`${code}\` | ${status} | ${meaning} | ${recovery} |`
    ),
    "",
    "## Schemas",
    "",
    "These JSON Schema 2020-12 definitions are generated into the OpenAPI document. Specialized semantic rules—such as safe HTML, supported icons, unique protocol values, date ranges, and account entitlements—are applied after structural validation and described in the guides.",
    ""
  );

  for (const [name, schema] of Object.entries(openapi.components.schemas)) {
    lines.push(
      `### Schema: ${name}`,
      "",
      `<details class="api-docs-schema"><summary>View generated JSON Schema</summary><pre><code>${escapeHtml(JSON.stringify(schema, null, 2))}</code></pre></details>`,
      ""
    );
  }

  return normalizedSource(lines.join("\n"));
}

function checkGeneratedFile(path: URL, expected: string, label: string) {
  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label} is missing. Run \`pnpm docs:generate\`.`);
  }
  if (current !== expected) {
    throw new Error(
      `${label} is stale. Run \`pnpm docs:generate\` and commit the result.`
    );
  }
}

function normalizedSource(source: string) {
  return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function main() {
  const command = process.argv[2];
  if (command === "generate") {
    await generateApiDocs();
    return;
  }
  if (command === "check") {
    await checkApiDocs();
    return;
  }
  throw new Error("Usage: tsx scripts/api-docs.ts <generate|check>");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
