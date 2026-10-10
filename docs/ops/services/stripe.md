# Stripe

## Tool

Use the official Stripe CLI: `stripe`.

Run `stripe --help` first, then run command-specific help before using flags
that are not already proven in this repository.

## Owns

- Account-scoped billing.
- Products and prices for hosted tiers.
- Checkout.
- Billing portal.
- Webhook endpoints and webhook delivery inspection.
- Cancellation, downgrade, payment failure, and grace-period state.

## Safe Checks

- Verify account mode before inspecting production.
- Use the Stripe CLI for billing object inspection, webhook delivery checks,
  event inspection, and API log tailing.
- Use `make billing-smoke` for no-charge hosted billing wiring checks. The
  command requires a valid operator-provided Clerk session cookie before it can
  create hosted Checkout sessions. Billing Portal smoke also requires an
  existing Stripe customer fixture and returns `action_required` when the smoke
  account has no customer. Full live completion is a separate owner-approved
  billing operation.
- Use read-only checks first when debugging checkout, webhook, portal,
  cancellation, downgrade, or grace behavior.
- Local/test-mode PR verification must cover successful checkout,
  payment-failure grace, webhook replay safety, and expired-grace downgrade
  cleanup before billing changes merge, unless the missing credentials or
  configuration are recorded as an explicit human checkpoint.

## Production Billing Shape

Production billing uses one account-scoped hosted paid product:

- Product: `Agent Outbox Hosted Paid`
- Monthly price lookup key: `agent_outbox_hosted_paid_monthly`, USD 500 cents,
  recurring monthly.
- Yearly price lookup key: `agent_outbox_hosted_paid_yearly`, USD 5000 cents,
  recurring yearly.
- Billing portal: invoice history, payment method update, cancellation at period
  end, and subscription updates only between the Agent Outbox monthly and yearly
  prices.
- Webhook URL: `https://app.agent-outbox.dev/api/billing/webhook`
- Webhook events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, and
  `invoice.payment_failed`.

Agent Outbox uses Stripe-hosted redirect Checkout and the hosted Billing Portal,
not embedded Checkout or Elements. Stripe payment method domain registration is
therefore not part of the current hosted redirect flow. If Agent Outbox later
uses Embedded Checkout, Elements, or wallet payment methods that require domain
registration, verify or create `app.agent-outbox.dev` through Stripe Payment
Method Domains first. Official Stripe references:
<https://docs.stripe.com/api/payment_method_domains/list> and
<https://docs.stripe.com/payments/payment-methods/pmd-registration>.

Checkout reserves one current attempt per account under a short authenticated
account lock, rereading billing eligibility before reservation and URL return.
The attempt stores immutable creation parameters, Stripe API version, creation
time and UUID idempotency key. Session and subscription metadata carry
`account_id` and `billing_attempt_id`; the attempt remains after completion.
Provider HTTP runs after the reservation commits, without database locks. A lost
commit acknowledgement requires a database reread before creation or URL return.
Attachment failures never blindly expire a URL another request may already have
received.

Repeated requests for the same interval retrieve and reuse the current open,
unpaid Checkout session. The latest interval selection expires that known
session and verifies its live expired status before conditionally reserving a
replacement. The billing smoke's sequential monthly/yearly requests therefore
exercise both prices, leaving only the yearly session usable. Completed sessions
block further checkout while activation settles. Unknown creation outcomes must
replay the exact saved parameters/version/key within the original 24-hour retry
window; Stripe 409, cached 500, parameter mismatch and network failure never
authorize another key. Unresolved attempts at or after that boundary require
operator reconciliation of the persisted attempt and Stripe request/session
state. Do not delete or rotate an unresolved attempt based on elapsed time.
Checkout recovery after expiration is not enabled.

### Reconcile an unresolved Checkout attempt

This is privileged maintenance, not an app-role recovery API. The app role has
no DELETE grant on attempts and forced RLS restricts access. Follow
[Supabase access and guardrails](supabase.md): verify the Agent Outbox project,
mode and roles, and obtain explicit human approval for the exact
account/attempt, proposed data changes and backup/export posture before any live
write. Export the account, attempt and relevant webhook receipts to approved
operator storage. Never put creation parameters, customer details, credentials
or raw errors in application logs. No production action is authorized by this
runbook alone.

1. From the reported error ID, find the structured checkout failure and record
   `account_id`, `billing_attempt_id` and `billing_attempt_created_at` (UTC).
   Read the current account and attempt through authorized database access;
   compare the UUID and original timestamp. Securely inspect its frozen
   `creation_parameters`, `stripe_api_version`, session/subscription IDs and the
   account's canonical and terminal subscription IDs. Failure logs distinguish
   creation retention, retrieval, identity, completion, payment, interval and
   URL failures. Expiration errors retain allowlisted name/code and the last
   successfully retrieved session/payment state; these states are not proof of
   the result of a failed later retrieval.
2. In the correct Stripe account and mode, use
   [Workbench request logs](https://docs.stripe.com/workbench/overview#view-api-request-logs)
   to inspect candidate `POST /v1/checkout/sessions` requests around the
   original creation and all subsequent dispatches. Use documented date, method,
   endpoint, status, version, error and resource filters; inspect each
   candidate's request headers for `Idempotency-Key` equal to the attempt UUID
   and `Stripe-Version`, then compare its payload with the frozen parameters.
   Record matching request IDs and responses in the private incident evidence.
   Do not assume an idempotency-key search filter exists. A missing request log
   or elapsed time does not establish that nothing was created; cached server
   failures can leave execution uncertain. See
   [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).
3. Retrieve any identified session live. Also
   [list Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/list)
   across the entire possible dispatch window, fully following `has_more` and
   `starting_after` pagination. Include all statuses; narrow by known customer
   or subscription only when that cannot exclude a candidate (a customer may
   have been created during Checkout). Inspect `client_reference_id` and both
   `account_id`/`billing_attempt_id` metadata, and inspect linked subscriptions,
   payments and webhook deliveries. Check subscription metadata and canonical
   billing identity together. Partial lists, matching customer alone, or absence
   of a session in logs cannot prove no purchase. If evidence remains ambiguous,
   keep checkout blocked and involve support/Stripe; do not replay creation
   beyond the original retry window or change the key to investigate.
4. Prefer attaching a conclusively identified same-attempt session. Before any
   maintenance write, quiesce checkout writers (including old/rollback writers)
   and cleanup, and drain their in-flight requests. Keep webhook delivery
   enabled: webhook transactions use the same account lock, so abort maintenance
   if they change the approved canonical state. Do not disable or delete the
   Stripe webhook destination; this stops future automatic retries. If a
   delivery needs reconciliation, Stripe supports manual resend from the
   Dashboard for 15 days or the CLI for 30 days; see
   [webhook delivery behavior](https://docs.stripe.com/webhooks#event-delivery-behaviors).
   With the approved privileged role (able to bypass forced RLS), begin a short
   transaction, lock the exact account row `FOR UPDATE`, then reread the current
   attempt and billing identity. Abort if the approved UUID/timestamp or
   canonical state changed. Conditionally update only `stripe_session_id` for
   that account and UUID when it is still null or already the proven ID; respect
   its unique constraint. Do not overwrite a different session, alter the frozen
   payload/version/key/time, or clear terminal identity. Require one affected
   row and commit; if acknowledgement is lost, reread before any further action.
   Resume writers and use normal checkout: live open/unpaid sessions are reused,
   expired sessions rotate, and complete sessions stay blocked until billing is
   reconciled. A completed paid purchase needs entitlement/webhook
   reconciliation, never another purchase as recovery.
5. Release an attempt only when attachment cannot resolve it and recorded
   evidence conclusively establishes no remaining purchase risk: every possible
   dispatch either provably did not execute, or its identified session is live
   expired with no purchase, or its purchase's canonical subscription is proven
   `canceled`/`incomplete_expired` with no other nonterminal
   subscription/payment pending. Do not treat `past_due`, `unpaid`, `paused`,
   cleanup state, a timeout, cached 500, missing logs, or session age as
   terminal/no-purchase proof. Quiesce and drain checkout and cleanup writers as
   in step 4, keeping webhooks enabled; without this, a late creation can
   invalidate the proof. Refresh live Stripe evidence before opening the short
   maintenance transaction. Under human-approved privileged maintenance, lock
   and reread the account and exact attempt, verify the approved billing
   identity and canonical terminal truth remain unchanged, then conditionally
   DELETE only the approved account/UUID/timestamp row. Require exactly one
   affected row; abort on changed identity or uncertain evidence. Preserve the
   account's canonical subscription and terminal latch. Commit and reread,
   record the outcome privately, then resume writers. The next normal checkout
   performs a fresh eligibility check and reservation. This is data maintenance,
   not schema repair; schema changes still require Flyway and the protected
   release workflow.

Resubscription requires terminal proof for the canonical subscription:
`canceled` or `incomplete_expired`. `past_due`, `unpaid` and `paused` are not
terminal, even if grace cleanup has downgraded the account and cleared its
provider status. A retained subscription ID without terminal proof is retrieved
outside the transaction and revalidated under the account lock. A separate
terminal identity survives cleanup. The previous Checkout must also be confirmed
complete for that terminal subscription or expired before its attempt rotates;
unknown sessions still require reconciliation.

Webhook references resolve together before any projection changes. Conflicting
account/customer/subscription/attempt references are acknowledged with a
structured `billing_conflict` warning and cannot change entitlement, grace,
attempt identity or ordering markers. A canonical nonterminal subscription
cannot be replaced. Replacement after terminal state requires current attempt
metadata. Legacy initial attachment is accepted only without a canonical
subscription or conflicting attempt; consistent same-canonical legacy events
remain supported. Stranger cancellation events never initially attach a
subscription. Invoice events obey the same canonical and attempt identity
checks. Confirmed terminal subscriptions cannot be revived by late active,
checkout or invoice events. For equal-created-second deliveries, terminal truth
wins; remaining transitions retain timestamp and receipt ordering. Receipt order
breaks delivery ties and does not establish Stripe chronology.

The attempt table forces RLS: authenticated account members and webhook control
plane operations can access it; callers, cross-account humans and generic
cleanup cannot. Account deletion cascades to its attempt.

The additive Flyway migration supports outgoing and incoming code, but duplicate
prevention applies only to writers using this protocol. Before release,
inventory and reconcile legacy open/completed/in-flight Checkout sessions from
both rollout and rollback old-writer windows, including requests still in
flight, and identify when all active writers use the new protocol. An old-code
paid completion without attempt metadata can be acknowledged as
`billing_conflict` without granting entitlement when a conflicting current
attempt or replacement after terminal state requires that metadata; reconcile
those payments before proceeding, without bypassing canonical identity
protections. A point-in-time empty inventory does not cover later old-writer
requests. Rollback restores the previous duplicate risk. Release readiness must
verify the restricted runtime Stripe key permits Checkout retrieve and expire,
as well as create, without mutating production objects as a test. Production
schema changes run only through the protected release workflow.

Webhook event ids are claimed inside the same database transaction that applies
their billing changes. A committed ledger row therefore means the event
completed; transaction rollback removes both the claim and billing changes so
Stripe can retry. The schema retains a transitional `processing_status` column
with a `processed` default so earlier writers that still name the column remain
valid as rollback targets. The current writer omits `processing_status` and
relies on the `processed_at` default, so it stays valid once that column is
dropped. The webhook writer reads the receipt order assigned by the expanded
ledger: before that migration it retains the prior projection behavior, and
after the migration it atomically rejects strictly older projection updates
while using receipt order to break equal-second ties. Existing projections start
from a conservative floor derived from their latest associated ledger receipt.
If a prior or rollback writer changes billing state without advancing the new
tie-breaker, the database clears that floor so it cannot falsely suppress later
events after the new writer returns. The prior writer can still explicitly write
`processing` and transition it to `processed` inside the same transaction. No
intermediate state is durably committed. Drop the compatibility column only in a
later reviewed contract migration once no deployed or rollback-target release
writes it; that contract migration must also replace the prune function's
`processing_status` predicate. The ledger stores no raw webhook payload. Signed
events whose required `created` ordering metadata violates the Stripe event
contract fail before ledger insertion and return a retry-visible `503`; they are
not recorded as successfully processed or silently discarded.

The webhook parser accepts both the pre-basil and the
`2025-03-31.basil`-and-later shapes of two moved fields: billing periods read
from `items.data[].current_period_end` or the earlier subscription-level
`current_period_end`, and failed-payment subscriptions read from
`parent.subscription_details.subscription` or the earlier
`invoice.subscription`. A subscription scheduled to cancel at period end grants
grace until the subscription period end (the earliest item period end on basil
and later). If no period end is present, the event fails with a reported,
retry-visible `503` instead of guessing a grace deadline; retries of the same
payload keep failing, so review that delivery in Stripe's webhook log.

Creating or rotating production billing resources requires a setup-only live
Stripe key with write permission for products, prices, Customer Portal
Configurations, and webhook endpoints. A read-only or otherwise restricted live
key can inspect resources but cannot create or rotate billing resources.

Setup-only keys are operator credentials for creating Stripe objects. Do not
store a setup-only key as `STRIPE_SECRET_KEY` or in the production
`stripe-secret-key` recovery path. If a setup key must be recoverable, store it
only in the setup-key recovery path documented in
[../secrets.md](../secrets.md). Production Checkout and Billing Portal sessions
use the separate restricted runtime key installed in Cloudflare Worker secrets.

Test-mode Stripe resources created for verification are disposable unless the
owner explicitly promotes a reusable test fixture. Record test-mode evidence,
but do not store disposable test-mode price ids or webhook secrets in Systems
Manager Parameter Store.

## Guardrails

- Do not create, update, delete, resend, or replay billing objects/events unless
  the task explicitly requires it.
- Do not change prices, billing terms, product ids, portal configuration, or
  webhook endpoints without owner approval.
- Do not paste customer billing data or secret keys into chat, issues, logs, or
  docs.
