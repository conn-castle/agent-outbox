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
- Issue 2026-08-17 row-popup-action-selection: Popup-bearing row actions lose their selected action
    Priority: High. Area: Human review / Actions
    Description: Selecting a row action such as `Request changes` opens Details without its composer active, forcing the person to locate and select the same action again.
    Next step: Preserve action identity when routing into Details and open the selected action's popup directly.

- Issue 2026-08-17 queue-priority-treatment: Queue priority lacks a meaningful visible treatment
    Priority: Medium. Area: Human review / Visual design
    Description: Priority is conveyed mainly through screen-reader text and a very small background-mix change that shares the caller-accent channel, so Low, Normal, High, and Urgent are not visibly distinct as documented.
    Next step: Implement and verify the canonical visible priority treatment without conflating it with caller accent.

- Issue 2026-08-17 civil-date-timezone: Civil-date responses invent timezone metadata
    Priority: High. Area: Human review / Response data
    Description: Date mode always displays and submits the browser timezone, and the human form/server path requires one, although the public date-response contract permits null.
    Next step: Align date-mode display, submission, and server validation with the canonical nullable timezone contract.

- Issue 2026-08-17 queue-count-scope: Page-scoped counts are presented as queue totals
    Priority: Medium. Area: Human review / Pagination
    Description: Pagination can present values such as `100+ of 100 remaining`, and later pages expose only local row counts rather than queue totals.
    Next step: Audit available count semantics and ensure every displayed label accurately communicates its scope.

- Issue 2026-08-17 summary-html-margins: Supported paragraph markup changes summary clamp geometry
    Priority: Medium. Area: Human review / Content rendering
    Description: Allowed `<p>` elements retain browser-default margins inside `.row-proposal`, making equivalent text consume different vertical space solely because of markup.
    Next step: Normalize supported rich-text block spacing within the canonical summary layout.

- Issue 2026-08-17 sort-label-drift: One sort state has inconsistent labels
    Priority: Low. Area: Human review / Controls
    Description: The selector labels the canonical recent sort as `Recent`, while the compact tools summary calls the same value `Newest`.
    Next step: Source both labels from one canonical presentation definition.

- Issue 2026-08-17 html-plain-text-drift: HTML-to-text conversions disagree
    Priority: Medium. Area: Human review / Accessibility
    Description: Three separate converters produce different plain text, allowing accessible row labels to expose entities such as `&amp;` literally while answer notices decode them.
    Next step: Consolidate plain-text derivation and verify consistent entity handling at every consumer.

- Issue 2026-08-17 search-placeholder-domain: Search copy invents a customer field
    Priority: Low. Area: Human review / Search
    Description: The placeholder names `customer`, but the API exposes callers and caller item IDs, and production search covers more fields than the placeholder communicates.
    Next step: Make the placeholder describe the actual searchable concepts without introducing an unsupported domain field.

- Issue 2026-08-17 review-row-invalid-nesting: Review rows render invalid span/div nesting
    Priority: Medium. Area: Human review / Markup
    Description: `SafeHtml` always emits a div, including when used inside `span.row-link-heading` and `span.row-heading-context`.
    Next step: Make the safe-HTML wrapper valid for each host context and verify the rendered DOM structure.

- Issue 2026-08-17 anatomy-table-duplication: Documentation authors a second row-anatomy source
    Priority: High. Area: API documentation / Single source of truth
    Description: The live table derives from `REVIEW_ROW_ANATOMY_PARTS`, while adjacent Markdown repeats the slots under inconsistent labels such as `Row type` versus `Classification chip`.
    Next step: Remove the independently authored anatomy inventory so all presentations derive from the canonical component data.

- Issue 2026-08-17 palette-drift: The tracked palette duplicates canonical colors without a parity check
    Priority: High. Area: Brand system / Single source of truth
    Description: The static palette page manually repeats supported color names and hex values from `input-schema-rules.ts`, allowing the public reference and API contract to drift.
    Next step: Derive the tracked palette from canonical color data or add an enforceable parity check.

- Issue 2026-08-17 progress-ring-fallback-color: Progress-ring fallback duplicates the canonical blue hex
    Priority: Low. Area: Human review / Visual design
    Description: The uncolored progress ring hardcodes `#326b91`, duplicating the palette mapping and assigning a caller-palette color when the caller supplied none.
    Next step: Replace the copied literal with the appropriate canonical product-owned token.

- Issue 2026-08-17 review-css-override-layer: Review styling has conflicting duplicate definitions
    Priority: High. Area: Human review / CSS architecture
    Description: Multiple `.human-workspace` token blocks and repeated queue selectors define competing values, leaving an appended override layer that silently wins and obscures the effective design.
    Next step: Consolidate the accepted appearance into one canonical style definition per token and component state.

- Issue 2026-08-17 legacy-color-transition: Existing arbitrary persisted colors lack a transition policy
    Priority: High. Area: Human review / Data compatibility
    Description: The former runtime accepted safe CSS colors, the current API accepts only named colors, and unrestricted legacy database values now silently fall back during rendering.
    Next step: Inventory persisted values and establish an explicit migration or compatibility path before release.

- Issue 2026-08-17 persisted-review-payload-decoding: Malformed persisted payloads silently become plausible UI
    Priority: High. Area: Human review / Data integrity
    Description: Database mapping converts invalid action and visual strings, numbers, and modes into empty values, zeroes, or `date`, concealing bad persisted data.
    Next step: Make invalid persisted payloads fail through an actionable, observable error path.

- Issue 2026-08-17 raw-doc-relative-links: Canonical Markdown contains broken relative links
    Priority: Medium. Area: API documentation
    Description: The web renderer rewrites links to generated reference and OpenAPI routes, but the canonical Markdown targets files that do not exist at those relative paths when read directly.
    Next step: Make canonical source links valid in raw Markdown as well as in the rendered docs site.

- Issue 2026-08-17 api-doc-manifest-duplication: Documentation route metadata is repeated
    Priority: Medium. Area: API documentation / Single source of truth
    Description: Guide slugs, source paths, navigation labels, rewrite mappings, static route params, and route expectations are maintained in separate lists that can drift.
    Next step: Identify the canonical documentation manifest and derive or validate all route consumers against it.

- Issue 2026-08-17 fixture-search-parity: Design-fixture search differs from production
    Priority: Medium. Area: Human review / Design fixture
    Description: Searching for a visible row type such as `CI task` returns no fixture result because fixture matching omits `rowType.display`, while production search includes it.
    Next step: Align fixture search fields with the production search contract.

- Issue 2026-08-17 fixture-sort-behavior: The design fixture's visible Sort control has no effect
    Priority: Medium. Area: Human review / Design fixture
    Description: The authored initial order is always preserved after a person explicitly selects a sort option, so the interactive fixture demonstrates behavior the product does not have.
    Next step: Preserve the intended initial mock order while honoring subsequent explicit sort selections.

- Issue 2026-08-17 overflow-derived-state: Overflow availability is stored twice
    Priority: Low. Area: Human review / Data model
    Description: `hasOverflowActions` duplicates information already derivable from `bulkActions[].overflow` across the DTO, production mapper, fixture mappers, and UI.
    Next step: Remove or enforce parity for the redundant state so overflow availability has one source of truth.

- Issue 2026-08-17 link-url-policy-drift: Link-button URL validation has two policies
    Priority: Low. Area: Human review / Validation
    Description: Canonical input permits HTTP(S), while a UI helper separately permits `mailto:`, creating a latent policy mismatch even though canonical data currently prevents it.
    Next step: Make the UI consume the canonical URL policy instead of maintaining a second allowlist.

- Issue 2026-08-17 dead-review-doc-helpers: Committed review and docs helpers are unused
    Priority: Low. Area: Human review / Maintenance
    Description: `PUBLIC_API_ROUTE_KEYS` has no consumers while route tests hardcode values, and `dragHorizontally` in `human-ui.spec.ts` has no caller.
    Next step: Remove the dead helpers or connect them to the intended canonical consumers.

- Issue 2026-07-11 human-review-search-seq-scan: Human review search filters cannot use indexes at scale
    Priority: Low. Area: Human review / Performance
    Description: `humanReviewListStatementWithLimit` (src/server/human-review.ts) filters with leading-wildcard `ilike` over `regexp_replace`-stripped HTML columns plus `caller_item_id`/`display_name`, so search scans all of an account's rows; queries are account-scoped via the indexed `account_id`, so this is only a concern for accounts with very large item counts.
    Next step: If per-account item counts grow enough for search latency to matter, add `pg_trgm` expression GIN indexes matching the exact `regexp_replace` expressions (or pre-stripped plain-text columns) via Flyway online-index migrations.
    Notes: Raised by gemini-code-assist review on PR #28.

- Issue 2026-07-11 stripe-webhook-status-contract-migration: Remove the transitional Stripe webhook status column after rollout
    Priority: Low. Area: Billing / Migrations
    Description: The expand migration retains `processing_status` with a `processed` default so the new writer and the prior-release rollback writer remain compatible; the column is redundant after that rollback target is retired.
    Next step: After this release is live and becomes the healthy rollback target for the next release, generate and review a forward contract migration that drops `processing_status`, replaces `agent_outbox_prune_stripe_webhook_events` in the same migration (its body filters on `processing_status`, and plpgsql bodies are not validated at column-drop time), and removes the explicit `processing_status`/`processed_at` write from `insertStripeWebhookEventStatement` in the same change.

- Issue 2026-07-10 billing-checkout-latency: Authenticated Stripe checkout latency is unmeasured after the transaction fix
    Priority: Medium. Area: Billing / Performance
    Description: Checkout's three sequential fresh database transactions were consolidated into one transaction locally, but the previously observed 5–10 second deployed latency has not been re-measured, so Stripe API and hosted page-load time remain unquantified.
    Next step: After the next production deploy, capture one authenticated checkout with Worker tail and browser request timing; add stage-level timing only if the residual delay remains material.
    Notes: Blocked on a production deploy (explicit trigger); restored after review found the verification obligation was dropped without a recorded measurement.

- Issue 2026-07-10 sentry-cli-api-schema-mismatch: Pinned sentry-cli cannot parse current Sentry API responses
    Priority: Low. Area: Tooling / Observability
    Description: `sentry-cli organizations list` (@sentry/cli 3.6.0) fails with "could not parse JSON response: missing field `requireEmailVerification`". Upstream merged PR #3352 on 2026-07-09 to use the current organization-list endpoint and remove the obsolete field, but stable 3.6.2 still does not include that fix; the operator workaround uses an explicit organization slug.
    Next step: When the next stable @sentry/cli release includes upstream PR #3352, bump package.json/toolchain.json and pnpm-lock.yaml, then re-verify `sentry-cli organizations list` and remove the documented workaround.
    Notes: Production source-map upload is unaffected (the @sentry/nextjs build plugin uploads via debug IDs).
