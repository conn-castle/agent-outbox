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
- Decision 2026-07-02 caller-connect-control-plane-lifecycle: Use standards-timed display-once connect codes with bounded transient state
    Decision: Browser setup codes and device/user codes expire after 10 minutes; device polling uses a 5-second interval; setup/device/user codes are stored only as keyed HMAC-SHA256 digests; connect start, poll, and exchange routes are DB-rate-limited at 30 per trusted client IP per UTC minute; connect approvals are limited at 30 per account per UTC minute; setup-request cleanup prunes terminal and long-expired rows after 7 days while preserving rows referenced by pending replacement credentials.
    Reason: RFC 6749 recommends short-lived single-use authorization codes with a 10-minute maximum, RFC 8628 defines device-code `expires_in` plus a 5-second default poll interval, and abandoned setup metadata needs bounded retention without deciding rotate/revoke activation semantics in WP-1.
    Tradeoffs: Setup remains simple and standards-aligned, and abandoned setup metadata is bounded; a lost display-once credential response still requires a new human-approved connect/rotate flow rather than replaying plaintext secret material.

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

- Decision 2026-07-02 caller-rotate-two-phase-activation: Activate replacement keys only after local storage succeeds
    Decision: Human-approved rotate exchange creates a `pending_activation` replacement key that cannot authenticate data-plane requests; the old active key is revoked only after the CLI stores the replacement locally and calls rotate activate, while rotate abort expires the pending key and leaves the old key active.
    Reason: Rotation must recover from local secure-storage failure without locking out the caller, and a stolen active caller key must not be sufficient to rotate or revoke credentials.
    Tradeoffs: Rotation has one extra activation round trip, but avoids both premature old-key revocation and pending-key data-plane access.

- Decision 2026-07-02 caller-connect-two-phase-activation: Activate connect keys only after local storage succeeds
    Decision: Human-approved connect exchange (browser exchange and device poll) returns a `pending_activation` display-once key plus `setup_request_id` in the response body; `connect/activate` marks the key active only after the CLI stores it locally, and `connect/abort` expires the pending key so no active hosted key is stranded. Mirrors `caller-rotate-two-phase-activation`.
    Reason: Connect must recover from local secure-storage failure without stranding an active, unrecoverable hosted credential; the exchange body carries `setup_request_id` (unlike rotate) because the connect device flow has no separate exchange step to return it.
    Tradeoffs: Connect gains failure-safe activation at the cost of one extra activation round trip and a pending key that cannot access the data plane until it is activated.

- Decision 2026-07-03 homebrew-cask-package-metadata: Generate Homebrew cask metadata for the CLI package gate
    Decision: Phase 6 package verification uses GoReleaser v2.16 `homebrew_casks` with `release.disable: true`, `skip_upload: true`, and snapshot-only local release generation instead of legacy formula metadata.
    Reason: GoReleaser v2.16 validates the current Homebrew binary artifact path through `homebrew_casks`; the phase requires non-publishing Homebrew-oriented package verification, not tap publication.
    Tradeoffs: The local gate proves cask metadata and archives rather than a Homebrew formula; intentional tap publication or formula support remains future release work.

- Decision 2026-07-03 connect-deny-preview-unscoped: Connect deny/preview is bearer-capability, not account-scoped
    Decision: Connect setup-request deny/preview (`denySetupRequestStatement`, `getConnect*ApprovalPreview` in src/server/caller-connect.ts) is authorized by possession of the unguessable UUIDv4 approval link, not by account ownership; rotate/revoke deny/preview stay account-scoped (`EXISTS (... callers WHERE caller.account_id = ...)`).
    Reason: A new connect request has no owning account until approved, so authority follows possession of the link (device-flow bearer-capability norm), whereas rotate/revoke act on an existing account-owned caller.
    Tradeoffs: Bounded exposure of an unclaimed ~10-minute request identified by a UUIDv4, in exchange for not forcing premature account ownership onto connect; the connect-vs-rotate/revoke asymmetry is intentional, not a missing scope check.
