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
- Issue 2026-06-30 output-cursor-answered-at-precision: Keyset pagination assumes millisecond-precision answered_at
    Priority: Medium. Area: Output queue/pagination
    Description: `src/server/output-queue.ts` keyset pagination compares `(answered_at, output_result_id) > ($3::timestamptz, $4::uuid)` but `cursorFromOutputRow` encodes `answered_at` via JS `Date.toISOString()` (millisecond precision) while the column is microsecond-capable `timestamptz` (default `now()`). Currently safe only because the sole writer `human-answer.ts` stores millisecond ISO; a sub-millisecond `answered_at` (column default or any future writer) would make the cursor always strictly-less, never advancing past the first page — the exact "must not silently leave unread pages behind" failure in `docs/spec/output-schema.md`.
    Next step: PRODUCT/DESIGN DECISION — either make the cursor precision-exact against the raw column (e.g. render `answered_at::text` / `to_jsonb`) or contractually enforce+document millisecond precision on every `answered_at` write.
    Notes: Latent (Low current reachability), Medium mechanism. Surfaced by Phase 4 audit review-scope.

- Issue 2026-06-30 stored-byte-math-duplication: Two encodings of stored-byte totals (enforcement vs reporting)
    Priority: Low. Area: Limits/Accounting
    Description: Stored-byte math (`non_file = input+output`, `overall = input+output+file`) is encoded twice: the SQL function `agent_outbox_account_stock_usage` (migration, used by `caller-api-limits.ts` enforcement) and an inline CTE in `src/server/status.ts` `storageStatusStatement` (reporting). They can silently drift, violating single-source-of-truth, so reported figures could disagree with enforced limits.
    Next step: Have `status.ts` call `agent_outbox_account_stock_usage(...)` so enforcement and reporting share one calculation.
    Notes: Surfaced by Phase 4 audit review-scope.

- Issue 2026-06-30 caller-request-rate-limit-and-quota-metering: Meter monthly quota on valid requests + add per-minute input request rate limit
    Priority: Medium. Area: Limits/Security
    Description: Two coupled changes the owner approved as a post-merge follow-up (Phase 4 / PR #3 behavior intentionally unchanged). (1) Stop debiting `authenticated_caller_api_requests_per_calendar_month` for rejected/invalid send/replace: `enforceCallerRequestLimits("caller_api_request")` increments the monthly window before `parseInputSubmission`, and the transaction commits on `ok:false` (only thrown errors roll back), so invalid requests permanently consume the sticky monthly quota and a buggy/retrying client can self-lock for the rest of the month. (2) Abuse protection must come from a short-window rate limit, not the monthly quota: the monthly quota is currently the ONLY pre-validation per-request meter on the input path. The one per-minute input limit `burst_input_submissions_per_account_per_minute` (unit submissions, operationKinds [input_submission]) runs post-validation and counts accepted submissions only — invalid input requests hit no per-minute limit. Output already has pre-validation per-minute request limits (`output_check_read`/`output_ack` per minute, unit requests); input send/replace has none.
    Next step: (a) move the monthly quota increment to after validation (or roll back on `ok:false`) so only valid requests debit it; (b) add a per-minute caller-request rate limit on the input send/replace path (pre-validation, unit requests, counts every authenticated request valid-or-not), defined across the free/paid/self-hosted tier matrix with enforcement wiring and tests; (c) verify the existing output per-minute limits give the intended abuse coverage. This is a cross-cutting limits-matrix change that warrants its own review.
    Notes: Surfaced by Phase 4 audit review-scope; owner chose to keep current behavior in PR #3 and do this as a focused follow-up.

- Issue 2026-06-30 caller-auth-notfound-timing: Key-id enumeration timing side-channel on not-found path
    Priority: Low. Area: Security/Caller-auth
    Description: `src/server/caller-api-auth.ts` returns before computing the HMAC + `timingSafeEqual` when the credential lookup is null, while a found-but-wrong-secret request does both, making "unknown key_id" timing-distinguishable from "known key_id, wrong secret." Impact is minimal — 128-bit random key_ids make enumeration infeasible and the DB round-trip dominates — but it deviates from "compare runs unconditionally."
    Next step: Optionally perform a dummy HMAC + `timingSafeEqual` against a fixed sentinel on the not-found branch.

- Issue 2026-06-30 legacy-oracle-verifier-dead: Legacy verifyCallerApiKeyAgainstCredential is dead but still oracle-shaped
    Priority: Low. Area: Security/Caller-auth
    Description: `src/server/caller-auth.ts::verifyCallerApiKeyAgainstCredential` is now called only by tests; the production path uses `authenticateCallerApiRequest`. It still returns distinct lifecycle codes (revoked/expired/not_active/invalid_secret), so leaving it in the tree invites future reuse that would reintroduce the resolved credential-lifecycle oracle at a client boundary.
    Next step: Delete it and migrate its tests onto `authenticateCallerApiRequest`, or annotate it as non-client-facing internal/legacy only.
    Notes: Surfaced by Phase 4 audit review-scope.

- Issue 2026-06-30 undocumented-phase7-error-codes: ApiErrorCode lists codes absent from errors.md catalog
    Priority: Low. Area: Docs/API contract
    Description: `retention_limit_exceeded` and `billing_grace_expired` are in the `ApiErrorCode` union and wired into limit definitions in `limits.ts`, but are not in the `docs/spec/errors.md` catalog. They are Phase 7 (billing/retention) forward declarations not yet emittable to callers, so the type/limits surface and the public error catalog have drifted.
    Next step: When Phase 7 builds billing/retention, add these codes to `errors.md`; until then keep the divergence intentional and tracked here.

- Issue 2026-06-30 json-body-buffered-before-cap: Request body fully buffered before 128 KB size check
    Priority: Low. Area: Input/Reliability
    Description: `src/server/input-schema.ts` `readJsonBodyWithLimit` calls `await request.arrayBuffer()` (materializing the whole body) before checking `bytes > INPUT_REQUEST_BODY_BYTE_LIMIT`, so the 128 KB cap bounds only what reaches `JSON.parse`, not peak memory. The effective memory ceiling is whatever the deploy platform's edge request-size limit is — an undocumented external assumption.
    Next step: Document and rely on the platform/edge body-size limit explicitly, or short-circuit on `Content-Length` before buffering.

- Issue 2026-06-30 output-read-path-hardening: check over-fetch and read-all single-row poison-pill
    Priority: Low. Area: Output queue
    Description: Two output read-path items in `src/server/output-queue.ts`: (1) `check` reuses `outputPageStatement` and pulls full `response_payload` JSON from the DB though `outputCheckItemFromRow` projects to metadata only (extra DB I/O, not a leak); (2) `read-all` returns `{ok:false}`/`temporary_unavailable` for the whole page if any single row fails materialization, which would block a page and everything after it. Both are currently low-impact (read-all poison-pill is unreachable until file-upload results become creatable in Phase 7).
    Next step: Give `check` a metadata-only SELECT; when file-upload results become creatable, degrade a single unmaterializable read-all row rather than failing the whole page.
    Notes: Surfaced by Phase 4 audit review-scope.

- Issue 2026-06-30 input-send-answered-live-output-branch: Inert answered-item branch may mask intended distinction
    Priority: Medium. Area: Input queue semantics
    Description: In `src/server/input-queue.ts` `sendResultForExisting`, the `existing.status === "answered" && existing.has_live_output` branch returns the same `answered_unacknowledged` error as the following plain `existing.status === "answered"` branch, so the `has_live_output` check is currently inert. The spec (`docs/spec/errors.md`, `docs/spec/http-api.md`) ties `answered_unacknowledged` specifically to an answered item whose output is still unacknowledged, suggesting an answered item with no live output may warrant different handling.
    Next step: Confirm intended behavior for an answered item without a live output, then implement the distinct response or collapse the redundant branch.
    Notes: Left intact during simplify-new-code pass to avoid erasing a possibly half-finished spec distinction.

- Issue 2026-06-30 account-bootstrap-security-flow: Account bootstrap path depends on auth design
    Priority: High. Area: Security/Auth
    Description: Initial account and owner membership creation under `agent_outbox_app` needs a narrow bootstrap path, but implementing it before the Clerk-to-internal-user flow and related security decisions are defined would bake in the wrong trust boundary.
    Next step: Define the Clerk-to-internal-user provisioning flow and all other security-related account bootstrap decisions, then implement a dedicated bootstrap function or equivalent narrow policy.
    Notes: Deferred from PR #2 review; regular Row Level Security membership policies intentionally remain unchanged in Phase 3.

- Issue 2026-06-30 next-middleware-proxy-convention: Next.js middleware file convention is deprecated
    Priority: Low. Area: Runtime/Next.js
    Description: `next build` on Next.js 16.2.9 warns that the `middleware` file convention is deprecated in favor of `proxy`.
    Next step: Rename the Clerk route-protection entrypoint to the supported proxy convention after verifying Clerk and OpenNext behavior.
