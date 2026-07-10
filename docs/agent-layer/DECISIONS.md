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

- Decision 2026-07-02 caller-connect-control-plane-lifecycle: Use standards-timed display-once connect codes with bounded transient state
    Decision: Browser setup codes and device/user codes expire after 10 minutes; device polling uses a 5-second interval; setup/device/user codes are stored only as keyed HMAC-SHA256 digests; connect start, poll, and exchange routes are DB-rate-limited at 30 per trusted client IP per UTC minute; connect approvals are limited at 30 per account per UTC minute; cleanup prunes terminal and long-expired setup rows after 7 days, preserves rotate pending replacement setup rows, and reclaims connect callers that never activated and have no audit/input/output history after the same 7-day window.
    Reason: RFC 6749 recommends short-lived single-use authorization codes with a 10-minute maximum, RFC 8628 defines device-code `expires_in` plus a 5-second default poll interval, and abandoned connect metadata needs bounded retention without deleting activated or audit-meaningful caller identity.
    Tradeoffs: Setup remains simple and standards-aligned, and abandoned setup/caller metadata is bounded; a lost display-once credential response still requires a new human-approved connect/rotate flow rather than replaying plaintext secret material.

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

- Decision 2026-07-04 hosted-security-fail-closed-cloudflare-ip: Fail closed and trust Cloudflare client IPs
    Decision: Hosted production protected routes fail closed when Clerk configuration is incomplete, except explicit test fixture bypasses; connect, rotate, and revoke per-IP rate limits trust only `CF-Connecting-IP`, and missing trusted IP fails loud instead of falling back to `X-Forwarded-For`.
    Reason: Agent Outbox's hosted path is Cloudflare/OpenNext, so the security boundary should use Cloudflare's client-IP header and avoid accepting spoofable generic proxy headers or silently exposing protected routes during auth misconfiguration.
    Tradeoffs: This is the smallest safe hosted policy and is easy to test, but non-Cloudflare self-hosters need an explicit future proxy policy before relying on forwarded headers.

- Decision 2026-07-04 caller-runtime-throttles-paid-monthly-disabled: Keep paid monthly quota disabled while enforcing data-plane bursts
    Decision: Hosted paid and self-hosted profiles keep the monthly caller API request quota disabled, while input send/replace, input delete, and raw output file downloads use per-account UTC-minute runtime throttles across all profiles.
    Reason: Paid/self-hosted callers should not hit monthly cleanup-blocking request caps, but burst protection still needs to cover data-plane writes, cleanup deletes, and raw byte downloads.
    Tradeoffs: Paid/self-hosted accounts can make unlimited monthly caller API requests, but bursty traffic is still denied temporarily by operation-specific minute windows.

- Decision 2026-07-06 cloudflare-production-runtime-phase8: Defer Cloudflare runtime setup to Phase 8
    Decision: Phase 7 may finish live Stripe object creation and SSM recovery without creating/deploying the Cloudflare Worker, binding `app.agent-outbox.dev`, or applying Worker runtime secrets.
    Reason: Wrangler secret changes are deploy-producing, and the `agent-outbox` Worker plus `app.agent-outbox.dev` DNS/custom-domain mapping were not live during Phase 7 closeout.
    Tradeoffs: Phase 7 cannot prove production billing end-to-end on Cloudflare, but avoids unplanned production platform writes and keeps Worker/domain/secrets/smoke verification together in Phase 8.

- Decision 2026-07-06 stripe-setup-key-not-runtime: Keep Stripe setup and runtime keys separate
    Decision: Use a setup-only live Stripe key for creating products, prices, Customer Portal configuration, and webhook endpoints; do not store that key as the app's production `STRIPE_SECRET_KEY`.
    Reason: The owner does not want the setup credential used for production checkouts, and runtime secrets are being installed with Cloudflare in Phase 8.
    Tradeoffs: Phase 7 can create and recover Stripe object ids, but production checkout/portal smoke requires a separate restricted runtime key in Phase 8.

- Decision 2026-07-07 client-events-four-signal-scope: Keep browser client-event logging to four signals
    Decision: The browser emitter sends `client_error`, `hydration_error`, `human_action_failed`, and `file_upload_failed`; `ui_state_inconsistent` remains server-allowlisted but unwired in the browser.
    Reason: No stable client-detectable UI invariant exists that is not already enforced by server-side action parsing or route state.
    Tradeoffs: The endpoint contract can accept a future state-inconsistency signal without another server migration, but MVP browser telemetry stays narrow and avoids speculative instrumentation.

- Decision 2026-07-10 production-release-certification: Certify production directly before numbering releases
    Decision: Until paying-customer usage justifies staging, production releases run only through the protected manual GitHub Actions workflow: certify the exact `main` SHA, capture a healthy rollback target, deploy, verify the live SHA, then publish the `package.json`-versioned tag and GitHub Release. A failed deploy or live verification automatically restores the captured Worker; because the Worker is smoke-verified before tagging, a tagging-only failure leaves the verified code live and reconciles on re-dispatch (finalization is idempotent) instead of reverting healthy production.
    Reason: Agent Outbox does not yet warrant a second provider stack, but direct production deploys still need the exact-SHA certification, post-deploy verification, immutable numbering, and rollback guarantees used by Agent Panel staging. Deploy health and release tagging are separate failure domains: reverting a healthy, smoke-verified Worker because a GitHub metadata write failed would be a self-inflicted outage, so only a failed deploy triggers rollback.
    Tradeoffs: This avoids staging cost and configuration while making releases reproducible and failure-safe, but production remains the first provider-backed environment, every deploy requires a committed version bump, and a verified deploy can be briefly live before its numbered tag exists until finalization is re-run.
