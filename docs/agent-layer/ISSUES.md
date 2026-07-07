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
- Issue 2026-07-07 client-events-origin-gate-prod-verify: /api/client-events origin gate may silently drop all events in production
    Priority: Low. Area: Observability/Reliability
    Description: `handleClientEventsRequest` drops events when `origin !== new URL(request.url).origin` and always returns 204, so if the deployed OpenNext/Cloudflare `request.url` origin does not match the browser `Origin` (proxy/rewrite), every event is dropped with no surfaced signal — a latent prod no-op that all same-origin local/browser tests pass through. Unverified at the deployed runtime (opposite failure mode from the deliberately-accepted forgeable-Origin direction).
    Next step: At Worker deploy, verify `new URL(request.url).origin` equals the public origin for a real same-origin POST; if not, gate on a configured expected origin and low-rate-log `origin_mismatch` drops.
    Notes: Verify alongside `client-events-ratelimit-activation` at Worker deploy. From review-scope 20260707-170624-c76a6f1e (F9).

- Issue 2026-07-07 human-failure-telemetry-notice-derived: human_action_failed/file_upload_failed derived from the ?error= notice undercounts and can misfire
    Priority: Low. Area: Human review UI / Observability
    Description: `ReviewWorkspace` emits failure telemetry from an effect keyed on the redirect notice with a message-dedup ref. Two items failing with the same code produce an identical notice string, so repeat failures never re-emit (undercount); conversely, loading/sharing a `/human?error=...` URL emits a failure with no action attempt, and each fresh load re-emits. Best-effort MVP tradeoff, not a functional bug.
    Next step: If fidelity later matters, emit from the server-action failure path (or add a per-attempt nonce) rather than deriving from the deduped notice; otherwise document the limitation where the metric is consumed.
    Notes: From review-scope 20260707-170624-c76a6f1e (F8). The browser test currently encodes the no-action emission path as expected.

- Issue 2026-07-07 client-events-ratelimit-activation: Prepared rate limit for /api/client-events is not active
    Priority: Medium. Area: Ops/Security
    Description: The public, unauthenticated `/api/client-events` endpoint has no active edge rate limit. Per the documented incident-controls-only posture (`cloudflare.md`), the Cloudflare rate-limit rule is being prepared as version-controlled config + runbook (option B) but is intentionally NOT activated. The same-origin gate is forgeable, so an active limit is needed before real public traffic to bound log-ingestion cost and alert noise.
    Next step: At Cloudflare Worker deploy (ROADMAP Phase 8, "Create or verify the Cloudflare Worker" task), mint a Zone-WAF-Write token, apply the prepared rate-limit ruleset (declarative PUT), and verify by API read-back.
    Notes: Blocked by Worker deploy/rate-limit activation sequencing, not bundle size. Cloudflare Free plan allows a path-only rule; the path+POST predicate needs Pro or higher — confirm the zone plan at activation.

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

- Issue 2026-07-05 stripe-billing-ssm-parameters-missing: Stripe billing runtime parameters are not recoverable from SSM
    Priority: Medium. Area: Ops/Secrets
    Description: SSM under `/agent-outbox/` now has the live Stripe setup key, product, monthly/yearly price, portal configuration, webhook endpoint, and webhook secret recovery paths, but the app runtime checkout/portal Stripe key is intentionally not installed yet.
    Next step: In Phase 8, create the separate restricted Stripe runtime key for Checkout and Billing Portal sessions, store it in the production `stripe-secret-key` SSM path, and apply it to Cloudflare runtime secrets.
    Notes: Updated on 2026-07-06 after live setup. Owner accepted using a setup-only Stripe key for object creation and deferring the separate checkout/portal runtime key plus Cloudflare runtime secret installation to Phase 8.

- Issue 2026-06-30 cloudflare-web-analytics-permission: Cloudflare Web Analytics site creation lacks token permission
    Priority: Medium. Area: Tooling/Deployment
    Description: Web Analytics site creation is still blocked because the deploy token lacks the needed RUM/account-settings write permission.
    Next step: Create Web Analytics with an appropriately scoped Cloudflare token or grant the deploy token the missing permission, then install the runtime analytics token.
    Notes: The Worker bundle-size blocker was resolved on 2026-07-07 by resolving runtime Sentry imports through the Sentry edge entry; Wrangler dry-run now reports 2122.53 KiB gzip.
