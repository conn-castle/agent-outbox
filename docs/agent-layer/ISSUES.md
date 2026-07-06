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
- Issue 2026-07-06 stripe-webhook-online-index-migration: Stripe webhook retention index needs nontransactional Flyway pattern
    Priority: Medium. Area: Database/Deployment
    Description: `db/migrations/V20260706193000__stripe_webhook_event_retention.sql` adds a retention index for a live table; building it safely may require an online/concurrent index outside Flyway's normal transaction.
    Next step: In Phase 8 deployment/release work, define the repository pattern for nontransactional or online-index Flyway migrations and apply it to the Stripe webhook retention index before production rollout.
    Notes: Deferred from CodeRabbit review comment 3532409084 because this PR should not establish the broader live-table migration policy.

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

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare/OpenNext deploy path lacks pinned verification
    Priority: Medium. Area: Tooling/Deployment
    Description: OpenNext/Workers deploy cannot be fully verified from the pinned package install because platform tools are outside the normal app toolchain; release must also prove Flyway migrations run before runtime or scheduled cleanup.
    Next step: In Phase 8 deployment/release work, pin platform tools, verify the intended Cloudflare account/Worker/route/custom-domain mapping, apply runtime secrets, ensure Flyway migrations precede cleanup execution, and add dedicated verification outside `make check`.
    Notes: Owner accepted Phase 8 deferral on 2026-07-06; Wrangler auth worked locally, `deployments status --name agent-outbox` found no Worker, `app.agent-outbox.dev` had no public DNS answer, and CodeRabbit body 4640189856 is deferred here.
