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
- Issue 2026-07-05 stripe-billing-ssm-parameters-missing: Stripe billing runtime parameters are not recoverable from SSM
    Priority: Medium. Area: Ops/Secrets
    Description: SSM under `/agent-outbox/` has Stripe account metadata but not the app billing parameters needed for checkout, webhooks, and portal configuration.
    Next step: During Phase 7 provider verification, store the approved test/live Stripe billing parameters in the canonical runtime secret store and matching SSM paths without exposing secret values.
    Notes: Local PR #18 verification used Stripe CLI-created test-mode resources and process-local secrets only.

- Issue 2026-07-05 stripe-webhook-ledger-retention: Stripe webhook idempotency ledger has no retention policy
    Priority: Low. Area: Billing/Cleanup
    Description: `agent_outbox_stripe_webhook_events` stores processed webhook ids for replay safety but has no agreed retention window or scheduled prune path, so rows can grow unbounded over time.
    Next step: Choose a retention period and add a migration, delete grant, index, cleanup statement, scheduled cleanup wiring, and verification for pruning old processed webhook ledger rows.
    Notes: Deferred from PR #18 review because selecting retention policy and expanding cleanup behavior is outside the approved package 1 gate.

- Issue 2026-07-04 human-signup-browser-fixture-timeout: Browser signup fixture hangs in Playwright gate
    Priority: Medium. Area: Browser tests/Human auth fixture
    Description: `make browser` reached tests and the caller connect/rotate/revoke flows passed, but `tests/browser/human-ui.spec.ts` first-time self-serve signup failed in both desktop and mobile by staying on `/sign-up` or aborting navigation to `/sign-up` until the 30s test timeout.
    Next step: Diagnose the human signup fixture navigation under Next dev fixture mode and stabilize the test or fixture without weakening the protected-route security policy.
    Notes: Observed during `hosted-security-fail-closed-cloudflare-ip` verification on 2026-07-04; no labeled browser Docker resources remained after the run.

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare/OpenNext deploy path lacks pinned verification
    Priority: Medium. Area: Tooling/Deployment
    Description: Tracked `open-next.config.ts`, `wrangler.jsonc`, and `worker/entry.mjs` cannot be fully verified from the pinned package install because OpenNext Cloudflare and Wrangler are intentionally outside the normal app toolchain.
    Next step: In deployment/release work, pin the platform tools and add a dedicated Cloudflare/OpenNext verification command outside `make check`.
    Notes: Matches the existing app-CI/platform split decision; not fixed in improve-codebase to avoid expanding package/deployment scope.

- Issue 2026-06-30 undocumented-phase7-error-codes: ApiErrorCode lists codes absent from errors.md catalog
    Priority: Low. Area: Docs/API contract
    Description: `retention_limit_exceeded` and `billing_grace_expired` are in the `ApiErrorCode` union and wired into limit definitions in `limits.ts`, but are not in the `docs/spec/errors.md` catalog. They are Phase 7 (billing/retention) forward declarations not yet emittable to callers, so the type/limits surface and the public error catalog have drifted.
    Next step: When Phase 7 builds billing/retention, add these codes to `errors.md`; until then keep the divergence intentional and tracked here.

- Issue 2026-06-30 output-read-all-single-row-poison-pill: read-all page can fail on one unmaterializable row
    Priority: Low. Area: Output queue
    Description: In `src/server/output-queue.ts`, `read-all` returns `{ok:false}`/`temporary_unavailable` for the whole page if any single row fails materialization, which would block a page and everything after it. Currently unreachable until file-upload results become creatable in Phase 7.
    Next step: When file-upload results become creatable, degrade a single unmaterializable read-all row rather than failing the whole page.
    Notes: Surfaced by Phase 4 audit review-scope; split from `output-read-path-hardening` after the output `check` query was changed to metadata-only.
