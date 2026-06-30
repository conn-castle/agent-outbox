# Decisions

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
A rolling log of important, non-obvious decisions that materially affect future work (constraints, deferrals, irreversible tradeoffs). Only record decisions that future developers/agents would not learn just by reading the code. Do not log routine choices or standard best-practice decisions; if it is obvious from the code, leave it out.

## Format
- Keep entries brief and durable (avoid restating obvious defaults).
- Keep the oldest decisions near the top and add new entries at the bottom.
- Insert entries under `<!-- ENTRIES START -->`.
- Line 1 starts with `- Decision YYYY-MM-DD <id>:` and a short title.
- Lines 2–4 are indented by **4 spaces** and use `Key: Value`.
- Keep **exactly one blank line** between entries.
- If a decision is superseded, replace the old entry with the new one. Fold the old entry's tradeoff context into the new entry's `Reason` field when it is still valuable, then remove the old entry.
- Periodically consolidate: remove entries that are now self-evident from the codebase (the decision is embodied in code, tests, or docs and a reader would learn it without the log). When removing, verify the tradeoff information is not uniquely preserved in the log.

### Entry template
```text
- Decision YYYY-MM-DD short-slug: Short title
    Decision: <what was chosen>
    Reason: <why it was chosen>
    Tradeoffs: <what is gained and what is lost>
```

## Decision Log

<!-- ENTRIES START -->
- Decision 2026-06-30 worker-scheduled-wrapper: Use a Worker wrapper for cron events
    Decision: `wrangler.jsonc` points at `worker/entry.mjs`, which delegates HTTP traffic to OpenNext's generated `.open-next/worker.js` and owns the Worker `scheduled` handler.
    Reason: The OpenNext Cloudflare template generates a `fetch` entrypoint but no project-owned `scheduled` export, while hosted cleanup will need a durable Worker cron hook.
    Tradeoffs: The wrapper adds one maintained file around generated output, but preserves OpenNext HTTP behavior and makes cron handling durable and testable.

- Decision 2026-06-30 app-ci-platform-split: Keep platform verification out of app CI
    Decision: `make check` and app tests verify the Next.js app only; Cloudflare/OpenNext/Wrangler verification belongs in later deployment/release work.
    Reason: App CI should fail for app defects, not deployment adapter installation, local Worker emulation, or Cloudflare credential/tooling issues.
    Tradeoffs: Platform regressions require a separate release/ops check, but normal development and CI stay provider-credential-free and platform-independent.

- Decision 2026-06-30 self-hosted-paid-profile-limits: Reuse paid limits profile for self-hosted mode
    Decision: Self-hosted/non-hosted operation maps to the hosted paid limits profile without Stripe billing state instead of adding a separate self-hosted limits surface.
    Reason: Self-hosting is a byproduct of the public repository, not a product goal, and a dedicated self-hosting limits model would add confusing code paths before real need exists.
    Tradeoffs: Self-hosted defaults inherit paid-tier storage/runtime behavior rather than removing product caps entirely, but the codebase stays simpler and hosted behavior remains canonical.

- Decision 2026-06-30 host-agnostic-flyway-migrations: Use Flyway for Postgres migrations
    Decision: `db/migrations/` is the canonical schema source and Flyway runs hand-authored PostgreSQL SQL against normal Postgres URLs; provider CLIs are not migration authorities.
    Reason: The schema must run on raw Postgres containers, Supabase, Neon, Aurora, and similar providers without binding migration history to one host.
    Tradeoffs: This adds a Dockerized Flyway tool boundary, but gives provider portability, checksum validation, and raw Postgres CI replay.
