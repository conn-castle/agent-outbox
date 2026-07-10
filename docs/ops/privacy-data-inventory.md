# Privacy And Data Inventory

This is the engineering source for claims in the public Privacy Policy. It
records what the hosted service processes, where it goes, and the implemented
retention behavior. Update this inventory and the public policy together when a
data field, processor, telemetry path, or retention rule changes.

The application schema, limit profiles, cleanup code, and provider configuration
remain canonical. This document describes them; it does not create a second
configurable policy.

## Public Posture

- Operator: Hardware Breakout LLC doing business as Conn Castle Studios.
- Public contact: `contact@agent-outbox.dev`, hosted by Zoho Mail.
- Intended market: United States. Agent Outbox does not market or localize the
  hosted service for the European Union, European Economic Area, United Kingdom,
  or Switzerland.
- Hosted service terms: `/terms-of-service`.
- Hosted service privacy policy: `/privacy-policy`.
- Software license: PolyForm Noncommercial License 1.0.0 in the repository
  `LICENSE` file. Hosted-service Terms must not contradict source-code rights
  granted by that license.

## Systems And Data

| System or surface                                                                     | Data processed                                                                                                                                                                                              | Purpose and boundaries                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clerk                                                                                 | Email, Clerk user/session identifiers, authentication state, necessary session cookies                                                                                                                      | Human sign-up, sign-in, and protected browser sessions. Clerk owns authentication credentials; Agent Outbox stores only the Clerk user id needed to map the hosted account.                                                                |
| Agent Outbox accounts and memberships in Supabase Postgres                            | Internal account/user/audit ids, Clerk user id, membership, tier, billing state, timestamps                                                                                                                 | Account ownership, authorization, product limits, and billing state. Row Level Security and transaction-local account context scope product access.                                                                                        |
| Caller registration in Supabase Postgres                                              | Caller names/slugs, operation/flow, setup-state identifiers and digests, callback URL, approval state, timestamps                                                                                           | Connect, rotate, revoke, browser callback, and device-code workflows. Display-once setup and API secrets are stored only as keyed digests after issuance.                                                                                  |
| Caller credentials in Supabase Postgres and local operating-system credential storage | Hosted key id, prefix, last characters, keyed secret digest, lifecycle timestamps; local plaintext caller API key                                                                                           | Hosted caller authentication and local CLI access. The hosted service does not retain the plaintext caller secret. The CLI stores it through the supported operating-system secret store.                                                  |
| Input queue in Supabase Postgres                                                      | Caller item id and hash, status, priority, row type, safe HTML fields, visual metadata, links, actions, popup schemas/options, payload sizes, timestamps                                                    | Present structured caller work to the authorized human. The product stores the typed relational shape rather than one opaque request body.                                                                                                 |
| Output queue and files in Supabase Postgres                                           | Selected action, response kind/payload, answer/read timestamps, filename, MIME type, byte size, SHA-256 digest, file bytes                                                                                  | Return human answers to the originating caller until acknowledgement or timeout. Raw files are served only from the authorized file-download route.                                                                                        |
| Audit events in Supabase Postgres                                                     | Event type, pseudonymous internal audit ids, queue/output/file ids, response kind, byte counts, quota/limit names, deletion reason, request/correlation ids, caller item hash, allowlisted numeric metadata | Append-only lifecycle, deletion, and byte-accounting evidence. Audit events must not contain review titles/HTML/summaries/details, answer text, file bytes, filenames, caller secrets, full request bodies, or raw caller display strings. |
| Quota, rate-limit, and cleanup state in Supabase Postgres                             | Account or IP subject keys, metric/window, used units, limit reason and reset state, cleanup run status and counts                                                                                          | Product limits, abuse controls, and scheduled cleanup. IP rate-limit state is enforcement data, not product analytics.                                                                                                                     |
| Stripe                                                                                | Customer/subscription/price ids, billing status, period end, hosted Checkout/Portal data, charges and invoices managed by Stripe                                                                            | Paid-plan purchase and administration. Agent Outbox does not receive or store full payment-card details.                                                                                                                                   |
| Stripe webhook ledger in Supabase Postgres                                            | Stripe event id/type, processing state, attempts, timestamps, safe error code                                                                                                                               | Idempotent billing-event processing. No raw payment method or card data is stored in this ledger.                                                                                                                                          |
| Cloudflare                                                                            | Request handling, trusted source IP, route/status/timing logs, Worker execution, Web Analytics page/performance metrics                                                                                     | Hosting, DNS, edge security, abuse control, structured logs, and privacy-oriented traffic/performance measurement. Web Analytics does not use browser storage and discards source IP from analytics data.                                  |
| Sentry                                                                                | Sanitized exception name/message, operation, route, environment, release, error id, source-map context                                                                                                      | Error grouping and release diagnosis. Runtime exception messages are replaced by a fixed message before capture; review content, answer content, caller data, and filenames must not be sent.                                              |
| Browser client-event endpoint                                                         | Closed event name/category, generated request/error ids, route and status                                                                                                                                   | Four narrow failure signals only: `client_error`, `hydration_error`, `human_action_failed`, and `file_upload_failed`. It is not a product-analytics event stream.                                                                          |
| Zoho Mail                                                                             | Sender/recipient address, subject, message, attachments, delivery metadata                                                                                                                                  | Support, billing, privacy, security, abuse, copyright, and legal contact. Users are instructed not to send secrets, card data, or unnecessary queue content.                                                                               |
| AWS Systems Manager Parameter Store                                                   | Runtime/provider credentials and resource configuration                                                                                                                                                     | Operator secret recovery. It is not a store for customer queue content or product analytics.                                                                                                                                               |

## Implemented Retention

| Data                                                    | Implemented behavior                                                                                                                                                                  | Canonical source                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Hosted-free pending inputs                              | Eligible for scheduled deletion 60 days after the last update.                                                                                                                        | `src/server/limits.ts` `HOSTED_FREE_LIMITS.input_retention_days`; scheduled cleanup |
| Hosted-paid pending inputs                              | No automatic pending-item retention cleanup. They remain until caller deletion, human answer followed by output resolution, account lifecycle action, or a future policy change.      | `src/server/limits.ts` `HOSTED_PAID_LIMITS.input_retention_days`                    |
| Answered inputs, outputs, and attached files            | Deleted on acknowledgement, pre-read human undo where allowed, downgrade cleanup where applicable, or the hard 14-day unacknowledged-output timeout.                                  | `src/server/limits.ts`; `src/server/cleanup.ts`; `docs/spec/output-schema.md`       |
| Caller setup requests and never-activated empty callers | Terminal/abandoned setup state and never-activated callers without meaningful history are eligible for pruning after seven days. Pending replacement rotation state is preserved.     | `src/server/cleanup.ts`; caller setup migrations                                    |
| Processed Stripe webhook ledger rows                    | Eligible for pruning after 90 days. Stuck `processing` rows are intentionally excluded pending the separate replay-safety decision in `ISSUES.md`.                                    | `src/server/cleanup.ts`; Stripe webhook retention migration                         |
| Quota and IP rate-limit windows                         | Pruned after the oldest still-live enforcement window. Minute IP windows are pruned on the minute-window boundary rather than retained for a calendar month.                          | `src/server/cleanup.ts`                                                             |
| Active limit blocks                                     | Maintained and removed when no longer active under the canonical reset rule.                                                                                                          | `src/server/cleanup.ts`; limit definitions                                          |
| Audit events                                            | Append-only with no automatic deletion window. Content exclusions make this durable ledger lower sensitivity than live queue content, but it remains account-linked operational data. | Initial schema; `src/server/accounting.ts`                                          |
| Cloudflare logs, Sentry events, and Zoho email          | Provider-configured operational retention; no app-owned duplicate copy.                                                                                                               | Provider configuration and service runbooks                                         |
| Stripe billing records                                  | Retained by Stripe and Conn Castle Studios as needed for subscription administration, fraud prevention, accounting, tax, disputes, and legal obligations.                             | Stripe account configuration and billing integration                                |

Backups and provider disaster-recovery copies may outlive deletion from active
systems until the provider backup cycle expires. Do not promise immediate
physical erasure from backups.

## Data That Must Not Enter Observability

- Review titles, subtitles, summaries, details, safe HTML, links, and caller
  action values.
- Human free-text or selection answers.
- Uploaded filenames or file bytes.
- Caller API keys, Clerk credentials, Stripe keys, webhook secrets, database
  URLs, cookies, bearer tokens, or authorization headers.
- Full request bodies or provider payloads.
- Raw provider error messages when they can include customer or content data.

Use content-safe identifiers, operation names, error classes, byte counts, and
bounded allowlisted metadata instead.

## Change Checklist

Before shipping a new field, processor, telemetry destination, cookie, storage
mechanism, or retention rule:

1. Identify the canonical schema/configuration/code source.
2. Decide collection purpose, access scope, and deletion behavior.
3. Update this inventory and the public Privacy Policy in the same change.
4. Update the Terms when the change affects billing, acceptable use, support,
   service commitments, user-content rights, or the software license boundary.
5. Verify public links from sign-up/sign-in, billing, and the global footer.
