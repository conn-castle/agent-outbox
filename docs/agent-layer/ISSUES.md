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
- Issue 2026-07-04 human-signup-browser-fixture-timeout: Browser signup fixture hangs in Playwright gate
    Priority: Medium. Area: Browser tests/Human auth fixture
    Description: `make browser` reached tests and the caller connect/rotate/revoke flows passed, but `tests/browser/human-ui.spec.ts` first-time self-serve signup failed in both desktop and mobile by staying on `/sign-up` or aborting navigation to `/sign-up` until the 30s test timeout.
    Next step: Diagnose the human signup fixture navigation under Next dev fixture mode and stabilize the test or fixture without weakening the protected-route security policy.
    Notes: Observed during `hosted-security-fail-closed-cloudflare-ip` verification on 2026-07-04; no labeled browser Docker resources remained after the run.

- Issue 2026-07-04 caller-request-limit-policy-gaps: Define remaining request-rate limit policy
    Priority: Medium. Area: Limits/Security
    Description: Input send/replace/delete and raw file download request throttles still need owner-approved per-minute numeric limits, including behavior when monthly caller API quota is disabled for paid/self-hosted profiles.
    Next step: Decide the limit names, numeric thresholds, and affected operation surfaces, then add the corresponding limit definitions and route coverage.
    Notes: Split from `caller-request-rate-limit-and-quota-metering`; the mechanical monthly request over-debit, accepted-submission over-debit, and multi-window all-or-nothing debit defects were fixed.

- Issue 2026-07-02 never-activated-connect-caller-name-burn: Abandoned connect leaves orphan caller rows and burns the name
    Priority: Medium. Area: Caller control-plane
    Description: Two-phase connect creates the `agent_outbox_callers` row (unique `caller_slug`) at approval but only activates the credential after CLI local persistence. A connect abandoned before activation leaves an orphan caller row plus an expired pending credential: re-connecting the same `local_caller_name` fails with `caller_already_exists` (name burned, no reclaim path), and because the setup-request prune cascade-cleans only the pending credential, abandoned/retried connects accumulate orphaned caller rows indefinitely (data hygiene, not a secret leak).
    Next step: Owner decision on whether/how to reclaim or reuse a never-activated caller name; a bounded prune (new migration + cleanup function) removing callers with no non-terminal credential after a retention window would cover both consequences. Do not implement auto reuse/rename/reclaim without that decision.
    Notes: Deferred from resolve-findings 20260702-195040-ac9d; the row-accumulation aspect was re-confirmed by audit-and-fix Round 1 (2026-07-03).

- Issue 2026-06-30 caller-last-used-hot-row-write: Caller credential last-used writes run on every valid request
    Priority: Low. Area: Reliability/Caller-auth
    Description: `authenticateCallerApiRequestWithDatabase` records `last_used_at` after every valid caller auth, including polling/status reads, which adds a transaction and can repeatedly update one hot credential row.
    Next step: Decide the required freshness for caller key last-used metadata, then coalesce or throttle updates without inventing an implicit interval.
    Notes: The current write is best-effort and logs failures so bookkeeping does not fail valid requests.

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare/OpenNext deploy path lacks pinned verification
    Priority: Medium. Area: Tooling/Deployment
    Description: Tracked `open-next.config.ts`, `wrangler.jsonc`, and `worker/entry.mjs` cannot be fully verified from the pinned package install because OpenNext Cloudflare and Wrangler are intentionally outside the normal app toolchain.
    Next step: In deployment/release work, pin the platform tools and add a dedicated Cloudflare/OpenNext verification command outside `make check`.
    Notes: Matches the existing app-CI/platform split decision; not fixed in improve-codebase to avoid expanding package/deployment scope.

- Issue 2026-06-30 undocumented-phase7-error-codes: ApiErrorCode lists codes absent from errors.md catalog
    Priority: Low. Area: Docs/API contract
    Description: `retention_limit_exceeded` and `billing_grace_expired` are in the `ApiErrorCode` union and wired into limit definitions in `limits.ts`, but are not in the `docs/spec/errors.md` catalog. They are Phase 7 (billing/retention) forward declarations not yet emittable to callers, so the type/limits surface and the public error catalog have drifted.
    Next step: When Phase 7 builds billing/retention, add these codes to `errors.md`; until then keep the divergence intentional and tracked here.

- Issue 2026-06-30 output-read-all-single-row-poison-pill: read-all page can fail on one unmaterializable row
    Priority: Low. Area: Output queue
    Description: In `src/server/output-queue.ts`, `read-all` returns `{ok:false}`/`temporary_unavailable` for the whole page if any single row fails materialization, which would block a page and everything after it. Currently unreachable until file-upload results become creatable in Phase 7.
    Next step: When file-upload results become creatable, degrade a single unmaterializable read-all row rather than failing the whole page.
    Notes: Surfaced by Phase 4 audit review-scope; split from `output-read-path-hardening` after the output `check` query was changed to metadata-only.

- Issue 2026-06-30 next-middleware-proxy-convention: Next.js middleware file convention is deprecated
    Priority: Low. Area: Runtime/Next.js
    Description: `next build` on Next.js 16.2.9 warns that the `middleware` file convention is deprecated in favor of `proxy`.
    Next step: Rename the Clerk route-protection entrypoint to the supported proxy convention after verifying Clerk and OpenNext behavior.
