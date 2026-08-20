# Backlog

Note: This is an agent-layer memory file. It is primarily for agent use.

## Purpose
Unscheduled user-visible features and tasks (distinct from issues; not refactors). Maintainability refactors belong in ISSUES.md.

## Format
- Insert new entries immediately below `<!-- ENTRIES START -->` (most recent first).
- Keep each entry **3–5 lines**.
- Line 1 starts with `- Backlog YYYY-MM-DD <id>:` and a short title.
- Lines 2–5 are indented by **4 spaces** and use `Key: Value`.
- Keep **exactly one blank line** between entries.
- Prevent duplicates: search the file and merge/rewrite instead of adding near-duplicates.
- When implemented, remove the entry from this file.

### Entry template
```text
- Backlog YYYY-MM-DD short-slug: Short title
    Priority: Critical | High | Medium | Low. Area: <area>
    Description: <what the user should be able to do>
    Acceptance criteria: <clear condition to consider it done>
    Notes: <optional dependencies/constraints>
```

## Features and tasks (not scheduled)

<!-- ENTRIES START -->

- Backlog 2026-08-17 account-limits-status-surface: Complete account limits and usage status
    Priority: Medium. Area: human review, account status
    Description: Give users one complete status surface for every configured account limit, current usage where measurable, reset timing, and active blocks instead of compressing partial information into the account menu.
    Acceptance criteria: Every applicable limit derives from canonical limit metadata, reports its configured state and available live usage accurately, and links active blocks to actionable recovery guidance.
    Notes: The current account-status contract exposes tier, upload eligibility, storage usage, and active blocks but not live usage for every configured fixed-window limit.

- Backlog 2026-08-17 review-stats-page: Review activity statistics
    Priority: Low. Area: human review, navigation
    Description: Add a dedicated statistics page alongside Review queue and History when product usage provides enough evidence to define useful measures.
    Acceptance criteria: The page reports decision activity from canonical review history without changing queue or undo semantics, and the primary navigation exposes only Review queue, History, and Stats.
    Notes: Define the actual measures after observing real usage; do not add vanity metrics speculatively.

- Backlog 2026-08-16 always-available-free-form-response: Optional always-visible free-form response
    Priority: Medium. Area: human review, settings
    Description: Add a dedicated setting that lets users keep a free-form response composer visible for every review, independently of caller-defined action buttons.
    Acceptance criteria: Users can enable or disable the setting; when enabled, every review exposes the free-form response affordance without replacing or masquerading as an API-defined action.
    Notes: Treat this as a product-level response mode, not another caller-configured button.

- Backlog 2026-08-16 tight-review-mode: Ultra-compact review queue mode
    Priority: Medium. Area: human review, display settings
    Description: Add an optional tight mode that compresses the current review UI, hides most secondary information, and favors icon-only controls for high-density scanning.
    Acceptance criteria: Users can opt into and out of the mode; its exact information hierarchy and controls will be defined after more real-world use of the standard layout.
    Notes: Preserve the standard mode and defer detailed behavior until the product has more usage evidence.

- Backlog 2026-08-15 undoable-action-history: Full history view for undoable actions
    Priority: Medium. Area: human review, history
    Description: Add a complete history view that shows prior review actions and clearly identifies every action that can still be undone.
    Acceptance criteria: The history is account-scoped and paginated, supports finding all currently undoable actions, offers undo only while the matching output remains unread, and updates immediately when an action is undone or caller read disables undo.
    Notes: Undo eligibility must derive from canonical review/output state; never imply that read, handled, or acknowledged output can be undone.

- Backlog 2026-07-23 interactive-landing-demo: Interactive live demo on the landing page (Herdr-style)
    Priority: Medium. Area: marketing, web
    Description: Add an interactive, self-serve demo on the public landing/marketing page so a visitor can see and interact with Agent Outbox (the human review queue for agent-prepared work) directly in the browser and immediately grasp what it does, without signing up.
    Acceptance criteria: The landing page hosts an embedded interactive demo (clickable/playable, not just a static screenshot or video) that conveys the core review-and-approve flow within seconds, works on desktop and mobile web, and links to the primary CTA (waitlist/signup).
    Notes: Inspired by Herdr (github.com/ogulcancelik/herdr), whose interactive landing-page demo was the single most-cited reason people tried it. Source: Nick, via The Code / Herdr deep-read, 2026-07.
