import assert from "node:assert/strict";
import test from "node:test";

import {
  flywayDockerEnvironmentNames,
  flywayEnvironmentFromConnection,
  flywayConnectionFromDatabaseUrl,
  validateMigrationFilenames
} from "../scripts/flyway.mjs";
import { withProcessEnv } from "./helpers/process-env.mjs";

const FLYWAY_TOOLCHAIN_FIXTURE = {
  version: "12.10.0",
  image: "flyway/flyway",
  source: "test"
};

test("validateMigrationFilenames enforces Flyway versioned SQL names", () => {
  assert.deepEqual(
    validateMigrationFilenames([
      "V20260630000000__initial_schema.sql",
      "V20260701010203__add_queue_indexes.sql",
      "V20260701010204__add_queue_index_online.sql.conf"
    ]),
    [
      "V20260701010204__add_queue_index_online.sql.conf must have matching SQL migration V20260701010204__add_queue_index_online.sql"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames([
      "20260630000000_initial_schema.sql",
      "V20260630000000__initial_schema.sql",
      "V20260630000000__other_change.sql"
    ]),
    [
      "20260630000000_initial_schema.sql must match VYYYYMMDDHHMMSS__lower_snake_description.sql or VYYYYMMDDHHMMSS__lower_snake_description.sql.conf",
      "migration version 20260630000000 is duplicated"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames(
      [
        "V20260701010204__add_queue_index_online.sql",
        "V20260701010204__add_queue_index_online.sql.conf"
      ],
      {
        "V20260701010204__add_queue_index_online.sql": `
          create index concurrently example_idx on public.example(id);
        `,
        "V20260701010204__add_queue_index_online.sql.conf":
          "executeInTransaction=false\n"
      }
    ),
    []
  );
  assert.deepEqual(
    validateMigrationFilenames(
      [
        "V20260701010205__add_unique_queue_index_online.sql",
        "V20260701010205__add_unique_queue_index_online.sql.conf"
      ],
      {
        "V20260701010205__add_unique_queue_index_online.sql": `
          create unique index concurrently example_unique_idx on public.example(id);
        `,
        "V20260701010205__add_unique_queue_index_online.sql.conf":
          "executeInTransaction=false\n"
      }
    ),
    []
  );
  assert.deepEqual(
    validateMigrationFilenames(
      ["V20260701010205__add_unique_queue_index_online.sql"],
      {
        "V20260701010205__add_unique_queue_index_online.sql": `
          create unique index concurrently example_unique_idx on public.example(id);
        `
      }
    ),
    [
      "V20260701010205__add_unique_queue_index_online.sql uses CREATE [UNIQUE]/DROP INDEX CONCURRENTLY and must have V20260701010205__add_unique_queue_index_online.sql.conf with executeInTransaction=false"
    ]
  );
  assert.deepEqual(
    validateMigrationFilenames(
      ["V20260701010204__add_queue_index_online.sql"],
      {
        "V20260701010204__add_queue_index_online.sql": `
          drop index concurrently if exists public.example_idx;
        `
      }
    ),
    [
      "V20260701010204__add_queue_index_online.sql uses CREATE [UNIQUE]/DROP INDEX CONCURRENTLY and must have V20260701010204__add_queue_index_online.sql.conf with executeInTransaction=false"
    ]
  );
});
test("flywayConnectionFromDatabaseUrl converts PostgreSQL URLs without leaking credentials into JDBC URLs", () => {
  withProcessEnv({ FLYWAY_USER: undefined, FLYWAY_PASSWORD: undefined }, () => {
    assert.deepEqual(
      flywayConnectionFromDatabaseUrl(
        "postgresql://agent%20user:s3cr%40t@example.com:5432/agent_outbox?sslmode=require"
      ),
      {
        jdbcUrl:
          "jdbc:postgresql://example.com:5432/agent_outbox?sslmode=require",
        user: "agent user",
        password: "s3cr@t"
      }
    );
  });
});
test("flyway validation scopes pending migration ignores to pre-migrate replay", () => {
  const connection = {
    jdbcUrl: "jdbc:postgresql://example.test:5432/agent_outbox",
    user: "migration_user",
    password: "secret"
  };

  withProcessEnv(
    {
      FLYWAY_CONNECT_RETRIES: undefined,
      FLYWAY_IGNORE_MIGRATION_PATTERNS: "*:pending"
    },
    () => {
      assert.deepEqual(flywayDockerEnvironmentNames(), [
        "FLYWAY_URL",
        "FLYWAY_LOCATIONS",
        "FLYWAY_CONNECT_RETRIES",
        "FLYWAY_USER",
        "FLYWAY_PASSWORD"
      ]);
      assert.equal(
        flywayEnvironmentFromConnection(connection)
          .FLYWAY_IGNORE_MIGRATION_PATTERNS,
        undefined
      );
      assert.deepEqual(
        flywayDockerEnvironmentNames({ ignorePendingMigrations: true }),
        [
          "FLYWAY_URL",
          "FLYWAY_LOCATIONS",
          "FLYWAY_CONNECT_RETRIES",
          "FLYWAY_USER",
          "FLYWAY_PASSWORD",
          "FLYWAY_IGNORE_MIGRATION_PATTERNS"
        ]
      );
      assert.equal(
        flywayEnvironmentFromConnection(connection, {
          ignorePendingMigrations: true
        }).FLYWAY_IGNORE_MIGRATION_PATTERNS,
        "*:pending"
      );
    }
  );
});
