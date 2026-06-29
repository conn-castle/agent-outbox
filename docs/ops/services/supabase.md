# Supabase

## Tool

Use the official Supabase CLI: `supabase`.

Run `supabase --help` first, then use `supabase help <command>` or
command-specific help before using flags that are not already proven in this
repository.

## Owns

- Postgres database.
- Queue rows, output rows, uploaded file bytes, quota windows, active limit
  blocks, audit events, and cleanup state.
- Migration execution through the project migration system.
- Supabase database logs.

## Safe Checks

- Verify the configured organization, project ref, database host, app role, and
  migration role before inspecting production.
- Use the Supabase CLI for project inspection and database workflows.
- Use read-only inspection first when debugging connection, storage, migration,
  or Row Level Security failures.

## Guardrails

- Never repair schema with raw SQL or direct service edits. Use migrations.
- Do not select review content unless the investigation explicitly requires it.
- Do not manually delete live data unless the owner approves the exact scope and
  backup/export posture.
