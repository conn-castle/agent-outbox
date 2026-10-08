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
- Issue 2026-10-07 connect-ineffective-style-intents: Caller-connect styles show dropped spacing and heading intent
    Priority: Low. Area: Caller connect / Visual design
    Description: Never-applied declarations were removed from `app/globals.css` during CSS consolidation. Rendering is unchanged, but these effects are missing: dense-surface actions keep a 1.5rem top margin (the dropped rule set 1.1rem); actions inside `.connect-device-decision` keep a 1.5rem top margin (the dropped rule set 0); `.connect-error-card` headings use the generic connect-card heading (`#202426`, 0 0 0.65rem margin; the dropped rule set `#292724` and 0 0 0.5rem).
    Open question: Whether any of these former intents are still the desired design.

- Issue 2026-10-07 date-picker-invalid-mode-throws: Invalid date_picker mode with min and max values throws instead of returning 422
    Priority: Medium. Area: Input validation
    Description: In `parseDatePickerPopup` (`src/server/input-schema.ts`), an unsupported `mode` combined with string `min_value` and `max_value` reaches `compareDatePickerValues`, which falls through to `compareUtcDateTimeValues` and throws "UTC datetime values must be validated before compare", so the send/replace request fails with an exception instead of a field-level validation error.
    Next step: Add a public-boundary test through `parseInputSubmission` for this input, then make the range comparison run only for a valid mode.

- Issue 2026-10-07 human-action-duration-zero: Human answer/undo transaction failure reports log near-zero durations
    Priority: Low. Area: Observability / Human review
    Description: `runHumanActionMutation` in `app/human/actions.ts` calls `humanAnswerTransactionFailure` without `startedAtMs` and `humanAnswerUndoTransactionFailure` (which always starts its clock internally), so their `duration_ms` measures only the reporter call, not the failed transaction.
    Next step: Capture the start time before the transaction and pass it to both reporters.

- Issue 2026-10-06 copilot-review-project-context: Hosted review lacks a committed project-guidance entry point
    Priority: Low. Area: Review tooling
    Description: Canonical project instructions are tracked under `.agent-layer/instructions`, but generated `AGENTS.md` and `.github/copilot-instructions.md` are gitignored and no committed Copilot review instruction file or review skill exposes them through GitHub's documented paths; repository MCP settings and actual review-context use are unverified.
    Next step: Identify the minimum review context needed and verify a supported integration against available review-session evidence without duplicating canonical rules.
    Notes: Deferred from PR208 Copilot review https://github.com/conn-castle/agent-outbox/pull/208#pullrequestreview-5435689404 and PR217 Copilot review https://github.com/conn-castle/agent-outbox/pull/217#pullrequestreview-5441007257. PR218 Copilot review https://github.com/conn-castle/agent-outbox/pull/218#pullrequestreview-5441851622. PR219 Copilot review https://github.com/conn-castle/agent-outbox/pull/219#pullrequestreview-5442567932. PR220 Copilot review https://github.com/conn-castle/agent-outbox/pull/220#pullrequestreview-5443605544. PR221 Copilot review https://github.com/conn-castle/agent-outbox/pull/221#pullrequestreview-5444854506. PR222 Copilot review https://github.com/conn-castle/agent-outbox/pull/222#pullrequestreview-5445660454. PR223 Copilot review https://github.com/conn-castle/agent-outbox/pull/223#pullrequestreview-5446746917. PR224 Copilot review https://github.com/conn-castle/agent-outbox/pull/224#pullrequestreview-5447680653.

- Issue 2026-10-04 stripe-duplicate-subscriptions: One account can hold several live Stripe subscriptions
    Priority: Medium. Area: Billing
    Description: Checkout (`src/server/billing.ts`) is refused only when the account is already live, so completing two Checkout sessions opened while free creates two subscriptions (and, with no stored customer, two Stripe customers). Subscription webhooks match by subscription id, customer id, or metadata account id and overwrite the stored subscription, so the account follows whichever subscription last emitted an event; cancelling one can start downgrade grace and paid-data cleanup while the other keeps charging, and the Billing Portal shows only the stored customer.
    Open question: Whether to prevent a second live subscription before Checkout, ignore and report events for non-stored subscriptions, or both.

- Issue 2026-10-02 cli-device-expiry-test-race: CLI device-expiry test races under `go test -race`
    Priority: Low. Area: CLI tests
    Description: `TestCallerConnectDevicePollRequestStopsAtDeviceExpiry` (`cli/internal/command/controlplane_test.go`) increments `polls` in the HTTP handler goroutine and reads it from the test goroutine after the client cancels the in-flight poll, so `-race` reports a data race. CI runs Go tests without `-race`, so it does not fail there.
    Next step: Synchronize the handler counter (for example, with `sync/atomic`) before adding `-race` to any Go gate.

- Issue 2026-10-02 migration-gate-lexing-gaps: Destructive-migration gate misreads some SQL lexical forms
    Priority: Low. Area: Policy gates / Migrations
    Description: `scripts/policy-gates/migration-discipline-scan.mjs` matches regexes over comment-stripped text without a SQL tokenizer. These destructive statements pass without the label: `E'...\'...'` strings that hide a later `DROP x` or `SET NOT NULL` action, quoted identifiers with no surrounding whitespace (`DROP"x"`, `ALTER TABLE"t"`), `U&"..."` table names, and `ALTER FOREIGN TABLE`. Dollar-quoted text and string literals that contain `ALTER TABLE ... DROP` can falsely block additive statements.
    Next step: Add fixtures for any of these forms when a real migration uses them.

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
    Description: Releases v0.1.0–v0.1.2 accepted safe CSS colors (hex, `rgb()`/`hsl()`, extra names) and the current API accepts only named colors. Legacy values silently fall back during rendering, and they fail the canonical shape check (`src/server/canonical-input.ts`), so `/api/input/read` and `/api/output/{id}/read` return 503 for such items and one such row fails the whole `/api/output/read-all` page.
    Next step: Inventory persisted values and establish an explicit migration or compatibility path before release.

- Issue 2026-07-11 human-review-search-seq-scan: Human review search filters cannot use indexes at scale
    Priority: Low. Area: Human review / Performance
    Description: `humanReviewListStatement` (src/server/human-review.ts) filters with leading-wildcard `ilike` over `regexp_replace`-stripped HTML columns plus `caller_item_id`/`display_name`, so search scans all of an account's rows; queries are account-scoped via the indexed `account_id`, so this is only a concern for accounts with very large item counts.
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
