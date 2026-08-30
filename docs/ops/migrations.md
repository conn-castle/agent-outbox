# Migration Rules

Flyway plus hand-authored PostgreSQL SQL is the only schema migration system.
The canonical migration source is `db/migrations/`.

1. Use Flyway versioned SQL files only: `VYYYYMMDDHHMMSS__description.sql`. CI:
   Enforced.
2. Use UTC timestamps and lower-snake-case descriptions. CI: Enforced for
   filename shape.
3. Replay every committed migration history from an empty Postgres database. CI:
   Enforced with raw `postgres:17`.
4. Validate Flyway schema history before and after applying migrations. CI:
   Enforced.
5. Treat shared or deployed migrations as immutable; roll forward instead. CI:
   Not fully enforceable on empty replay; Flyway validates this on durable
   databases.
6. Keep all schema, function, extension, grant, revoke, and RLS changes in
   migrations. CI: Partly enforced by replay; code review enforces scope.
7. Do not use provider dashboards, SQL editors, or provider migration CLIs for
   schema changes. CI: Enforced for GitHub workflows; operations discipline
   enforces elsewhere.
8. Keep provider-specific setup out of the canonical migration source unless the
   SQL is conditional and runs on plain Postgres. CI: Enforced by raw Postgres
   replay.
9. Do not add declarative schemas as a second source of truth. CI: Code review
   enforced.
10. Run database behavior tests against the replayed schema. CI: Enforced for
    representative RLS, app-role, and cleanup behavior.
11. Destructive SQL (`DROP TABLE`, `DROP COLUMN`, `DROP INDEX` including
    `CONCURRENTLY`, column/table renames, type changes, and `SET NOT NULL`
    without a same-column `DEFAULT`) requires the human-only
    `migration-destructive-approved` label. CI: Enforced by Policy gates.
12. Every production migration must be compatible with both the outgoing and
    incoming application release. Schema is forward-only infrastructure state,
    applied before candidate traffic and never rolled back automatically. Use
    expand/contract sequencing because a failed release restores Worker code
    only, never schema, and may leave expand migrations in place. CI: Code
    review enforced.

## Production Application

Production migrations run only within the protected manual release workflow in
`.github/workflows/deploy-production.yml`. The workflow certifies the exact
release SHA, prepares byte-verified draft assets, captures the rollback target,
uploads an inactive candidate Worker version, then validates existing Flyway
history while allowing pending checked-in migrations, applies those migrations,
and strictly validates the resulting history before any candidate traffic.
Override smoke of the 0% candidate and post-promotion smoke execute the
production human-review list query through the restricted application role under
an isolated human account context, so a release cannot finalize when its schema
cannot serve the queue. Rollback-target smoke tolerates the field being absent
from an outgoing release that predates this canary, but reject a failed result
whenever the deployed Worker exposes it. The outgoing Worker remains live
against the migrated schema until promotion, and a proven pre-commit failure
restores only that Worker version. This makes rule 12 a release requirement, not
optional rollback advice.

`DATABASE_MIGRATION_URL` in the GitHub `production` environment is a downstream
copy of the canonical SSM parameter. Missing credentials or any Flyway failure
must stop the release before application deployment. Never apply production
migrations from a local operator or agent shell. Local `migration:migrate` and
`migration:replay` commands are only for local or disposable databases.

## Online Index Migrations

Use an online index migration for indexes on live or potentially large tables.
Keep it in a dedicated versioned SQL migration that contains only the online
index operation and any directly related index comment or rename.

Repository pattern:

1. Use `CREATE INDEX CONCURRENTLY`, `CREATE UNIQUE INDEX CONCURRENTLY`, or
   `DROP INDEX CONCURRENTLY` for the online index operation.
2. Add a same-directory Flyway script config file with the exact migration file
   name plus `.conf`, for example
   `V20260706193001__stripe_webhook_event_retention_online_index.sql.conf`.
3. Put `executeInTransaction=false` in that `.conf` file.
4. Run the migration through `scripts/flyway.mjs` or the `make migration-*`
   targets. The wrapper validates the companion `.conf` file and passes
   `FLYWAY_POSTGRESQL_TRANSACTIONAL_LOCK=false` when online index migrations are
   present.

Use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (and the unique/drop equivalents)
so a re-run after a partial failure is idempotent. Because these migrations run
with `executeInTransaction=false`, a `CONCURRENTLY` build that fails partway
(lock timeout, deadlock, dropped connection) leaves an `INVALID` index behind
and Flyway records the migration as failed. `IF NOT EXISTS` does not replace
that invalid leftover: on `flyway repair` and re-run it sees the existing
(invalid) index and skips creation, so the index stays unusable. Recovery:
manually `DROP INDEX IF EXISTS <index_name>` first, then `flyway repair` and
re-run the migration so the index is rebuilt cleanly.

Do not mix online index statements with unrelated schema, function, policy,
grant, or data changes. If a shared migration needs an online index but has
already been applied to a durable database, leave the shared migration immutable
and use a roll-forward online index migration. If the product is still
pre-release and no durable database history must be preserved, rewrite the
unapplied migration sequence so the online index lives in its own dedicated
migration.
