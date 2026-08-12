import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import toolchain from "../toolchain.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const MIGRATION_FILE_PATTERN = /^V(\d{14})__[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const MIGRATION_CONFIG_FILE_PATTERN =
  /^V(\d{14})__[a-z0-9]+(?:_[a-z0-9]+)*\.sql\.conf$/;
const CONCURRENT_INDEX_PATTERN =
  /\b(?:create\s+(?:unique\s+)?index|drop\s+index)\s+concurrently\b/i;
const ALLOWED_COMMANDS = new Set(["validate", "migrate"]);
const PENDING_MIGRATION_IGNORE_PATTERN = "*:pending";
const POSTGRESQL_TRANSACTIONAL_LOCK_ENV =
  "FLYWAY_POSTGRESQL_TRANSACTIONAL_LOCK";

export const FLYWAY_DOCKER_IMAGE = `${toolchain.flyway.image}:${toolchain.flyway.version}`;

/**
 * @typedef {{
 *   ignorePendingMigrations?: boolean
 * }} FlywayOptions
 */

/**
 * @param {string} databaseUrl
 * @returns {{ jdbcUrl: string, user?: string, password?: string }}
 */
export function flywayConnectionFromDatabaseUrl(databaseUrl) {
  if (
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("postgres://")
  ) {
    throw new Error("DATABASE_MIGRATION_URL must be a PostgreSQL URL");
  }

  const parsed = new URL(databaseUrl);
  const user = parsed.username ? decodeURIComponent(parsed.username) : null;

  if (!user) {
    throw new Error("DATABASE_MIGRATION_URL must include a database user");
  }

  return {
    jdbcUrl: `jdbc:postgresql://${parsed.host}${parsed.pathname}${parsed.search}`,
    user,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined
  };
}

/**
 * @param {Record<string, string>} migrationFileContents
 * @returns {Set<string>}
 */
function concurrentIndexMigrationFiles(migrationFileContents) {
  const migrationFiles = new Set();

  for (const [file, content] of Object.entries(migrationFileContents)) {
    if (file.endsWith(".sql") && CONCURRENT_INDEX_PATTERN.test(content)) {
      migrationFiles.add(file);
    }
  }

  return migrationFiles;
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function disablesTransactions(content) {
  return content
    .split(/\r?\n/)
    .some((line) => line.trim() === "executeInTransaction=false");
}

/**
 * @param {string[]} migrationFiles
 * @param {Record<string, string>} [migrationFileContents]
 * @returns {string[]}
 */
export function validateMigrationFilenames(
  migrationFiles,
  migrationFileContents = {}
) {
  const errors = [];
  const versions = new Set();
  const sqlFiles = new Set();
  const configFiles = new Map();

  for (const file of migrationFiles) {
    const sqlMatch = file.match(MIGRATION_FILE_PATTERN);
    if (sqlMatch) {
      const version = sqlMatch[1];
      if (versions.has(version)) {
        errors.push(`migration version ${version} is duplicated`);
      }
      versions.add(version);
      sqlFiles.add(file);
      continue;
    }

    const configMatch = file.match(MIGRATION_CONFIG_FILE_PATTERN);
    if (configMatch) {
      configFiles.set(file.slice(0, -".conf".length), file);
      continue;
    }

    errors.push(
      `${file} must match VYYYYMMDDHHMMSS__lower_snake_description.sql or VYYYYMMDDHHMMSS__lower_snake_description.sql.conf`
    );
  }

  for (const [sqlFile, configFile] of configFiles) {
    if (!sqlFiles.has(sqlFile)) {
      errors.push(`${configFile} must have matching SQL migration ${sqlFile}`);
    }
  }

  const onlineIndexFiles = concurrentIndexMigrationFiles(migrationFileContents);
  for (const file of onlineIndexFiles) {
    const configFile = configFiles.get(file);
    if (
      !configFile ||
      !disablesTransactions(migrationFileContents[configFile] ?? "")
    ) {
      errors.push(
        `${file} uses CREATE [UNIQUE]/DROP INDEX CONCURRENTLY and must have ${file}.conf with executeInTransaction=false`
      );
    }
  }

  return errors;
}

/**
 * @returns {{ files: string[], contents: Record<string, string> }}
 */
function readMigrationFiles() {
  const files = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const contents = Object.fromEntries(
    files.map((file) => [
      file,
      readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    ])
  );

  return { files, contents };
}

/**
 * @param {{ files: string[], contents: Record<string, string> }} migrationFiles
 */
function assertMigrationFilenames(migrationFiles) {
  const errors = validateMigrationFilenames(
    migrationFiles.files,
    migrationFiles.contents
  );
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.notEqual(
    migrationFiles.files.filter((file) => file.endsWith(".sql")).length,
    0,
    "db/migrations must not be empty"
  );
}

/**
 * @param {FlywayOptions} [options]
 * @returns {string[]}
 */
export function flywayDockerEnvironmentNames(options = {}) {
  const environmentNames = [
    "FLYWAY_URL",
    "FLYWAY_LOCATIONS",
    "FLYWAY_CONNECT_RETRIES",
    "FLYWAY_USER",
    "FLYWAY_PASSWORD"
  ];

  if (options.ignorePendingMigrations) {
    environmentNames.push("FLYWAY_IGNORE_MIGRATION_PATTERNS");
  }

  return environmentNames;
}

/**
 * @param {{ jdbcUrl: string, user?: string, password?: string }} connection
 * @param {FlywayOptions} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function flywayEnvironmentFromConnection(connection, options = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    FLYWAY_CONNECT_RETRIES: process.env.FLYWAY_CONNECT_RETRIES ?? "60",
    FLYWAY_LOCATIONS: "filesystem:/flyway/sql",
    FLYWAY_PASSWORD: connection.password ?? "",
    FLYWAY_URL: connection.jdbcUrl,
    FLYWAY_USER: connection.user
  };

  delete environment.FLYWAY_IGNORE_MIGRATION_PATTERNS;
  if (options.ignorePendingMigrations) {
    environment.FLYWAY_IGNORE_MIGRATION_PATTERNS =
      process.env.FLYWAY_IGNORE_MIGRATION_PATTERNS ??
      PENDING_MIGRATION_IGNORE_PATTERN;
  }

  return environment;
}

function printUsage() {
  console.error(
    "Usage: node scripts/flyway.mjs <validate|migrate> [--ignore-pending]"
  );
}

/**
 * @param {string} command
 * @param {FlywayOptions} [options]
 * @returns {number}
 */
function runFlyway(command, options = {}) {
  if (
    !ALLOWED_COMMANDS.has(command) ||
    (options.ignorePendingMigrations && command !== "validate")
  ) {
    printUsage();
    return 2;
  }

  const migrationFiles = readMigrationFiles();
  assertMigrationFilenames(migrationFiles);

  const databaseUrl = process.env.DATABASE_MIGRATION_URL;
  assert.ok(databaseUrl, "DATABASE_MIGRATION_URL is required");
  const connection = flywayConnectionFromDatabaseUrl(databaseUrl);
  const hasOnlineIndexMigration =
    concurrentIndexMigrationFiles(migrationFiles.contents).size > 0;

  const dockerArgs = ["run", "--rm"];
  if (process.env.FLYWAY_DOCKER_NETWORK) {
    dockerArgs.push("--network", process.env.FLYWAY_DOCKER_NETWORK);
  }

  const dockerEnvironmentNames = flywayDockerEnvironmentNames(options);
  if (hasOnlineIndexMigration) {
    dockerEnvironmentNames.push(POSTGRESQL_TRANSACTIONAL_LOCK_ENV);
  }

  for (const name of dockerEnvironmentNames) {
    dockerArgs.push("-e", name);
  }

  dockerArgs.push(
    "-v",
    `${MIGRATIONS_DIR}:/flyway/sql:ro`,
    FLYWAY_DOCKER_IMAGE,
    command
  );

  const flywayEnvironment = flywayEnvironmentFromConnection(
    connection,
    options
  );
  if (hasOnlineIndexMigration) {
    flywayEnvironment[POSTGRESQL_TRANSACTIONAL_LOCK_ENV] = "false";
  }

  const result = spawnSync("docker", dockerArgs, {
    cwd: ROOT,
    env: flywayEnvironment,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(3);
  const unknownFlag = flags.find((flag) => flag !== "--ignore-pending");
  if (unknownFlag) {
    printUsage();
    process.exitCode = 2;
  } else {
    process.exitCode = runFlyway(process.argv[2] ?? "", {
      ignorePendingMigrations: flags.includes("--ignore-pending")
    });
  }
}
