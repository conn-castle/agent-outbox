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

- Backlog 2026-07-23 interactive-landing-demo: Interactive live demo on the landing page (Herdr-style)
    Priority: Medium. Area: marketing, web
    Description: Add an interactive, self-serve demo on the public landing/marketing page so a visitor can see and interact with Agent Outbox (the human review queue for agent-prepared work) directly in the browser and immediately grasp what it does, without signing up.
    Acceptance criteria: The landing page hosts an embedded interactive demo (clickable/playable, not just a static screenshot or video) that conveys the core review-and-approve flow within seconds, works on desktop and mobile web, and links to the primary CTA (waitlist/signup).
    Notes: Inspired by Herdr (github.com/ogulcancelik/herdr), whose interactive landing-page demo was the single most-cited reason people tried it. Source: Nick, via The Code / Herdr deep-read, 2026-07.
