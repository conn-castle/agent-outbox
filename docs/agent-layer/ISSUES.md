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

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare Worker deploy is blocked by account limits
    Priority: High. Area: Tooling/Deployment
    Description: Cloudflare rejected the Worker upload because the built script is about 4.6 MiB gzip and the current account limit is 3 MB; investigation found the server handler is dominated by repeated `@sentry/nextjs`/`@sentry/node`/OpenTelemetry chunks plus Next/OpenNext runtime, not app logic.
    Next step: With Sentry retained, choose whether to reduce how Sentry is bundled, split verified route bundles, replace the Next/OpenNext runtime with a smaller Worker-native surface, or use a Cloudflare Workers Paid/limit increase.
    Notes: Production Flyway schema was reset/replayed to 12 migrations and validated on 2026-07-07. No Worker deployment or secrets exist after the failed upload; Web Analytics site creation is also blocked by the deploy token lacking the needed RUM/account-settings write permission. Bundle investigation report: `.agent-layer/tmp/debug-issue.20260707-152452-dc2fc3.report.md`.
