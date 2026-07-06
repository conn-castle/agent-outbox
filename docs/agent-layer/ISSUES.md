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
    Description: Tracked `open-next.config.ts`, `wrangler.jsonc`, and `worker/entry.mjs` cannot be fully verified from the pinned package install because OpenNext Cloudflare and Wrangler are intentionally outside the normal app toolchain; Wrangler auth works locally, but `deployments status --name agent-outbox` reported no Worker under the cached account on 2026-07-06.
    Next step: In Phase 8 deployment/release work, pin the platform tools, create or verify the intended Cloudflare account/Worker/route/custom-domain mapping, apply runtime secrets, and add a dedicated Cloudflare/OpenNext verification command outside `make check`.
    Notes: Owner accepted Phase 8 deferral on 2026-07-06; `app.agent-outbox.dev` also had no public DNS answer during the same check.
