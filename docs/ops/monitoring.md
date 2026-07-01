# Monitoring

Use this runbook to find new issues before or without a direct user report. Use
[debugging.md](debugging.md) once a specific failure is identified. Use the
service docs under [services/](services/) for service-specific official CLI
guidance.

## Signals

| Signal                   | Service                         | Purpose                                               |
| ------------------------ | ------------------------------- | ----------------------------------------------------- |
| Application exceptions   | Sentry                          | Error grouping, release health, source maps           |
| Server structured logs   | Cloudflare Workers logs         | Request and operational forensics                     |
| Database platform logs   | Supabase logs                   | Database connectivity, query, and service diagnostics |
| Public traffic analytics | Cloudflare Web Analytics        | Basic page and performance analytics                  |
| Frontend app events      | Worker endpoint, if implemented | Sanitized browser error and UI consistency events     |

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

- app runtime is serving;
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

If the app adds a frontend event endpoint, it must be intentionally narrow:

- allowlisted event names only;
- small batch and body limits;
- same-origin requests only;
- per-session or per-IP rate limits;
- server-derived account/user context when signed in;
- no arbitrary messages;
- no raw stack traces by default;
- no form values, review content, or uploaded file metadata beyond coarse
  failure category.

Use this for client errors, hydration failures, failed human-action submissions,
upload failures, and major UI state inconsistencies. Do not turn it into a
general product analytics firehose.
