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
- `path_shape` on Next.js `onRequestError` logs: `contains_dot` or
  `extensionless` for the original request path. The raw path is never logged;
  `contains_dot` means the request would also miss the middleware matcher that
  skips dotted paths.
- `multipart_boundary` on Next.js `onRequestError` logs: `not_multipart`,
  `absent`, `empty`, `quoted`, `unquoted`, `malformed`, or `multiple`. Use this
  to distinguish a missing multipart boundary from a declared boundary without
  recording the boundary token or deciding whether the body was complete.
  `unknown` means the hook did not provide usable header metadata.
- `content_length_state` on Next.js `onRequestError` logs: `absent`, `zero`,
  `positive`, `invalid`, or `unknown`. The raw Content-Length value is never
  logged.
- `limit_name` for quota and rate-limit denials
- `sentry_captured` on every 5xx failure log: whether this failure reached
  Sentry
- `sentry_capture_rate_limited` when a low-trust browser operation was kept as a
  warning log but not sent to Sentry because that Worker isolate had attempted
  another browser capture within the preceding minute

Use stable low-cardinality fields. Do not use high-cardinality caller display
strings as log dimensions.

Sentry capture policy for server failures: unexpected exceptions are always
captured (`reportRuntimeFailure`) regardless of status code. Sanitized GitHub
sign-in launch-failure beacons use the same capture path after the server
validates their allowlisted event name and derives its canonical category.
Non-exception handled failures are captured only for internal `500` responses;
expected operational non-500 5xx failures (for example `503`
missing-configuration or temporary-unavailable) are log-only and carry an
explicit `sentry_captured: false`. Alert on error-level logs, not on
`sentry_captured` alone; `sentry_captured: false` on a `500` indicates capture
was attempted but disabled or failed (for example a missing production DSN or
release).

Next.js `onRequestError` failures use `operation=next_request_error` and keep
the SDK's unhandled `auto.function.nextjs.on_request_error` capture. Each hook
invocation generates one `error_id` shared by the Sentry event tags/context and
the structured Worker log. `sentry_scope_attached` reports whether the Sentry
event received that correlation metadata; `false` means the capture was retried
without the added scope after scope setup failed. The log message is a fixed
safe string; it never includes the exception text, original path, query,
headers, boundary token, or body. `sentry_captured` keeps its canonical meaning:
it is true only when capture was enabled and the Sentry delegate returned
successfully. After a recurrence, list the Sentry events with tags and match the
Worker log row by `error_id`:

```bash
pnpm run sentry -- events list --show-tags
```

Compare `path_shape`, `multipart_boundary`, and `content_length_state` across
the Sentry event and the Worker log to choose the next root-cause branch without
guessing at the original request.

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
- Supabase connectivity works through the restricted app role, and the
  account-scoped human-review queue query executes against the deployed schema;
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

It accepts only client errors, hydration failures, GitHub sign-in launch
failures, failed human-action submissions, upload failures, and major UI state
inconsistencies. Browser exception, hydration, and GitHub sign-in reports use
`operation_kind=browser` and remain low-trust. Only the named GitHub sign-in
launch failures are eligible for Sentry. Each Worker isolate permits at most one
capture attempt across all such names per minute; further events remain
warning-level structured logs. GitHub sign-in owns the provider launch so it can
reset abandoned Clerk state, bound a pending Clerk call, and report a
resolved-without-navigation stall; these handled failures would not be visible
to a global browser exception listener. Human-action and upload failures
originate from the canonical server action outcome and use
`operation_kind=server_action`; rendering or sharing an error-notice URL does
not emit them. No stable, client-detectable `ui_state_inconsistent` invariant
exists yet. Event delivery is best-effort and never gates product flows. Do not
turn it into a general product analytics firehose.

For events accepted by the browser endpoint, the same-origin check is a browser
safety boundary, not authentication: non-browser clients can forge `Origin`. The
always-on Cloudflare Rulesets API rate limit in
`scripts/cloudflare-ratelimit.mjs` blocks more than 120 requests per 10 seconds
per source IP and Cloudflare location before they reach the application. Verify
the rule is present and enabled with `pnpm run cloudflare:ratelimit --check`.
The one-minute per-isolate application limiter separately bounds both Sentry
ingestion and error-level alert amplification even when Sentry capture is
unavailable; later genuine failures become eligible again. If signal quality
still degrades, filter client-event logs separately from higher-trust server API
and runtime failures.
