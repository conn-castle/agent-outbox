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
- Issue 2026-06-30 caller-quota-consume-source: Two encodings of "consumes monthly caller API quota"
    Priority: Low. Area: Limits/Accounting
    Description: `consumesMonthlyCallerApiRequestQuota` (deny-list in accounting.ts) and the `authenticated_caller_api_requests_per_calendar_month` limit `operationKinds` allow-list (limits.ts) can drift on which operations debit the quota; they currently encode different semantics.
    Next step: Product decision needed — define one canonical set of operation kinds that debit the monthly caller API quota, then derive both call sites from it.
    Notes: Deferred from review M-LM2; unifying changes runtime debit behavior, so it is a product/architecture call, not a mechanical fix.

- Issue 2026-06-30 caller-credential-lifecycle-oracle: Verifier leaks credential lifecycle state before secret check
    Priority: Low. Area: Security/Caller-auth
    Description: `verifyCallerApiKeyAgainstCredential` returns distinct codes (caller_key_revoked/not_active) before the timing-safe secret compare, so a holder of a valid 128-bit key_id can learn lifecycle state without the secret. Exploitability is gated by key_id entropy.
    Next step: When the caller route is built, return a generic client error (keep granular codes for internal logging) and run the secret comparison unconditionally.
    Notes: Deferred from review L1; the client-facing genericization belongs in the not-yet-existent caller route handler.

- Issue 2026-06-30 next-middleware-proxy-convention: Next.js middleware file convention is deprecated
    Priority: Low. Area: Runtime/Next.js
    Description: `next build` on Next.js 16.2.9 warns that the `middleware` file convention is deprecated in favor of `proxy`.
    Next step: Rename the Clerk route-protection entrypoint to the supported proxy convention after verifying Clerk and OpenNext behavior.
