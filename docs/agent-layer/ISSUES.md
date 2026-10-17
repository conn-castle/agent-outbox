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
- Issue 2026-10-17 review-text-maintenance-scan: Derived-text maintenance scans retained rows after convergence
    Priority: Low. Area: Scheduled maintenance / Performance
    Description: The hourly per-account null-digest query has no supporting partial index, so even a fully derived account requires scanning its retained rows to find no candidates.
    Next step: Measure the candidate query plan and duration at representative retained item counts before changing its indexing.

- Issue 2026-10-17 worker-source-map-chain: Worker frames reference source maps for different generated coordinates
    Priority: Medium. Area: Observability / Release build
    Description: Release builds upload Next chunk maps, then OpenNext and Wrangler combine those chunks into entry.js. Multiple chunk debug IDs collapse onto that filename, selecting a chunk map for final-bundle coordinates and producing invalid source-map locations. OpenNext also omits the intermediate server map needed to reach application TypeScript.
    Open question: Which release-build mapping approach should provide correct source lines while keeping upstream maintenance acceptable?
    Notes: Reproduced with the installed SDK and local sentry-cli resolution; no production change. OpenNext's missing server-map support is tracked upstream at https://github.com/opennextjs/opennextjs-cloudflare/issues/1352.

- Issue 2026-10-17 dev-tool-advisory-constraints: Development-tool advisories remain outside upstream dependency ranges
    Priority: Low. Area: Development tooling / Dependencies
    Description: The remaining audit paths run through rclone.js (`adm-zip`) and markdownlint-cli2 (`braces`, `smol-toml`, and `katex`); the production dependency audit is clear. Current parent releases do not admit all fixed versions.
    Next step: Recheck upstream releases for a supported dependency graph that clears these findings.
    Notes: rclone.js 0.6.6 requires adm-zip ^0.5.9 (fix >=0.6.1); braces has no patched version; markdownlint-cli2 0.23.3 pins smol-toml 1.8.0 (fix >=1.9.0), and its math extension requires katex ^0.16.0 (fix >=0.18.2).

- Issue 2026-10-17 public-header-mobile-clipping: Public header controls clip on narrow screens
    Priority: Medium. Area: Public site / Navigation
    Description: On `/docs/api/ui` at 360, 393, and 430px, the Get started control extends to about 486px and is clipped by the viewport. A two-row experiment avoided clipping but covered the sticky docs navigation and anchored headings.
    Open question: Which compact header presentation should preserve navigation and touch targets without clipping or covering sticky sections?

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
