# Debugging

Use this runbook for reported failures. For proactive issue discovery, use
[monitoring.md](monitoring.md).

## Start Here

For any failure, collect:

- UTC timestamp and reporter timezone;
- production URL or CLI command used;
- release SHA/version if visible;
- user-visible `error_id` if present;
- account id, caller id, or local caller name if safe and relevant;
- affected surface: human UI, caller API, auth, billing, upload/download,
  cleanup, or observability.

Then check:

1. Sentry unresolved issues for the time window.
2. Cloudflare Workers logs for the same `error_id` or route.
3. Supabase logs for database, storage, migration, or connection failures.
4. Clerk or Stripe CLI checks for auth or billing-specific failures.

## Caller Selection Or API Key Failure

Symptoms include `ambiguous_caller`, selected caller not found, conflict between
`--caller` and `AGENT_OUTBOX_CALLER`, or caller API authentication failure.

Checks:

- Run `agent-outbox caller status --caller <caller>`.
- If both `--caller` and `AGENT_OUTBOX_CALLER` are set, unset one. The command
  must fail even if values match.
- If multiple local callers exist, pass `--caller <caller>`.
- Check Sentry and Workers logs for the authentication failure code using
  [services/sentry.md](services/sentry.md) and
  [services/cloudflare.md](services/cloudflare.md).
- Check audit events for caller rotation or revocation when the schema exists.

Caller API keys are display-once. Do not try to recover plaintext keys. Rotate.

## Output Delivery Failure

Remember:

- `output check` is non-mutating and returns readiness metadata only.
- `output read` returns the output payload and marks returned results as read.
- `output ack` is idempotent and destructive from the live queue perspective.
- Delivery is at least once until acknowledgement or timeout cleanup.

Check whether:

- the human answered the item;
- the caller is using the same caller identity that submitted the input;
- the output was already acknowledged;
- the output timed out under the retention rules in
  [../architecture.md](../architecture.md);
- the item was undone before caller read;
- the caller hit output check/read rate limits.

## File Upload Or Download Failure

Hosted-free accounts cannot submit input items containing a `file_upload`
popup. The API returns a dedicated upgrade-required error with an upgrade URL.

Output reads return file metadata only. File bytes are served only through the
dedicated file-download endpoint. That endpoint validates account/caller
ownership, output/file linkage, retention/ack status, and sends safe attachment
headers.

If free-tier file upload returns a generic validation, quota, or internal
failure, that is a bug.

## Rate Limit Or Quota Failure

Limit errors include:

- stable machine-readable code;
- `limit_name`;
- `limit_reason_code`;
- `limit_reason`;
- `limit_resets_at` when known;
- `Retry-After` for rate limits when available.

Cleanup operations such as `input delete` and `output ack` do not consume the
monthly caller API request quota, but they may still have narrow burst controls.

## Auth Or Signup Failure

Use [services/clerk.md](services/clerk.md) to check:

- Clerk application status and instance config;
- verified email requirement;
- bot sign-up protection;
- disposable-email blocking;
- sender/domain configuration for auth and account emails;
- Cloudflare logs for protected route failures.

Do not add a separate app-owned CAPTCHA in front of Clerk signup unless the
owner deliberately changes the signup design. Clerk owns hosted account
creation controls.

## Billing Failure

Use [services/stripe.md](services/stripe.md) to check:

- Stripe webhook delivery history;
- app logs for webhook signature or handler failures;
- Stripe product, price, portal, and webhook ids in runtime configuration;
- whether the account is inside the documented billing grace window;
- whether storage-producing operations are blocked by the paid storage cap.

Billing notification emails are not authoritative product state. Absence of an
email is not proof that billing state is healthy.

## Database Or Storage Failure

Likely causes:

- Supabase project paused, unavailable, or quota-limited;
- direct Postgres connection blocked from Workers runtime;
- connection pool saturation;
- missing restricted app role or Row Level Security context;
- database storage growth from uploaded file bytes;
- migration drift or failed migration.

Use [services/supabase.md](services/supabase.md) for Supabase CLI checks and logs
first. Do not repair schema with raw SQL.

## Observability Missing

If Sentry has an issue but Cloudflare logs do not show the same `error_id`, the
structured logger or log sampling/config is suspect.

If Cloudflare logs have errors but Sentry has no issue, check Sentry
configuration, sampling, source-map setup, and whether the error path
intentionally logs without Sentry capture.

If both are missing, verify the deployed runtime enabled Workers observability
and Sentry configuration.
