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
- When scheduled into ROADMAP.md, move the work into ROADMAP.md and remove it from this file.
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
- Backlog 2026-07-07 surface-error-id-server-actions: Surface generated error_id to users on server-action paths
    Priority: Low. Area: Human review UI / Error handling
    Description: Server-action paths (/human submit and undo, caller-approval error redirect) generate an `error_id` in logs and Sentry but return only a generic code/redirect, so users get no support-correlation handle like API routes provide.
    Acceptance criteria: Failed /human submit/undo and caller-approval error flows surface the generated `error_id` to the user (error UI or redirect) so it can be quoted for support correlation.
    Notes: Deferred from observability-analytics-stack review (review-scope 20260707-164409-d437).

- Backlog 2026-07-01 server-backed-review-list-controls: Server-backed review list controls for large queues
    Priority: Medium. Area: Human review UI
    Description: Humans should be able to search, filter, sort, and page through the full review queue instead of only the first bounded list slice.
    Acceptance criteria: Review list controls are URL-backed, applied in `humanReviewListStatement`, and expose pagination or load-more behavior with browser coverage for results beyond the initial slice.
    Notes: Deferred from Phase 5 PR audit; current UI intentionally keeps a bounded first-page client workspace.

- Backlog 2026-06-30 next-middleware-proxy-convention: Migrate middleware to proxy after upstream support
    Priority: Low. Area: Runtime/Next.js
    Description: Move the Clerk route-protection entrypoint from deprecated `middleware.ts` to `proxy.ts` after released OpenNext Cloudflare support exists.
    Acceptance criteria: Upstream OpenNext Cloudflare supports Next 16 `proxy.ts`/Node middleware, the migration preserves protected-route behavior, and `make platform-check` passes.
    Notes: User-approved reclassification; unscheduled because implementation waits on an upstream gate outside this repo's control.
