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

The implemented provider-backed runtime smoke check is `make smoke-runtime`. Run
it from a configured checkout with the app serving `APP_BASE_URL` and `.env`
containing local development Clerk, Postgres/Supabase, Sentry, caller-key hash,
and smoke-token values. The command checks:

- app runtime is serving, with only coarse runtime canary data public and
  detailed configuration posture available only through the smoke bearer token;
- Clerk auth-adjacent pages and the protected human route are reachable or
  redirect safely;
- caller API bearer auth works;
- Supabase connectivity works through the restricted app role;
- Sentry and native logs receive canary records;
- scheduled-trigger handling responds through the route canary;
- structured runtime error correlation returns a safe `error_id`.

Later hosted health inspection should also check cleanup recency, quota and
limit-block enforcement, paid file upload/download behavior after that workflow
exists, and recent content-safe audit events for lifecycle operations.

## Frontend Events

The frontend event endpoint is intentionally narrow:

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
submissions, upload failures, and major UI state inconsistencies. It returns a
best-effort 204 response and never gates product flows. Do not turn it into a
general product analytics firehose.

The same-origin check is a browser safety boundary, not authentication:
non-browser clients can forge `Origin`. Before public launch, either add a
Cloudflare/app-level request-rate posture for `/api/client-events` or document
the accepted operator risk for spoofed `client_event.*` volume. If signal
quality degrades, filter client-event logs separately from server failure logs
while preserving server-side Sentry and API error signals as the higher-trust
source.
