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

## Configuration To Verify

- The selected Supabase organization and project belong to Agent Outbox.
- The production project is in the intended region and healthy before runtime or
  migration work.
- Local and serverless database URLs use the Supabase pooler unless direct
  connectivity has been explicitly verified.
- `DATABASE_APP_ROLE_URL` uses the restricted app role through the transaction
  pooler.
- `DATABASE_URL` and `DATABASE_MIGRATION_URL` use the migration/session
  connection posture selected for the environment.
- The restricted app role exists through the project migration system.
- Legacy JWT-based anon and service-role API keys are disabled when dedicated
  database URLs or scoped API keys replace them.

Store Supabase project refs, hosts, pooler hosts, role names when sensitive,
passwords, full database URLs, API keys, and decrypted Systems Manager Parameter
Store values only in approved operator-controlled systems. Do not commit those
values to Markdown.

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
