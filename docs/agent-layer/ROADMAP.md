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
- Deployed Cloudflare Web Analytics for `app.agent-outbox.dev`, closing the earlier provider-permission gap: the site was created in the Cloudflare dashboard (no Cloudflare API token can create Web Analytics sites) and its beacon token stored in Systems Manager Parameter Store and the GitHub production environment.
- Enabled Sentry source-map upload on the numbered-release deploy path by threading the Sentry org/project/auth-token into the OpenNext build subprocess only (never the Worker runtime or deploy subprocess), so production stack traces de-minify.

## Phase 9 — Product Experience, Branding, And Public API Documentation

### Goal
- Replace the runtime-proof presentation with a coherent public product experience that explains Agent Outbox and leads users into signup, documentation, and the review workflow.
- Establish one accessible, responsive visual system across the public site, authentication, review queue, caller approval, billing, support, and legal surfaces.
- Publish user-facing API documentation without creating a second mutable contract beside `docs/spec/`.

### Tasks
- [ ] Create and review real screen-by-screen storyboards before implementation for the landing/docs experience and key user journeys—signup/sign-in, first empty account, review queue/list/detail/actions, caller approval, upgrade/billing, support/legal, and important loading/empty/error states—using explicit owner checkpoints so the storyboard becomes the shared source for collaboration, scope, hierarchy, transitions, content, and responsive behavior.
- [ ] Establish the documented public-domain split so `https://agent-outbox.dev` serves the product landing page and API documentation while `https://app.agent-outbox.dev` remains the human app and caller API origin, without creating duplicate product or contract sources.
- [ ] Replace the runtime-proof public presentation with a real landing page covering the product value, asynchronous human-review flow, representative use cases, hosted limits/pricing posture, source-available license, and clear signup, sign-in, and API documentation calls to action; prepare the repository link for activation when Phase 10 makes it public.
- [ ] Define and apply shared design tokens, typography, layout, navigation, interaction, feedback, empty/loading/error, and component patterns across landing, authentication, human review, caller approval, upgrade, contact, privacy, terms, and documentation surfaces.
- [ ] Redesign the human review workspace around the shared system while preserving its generic queue semantics, typed actions, caller-defined presentation, and focused review workflow.
- [ ] Build a public API documentation experience derived from the canonical `docs/spec/` contract, covering authentication, caller connection, queue lifecycle, endpoint and schema reference, errors, pagination, files, limits, and CLI/raw-HTTP examples without duplicating independently maintained behavior.
- [ ] Create and approve final Agent Outbox brand assets, then install the logo and favicon consistently on the website, Clerk-hosted authentication surfaces, and the production GitHub OAuth app.
- [ ] Add focused desktop/mobile browser coverage and accessibility checks for the landing page, documentation navigation, authentication entrypoints, redesigned review workflow, keyboard operation, focus behavior, and major empty/error states.

### Exit criteria
- Owner-approved storyboards cover the major public and authenticated journeys, and each Phase 9 implementation and browser-test task traces to the storyboard or records an explicitly approved deviation.
- `agent-outbox.dev` presents Agent Outbox as a product rather than a runtime proof and provides working paths to the `app.agent-outbox.dev` signup/sign-in experience, documentation, and legal/support information, with the source-repository link ready for Phase 10 publication.
- Public, authenticated, billing, approval, and documentation surfaces use one coherent responsive design with verified keyboard and accessibility behavior.
- A caller developer can understand, connect to, and exercise the API from the public documentation, and the rendered reference remains traceable to the canonical `docs/spec/` source.
- Final logo/favicon assets render on the website and Clerk/GitHub OAuth surfaces, and the redesigned review workflow retains focused browser coverage.

## Phase 10 — Codebase, Documentation, And Public Repository Hardening

### Goal
- Remove known correctness, reliability, test, maintainability, and documentation debt before inviting external contributors and depending on the repository as the public product source.
- Publish the repository safely with accurate source-available positioning, usable contributor/support paths, and release evidence that matches production.
- Leave every current issue and backlog item fixed, scheduled behind an explicit trigger, or explicitly accepted by the owner—never silently abandoned.

### Tasks
- [ ] Resolve every actionable entry currently recorded in ISSUES.md, prioritizing the human database-test isolation failure, then the observability gaps, cleanup/refactor items, Stripe webhook retention decision, local/CI security parity, and database teardown consistency; remove entries only after their fixes are verified.
- [ ] Surface generated `error_id` values on the scheduled `/human` submit/undo and caller-approval failure paths so users can provide support-correlation handles.
- [ ] Run iterative correctness, simplification, interface, test-quality, and documentation audits across the web app, HTTP API, CLI, database, deployment tooling, public docs, and operations docs; fix accepted findings and repeat until a fresh review has no unresolved critical/high findings and no unaccepted medium findings.
- [ ] Audit tracked files, generated artifacts, configuration, and Git history for secrets, credentials, private-only references, unsafe examples, stale implementation claims, and licensing/privacy mismatches before changing repository visibility.
- [ ] Finish the public repository surface: update pre-release wording and hosted links, preserve accurate `source-available`/PolyForm terminology, add or verify contribution, issue, security/support, and release guidance, and configure the repository description, homepage, issue path, and required branch protections.
- [ ] Decide and implement the public CLI installation posture: either publish verified tagged binaries/Homebrew distribution from the existing GoReleaser package path or explicitly launch with a tested build-from-source workflow, then make the landing page, API docs, and README agree.
- [ ] Run the complete local, CI, browser, migration, package, Worker dry-run, hosted runtime, hosted-health, billing, signup/auth, and production CLI smoke matrix; resolve failures and record any owner-accepted provider limitations in the release evidence.
- [ ] Change `conn-castle/agent-outbox` from private to public only after the repository-safety audit and verification matrix pass, then verify an unauthenticated clone plus all website, documentation, license, issue, and support links from the public repository.
- [x] Opened production Clerk signup on 2026-07-10 after the owner explicitly accepted enabling it before the remaining pilot and launch-hardening work.

### Exit criteria
- Every current ISSUES.md item is either verified fixed or retained with a concrete external blocker/owner-approved deferral and named later trigger; no actionable pre-launch defect is silently carried forward.
- Repeated code, test, interface, and documentation reviews find no unresolved critical/high issue and no medium issue lacking an explicit disposition.
- A new caller has one tested, publicly documented way to install or build the CLI and reach the canonical API documentation.
- The full release and hosted verification matrix passes or has explicit owner acceptance for each provider-only limitation, with no unresolved secret, privacy, license, or production-link mismatch.
- The GitHub repository is publicly readable, safely cloneable, accurately describes the hosted/source-available product, and exposes working contribution, issue, security/support, documentation, and license paths.

## Phase 11 — Steward Pilot And Public MVP Launch

### Goal
- Prove Agent Outbox as a standalone product with Steward as the first external caller, then launch the public hosted MVP.
- Preserve the product boundary: Steward pressures the generic API, but Steward concepts do not become core Agent Outbox semantics.
- Source map: [README.md](../../README.md) "How It Works", "Product Boundaries", and "Self-Hosting", [NORTH_STAR.md](../../NORTH_STAR.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for standalone product direction, first domains, guardrails, sequencing, and implementation-time action items.

### Tasks
- [ ] Build the Steward email caller integration against the public HTTP/CLI contract while keeping the existing Steward email review UI stable until migration is explicitly safe.
- [ ] Map Steward email rows into generic Agent Outbox input items, including evidence, exact proposed actions/text, links, action values, and caller-owned downstream handling.
- [ ] Implement Steward-side output check/read/ack handling with caller-side idempotency, freshness validation before source-system writes, and durable handling before acknowledgement.
- [ ] Run the hosted production smoke checklist after deploy because there is no persistent staging environment.
- [ ] Reverify that public README/docs, hosted URLs, self-hosting posture, retention disclosure, limits, source-available license presentation, signup protection, and issue/support paths still match the shipped Steward-backed launch state.

### Exit criteria
- Steward can submit, review, read, handle, and acknowledge real review items through the same hosted API/CLI contract future callers use.
- Steward pilot fixtures prove Agent Outbox does not hardcode Gmail, classifier, archive, route-label, or email-specific execution semantics.
- At least one production end-to-end run covers caller connect, input send, human answer, output check, output read, downstream handling, output ack, retention-safe cleanup, and audit/log correlation.
- Public launch checklist is complete, including provider resource inventory, production smoke results, signup protection, spend/abuse guardrails, rollback/incident expectations, and license posture.
- Any unresolved launch, legal, provider, or runtime blocker is explicitly accepted by the project owner or the public launch does not proceed.

## Phase 12 — Post-MVP Expansion And Deferrals

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
- [ ] Add in-app usage analytics for queued, answered, and skipped throughput only after real hosted usage demonstrates that the existing Postgres data needs a product-facing rollup or query surface.
- [ ] Migrate the Clerk route-protection entrypoint from `middleware.ts` to `proxy.ts` only after a released OpenNext Cloudflare version supports the Next.js convention and the platform verification gate proves parity.
- [ ] Revisit Supabase Realtime, saved views, input expiry, team roles, caller-management UI, proactive monitoring/dashboards, Axiom, and richer card visuals only when real workflows require them.

### Exit criteria
- Each post-MVP item has a named trigger from real usage, support load, cost pressure, or caller-domain proof before implementation starts.
- New caller domains continue to treat source systems as canonical and return caller-defined action values through Agent Outbox rather than adding domain-specific execution to the core.
- Any new delivery, auth, storage, billing, monitoring, or UI feature is documented as an additive extension that preserves the MVP queue and acknowledgement contract.
