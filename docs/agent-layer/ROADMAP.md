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

## Phase 1 ✅ — Operating Foundation And Quality Gates
- Added the root command surface in `Makefile` and documented canonical setup, verification, doctor, release-check, development, and maintenance commands in [COMMANDS.md](COMMANDS.md).
- Added pinned Phase 1 tooling and future runtime compatibility metadata in `toolchain.json`, with package metadata, CI workflow Node versions, command docs, Node type definitions, and lockfile state validated by local gates.
- Added credential-free local gates for formatting, Markdown lint, TypeScript typecheck, Node tests, build consistency, and structural smoke checks.
- Added GitHub Actions CI and release-check skeletons that provision pinned Node, run setup before verification, use read-only repository permissions, and contain no deploy or publish commands.
- Added fail-loud local/provider diagnostics for pinned tools, `.env` required names, read-only provider CLI authentication, command timeouts, and the dedicated Agent Outbox Supabase project reference.
- Audited and updated pre-product docs for the new command/setup truth, including README, NORTH_STAR, architecture, ops docs, ROADMAP, COMMANDS, and Supabase setup context.

## Phase 2 ✅ — App Runtime Shell Proof
- Established the single Next.js app/API boundary with public, auth-adjacent, protected human, caller-auth, database, structured-log, structured-error, Sentry, and scheduled canary routes.
- Added pinned Next.js, Clerk, Supabase/Postgres, Sentry, logging, and runtime tooling to app gates while keeping queue lifecycle, product tables, file workflows, billing, cleanup implementation, and Steward-specific behavior out of scope.
- Kept normal app CI and `make check` independent of Wrangler, OpenNext Cloudflare, provider credentials, deployment artifacts, and platform runtime emulation.
- Verified the provider-backed runtime proof with `make doctor` and `make smoke-runtime` against the local app using real development Clerk, Supabase/Postgres, Sentry, and smoke-token values.

## Phase 3 — Accounts, Authorization, Limits, And Cleanup Foundation

### Goal
- Create the account-scoped foundation for humans, callers, authorization, limits, audit, and lifecycle cleanup.
- Keep one source of truth for tier/limit behavior so API errors, status output, cleanup, and UI copy cannot drift.
- Source map: [architecture.md](../architecture.md) "Trust Boundaries", "Data Authority", and "Limits, Billing, And Cleanup", [ops/secrets.md](../ops/secrets.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for account, reviewer, caller credential, database authorization, hosted-tier limit, audit, quota, and analytics decisions.

### Tasks
- [ ] Implement Agent Outbox-owned accounts, users, owner-level membership, callers, caller credential metadata, and display-once bearer-key handling.
- [ ] Add product migrations and data-access boundaries for queue state, output references, file metadata/byte ownership, content-safe audit, quota windows, active limit blocks, and cleanup state without making Agent Outbox a durable storage platform.
- [ ] Enforce app-layer authorization and database row-policy protection for human and caller paths, with identity derived from sessions or credentials rather than request bodies.
- [ ] Implement one tier-aware limits source for free, paid, self-hosted, retention, timeout, rate-limit, and file-availability behavior.
- [ ] Implement shared quota/accounting/audit helpers for accepted writes, denials, lifecycle transitions, file byte accounting, and cleanup.
- [ ] Implement idempotent cleanup primitives for acknowledgement, output timeout, retention, downgrade grace expiry, quota-window pruning, and active-limit maintenance.

### Exit criteria
- Migrations apply cleanly in local development and representative tests prove cross-account denial at both app-layer and database-policy boundaries.
- Limit enforcement, account/caller status, doctor metadata, cleanup, active limit blocks, and error metadata all derive from the same tier-aware limits source.
- Current queue/storage state is derived from live rows; historical flow usage is derived from quota windows and audit events, with no duplicate mutable usage gauge.
- Audit/log output is content-safe and excludes review HTML, free-text answers, file bytes, caller keys, full request bodies, and raw caller-controlled display strings.
- Cleanup verification proves terminal output deletion removes the matching visible input item and attached file bytes, while pre-read undo is the only restore-to-pending exception.

## Phase 4 — Core Caller HTTP API And Queue Semantics

### Goal
- Ship the canonical raw HTTP contract for callers before relying on the CLI as a wrapper.
- Implement the typed async input/output queue lifecycle without adding workflow-engine, source-system, realtime, or task-management semantics.
- Source map: [README.md](../../README.md) "Input Items", "Output Results", "Queue Semantics", and "Caller Integration", [architecture.md](../architecture.md) "Queue And Delivery" and "File Handling", and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for input queue, output queue, output delivery, and API definition order.

### Tasks
- [ ] Define and document implementation-owned HTTP routes, request/response envelopes, pagination envelopes, and stable error codes for input, output, caller registration, and status contracts.
- [ ] Implement input submission validation, HTML/color/icon safety, request-size/list caps, retry-safe `send`, explicit pending-only `replace`, and pending-only `delete`.
- [ ] Implement human-answer creation as exactly one output result for the originating caller, including stale-answer protection and pre-read undo support.
- [ ] Implement non-mutating output checks, output reads that mark returned results as read, auto-pageable bulk reads, idempotent acknowledgement, and at-least-once delivery until acknowledgement or timeout cleanup.
- [ ] Implement authorized file metadata and dedicated raw-byte file download behavior without returning file bytes from output check/read; complete paid file-upload workflows in Phase 7.
- [ ] Implement the shared API/CLI error model, including distinct validation, auth, authorization, conflict, stale, not found, already-acknowledged, quota/rate-limit, upgrade-required, temporary, and internal failures.

### Exit criteria
- HTTP contract docs exist and the CLI roadmap has no hidden behavior not expressible through documented HTTP endpoints.
- API tests cover duplicate input send, pending conflict, explicit replace, pending delete, answered-unacknowledged conflict, output check/read/read-all/ack, pre-read undo, stale answer rejection, and timeout/ack deletion invariants.
- Pagination verification proves `check` and `read --all` cannot silently leave unread pages behind when the server reports more results.
- File verification proves output reads return metadata only and raw bytes require the dedicated caller-authorized file endpoint.
- Error responses and logs include correlation identifiers and safe machine-readable codes without leaking user content or secrets.

## Phase 5 — Human Review Web UI

### Goal
- Build the calm, generic human review surface over the typed queue model.
- Keep the human as the sole UI user; callers and agents remain API/CLI users.
- Source map: [NORTH_STAR.md](../../NORTH_STAR.md), [README.md](../../README.md) "How It Works" and "Product Boundaries", [architecture.md](../architecture.md) "Human Review Surface", and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for MVP human web UI scope.

### Tasks
- [ ] Implement authenticated list/detail review with lightweight rows, lazy details, bounded rendering, search, generic filters, priority/timestamp sorting, and caller/status affordances.
- [ ] Render typed input content safely, including sanitized HTML text, links, row accent colors, numeric bars, pills, progress rings, primary actions, overflow actions, and supported popup kinds.
- [ ] Implement human answers for no-popup, free-text, single-select, multi-select, and date/datetime actions using server-only writes.
- [ ] Implement pre-read undo, answered-state display, billing/downgrade grace banner behavior, and front-end-only skipped ordering without adding backend skip lifecycle state.
- [ ] Implement narrow bulk actions only when selected pending rows expose the same complete no-popup action.
- [ ] Keep caller-specific source semantics, downstream execution, saved views, due dates, snooze/scheduling, grouping keys, task-manager behavior, and caller-management dashboards out of the UI.

### Exit criteria
- Browser-level verification covers desktop and mobile list/detail review, supported popup kinds, bulk action compatibility, skipped ordering, search/filter/sort, undo before read, and no undo after caller read.
- Security verification proves unsafe HTML, unsafe colors, arbitrary SVG/media/forms/scripts, and caller-supplied UI components are rejected or sanitized before rendering.
- UI tests or review fixtures include at least one Steward-shaped item without hardcoding email classifier, Gmail, route-label, or downstream execution concepts into Agent Outbox.
- The human UI does not expose caller API keys, manual key creation, source-system execution controls, or any caller/agent-only workflow.

## Phase 6 — Go CLI And Agent Integration Surface

### Goal
- Deliver the first agent-facing integration as a Go `agent-outbox` CLI that maps directly to the HTTP API.
- Make agent automation predictable through crisp output, stable JSON, explicit exit codes, and local secure caller storage.
- Source map: [README.md](../../README.md) "Quickstart" and "Caller Integration", [COMMANDS.md](COMMANDS.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for caller integration surface, caller registration, caller credential operations, local caller selection, and error handling.

### Tasks
- [ ] Implement `caller connect`, browser callback, device-code fallback, local secure storage, caller selection, `caller list/status/rotate/revoke/disconnect`, and `account status`.
- [ ] Implement `input send/replace/delete`, `output check`, `output read`, `output read --all`, `output file get`, and `output ack` as noninteractive data-plane commands.
- [ ] Implement `docs`, `doctor`, `upgrade`, `version`, `--version`, global base-URL/config selection, `--json`, explicit exit codes, stdout/stderr separation, and no-color behavior.
- [ ] Implement auto-pagination for output check/read-all by default, with explicit cursor/page-size/no-auto-page controls for debugging and raw API parity.
- [ ] Package the CLI for Homebrew distribution without requiring Python or Node at runtime.
- [ ] Keep local config to platform-standard Agent Outbox config locations and keep caller secrets out of non-secret config, logs, diagnostics, and JSON metadata.

### Exit criteria
- CLI integration tests pass against a local app for caller setup, caller selection conflicts, config/auth failures, input lifecycle, output check/read/ack, file download refusal-to-overwrite, and JSON/human output modes.
- Every command has accurate help covering purpose, arguments, flags, environment variables, examples, exit codes, and related docs.
- Data-plane commands are noninteractive by default and fail loud for missing config, revoked keys, invalid schemas, unsafe HTML, oversized payloads/uploads, stale output, and rate limits.
- `--json` output is stable and complete enough for agents; human output is concise, line-oriented, and does not rely on color, spinners, or prose banners.
- CLI behavior is demonstrably a wrapper over the documented HTTP API, not a second product contract.

## Phase 7 — Billing, Files, And Retention

### Goal
- Complete hosted MVP paid-tier behavior, paid file workflows, and retention/cleanup behavior after the queue contract is working.
- Keep billing and file handling narrow: Agent Outbox is an async review queue, not a durable storage or billing platform.
- Source map: [README.md](../../README.md) "Hosted Service" and "Product Boundaries", [architecture.md](../architecture.md) "File Handling" and "Limits, Billing, And Cleanup", [ops/resources.md](../ops/resources.md), [ops/secrets.md](../ops/secrets.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for billing/tier, file storage, backup/durability, and spend-control decisions.

### Tasks
- [ ] Implement Stripe account-scoped paid tier, upgrade flow, portal/webhook handling, billing grace behavior, and account/tier status surfaces.
- [ ] Complete paid-only file-upload actions, free-tier upgrade-required rejection, server-only upload/download routes, stored-byte accounting, safe attachment headers, and file delete audit events.
- [ ] Complete retention, output-timeout, downgrade-grace, acknowledgement, quota-window, and active-limit-block cleanup jobs using the shared deletion path.
- [ ] Reverify provider pricing, free-tier limits, Clerk signup protections, Cloudflare edge safety controls, Supabase storage posture, and secret recovery assumptions before public release.
- [ ] Keep billing emails, higher paid tiers, managed backups, point-in-time recovery, encrypted off-site exports, and proactive spend automation deferred unless required for launch approval.

### Exit criteria
- Stripe test-mode verification covers successful upgrade, payment failure/grace, grace expiry behavior, webhook replay safety, and downgrade cleanup ordering without depending on billing emails.
- File verification covers paid upload/download, free-tier file-upload rejection, oversized upload rejection, metadata-only output reads, raw-byte download, audit byte accounting, and deletion through acknowledgement/timeout/cleanup.
- Cleanup verification proves terminal output deletion, retention expiry, downgrade grace expiry, and quota maintenance use the shared deletion path and remain idempotent.
- Launch-blocking provider limits, prices, protections, and secret recovery assumptions are reverified as of the phase completion date.
- Deferred operational/business items are recorded in the final deferral phase or explicitly accepted by the project owner.

## Phase 8 — Observability, Operations, And Release Readiness

### Goal
- Make the hosted MVP inspectable, diagnosable, and releasable without adding heavyweight operations before usage justifies them.
- Keep operations lightweight and provider-native.
- Source map: [ops/resources.md](../ops/resources.md), [ops/monitoring.md](../ops/monitoring.md), [ops/debugging.md](../ops/debugging.md), [ops/incidents.md](../ops/incidents.md), [ops/secrets.md](../ops/secrets.md), and original handoff path `/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md` for observability, secrets source, emergency shutdown, and launch-readiness decisions.

### Tasks
- [ ] Decide the launch analytics and product-tooling stack, then implement Sentry, Cloudflare structured logs, Supabase log usage, Cloudflare Web Analytics or the chosen web analytics tool, narrow frontend client-event logging, and canary records with shared `error_id` correlation.
- [ ] Populate production resource inventory, deployment smoke checklist, debugging, incident, monitoring, and secret recovery instructions with exact Agent Outbox resources as they are created.
- [ ] Build the agent-run hosted health inspection workflow so an agent can check app, auth, caller API, database connectivity, cleanup, quota enforcement, file path, logs, audit events, and obvious abuse/cost signals on demand.
- [ ] Prepare release verification that covers local gates, CI gates, package artifacts, hosted smoke, rollback expectations, and owner acceptance.
- [ ] Prepare legal/business launch materials for owner review, including privacy policy, terms, abuse/contact path, retention disclosure, support boundaries, and public/open-source license presentation matching Agent Layer's license.

### Exit criteria
- Observability canaries and logs correlate app, API, cleanup, and file-path failures by safe identifiers without leaking content or secrets.
- Production smoke coverage is documented for Clerk sign-in/out, protected queue load, caller auth, CLI browser callback, CLI device-code fallback, cleanup execution, observability canary, and paid file upload/download.
- The health inspection workflow can be run by an agent and reports actionable pass/fail status without requiring dashboard spelunking.
- Public launch materials are accepted by the project owner before public signup opens.
- Any unresolved launch, legal, provider, or runtime blocker is explicitly accepted by the project owner or public launch does not proceed.

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
