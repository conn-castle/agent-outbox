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
    Description: SSM under `/agent-outbox/` has Stripe account metadata but still lacks the app billing parameter names needed for checkout, webhooks, monthly/yearly paid prices, and portal configuration.
    Next step: Store approved test/live Stripe billing parameters, including `STRIPE_PAID_MONTHLY_PRICE_ID` and `STRIPE_PAID_YEARLY_PRICE_ID`, in the canonical runtime secret store and matching SSM paths without exposing secret values.
    Notes: Rechecked by name-only SSM inspection on 2026-07-06; do not mark Phase 7 complete until this recovery gap is closed or explicitly waived.

- Issue 2026-07-05 stripe-webhook-ledger-retention: Stripe webhook idempotency ledger has no retention policy
    Priority: Low. Area: Billing/Cleanup
    Description: `agent_outbox_stripe_webhook_events` stores processed webhook ids for replay safety but has no agreed retention window or scheduled prune path, so rows can grow unbounded over time.
    Next step: Choose a retention period and add a migration, delete grant, index, cleanup statement, scheduled cleanup wiring, and verification for pruning old processed webhook ledger rows.
    Notes: Deferred from PR #18 review because selecting retention policy and expanding cleanup behavior is outside the approved package 1 gate.

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare/OpenNext deploy path lacks pinned verification
    Priority: Medium. Area: Tooling/Deployment
    Description: Tracked `open-next.config.ts`, `wrangler.jsonc`, and `worker/entry.mjs` cannot be fully verified from the pinned package install because OpenNext Cloudflare and Wrangler are intentionally outside the normal app toolchain; Wrangler auth works locally, but `deployments status --name agent-outbox` reported no Worker under the cached account on 2026-07-06.
    Next step: In deployment/release work, pin the platform tools, verify the intended Cloudflare account/Worker/route mapping, and add a dedicated Cloudflare/OpenNext verification command outside `make check`.
    Notes: Matches the existing app-CI/platform split decision; not fixed in Phase 7 PR 2 because creating/deploying a Worker is outside the approved scope.
