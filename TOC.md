# Agent Outbox - File Router (TOC)

Agent-facing map of this repository. Use it to pick which file to open for a
question or task. This is a router, not a product overview or a planning index.

Until the first release, documentation describes the intended final pre-release
state and may be ahead of implementation. Verify current implemented behavior in
code when the distinction matters.

## Start here

- [`README.md`](README.md) —> Product model, hosted service, API/CLI direction,
  broad stack, license
- [`NORTH_STAR.md`](NORTH_STAR.md) —> Why Agent Outbox exists, the async
  human-in-the-loop queue principle, and the simplicity boundary
- [`docs/architecture.md`](docs/architecture.md) —> System boundaries, runtime
  topology, trust boundaries, data authority, queue/delivery model, limit
  enforcement, and runtime proofs
- [`docs/spec/`](docs/spec/README.md) —> Canonical caller HTTP contract, input
  and output schemas, pagination, file download, status, registration, and API
  error envelopes
- [`.env.example`](.env.example) —> Tracked template and variable list for
  repo-root `.env`

## Operations and runbooks (`docs/ops/`)

- [`docs/ops/resources.md`](docs/ops/resources.md) —> Concrete hosted resource
  inventory for public surfaces and services
- [`docs/ops/debugging.md`](docs/ops/debugging.md) —> Reported failure
  investigation and common diagnostics
- [`docs/ops/monitoring.md`](docs/ops/monitoring.md) —> Finding new issues
  through logs, official CLIs, and health checks
- [`docs/ops/incidents.md`](docs/ops/incidents.md) —> Incident response,
  service-level controls, escalation
- [`docs/ops/secrets.md`](docs/ops/secrets.md) —> Secret ownership, recovery,
  rotation, safe inspection
- [`docs/ops/migrations.md`](docs/ops/migrations.md) —> Flyway migration rules,
  migration source, and CI enforcement

## Hosted Services (`docs/ops/services/`)

- [`docs/ops/services/cloudflare.md`](docs/ops/services/cloudflare.md) —>
  Cloudflare official CLI, owned resources, safe checks, guardrails
- [`docs/ops/services/supabase.md`](docs/ops/services/supabase.md) —> Supabase
  official CLI, owned resources, safe checks, guardrails
- [`docs/ops/services/clerk.md`](docs/ops/services/clerk.md) —> Clerk official
  CLI, owned resources, safe checks, guardrails
- [`docs/ops/services/stripe.md`](docs/ops/services/stripe.md) —> Stripe
  official CLI, owned resources, safe checks, guardrails
- [`docs/ops/services/sentry.md`](docs/ops/services/sentry.md) —> Sentry
  official CLI, owned resources, safe checks, guardrails
