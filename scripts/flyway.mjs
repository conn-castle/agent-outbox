import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import toolchain from "../toolchain.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const MIGRATION_FILE_PATTERN = /^V(\d{14})__[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const ALLOWED_COMMANDS = new Set(["validate", "migrate"]);
const PENDING_MIGRATION_IGNORE_PATTERN = "*:pending";

export const FLYWAY_DOCKER_IMAGE = `${toolchain.flyway.image}:${toolchain.flyway.version}`;

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
 * @param {string[]} migrationFiles
 * @returns {string[]}
 */
export function validateMigrationFilenames(migrationFiles) {
  const errors = [];
  const versions = new Set();

  for (const file of migrationFiles) {
    const match = file.match(MIGRATION_FILE_PATTERN);
    if (!match) {
      errors.push(
        `${file} must match VYYYYMMDDHHMMSS__lower_snake_description.sql`
      );
      continue;
    }

    const version = match[1];
    if (versions.has(version)) {
      errors.push(`migration version ${version} is duplicated`);
    }
    versions.add(version);
  }

  return errors;
}

function assertMigrationFilenames() {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const errors = validateMigrationFilenames(migrationFiles);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.notEqual(migrationFiles.length, 0, "db/migrations must not be empty");
}

/**
 * @param {{ ignorePendingMigrations?: boolean }} [options]
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
 * @param {{ ignorePendingMigrations?: boolean }} [options]
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
 * @param {{ ignorePendingMigrations?: boolean }} [options]
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

  assertMigrationFilenames();

  const databaseUrl = process.env.DATABASE_MIGRATION_URL;
  assert.ok(databaseUrl, "DATABASE_MIGRATION_URL is required");
  const connection = flywayConnectionFromDatabaseUrl(databaseUrl);

  const dockerArgs = ["run", "--rm"];
  if (process.env.FLYWAY_DOCKER_NETWORK) {
    dockerArgs.push("--network", process.env.FLYWAY_DOCKER_NETWORK);
  }

  for (const name of flywayDockerEnvironmentNames(options)) {
    dockerArgs.push("-e", name);
  }

  dockerArgs.push(
    "-v",
    `${MIGRATIONS_DIR}:/flyway/sql:ro`,
    FLYWAY_DOCKER_IMAGE,
    command
  );

  const result = spawnSync("docker", dockerArgs, {
    cwd: ROOT,
    env: flywayEnvironmentFromConnection(connection, options),
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
