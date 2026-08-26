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

- Decision 2026-07-06 stripe-setup-key-not-runtime: Keep Stripe setup and runtime keys separate
    Decision: Use a setup-only live Stripe key for creating products, prices, Customer Portal configuration, and webhook endpoints; do not store that key as the app's production `STRIPE_SECRET_KEY`.
    Reason: Setup credentials need broader resource-management permissions than production checkout and portal requests, so reusing one key would unnecessarily widen runtime authority.
    Tradeoffs: Operators must manage separate setup and runtime credentials, but the production Worker keeps narrower Stripe permissions.

- Decision 2026-07-07 client-events-narrow-signal-scope: Keep client events allowlisted with explicit producers and server-derived categories
    Decision: Browser code emits client, hydration, and named GitHub sign-in launch failures; canonical human server-action outcomes emit human-action and file-upload failures. The server derives categories from the allowlisted name, distinguishes `browser` from `server_action`, and permits one low-trust GitHub launch capture attempt per Worker isolate per minute across all names. `ui_state_inconsistent` remains allowlisted but unwired.
    Reason: GitHub launch failures can resolve without throwing and need an operator-visible group, but the public endpoint is forgeable; canonical name mapping prevents client-controlled routing, and a time-bounded global limiter prevents attacker-selected names from permanently suppressing one operation or creating an unlimited Sentry and error-alert ingest path.
    Tradeoffs: Further launch failures within the minute remain warning logs and do not increment Sentry; a forged event can briefly suppress capture in one isolate, but later genuine failures become eligible again.

- Decision 2026-07-10 production-release-certification: Certify production directly before numbering releases
    Decision: Until paying-customer usage justifies staging, production releases run only through the protected manual GitHub Actions workflow: certify the exact `main` SHA, capture a healthy rollback target, deploy, verify the live SHA, then publish the `package.json`-versioned tag and GitHub Release. A failed deploy or live verification automatically restores the captured Worker; because the Worker is smoke-verified before tagging, a tagging-only failure leaves the verified code live and reconciles on re-dispatch (finalization is idempotent) instead of reverting healthy production.
    Reason: Agent Outbox does not yet warrant a second provider stack, but direct production deploys still need the exact-SHA certification, post-deploy verification, immutable numbering, and rollback guarantees used by Agent Panel staging. Deploy health and release tagging are separate failure domains: reverting a healthy, smoke-verified Worker because a GitHub metadata write failed would be a self-inflicted outage, so only a failed deploy triggers rollback.
    Tradeoffs: This avoids staging cost and configuration while making releases reproducible and failure-safe, but production remains the first provider-backed environment, every deploy requires a committed version bump, and a verified deploy can be briefly live before its numbered tag exists until finalization is re-run.

- Decision 2026-07-11 privileged-migration-owner-runtime-role-split: Keep migration ownership privileged and runtime access restricted
    Decision: `DATABASE_MIGRATION_URL` uses a superuser or `BYPASSRLS` migration owner; application traffic uses the separate non-superuser, non-`BYPASSRLS` `agent_outbox_app` role.
    Reason: Security-definer bootstrap and maintenance functions operate over forced-Row-Level-Security tables, while the runtime boundary must remain least-privileged; PostgreSQL 17 creator/admin membership with `set_option=false` is baseline ownership metadata, not test leakage.
    Tradeoffs: Local migration/database tests require a privileged disposable connection matching CI, but runtime credentials cannot bypass Row-Level Security and tests fail loudly when the roles are conflated.

- Decision 2026-08-12 database-parity-runs-full-root-suite: Discover every root test file in database parity checks
    Decision: The canonical `make test-database` command runs every `tests/*.test.mjs` file serially in local, CI, and release-check database environments.
    Reason: A new database-gated root test must automatically receive migrated-Postgres coverage; one Make target keeps the local and workflow boundary identical.
    Tradeoffs: Migration-replay jobs repeat credential-free coverage and run new root tests serially, but cannot silently omit database-gated tests or drift from the canonical command.

- Decision 2026-08-12 retain-pr-release-certification: Retain independent release certification on pull requests
    Decision: Keep both ordinary CI and the release-check workflow running on pull requests, including their intentionally duplicated browser and migration-replay lanes.
    Reason: Development is fully agentic and relies on automated process rather than routine human code inspection, so catching packaging, workflow, and provider-parity regressions before merge is more important than minimizing CI consumption.
    Tradeoffs: Pull requests consume additional runner time and repeat several gates, but gain independent certification and earlier release-specific feedback rather than discovering those failures during a production release.

- Decision 2026-08-14 perimeter-source-license: Permit internal commercial use while prohibiting competing products
    Decision: License Agent Outbox source under PolyForm Perimeter License 1.0.1, allowing internal use and modification, including commercial internal operations, while prohibiting providing others a product that competes with Agent Outbox, including a competing hosted service.
    Reason: Nick selected this boundary so individuals and companies can adapt Agent Outbox for their own operations without enabling competing products or hosted services.
    Tradeoffs: Commercial internal operation is allowed, but the source license cannot be used to provide others a competing product; access to hosted free and paid services remains governed by the Terms and plan limits.

- Decision 2026-08-20 human-only-pr-policy-gates: Enforce human-only PR labels without a merge-CI phase
    Decision: Policy gates run in a dedicated PR workflow for megachange, destructive migrations, and public legal-policy changes. Agents must never apply `megachange-approved`, `migration-destructive-approved`, or `legal-policy-approved`. There is no `ready-for-merge` label or second merge-CI phase.
    Reason: Ordinary PR CI already covers the full verification surface, so a label-gated merge phase would add delay without a faster inner loop. Human-only labels still need a required check that fails until a person applies them in GitHub.
    Tradeoffs: Applying an approval label retriggers only Policy gates, not the heavier CI jobs; a real-user-journey certification gate is deferred until that harness exists.

- Decision 2026-08-21 public-website-app-subdomain: Keep marketing on the apex and the app on the app subdomain
    Decision: `https://agent-outbox.dev` is the public landing/docs origin. `https://app.agent-outbox.dev` remains the human app and caller API origin. Do not serve the app under `/app` on the apex.
    Reason: The landing page must be the googled root URL, while the caller API, CLI default, Clerk session cookies, and existing production origin already use the app subdomain.
    Tradeoffs: One Worker still serves both hostnames, so host redirects and nav links have to stay aligned; this avoids a breaking API origin change and keeps auth cookies off the marketing site.

- Decision 2026-08-22 release-marketing-screenshot-attestation: Recapture and approve landing screenshots before every version bump
    Decision: `marketing/screenshots.json` is the canonical inventory for landing-page product screenshots and records the release version, capture route and viewport, and approved SHA-256. Release preparation first fetches numbered tags and rejects a target older than the package or fetched `main` version, not newer than the latest tag, or whose tag exists. Equality with the package and `main` version is allowed so an unpublished prepared release can be resumed. It then regenerates the tracked `public/` images directly from the deterministic human-review fixture using a pinned Linux/amd64 Playwright container, leaves them unstaged for unconditional human review, and repeats the version gate before recording the reviewed hashes ahead of the package version bump. Only comparison evidence is temporary. Release verification recaptures and compares without modifying committed files, while production preparation fails fast on a stale version or hash.
    Reason: Real product screenshots are release material and must be intentionally reviewed for every release, but production workflows must never generate or commit them. A versioned attestation represents a fresh pixel-identical review without manufacturing meaningless binary changes, and the pinned rasterizer keeps local Apple Silicon and Linux CI evidence comparable.
    Tradeoffs: Screenshot verification adds a Docker-backed Playwright capture to release certification and an explicit human checkpoint to release preparation; unchanged PNGs may not appear in the release diff, but the manifest still advances and the fresh-capture gate proves the approved pixels match the current fixture.

- Decision 2026-08-25 ssm-canonical-secret-authority: Make SSM the canonical project secret store
    Decision: AWS Systems Manager Parameter Store under the Agent Outbox prefixes is authoritative for all managed, recoverable secrets and environment-owned provider configuration. Provider-issued values are written to SSM before downstream GitHub, Cloudflare, or service-native runtime copies; approved local operator tooling may inject narrow non-mutating SSM sets directly into child processes using AWS SSO profile `conn` without plaintext caches. Production migration credentials are available only to the protected GitHub Actions release path.
    Reason: Recovery-only mirrors allow runtime and deployment stores to drift while leaving operators uncertain which copy is correct; a readable canonical store makes rotation, restoration, and local diagnostics deterministic.
    Tradeoffs: Normal deploys retain downstream copies and do not depend on AWS availability, so rotations must update SSM first and then reconcile every consumer; display-once caller API keys remain intentionally unrecoverable and are rotated instead.
