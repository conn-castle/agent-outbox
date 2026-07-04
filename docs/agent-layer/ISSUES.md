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
- Issue 2026-07-03 cli-secret-store-no-cross-process-lock: Concurrent CLI invocations can lose credentials
    Priority: Medium. Area: CLI/Reliability
    Description: `cli/internal/foundation/secrets.go` (loadManifest/persistManifest) and `config.go` (saveConfig) do whole-file read-modify-write with no advisory lock spanning load→persist. Each write is atomic (temp+rename), but two concurrent invocations (e.g. two `connect`s) both read then both write, so the last writer clobbers the other's entry. The secret store and config are separate files updated in sequence, so a concurrent run can also leave them inconsistent (a config caller with no secret). Single-flow rollback does not protect against a second process.
    Next step: Hold an advisory lock (flock or O_CREATE|O_EXCL lock file) across the load→persist window for both the manifest and config; decide stale-lock handling.
    Notes: Deferred from audit-and-fix Round 1 (F4) as broader scope than a point fix.

- Issue 2026-07-03 cli-browser-denial-waits-for-expiry: Denied browser approval hangs until the ~10-min deadline
    Priority: Low. Area: CLI/Caller control-plane UX
    Description: In `cli/internal/command/controlplane.go` runBrowserFlow, the /callback handler drops every non-approved result (returns without sending to the callbacks channel) and callbackResultFromRequest checks status before the setup_request_id match. If the hosted app redirects a denial to the loopback callback, the terminal waits out the setup-request expiry and then reports a misleading "Timed out waiting for browser approval callback" instead of failing fast on the denial.
    Next step: Confirm the cross-repo contract (does the app redirect a denied approval to the loopback callback, and with what status?). If yes, validate setup_request_id first and deliver a matched denial on the channel while still dropping mismatched/spurious callbacks.
    Notes: Deferred from audit-and-fix Round 1 (F2): unverifiable from the CLI diff alone, and the naive fix would break controlplane_test.go ~217, which asserts a matched-id-without-status callback is dropped.

- Issue 2026-07-03 cli-device-poll-no-client-deadline: Device-code poll loops rely on the server for termination
    Priority: Low. Area: CLI/Caller control-plane
    Description: `runDeviceConnect` and `runDeviceSetupCodeFlow` in controlplane.go loop while the server returns authorization_pending, exiting only on a non-pending error or ctx cancellation. deviceStartData carries no expires_in, so the client cannot self-bound the poll; termination depends entirely on a conformant (RFC 8628) server returning a terminal expired_token. Bounded against a correct first-party server, unbounded against a misbehaving one.
    Next step: Surface expires_in/expires_at from the device-start response and cap the poll loop, or add a decided client-side cap (no hidden magic default).
    Notes: Deferred from audit-and-fix Round 1 (F10).

- Issue 2026-07-03 caller-setup-prune-test-account-scoped: DB test can't catch a reverted prune preservation guard
    Priority: Medium. Area: Testing/Database cleanup
    Description: `agent_outbox_prune_caller_setup_requests` was made `security definer` so its `not exists (... caller_credentials ...)` preservation guard works under account-less global cleanup (`caller_credentials` has only account-scoped RLS). The opt-in DB test `phase 3 local database` (tests/foundation.test.mjs ~3077-3200) runs that prune with `auth_surface=cleanup` AND `account_id=accountA` set, so the guard sees accountA's credentials even under SECURITY INVOKER — the test passes whether the function is definer or invoker and cannot catch a regression that reverts the guard. No production executor runs this prune yet (the cron is a canary; the builder is test-only).
    Next step: Add an assertion that runs the prune under cleanup surface with NO account_id and asserts the referenced pending-replacement setup request + credential are still preserved (would fail under security invoker).
    Notes: Surfaced by audit-and-fix Round 1 while validating the F1 security-definer fix.

- Issue 2026-07-03 quota-maintenance-unwired: Periodic quota/limit/retention cleanup has no production caller
    Priority: Medium. Area: Reliability/Cleanup
    Description: `quotaWindowMaintenanceStatements`, `activeLimitMaintenanceStatement`, and `pendingInputRetentionStatement` in `src/server/cleanup.ts` have no production caller (only tests), so account/IP quota windows, expired limit blocks, and retained pending inputs are never pruned.
    Next step: Add a scheduled cleanup job running these statements under the `cleanup` auth surface.
    Notes: Found during resolve-findings 20260703-133952-c85f (finding 8); the IP prune cutoff was already tightened to minute-anchored and an `updated_at` index on `agent_outbox_ip_quota_windows` was added in V20260702000000, but nothing prunes until the job exists.

- Issue 2026-07-02 never-activated-connect-caller-name-burn: Abandoned connect leaves orphan caller rows and burns the name
    Priority: Medium. Area: Caller control-plane
    Description: Two-phase connect creates the `agent_outbox_callers` row (unique `caller_slug`) at approval but only activates the credential after CLI local persistence. A connect abandoned before activation leaves an orphan caller row plus an expired pending credential: re-connecting the same `local_caller_name` fails with `caller_already_exists` (name burned, no reclaim path), and because the setup-request prune cascade-cleans only the pending credential, abandoned/retried connects accumulate orphaned caller rows indefinitely (data hygiene, not a secret leak).
    Next step: Owner decision on whether/how to reclaim or reuse a never-activated caller name; a bounded prune (new migration + cleanup function) removing callers with no non-terminal credential after a retention window would cover both consequences. Do not implement auto reuse/rename/reclaim without that decision.
    Notes: Deferred from resolve-findings 20260702-195040-ac9d; the row-accumulation aspect was re-confirmed by audit-and-fix Round 1 (2026-07-03).

- Issue 2026-07-02 connect-client-ip-trust-policy: Connect per-IP limits need an explicit proxy trust policy
    Priority: Medium. Area: Caller control-plane/Security
    Description: `trustedClientIpAddress` accepts `CF-Connecting-IP`, then falls back to the first `X-Forwarded-For` value. The repo documents Cloudflare Workers/OpenNext as the hosted runtime, but does not define when fallback proxy headers are trustworthy.
    Next step: Decide and document the deployment/proxy trust policy, then update `trustedClientIpAddress` and route tests to enforce only the approved client-IP source(s).
    Notes: Deferred from resolve-findings 20260702-031158-414f because inventing this policy would broaden WP-1.

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

- Issue 2026-06-30 undocumented-phase7-error-codes: ApiErrorCode lists codes absent from errors.md catalog
    Priority: Low. Area: Docs/API contract
    Description: `retention_limit_exceeded` and `billing_grace_expired` are in the `ApiErrorCode` union and wired into limit definitions in `limits.ts`, but are not in the `docs/spec/errors.md` catalog. They are Phase 7 (billing/retention) forward declarations not yet emittable to callers, so the type/limits surface and the public error catalog have drifted.
    Next step: When Phase 7 builds billing/retention, add these codes to `errors.md`; until then keep the divergence intentional and tracked here.

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
