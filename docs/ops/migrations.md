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
