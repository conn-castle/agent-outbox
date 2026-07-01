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
- Issue 2026-07-01 output-file-single-row-invariant: Output files table permits multiple rows per result
    Priority: Medium. Area: Database/File uploads
    Description: The MVP file-upload contract permits exactly one output-file row per file-upload response, but `agent_outbox_output_files` only enforces unique `(output_result_id, display_order)`, so multiple file rows can exist for one output result with different display orders.
    Next step: Before enabling paid file uploads, enforce the invariant with a unique `output_result_id` constraint or equivalent migration and add database coverage.
    Notes: Current Phase 4 API cannot create file-upload outputs yet; this becomes launch-blocking in Phase 7.

- Issue 2026-06-30 caller-last-used-hot-row-write: Caller credential last-used writes run on every valid request
    Priority: Low. Area: Reliability/Caller-auth
    Description: `authenticateCallerApiRequestWithDatabase` records `last_used_at` after every valid caller auth, including polling/status reads, which adds a transaction and can repeatedly update one hot credential row.
    Next step: Decide the required freshness for caller key last-used metadata, then coalesce or throttle updates without inventing an implicit interval.
    Notes: The current write is best-effort and logs failures so bookkeeping does not fail valid requests.

- Issue 2026-06-30 initial-schema-freeze-before-durable-apply: Freeze initial migration before shared database use
    Priority: Low. Area: Database/Migrations
    Description: The pre-release initial Flyway migration is still being edited in place; after any durable/shared database applies it, further edits will create checksum drift that fresh replay CI cannot catch.
    Next step: Before the first durable or shared database apply, freeze `V20260630000000__initial_schema.sql` and put later schema changes in forward migrations.
    Notes: Tracked during PR shipping after adding the downgrade-grace SQL guard to the initial schema.

- Issue 2026-06-30 runtime-canary-public-config-detail: Public runtime canary exposes detailed configuration posture
    Priority: Medium. Area: Security/Observability
    Description: `GET /api/runtime/canary` is unauthenticated and returns exact missing/insecure runtime configuration names plus `APP_ENV`. Values are redacted, but the route still gives public operational reconnaissance.
    Next step: Split public liveness from authenticated smoke diagnostics; keep coarse public canary data and require the smoke bearer token for configuration detail.
    Notes: Deferred from improve-codebase Chunk 4 because it changes the public runtime diagnostic contract.

- Issue 2026-06-30 protected-human-middleware-fail-open: Protected human middleware fails open on missing Clerk configuration
    Priority: Medium. Area: Security/Auth
    Description: `middleware.ts` skips Clerk protection when either Clerk env var is missing. The current `/human` page has its own missing-config guard, but future `/human/*` routes could rely on middleware and accidentally pass through during misconfiguration.
    Next step: Decide the fail-closed behavior for protected routes when Clerk is incomplete, then centralize Clerk readiness checks across middleware and auth-adjacent pages.
    Notes: Deferred from improve-codebase Chunk 4 because fail-closed middleware changes current missing-configuration routing behavior.

- Issue 2026-06-30 cloudflare-opennext-platform-verification: Cloudflare/OpenNext deploy path lacks pinned verification
    Priority: Medium. Area: Tooling/Deployment
    Description: Tracked `open-next.config.ts`, `wrangler.jsonc`, and `worker/entry.mjs` cannot be fully verified from the pinned package install because OpenNext Cloudflare and Wrangler are intentionally outside the normal app toolchain.
    Next step: In deployment/release work, pin the platform tools and add a dedicated Cloudflare/OpenNext verification command outside `make check`.
    Notes: Matches the existing app-CI/platform split decision; not fixed in improve-codebase to avoid expanding package/deployment scope.

- Issue 2026-06-30 output-sql-operation-auth-matrix: Delete/restore SQL primitives use broad context authorization
    Priority: Medium. Area: Security/Database
    Description: `agent_outbox_delete_output_result` and `agent_outbox_restore_unread_output` rely on the broad `agent_outbox_context_allows_caller` helper instead of enforcing an operation-specific surface/reason matrix at the SQL boundary before destructive delete or restore work.
    Next step: Define and enforce the allowed surface/reason matrix in the SQL functions, then add denial coverage for wrong-surface calls.
    Notes: Deferred from improve-codebase Chunk 3 pending owner approval because tightening this can change internal auth behavior.

- Issue 2026-06-30 caller-request-rate-limit-and-quota-metering: Meter monthly quota on valid requests + add per-minute input request rate limit
    Priority: Medium. Area: Limits/Security
    Description: Caller quota/rate metering has coupled drift cases: invalid send/replace debits monthly quota before validation; input send/replace lacks a pre-validation per-minute request limit; input delete has no request throttle; raw file downloads lack a fixed-window throttle when monthly quota is disabled; concurrent duplicate sends can debit accepted-submission windows for rows they do not create; multi-window fixed-limit checks can increment an earlier window before a later window denies the request.
    Next step: Rework caller request and fixed-window metering as one focused limits-matrix change: add input and file-download request rate limits, make request/submission debits all-or-nothing and post-success where required, and verify output per-minute coverage.
    Notes: Surfaced by Phase 4 and improve-codebase Chunk 1/2 audits; owner chose to keep Phase 4 behavior unchanged and do this as a focused follow-up.

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

- Issue 2026-06-30 json-body-buffered-before-cap: Chunked/unstated-length bodies buffered before 128 KB size check
    Priority: Low. Area: Input/Reliability
    Description: `src/server/input-schema.ts` `readJsonBodyWithLimit` now short-circuits on a declared `Content-Length` over `INPUT_REQUEST_BODY_BYTE_LIMIT` before `request.arrayBuffer()`, closing the common case. The residual: a request that omits or understates `Content-Length` (chunked transfer-encoding or a lying header) is still fully materialized before the post-buffer byte check, so peak memory for those requests is bounded only by the deploy platform's edge request-size limit — an undocumented external backstop.
    Next step: Document and rely on the platform/edge body-size limit explicitly (or stream-and-count) for the chunked/unstated-length residual.

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

- Issue 2026-06-30 next-middleware-proxy-convention: Next.js middleware file convention is deprecated
    Priority: Low. Area: Runtime/Next.js
    Description: `next build` on Next.js 16.2.9 warns that the `middleware` file convention is deprecated in favor of `proxy`.
    Next step: Rename the Clerk route-protection entrypoint to the supported proxy convention after verifying Clerk and OpenNext behavior.
