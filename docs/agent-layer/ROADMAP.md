# Roadmap

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
A phased plan of work that guides architecture decisions and sequencing. The roadmap is the “what next” reference; the backlog holds unscheduled items.

## Format
- The roadmap is a single list of numbered phases under `<!-- PHASES START -->`.
- Do not renumber completed phases (phases marked with ✅).
- You may renumber incomplete phases when updating the roadmap (e.g., to insert a new phase).
- Incomplete phases include **Goal**, **Tasks** (checkbox list), and **Exit criteria** sections.
- When a phase is complete:
  - update the heading to: `## Phase N ✅ — <phase name>`
  - replace ALL phase content (Goal, Tasks, Task details, Exit criteria) with a concise bullet summary of what was accomplished (no checkbox list).
- **Archival:** When more than 5 completed phases exist, consolidate the oldest completed phases into a single `## Archived phases` summary. Keep the 5 most recently completed phases as individual entries. The archive section uses one line per phase.

### Phase templates

Archived (compact):
```markdown
## Archived phases (1–N)
- Phase 1 — <name>: <one-line summary>
- Phase 2 — <name>: <one-line summary>
```

Completed:
```markdown
## Phase N ✅ — <phase name>
- <Accomplishment summary bullet>
- <Accomplishment summary bullet>
```

Incomplete:
```markdown
## Phase N — <phase name>

### Goal
- <What success looks like for this phase, in 1–3 bullet points.>

### Tasks
- [ ] <Concrete deliverable-oriented task>
- [ ] <Concrete deliverable-oriented task>

### Exit criteria
- <Objective condition that must be true to call the phase complete.>
- <Prefer testable statements: “X exists”, “Y passes”, “Z is documented”.>
```

## Phases

<!-- PHASES START -->

## Archived phases (1–3)
- Phase 1 — Operating Foundation And Quality Gates: Established the root command surface, pinned tooling, credential-free local gates, CI/release-check skeletons, diagnostics, and pre-product docs alignment.
- Phase 2 — App Runtime Shell Proof: Established the single Next.js app/API boundary, provider-backed runtime proof routes, pinned runtime tooling, and the split between app CI and later Cloudflare/OpenNext deployment verification.
- Phase 3 — Accounts, Authorization, Limits, And Cleanup Foundation: Established the Row-Level-Security-backed account and queue schema, authorization boundaries, canonical tier limits, audit/accounting helpers, and retention and cleanup primitives.

## Phase 4 ✅ — Core Caller HTTP API And Queue Semantics
- Added canonical caller HTTP contract docs for input, output, status, files, caller-registration control-plane shape, response envelopes, pagination, and stable error codes, with route-guard smoke checks keeping later-phase API drift out.
- Added caller bearer API authentication, shared response/error envelopes, route handlers for input send/replace/delete, output check/read/read-all/ack, raw file download, caller status, and account status.
- Implemented typed input validation, supported-icon enforcement, safe HTML/color/URL checks, request/cardinality caps, retry-safe send, pending-only replace/delete, and loud `file_upload` deferral until the paid upload workflow in Phase 7.
- Implemented server-only human answer creation, stale-answer protection, pre-read undo, output reads that mark returned results read, idempotent acknowledgement through the shared deletion path, and metadata-only file reads with dedicated raw-byte downloads.
- Added caller API quota/rate enforcement through canonical limits, quota windows, active limit blocks, account-scoped stock checks, and cleanup exemptions for input delete and output ack.
- Verified the phase with focused behavior tests plus `make check` covering formatting, Markdown lint, TypeScript, 96 tests, build, and structural smoke.

## Phase 5 ✅ — Human Review Web UI
- Added Clerk-backed self-serve sign-up/sign-in entrypoints, first-time human account bootstrap through a narrow database function, idempotent Clerk-to-Agent-Outbox user/account/member provisioning, and human account context resolution.
- Added server-only human review list/detail/status query helpers and replaced the protected placeholder with the responsive review workspace over lightweight rows, lazy detail loading, search, status filter, priority/updated sorting, caller/status affordances, account banner metadata, and front-end-only skipped ordering.
- Added safe typed rendering for sanitized HTML, safe links, accent colors, numeric bars, pills, progress rings, supported icons, primary/overflow actions, popup metadata, and disabled file-upload action display until the Phase 7 paid file workflow exists.
- Added server-only human answer submission for no-popup, free-text, single-select, multi-select, date, and datetime responses; answered-state display; pre-read undo; no-undo-after-caller-read behavior; and narrow compatible bulk actions for selected pending rows with the same no-popup action.
- Kept caller-specific source semantics, downstream execution, saved views, due dates, snooze/scheduling, grouping keys, task-manager behavior, caller-management dashboards, caller API keys, and manual key creation out of the human UI.
- Verified the phase with focused Node tests, `make browser` desktop/mobile coverage for the review and security matrix, and `make check` covering format, Markdown lint, TypeScript, the Node test suite, build, and structural smoke.

## Phase 6 ✅ — Go CLI And Agent Integration Surface
- Added the Go `agent-outbox` CLI with caller connect/browser/device setup, two-phase connect and rotate activation, caller list/status/rotate/revoke/disconnect, account status, local config selection, and secure local caller credential storage.
- Added noninteractive data-plane commands for input send/replace/delete and output check/read/read-all/file get/ack, including stable JSON, concise human output, explicit exit-code mapping, no secret leakage, safe file-download behavior, and default output auto-pagination with cursor/page-size/no-auto-page controls.
- Added local utility commands `docs [topic]`, `doctor [--caller]`, `upgrade`, `version`, and `--version`; local-only commands bypass remote preflight where required, and `doctor` performs read-only diagnostics unless a remote status check is intentionally reachable.
- Added Homebrew-oriented GoReleaser package verification through a non-publishing `make package-check`/`make release-check` path that builds snapshot archives and local cask metadata without requiring Python or Node at runtime.
- Updated public/spec docs and command memory for the implemented CLI surface, package verification, local utility-command boundaries, and Phase 7 billing/file-upload deferrals.
- Verified the phase with Go unit/vet/build gates, Node/app gates, direct binary smoke, Playwright browser/device approval coverage, non-publishing package checks, fresh plan verification, review-scope audits, prune/simplify passes, and recorded the local standalone migration replay environment gap while preserving CI/raw-Postgres migration coverage.

## Phase 7 ✅ — Billing, Files, And Retention
- Added account-scoped Stripe paid-tier behavior with checkout and Billing Portal sessions, signed webhook processing, webhook replay safety, billing grace synchronization, upgrade actions, and account/tier status surfaces.
- Created the approved live Stripe hosted-paid product, monthly/yearly prices, Billing Portal configuration, and billing webhook endpoint; stored setup/object/webhook recovery values in Systems Manager Parameter Store while keeping the separate production runtime Stripe key deferred to Phase 8 with Cloudflare runtime secrets.
- Completed paid-only file-upload and output-file download workflows with free-tier upgrade-required rejection, raw upload/download limits, Postgres byte storage, metadata-only output reads, safe attachment headers, content-safe upload/download/delete audit accounting, and status storage reporting.
- Completed shared cleanup for acknowledgement, output timeout, pending retention, downgrade grace, quota windows, active limit blocks, caller setup pruning, never-activated caller pruning, and Stripe webhook idempotency ledger pruning.
- Reverified provider pricing, free/paid limits, Clerk application posture, Supabase Postgres storage posture, Sentry/Stripe recovery assumptions, and accepted deferrals for Cloudflare runtime setup, Stripe custom/domain configuration, billing emails, higher tiers, managed backups, point-in-time recovery, encrypted off-site exports, and proactive spend automation.

## Phase 8 ✅ — Observability, Operations, And Release Readiness
- Deployed the Cloudflare Worker and custom domain with production secrets, Hyperdrive database access, Stripe-hosted billing configuration, structured logs, Sentry, narrow browser telemetry, and correlated canaries.
- Added production resource, monitoring, debugging, incident, secret-recovery, deployment, rollback, hosted-health, runtime-smoke, and billing-smoke workflows and verified the controlled production evidence paths.
- Established the protected `main` and `production` release policy with the settled local, CI, browser, migration, package, and hosted verification gates.
- Published and accepted the Privacy Policy, Terms of Service, Zoho-backed contact path, retention and support disclosures, and PolyForm Noncommercial license presentation for the production launch.
- Accepted the current Cloudflare Web Analytics provider-permission gap as non-blocking for launch while retaining the deferred setup work in ISSUES.md.

## Phase 9 — Steward Pilot And Public MVP Launch

### Goal
- Prove Agent Outbox as a standalone product with Steward as the first external caller, then launch the public hosted MVP.
- Preserve the product boundary: Steward pressures the generic API, but Steward concepts do not become core Agent Outbox semantics.
- Source map: [README.md](../../README.md) "How It Works", "Product Boundaries", and "Self-Hosting", [NORTH_STAR.md](../../NORTH_STAR.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for standalone product direction, first domains, guardrails, sequencing, and implementation-time action items.

### Tasks
- [ ] Build the Steward email caller integration against the public HTTP/CLI contract while keeping the existing Steward email review UI stable until migration is explicitly safe.
- [ ] Map Steward email rows into generic Agent Outbox input items, including evidence, exact proposed actions/text, links, action values, and caller-owned downstream handling.
- [ ] Implement Steward-side output check/read/ack handling with caller-side idempotency, freshness validation before source-system writes, and durable handling before acknowledgement.
- [ ] Run the hosted production smoke checklist after deploy because there is no persistent staging environment.
- [ ] Verify public README, docs, issue path, hosted URLs, self-hosting posture, retention disclosure, limits, and public/open-source license presentation are coherent for launch and match Agent Layer's license posture.
- [ ] Open public signup only after the health inspection workflow, provider-side abuse controls, hard product limits, and owner-approved launch materials are in place.

### Exit criteria
- Steward can submit, review, read, handle, and acknowledge real review items through the same hosted API/CLI contract future callers use.
- Steward pilot fixtures prove Agent Outbox does not hardcode Gmail, classifier, archive, route-label, or email-specific execution semantics.
- At least one production end-to-end run covers caller connect, input send, human answer, output check, output read, downstream handling, output ack, retention-safe cleanup, and audit/log correlation.
- Public launch checklist is complete, including provider resource inventory, production smoke results, signup protection, spend/abuse guardrails, rollback/incident expectations, and license posture.
- Any unresolved launch, legal, provider, or runtime blocker is explicitly accepted by the project owner or the public launch does not proceed.

## Phase 10 — Post-MVP Expansion And Deferrals

### Goal
- Preserve useful future work without expanding the hosted MVP beyond the async review queue.
- Sequence post-MVP work by proven demand, starting with caller integrations that validate the generic contract.
- Source map: [NORTH_STAR.md](../../NORTH_STAR.md), [README.md](../../README.md) "Product Boundaries", and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for post-MVP backlog, first domains, sequencing, and post-MVP notes in billing, observability, storage, auth, backup, and delivery decisions.

### Tasks
- [ ] Add the next caller domains in order of product learning value, with X/Twitter as the next proof before LinkedIn, Monarch, SMS/SignalWire, or shared human access.
- [ ] Add output webhooks only after polling plus explicit acknowledgement has launched and callers need notification-based delivery.
- [ ] Revisit caller authentication with OAuth or delegated authorization only after third-party callers, delegated scopes, or marketplace-style integrations make bearer keys the limiting tradeoff.
- [ ] Revisit higher paid tiers, billing notification emails, managed backups, point-in-time recovery, encrypted off-site exports, and spend/usage guards only after real hosted usage or paying customers justify the operational burden.
- [ ] Revisit Supabase Storage or another object store only if Postgres file storage becomes a measured cost or operational constraint.
- [ ] Revisit Supabase Realtime, saved views, input expiry, team roles, caller-management UI, proactive monitoring/dashboards, analytics rollups, Axiom, and richer card visuals only when real workflows require them.

### Exit criteria
- Each post-MVP item has a named trigger from real usage, support load, cost pressure, or caller-domain proof before implementation starts.
- New caller domains continue to treat source systems as canonical and return caller-defined action values through Agent Outbox rather than adding domain-specific execution to the core.
- Any new delivery, auth, storage, billing, monitoring, or UI feature is documented as an additive extension that preserves the MVP queue and acknowledgement contract.
