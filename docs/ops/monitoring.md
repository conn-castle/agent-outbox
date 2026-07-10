# Monitoring

Use this runbook to find new issues before or without a direct user report. Use
[debugging.md](debugging.md) once a specific failure is identified. Use the
service docs under [services/](services/) for service-specific official CLI
guidance.

The launch observability stack is intentionally provider-native: Sentry,
Cloudflare Workers structured logs and observability, Supabase native logs,
Cloudflare Web Analytics, and the narrow same-origin frontend event endpoint.
Axiom, custom observability dashboards, alert fan-out, and proactive monitoring
are out of scope for the MVP launch.

## Signals

| Signal                   | Service                  | Purpose                                               |
| ------------------------ | ------------------------ | ----------------------------------------------------- |
| Application exceptions   | Sentry                   | Error grouping, release health, source maps           |
| Server structured logs   | Cloudflare Workers logs  | Request and operational forensics                     |
| Database platform logs   | Supabase logs            | Database connectivity, query, and service diagnostics |
| Public traffic analytics | Cloudflare Web Analytics | Basic page and performance analytics                  |
| Frontend app events      | Worker endpoint          | Sanitized browser error and UI consistency events     |

Production Sentry capture requires `SENTRY_DSN` and a deploy-injected
`SENTRY_RELEASE` value. Use the immutable release identifier for the deployed
Worker build, such as the Git commit SHA or the release tag used by the deploy
pipeline. Sentry release/source-map upload is disabled unless `SENTRY_ORG`,
`SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`, `AGENT_OUTBOX_SENTRY_RELEASE_UPLOAD=1`,
and `AGENT_OUTBOX_SENTRY_DEPLOY_RELEASE_PATH=1` are set. Ordinary production
builds must not set the deploy/release-path flag.

## Regular Checks

Check these sources when validating production health:

1. Sentry unresolved issues for new or regressed groups.
2. Cloudflare Workers logs for elevated errors, auth failures, quota denials,
   cleanup failures, file failures, and billing webhook failures.
3. Supabase logs for failed or slow Postgres connections, pool saturation,
   migration failures, Row Level Security policy denials, storage growth, and
   cleanup job errors.
4. Stripe webhook delivery history after billing-impacting changes.
5. Clerk auth and signup configuration before exposing broad public signup.

Use the service's official CLI doc for each check:
[services/sentry.md](services/sentry.md),
[services/cloudflare.md](services/cloudflare.md),
[services/supabase.md](services/supabase.md),
[services/stripe.md](services/stripe.md), and
[services/clerk.md](services/clerk.md).

## Logging Contract

Server-only paths emit structured JSON logs for unexpected or
operator-actionable handled failures. Useful fields include:

- `error_id`
- `request_id`
- `environment`
- `release`
- `surface`
- `route`
- `method`
- `status_code`
- `duration_ms`
- `account_id` or an opaque audit-safe account id when useful
- `caller_id` or an opaque audit-safe caller id when useful
- `operation`
- `limit_name` for quota and rate-limit denials

Use stable low-cardinality fields. Do not use high-cardinality caller display
strings as log dimensions.

## Log Safety

Never log:

- caller API keys or local caller secrets;
- raw input HTML, details, summaries, titles, subtitles, or full request bodies;
- free-text action responses;
- uploaded file bytes;
- uploaded filenames when avoidable;
- source-system secrets;
- Stripe, Clerk, Supabase, Sentry, GitHub, Cloudflare, or AWS secret values.

File upload, download, and delete audit events record raw byte counts and
system-owned ids, not file bytes or full user content.

## Health Checks

The implemented provider-backed runtime smoke check is `make smoke-runtime`. For
local development it reads root `.env`. For hosted production, set
`AGENT_OUTBOX_RUNTIME_SMOKE_ENV_FILE` to an operator-controlled env file that
points `APP_BASE_URL` at `https://app.agent-outbox.dev` and contains the
production smoke/runtime values; do not replace root `.env` with production
credentials. The command checks:

- app runtime is serving, with only coarse runtime canary data public and
  detailed configuration posture available only through the smoke bearer token;
- Clerk auth-adjacent pages and the protected human route are reachable or
  redirect safely;
- caller API bearer auth works;
- Supabase connectivity works through the restricted app role;
- Sentry and native logs receive canary records;
- scheduled-trigger handling responds through the route canary;
- structured runtime error correlation returns a safe `error_id`.

Use `make hosted-health` for the broader agent-run inspection required before
release. It runs the smoke-safe runtime checks and reports `action_required` for
quota, file path, audit-event, or abuse/cost evidence that cannot be checked
without a safe operator-provided marker. Exit code `2` means no check failed,
but the release or incident review still needs operator action.

Use `make billing-smoke` for hosted billing wiring checks. It is no-charge by
default and must not replace hermetic unit, integration, or browser tests for
billing behavior. With a valid Clerk session cookie, it verifies that the
deployed app can create live Stripe-hosted Checkout sessions. Billing Portal
session smoke additionally requires an existing Stripe customer fixture; without
one it reports operator `action_required`. Full live completion remains an
owner-approved billing operation.

## Frontend Events

The frontend event endpoint is intentionally narrow and is wired from the
browser through the shared client-event contract:

- allowlisted event names only;
- small batch and body limits;
- same-origin requests only;
- server-derived request ids, the endpoint route label, environment, and release
  metadata;
- no arbitrary messages;
- no raw stack traces by default;
- no form values, review content, or uploaded file metadata beyond coarse
  failure category.

It accepts only client errors, hydration failures, failed human-action
submissions, upload failures, and major UI state inconsistencies. The current
browser emitter deliberately sends only the first four signals; no stable,
client-detectable `ui_state_inconsistent` invariant exists yet. It returns a
best-effort 204 response and never gates product flows. Do not turn it into a
general product analytics firehose.

The same-origin check is a browser safety boundary, not authentication:
non-browser clients can forge `Origin`. A prepared-but-inactive Cloudflare
Rulesets API rate limit exists in `scripts/cloudflare-ratelimit.mjs`; verify the
prepared disabled rule with `node scripts/cloudflare-ratelimit.mjs --check` when
reviewing launch posture or abuse response readiness. Keep the rule disabled
during normal launch-readiness checks unless the owner explicitly approves
activating or modifying it for abuse response. Until then, the accepted risk is
spoofed `client_event.*` volume causing noisy logs rather than product-flow
failure. If signal quality degrades, filter client-event logs separately from
server failure logs while preserving server-side Sentry and API error signals as
the higher-trust source.
