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
- A hosted Postgres target for the Flyway migration system.
- Supabase database logs.

## Configuration To Verify

- The selected Supabase organization and project belong to Agent Outbox.
- The production project is in the intended region and healthy before runtime or
  migration work.
- Local and generic serverless database URLs use the Supabase pooler unless
  direct connectivity has been explicitly verified.
- Cloudflare Workers production uses Cloudflare Hyperdrive against the direct
  Supabase Postgres host with the restricted app role; Hyperdrive supplies the
  Worker runtime connection string through the `AGENT_OUTBOX_DATABASE` binding.
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

## Database Access And Data API Grants

Agent Outbox uses `pg` over the Postgres protocol. The production Worker obtains
its restricted application-role connection from Hyperdrive; local Node execution
uses `DATABASE_APP_ROLE_URL`. Clerk handles human authentication, and the Outbox
server authenticates caller API requests. These requests do not use Supabase
Auth, PostgREST, GraphQL, or `supabase-js`.

Supabase's
[default-grant announcement](https://github.com/orgs/supabase/discussions/45329),
reviewed on 2026-10-20, schedules the change for existing projects on October
30, 2026. It affects automatic Data API grants on new `public` objects,
preserves existing grants, and does not change direct Postgres access. Outbox
migrations grant the restricted application role access explicitly, so fresh
Flyway replay does not depend on automatic API-role grants. Follow the
[Flyway rules](../migrations.md) for local or disposable replay;
`supabase db reset` is not this repository's migration workflow.

Keep privileges in the migration that introduces each object. Grant the app role
only the operations the server needs, required schema usage and sequence access,
and execution of its application functions. Preserve forced RLS and
transaction-local account and authentication context. For example, the audit
ledger permits SELECT and INSERT, while billing checkout attempts permit SELECT,
INSERT, and UPDATE; account deletion removes attempts through the foreign-key
cascade without a direct DELETE grant.

Do not add grants to `anon`, `authenticated`, or `service_role` to address a
Data API notice unless a separately established application requirement uses
those roles. `REVOKE ... FROM PUBLIC` does not remove privileges granted
directly to named provider roles or inherited through role membership. Inspect
actual object ACLs and creator-specific default privileges before recommending
any revocation; RLS alone does not constrain a role with `BYPASSRLS`.

## Read-only Grant Investigation

Follow [the canonical secret-access procedure](../secrets.md) with AWS profile
`conn`. Retrieve only the target identity and database credentials needed for
the inspection, inside the operator process; never print or persist their
values. Use the restricted app-role connection for catalog inspection when
sufficient. An expired SSO session requires operator authentication through the
documented [SSO recovery command](sentry.md#tool); a missing runtime environment
variable does not establish that the canonical credential is missing.

Verify the canonical target against the live Worker's Hyperdrive origin before
connecting. Set `default_transaction_read_only=on` when opening the connection,
use a bounded `REPEATABLE READ READ ONLY` transaction and statement/connection
timeouts, and roll back after inspection. Catalog checks need no application row
contents: inspect role attributes and memberships, schema ACLs and all table,
sequence, and function ACLs, effective privileges, default ACLs for the actual
object creators, RLS flags and policies, and function ownership/security mode.
Verify exposed schemas separately through the project's Data API settings;
schema names alone do not prove API exposure.

An absent inventory entry or permission denial does not mean Outbox is absent or
unhealthy. Report access limitations and restore the appropriate operator access
before claiming live grants or Data API settings were verified.

## Safe Checks

- Verify the configured organization, project ref, database host, app role, and
  migration role before inspecting production.
- Use the Supabase CLI for project inspection.
- Use Flyway for schema migrations.
- Use read-only inspection first when debugging connection, storage, migration,
  or Row Level Security failures.

## Guardrails

- Never repair schema with raw SQL, direct service edits, or Supabase migration
  commands. Use the Flyway migrations in `db/migrations/`.
- Do not select review content unless the investigation explicitly requires it.
- Do not manually delete live data unless the owner approves the exact scope and
  backup/export posture.
