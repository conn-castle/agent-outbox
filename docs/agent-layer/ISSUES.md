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
- Describe the problem without choosing a solution or listing options.
- Use `Next step` only when the action is useful regardless of the eventual solution. Otherwise, use `Open question: <decision needed>`.

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
- Issue 2026-09-29 human-answer-payload-decoding: Answer validation reads persisted popup bounds loosely
    Priority: Medium. Area: Human answers / Data integrity
    Description: `numberField`, `stringField`, and `acceptedMimeTypes` in `src/server/human-answer.ts` treat a malformed persisted `popup_payload` field (for example `min_length: "5"` or `max_selected: "2"`) as absent, so answer-time bounds are silently not enforced. The review page now rejects such payloads strictly in `src/server/human-review.ts`, which makes this mostly unreachable through the UI.
    Next step: Make answer validation fail loudly on malformed persisted popup payload fields, consistent with the review-page decoder.

- Issue 2026-09-29 docs-ui-topbar-contrast: API UI docs page renders the wordmark dark on the dark top bar
    Priority: Medium. Area: API documentation / Visual design
    Description: On `/docs/api/ui` the embedded row-anatomy preview carries `.human-workspace`, so the `.shell:has(.human-workspace)` topbar rules in `app/globals.css` apply; the "Agent" wordmark becomes near-invisible and the nav links and call-to-action are dimmed on the dark API-docs top bar. `/docs/api` is unaffected.
    Open question: Whether to scope the workspace topbar rules or stop marking embedded anatomy previews as `.human-workspace`.

- Issue 2026-09-29 review-ineffective-style-intents: Review styles show dropped intent and stale palette literals
    Priority: Low. Area: Human review / Visual design
    Description: Declarations that never applied were removed during CSS consolidation, leaving: the filter count badge as dark text on the accent-dark background (intended white); pressed context links still scaling under `prefers-reduced-motion: reduce`; the filter popover close button using accent-dark rather than muted; and a 0 min-height detail loading panel (intended 8rem). Old-palette literals (`#f3efe6` page background, `#fffdf8`/`rgba(255, 253, 248, …)` popovers, `#202526` anatomy colors) also no longer match the effective tokens.
    Open question: Which of these former intents are still the desired design.

- Issue 2026-09-28 review-search-entity-text: Review search and title sort use entity-encoded text
    Priority: Low. Area: Human review / Search
    Description: Production search and title sort in `src/server/human-review.ts` strip tags but do not decode character references, so searching `AT&T` misses a title stored as `AT&amp;T` and titles sort by encoded text.
    Open question: Whether search and sort should operate on decoded text, which requires server-side decoding or stored plain-text columns.

- Issue 2026-08-17 legacy-color-transition: Existing arbitrary persisted colors lack a transition policy
    Priority: High. Area: Human review / Data compatibility
    Description: The former runtime accepted safe CSS colors, the current API accepts only named colors, and unrestricted legacy database values now silently fall back during rendering.
    Next step: Inventory persisted values and establish an explicit migration or compatibility path before release.

- Issue 2026-07-11 human-review-search-seq-scan: Human review search filters cannot use indexes at scale
    Priority: Low. Area: Human review / Performance
    Description: `humanReviewListStatementWithLimit` (src/server/human-review.ts) filters with leading-wildcard `ilike` over `regexp_replace`-stripped HTML columns plus `caller_item_id`/`display_name`, so search scans all of an account's rows; queries are account-scoped via the indexed `account_id`, so this is only a concern for accounts with very large item counts.
    Next step: If per-account item counts grow enough for search latency to matter, add `pg_trgm` expression GIN indexes matching the exact `regexp_replace` expressions (or pre-stripped plain-text columns) via Flyway online-index migrations.
    Notes: Raised by gemini-code-assist review on PR #28.

- Issue 2026-07-11 stripe-webhook-status-contract-migration: Remove the transitional Stripe webhook status column after rollout
    Priority: Low. Area: Billing / Migrations
    Description: The expand migration retains `processing_status` with a `processed` default for compatibility with writers that name it; releases through v0.4.7 still write it explicitly, so the column cannot be dropped until a release whose writer omits it is live and is the rollback target.
    Next step: Once a release containing the column-free `insertStripeWebhookEventStatement` is live and is the healthy rollback target, generate and review a forward contract migration that drops `processing_status`, replaces `agent_outbox_prune_stripe_webhook_events` in the same migration (its body filters on `processing_status`, and plpgsql bodies are not validated at column-drop time), and updates the table comment's rollout-compatible status wording.

- Issue 2026-07-10 billing-checkout-latency: Authenticated Stripe checkout latency is unmeasured after the transaction fix
    Priority: Medium. Area: Billing / Performance
    Description: Checkout's three sequential fresh database transactions were consolidated into one transaction locally, but the previously observed 5–10 second deployed latency has not been re-measured, so Stripe API and hosted page-load time remain unquantified.
    Next step: After the next production deploy, capture one authenticated checkout with Worker tail and browser request timing; add stage-level timing only if the residual delay remains material.
    Notes: Blocked on a production deploy (explicit trigger); restored after review found the verification obligation was dropped without a recorded measurement.
