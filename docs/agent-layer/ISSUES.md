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
- Issue 2026-11-21 review-error-dismiss-touch-target: Review action error dismiss control is small on phones
    Priority: Low. Area: human review queue
    Description: The dismiss button on the floating error alert measures about 27 by 27 CSS pixels at 360px. It sits over the queue, where taps outside the alert can reach the underlying content.
    Notes: Reported in [PR #318](https://github.com/conn-castle/agent-outbox/pull/318#pullrequestreview-6006396425). The button was the same size before the mobile Undo header change.

- Issue 2026-11-19 sentry-cli-two-majors: Release builds use two major versions of the Sentry CLI
    Priority: Low. Area: dependencies / Sentry
    Description: `pnpm-lock.yaml` resolves `@sentry/cli` 2.58.6 for `@sentry/bundler-plugins` 10.78.0, and `package.json` pins `@sentry/cli` 3.8.0 for `pnpm exec sentry-cli`. `next.config.ts` lets the build plugin create and finalize the Sentry release, and `scripts/worker-deploy.mjs` injects and uploads source maps with the pinned CLI.
    Open question: Should both steps use one CLI version?

- Issue 2026-11-19 otel-sdk-trace-base-deprecated: Lockfile resolves a deprecated OpenTelemetry package version
    Priority: Low. Area: dependencies / Sentry
    Description: `pnpm-lock.yaml` resolves `@opentelemetry/sdk-trace-base` 2.11.0 for `@sentry/node`, `@sentry/node-core` and `@sentry/opentelemetry`, and records it as `deprecated: Use @opentelemetry/sdk-trace package`.
    Open question: Should the deprecated version be replaced before a Sentry update replaces it?

- Issue 2026-11-19 built-worker-not-run-before-release: No pull request check runs the built Worker
    Priority: Medium. Area: CI / Cloudflare Worker
    Description: With `next` 16.4.6 and `@opennextjs/cloudflare` 1.20.8, `make check`, `make browser`, `corepack pnpm run worker:dry-run` and every required check on PR #309 passed, but the built Worker under local `wrangler dev` answered Next-routed requests with 500 (`Unexpected loadManifest(/.next/server/preview-props.json) call!`). The browser suite serves the Node-hosted app (`scripts/node-server.mjs`); the first run of a built Worker is the release workflow's 0% smoke, after production migrations.
    Open question: Where should a built Worker be run before a release?

- Issue 2026-11-16 review-error-one-line-on-touch: Review action errors show one cut-off line with the rest only in a tooltip
    Priority: Low. Area: human review queue
    Description: `.last-action-error` shows one ellipsized line (`max-width: 8.5rem` on phones) and carries the full message only in its `title`. In the mobile browser project a 139-character message showed its first 16 characters.
    Open question: Where should the full message be readable on a touch device?

- Issue 2026-11-16 review-fixture-state-cookie-trimmed: Browser fixture drops answered items past its cookie limit
    Priority: Low. Area: browser test fixture
    Description: `fixtureResolvedItemsCookieValue` keeps only the newest records that fit 3,500 bytes (at most 50) and drops the rest without reporting it. Called directly with 20 answered items it kept 14. A dropped item falls back to its seeded state, and its record's `mutationId`, which is what recognizes a repeated answer, is lost with it.
    Open question: What should the fixture do when its answered-item state no longer fits one cookie?

- Issue 2026-11-16 review-default-sort-ordering-duplicated: The default review ordering is defined in several places
    Priority: Low. Area: Human review / Maintainability
    Description: The default ordering, priority ascending, is defined separately in `src/shared/human-review-view.ts` by the parse fallback in `parseSortRules` (`parseSort(readOne("sort"), "priority")` with `defaultHumanReviewSortDirection`), by the empty-list fallback in `canonicalSortRules` and by `isDefaultHumanReviewOrdering`, and in `src/components/human/ReviewViewControls.tsx` by the Sort panel's Reset button. If they stop agreeing, the parsed default, Reset and the default check can disagree.
    Open question: Which module should own the default ordering.

- Issue 2026-11-16 review-sort-direction-label-fallback: Sort direction labels fall back to time wording for any unnamed key
    Priority: Low. Area: Human review / Maintainability
    Description: `sortDirectionLabel` in `src/components/human/ReviewViewControls.tsx` returns "Newest first" or "Oldest first" for every `HumanReviewSort` key it does not name. Today those are `card_time`, `created_at` and `updated_at`, which are all times; a new key that is not a time would get those labels with no compile error.
    Open question: How a sort key that is not a time should get its direction labels.

- Issue 2026-11-16 review-filter-focus-lost-on-close: Closing a review Filter or Sort panel does not always return focus to its trigger
    Priority: Low. Area: Human review / Accessibility
    Description: Observed in Chromium for `src/components/human/ReviewViewControls.tsx`. Focus returns to the panel's trigger after Escape (both panels), the Sort panel's Done button, and keyboard activation of the Sort scrim. Focus lands on the page body after the Filter panel's Done, close and scrim buttons (keyboard or pointer), after a pointer press on the Sort scrim, and after a press on non-focusable content outside either panel.
    Open question: Whether pointer dismissal should move focus to the trigger.

- Issue 2026-11-16 billing-grace-from-webhook-arrival: Grace deadlines run from webhook arrival, not event creation
    Priority: Low. Area: billing
    Description: Every `graceEndsAt(now)` in `src/server/billing.ts` measures from the time a webhook is processed: the failed-invoice update and each `billingTransitionForSubscription` outcome other than active or scheduled to cancel at period end. Stripe retries deliveries for days, so a late failed invoice, or a late subscription event whose status is canceled, expired, past due, unpaid, incomplete or unrecognized, extends paid access past the configured downgrade grace period measured from the event. Raised in review of PR #297.
    Open question: Should grace be measured from the Stripe event's creation time or from when Agent Outbox learns of it?

- Issue 2026-10-20 supabase-api-role-grants: Named API-role grants exceed the direct-SQL application boundary
    Priority: Medium. Area: operations / database access
    Description: A read-only production catalog audit on 2026-11-15 found that `anon`, `authenticated` and `service_role` hold privileges on `agent_outbox_billing_checkout_attempts`, `agent_outbox_stripe_webhook_events`, `flyway_schema_history` and the sequence `agent_outbox_stripe_webhook_receipt_order_seq`, and EXECUTE on the trigger functions `agent_outbox_clear_stale_review_text` and `agent_outbox_clear_stripe_event_order_on_legacy_update`. `service_role` has BYPASSRLS, and default privileges for objects that `postgres` or `supabase_admin` create in `public` name the three roles. All 19 application tables have forced RLS; `flyway_schema_history` has RLS disabled. On 2026-11-19 the project owner read the production project's Data API settings in the Supabase dashboard: the Data API is not enabled.
    Open question: What privileges should `anon`, `authenticated` and `service_role` hold, given that the application reaches Postgres only through direct SQL?

- Issue 2026-10-19 prod-audit-read-route: Historical audit access lacks a least-privilege procedure
    Priority: Medium. Area: operations / database access
    Description: App-role audit SELECT depends on account-scoped caller, human, or cleanup context; an operator procedure for investigations with unknown account identity is undocumented.
    Open question: Which least-privilege route should operators use for historical audit reads when the account identity is unknown?

- Issue 2026-10-17 review-text-maintenance-scan: Derived-text maintenance scans retained rows after convergence
    Priority: Low. Area: Scheduled maintenance / Performance
    Description: The hourly per-account null-digest query has no supporting partial index, so even a fully derived account requires scanning its retained rows to find no candidates.
    Next step: Measure the candidate query plan and duration at representative retained item counts before changing its indexing.

- Issue 2026-10-17 worker-next-routed-source-map: Next-routed Worker frames stop at OpenNext handler.mjs
    Priority: Medium. Area: Observability / Release build
    Description: OpenNext's server-bundle pass emits no source map, so final Worker frames for Next-routed code resolve to minified handler.mjs rather than application TypeScript.
    Next step: Recheck opennextjs-cloudflare #1352/#1124/#824 for a supported server-bundle source-map option.

- Issue 2026-10-17 dev-tool-advisory-constraints: Advisories remain outside the installed parents' dependency ranges
    Priority: Low. Area: Build and development tooling / Dependencies
    Description: `pnpm audit` reports `adm-zip` (through rclone.js), `katex` (through markdownlint-cli2), and `glob` and `minimatch` (through `@opennextjs/cloudflare` and `@sentry/bundler-plugins`). `pnpm audit --prod` reports `glob` and `minimatch`, because `@sentry/nextjs`, which brings in `@sentry/bundler-plugins`, is under `dependencies`. The Worker bundle contains neither `glob` nor `minimatch`; `wrangler deploy --dry-run --outdir` and the `wrangler versions upload --dry-run --outdir` that `scripts/worker-deploy.mjs` runs write the same `entry.js`. The installed parent versions do not admit the fixed versions.
    Next step: Recheck rclone.js, micromark-extension-math and `@opennextjs/cloudflare` releases for ranges that admit the fixed versions, and decide on the `@sentry/nextjs` 11 major update.
    Notes: rclone.js 0.6.6 requires adm-zip ^0.5.9 (fix >=0.6.1); micromark-extension-math 3.1.0 requires katex ^0.16.0 (fix >=0.18.2); `@opennextjs/cloudflare` 1.20.17 and `@sentry/bundler-plugins` 10.78.0 require glob ^13.0.6 (fix >=14.0.2), and glob 13.0.6 requires minimatch ^10.2.2 (fix >=11.0.1). A later release that is not installed, `@sentry/bundler-plugins` 11.15.0 (with `@sentry/nextjs` 11.15.0), requires glob ^14.0.3, and glob 14.0.6 requires minimatch ^11.0.5; a lockfile-only resolution with `@sentry/nextjs` 11.15.0 clears `pnpm audit --prod` and keeps glob 13.0.6 through `@opennextjs/cloudflare`.

- Issue 2026-10-07 connect-ineffective-style-intents: Caller-connect styles show dropped spacing and heading intent
    Priority: Low. Area: Caller connect / Visual design
    Description: Never-applied declarations were removed from `app/globals.css` during CSS consolidation. Rendering is unchanged, but these effects are missing: dense-surface actions keep a 1.5rem top margin (the dropped rule set 1.1rem); actions inside `.connect-device-decision` keep a 1.5rem top margin (the dropped rule set 0); `.connect-error-card` headings use the generic connect-card heading (`#202426`, 0 0 0.65rem margin; the dropped rule set `#292724` and 0 0 0.5rem).
    Open question: Whether any of these former intents are still the desired design.

- Issue 2026-10-06 copilot-review-project-context: Hosted review lacks a committed project-guidance entry point
    Priority: Low. Area: Review tooling
    Description: Canonical project instructions are tracked under `.agent-layer/instructions`, but generated `AGENTS.md` and `.github/copilot-instructions.md` are gitignored and no committed Copilot review instruction file or review skill exposes them through GitHub's documented paths; repository MCP settings and actual review-context use are unverified.
    Next step: Identify the minimum review context needed and verify a supported integration against available review-session evidence without duplicating canonical rules.
    Notes: Deferred from PR208 Copilot review https://github.com/conn-castle/agent-outbox/pull/208#pullrequestreview-5435689404 and PR217 Copilot review https://github.com/conn-castle/agent-outbox/pull/217#pullrequestreview-5441007257. PR218 Copilot review https://github.com/conn-castle/agent-outbox/pull/218#pullrequestreview-5441851622. PR219 Copilot review https://github.com/conn-castle/agent-outbox/pull/219#pullrequestreview-5442567932. PR220 Copilot review https://github.com/conn-castle/agent-outbox/pull/220#pullrequestreview-5443605544. PR221 Copilot review https://github.com/conn-castle/agent-outbox/pull/221#pullrequestreview-5444854506. PR222 Copilot review https://github.com/conn-castle/agent-outbox/pull/222#pullrequestreview-5445660454. PR223 Copilot review https://github.com/conn-castle/agent-outbox/pull/223#pullrequestreview-5446746917. PR224 Copilot review https://github.com/conn-castle/agent-outbox/pull/224#pullrequestreview-5447680653.

- Issue 2026-10-02 migration-gate-lexing-gaps: Destructive-migration gate misreads some SQL lexical forms
    Priority: Low. Area: Policy gates / Migrations
    Description: `scripts/policy-gates/migration-discipline-scan.mjs` matches regexes over comment-stripped text without a SQL tokenizer. Some destructive operations using `U&"..."` table/column names still pass without the label, and `UESCAPE` identities are not canonicalized. E strings whose embedded semicolon separates the `ALTER TABLE` header from a later implicit action (`ALTER TABLE t ALTER note SET DEFAULT E'prefix;it\'s', DROP x;`) can bypass detection. Dollar-quoted text and string literals that contain `ALTER TABLE ... DROP` can falsely block additive statements.
    Next step: Add fixtures for any of these forms when a real migration uses them.

- Issue 2026-09-29 review-ineffective-style-intents: Review styles show dropped intent and stale palette literals
    Priority: Low. Area: Human review / Visual design
    Description: Declarations that never applied were removed during CSS consolidation, leaving: pressed context links still scaling under `prefers-reduced-motion: reduce`; the filter popover close button using accent-dark rather than muted; and a 0 min-height detail loading panel (intended 8rem). Old-palette literals (`#f3efe6` page background, `#fffdf8`/`rgba(255, 253, 248, …)` popovers, `#202526` anatomy colors) also no longer match the effective tokens.
    Open question: Which of these former intents are still the desired design.

- Issue 2026-07-11 human-review-search-seq-scan: Human review search filters cannot use indexes at scale
    Priority: Low. Area: Human review / Performance
    Description: `humanReviewListStatement` (src/server/human-review.ts) filters with leading-wildcard `ilike` over coalesced derived text / tag-stripped HTML expressions plus `caller_item_id`/`display_name`, so search scans all of an account's rows; queries are account-scoped via the indexed `account_id`, so this is only a concern for accounts with very large item counts.
    Next step: If per-account item counts grow enough for search latency to matter, add `pg_trgm` expression GIN indexes matching the exact `coalesce(i.<field>_text, btrim(regexp_replace(regexp_replace(i.<field>_html, '<[^>]*>', ' ', 'g'), '[<JAVASCRIPT_WHITESPACE_CLASS>]+', ' ', 'g')))` expressions from `reviewSearchTextSql` for title/subtitle/summary (including its literal whitespace class), rather than the bare derived columns via Flyway online-index migrations.
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
