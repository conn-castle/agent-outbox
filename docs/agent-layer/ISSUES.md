# Issues

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
Deferred defects, maintainability refactors, technical debt, risks, and engineering concerns. Add an entry only when you are not fixing it now.

## Format
- Insert new entries immediately below `<!-- ENTRIES START -->` (most recent first).
- Keep each entry **3–5 lines**.
- Line 1 starts with `- Issue YYYY-MM-DD <id>:` and a short title.
- Lines 2–5 are indented by **4 spaces** and use `Key: Value`.
- Keep **exactly one blank line** between entries.
- Prevent duplicates: search the file and merge/rewrite instead of adding near-duplicates.
- When fixed, remove the entry from this file.

### Entry template
```text
- Issue YYYY-MM-DD short-slug: Short title
    Priority: Critical | High | Medium | Low. Area: <area>
    Description: <observed problem or risk>
    Next step: <smallest concrete next action>
    Notes: <optional dependencies/constraints>
```

## Open issues

<!-- ENTRIES START -->
- Issue 2026-07-10 billing-checkout-latency: Authenticated Stripe checkout takes 5–10 seconds to appear
    Priority: Medium. Area: Billing / Performance
    Description: Unauthenticated production requests complete in 6–102 ms of Worker wall time, while the configured database takes 387–525 ms per transaction and checkout performs three fresh sequential transactions before/during Stripe session creation; an authenticated production sample is still needed to isolate database, Stripe API, and Stripe page-load time.
    Next step: Capture one authenticated checkout with Worker tail plus browser request timing, add stage-level timing evidence if needed, then remove confirmed redundant transaction/session work without weakening account authorization.

- Issue 2026-07-10 human-review-first-100-unreachable: Human review UI cannot reach queue items beyond the first 100
    Priority: High. Area: Human review UI / Correctness
    Description: `/human` fetches at most 100 priority-sorted rows, then applies search, status filtering, and sorting only to that client-side subset. Free accounts can queue 1,000 items and paid accounts have no item-count cap, so valid items outside the first 100 can be invisible and unsearchable.
    Next step: Make search/status/sort URL-backed server inputs and add stable pagination or load-more navigation with browser coverage proving items beyond the first 100 remain discoverable, selectable, and reviewable.

- Issue 2026-07-07 root-layout-error-telemetry-gap: Root-layout render errors emit no client-event telemetry
    Priority: Low. Area: Observability / Human review UI
    Description: `app/error.tsx` is a route-segment error boundary and, per Next.js App Router semantics, does not catch errors thrown while rendering the root `app/layout.tsx`. Such failures are only caught by an `app/global-error.tsx` boundary, which does not exist, so a root-layout crash emits none of the four client-event signals. The current layout is a thin shell (providers + analytics + ClientEventsInit), so the gap is narrow.
    Next step: Add `app/global-error.tsx` (with its own `<html>`/`<body>` shell) that reuses `classifyReactError` + `emitClientEvent` so root-layout render errors emit the same telemetry; keep `app/error.tsx` for segment-level handling.
    Notes: From PR #23 review (CodeRabbit). Deferred as a new user-facing full-page crash surface beyond the segment-boundary scope of this PR.

- Issue 2026-07-07 human-failure-telemetry-notice-derived: human_action_failed/file_upload_failed derived from the ?error= notice undercounts and can misfire
    Priority: Low. Area: Human review UI / Observability
    Description: `ReviewWorkspace` emits failure telemetry from an effect keyed on the redirect notice with a message-dedup ref. Two items failing with the same code produce an identical notice string, so repeat failures never re-emit (undercount); conversely, loading/sharing a `/human?error=...` URL emits a failure with no action attempt, and each fresh load re-emits. Best-effort MVP tradeoff, not a functional bug.
    Next step: If fidelity later matters, emit from the server-action failure path (or add a per-attempt nonce) rather than deriving from the deduped notice; otherwise document the limitation where the metric is consumed.
    Notes: From review-scope 20260707-170624-c76a6f1e (F8). The browser test currently encodes the no-action emission path as expected.

- Issue 2026-07-07 sentry-capture-disabled-visibility: Silent Sentry capture-disable is not surfaced in the error log payload
    Priority: Low. Area: Observability
    Description: When `runtimeRelease()` is null in production (SENTRY_RELEASE/GITHUB_SHA both unset), `sentryCaptureEnabled()` disables capture; `reportRuntimeFailure` returns `sentry_captured:false` but the emitted structured log omits it, so a misconfigured deploy where errors never reach Sentry can go unnoticed.
    Next step: Add `sentry_captured` to `RuntimeLogEvent`/`SAFE_LOG_KEYS` and include it in `reportRuntimeFailure`'s log line (or emit a one-time startup warning when capture is disabled in production).
    Notes: Deferred from PR #22 CodeRabbit nitpick as a log-schema change beyond the batched remediation scope.

- Issue 2026-07-07 billing-account-lookup-duplication: Billing account-lookup + failure-report block duplicated across checkout and portal flows
    Priority: Low. Area: Maintainability
    Description: The `runTransaction(... billingAccountStatement ...)` + `billingRuntimeFailure(error, ...)` account-lookup pattern is repeated near-verbatim in `createCheckoutSessionForAccount` and `createBillingPortalSessionForAccount` in `src/server/billing.ts`, differing only in operation/message strings; the two copies can drift.
    Next step: Extract a shared `lookupBillingAccountOrFail(...)` helper both flows call, parameterized by operation/message/responseMessage.
    Notes: Deferred from PR #22 CodeRabbit nitpick as a refactor unrelated to the observability PR's purpose.

- Issue 2026-07-07 queue-invariant-500-no-sentry: Non-exception invariant 500s are logged but never captured to Sentry
    Priority: Low. Area: Observability
    Description: `internalQueueError` in `input-queue.ts` returns 500 via `apiErrorResponse`, which has a structured-log path but no Sentry capture path, so invariant-violation 5xx returns never reach Sentry (only exception paths via `reportRuntimeFailure` do). Residual gap, not a regression.
    Next step: Thread `errorId` through non-exception 5xx returns and add a Sentry capture path in `apiErrorResponse` (queue-wide refactor).
    Notes: Deferred from observability-analytics-stack review (review-scope 20260707-164409-d437).

- Issue 2026-07-07 operator-failure-logging-duplication: Operator-actionable failure logging policy duplicated across two implementations
    Priority: Low. Area: Maintainability
    Description: The operator-actionable failure logging policy is implemented twice — `emitOperatorActionableApiFailure` (api-errors.ts) and `emitHumanFileUploadFailure` (human-answer.ts) — because the `/human` server-action path bypasses `apiErrorResponse`. Two implementations of one policy will drift.
    Next step: Extract a shared helper both paths call.
    Notes: Deferred from observability-analytics-stack review (review-scope 20260707-164409-d437).

- Issue 2026-07-06 human-db-test-isolation: Human database tests have isolation failures
    Priority: High. Area: Tests/Database
    Description: The audit found pre-existing isolation failures in `tests/human-answer.test.mjs` and `tests/human-session.test.mjs` that are outside the current billing-retention diff.
    Next step: Reproduce the failures independently, identify shared database state or teardown leakage, and fix the affected tests without weakening assertions.
    Notes: Deferred from the Phase 7 billing-retention PR audit as out of scope.

- Issue 2026-07-06 stripe-webhook-processing-retention: Stuck Stripe webhook processing rows have no retention decision
    Priority: Low. Area: Billing/Cleanup
    Description: Processed Stripe webhook ledger rows now have scheduled retention, but stuck `processing` rows still need an explicit product and replay-safety policy before pruning.
    Next step: Decide whether stale `processing` webhook rows should be retained for investigation, retried, marked failed, or pruned after a separate cutoff.
    Notes: Requires a behavior decision distinct from processed-event replay retention.

- Issue 2026-07-06 local-ci-security-posture-parity: Security posture checks differ between local and CI environments
    Priority: Low. Area: Tests/CI
    Description: The audit found a local-vs-CI environment discrepancy affecting security posture verification confidence.
    Next step: Compare CI and local database/tooling setup for the affected security posture checks and document or align the intentional differences.
    Notes: Deferred as a test infrastructure improvement.

- Issue 2026-07-06 database-test-teardown-consistency: Database test teardown handling is inconsistent
    Priority: Low. Area: Tests/Database
    Description: `tests/foundation.test.mjs` now guards teardown steps, but similar robust teardown handling is not consistently applied across other database test files.
    Next step: Review database test teardown helpers and apply one consistent failure-safe cleanup pattern where needed.
    Notes: Deferred from the Phase 7 billing-retention PR audit to avoid broad test refactoring in this PR.

- Issue 2026-06-30 cloudflare-web-analytics-permission: Cloudflare Web Analytics site creation lacks token permission
    Priority: Medium. Area: Tooling/Deployment
    Description: Web Analytics site creation is still blocked because the deploy token lacks the needed RUM/account-settings write permission.
    Next step: Create Web Analytics with an appropriately scoped Cloudflare token or grant the deploy token the missing permission, then install the runtime analytics token.
    Notes: The Worker bundle-size blocker was resolved on 2026-07-07 by resolving runtime Sentry imports through the Sentry edge entry; Wrangler dry-run now reports 2122.53 KiB gzip.
