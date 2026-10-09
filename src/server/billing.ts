import Stripe from "stripe";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

import {
  apiTemporaryUnavailable,
  apiTransactionFailure,
  isJsonRecord,
  type ApiRequestContext,
  type ApiResult
} from "./api-errors.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { absoluteHttpOrigin } from "./env.ts";
import {
  durationSinceMs,
  emitRuntimeLog,
  safeErrorName,
  type RuntimeLogEvent
} from "./logging.ts";
import {
  readJsonBodyWithLimit,
  readRawRequestBodyWithLimit
} from "./request-body.ts";

const BILLING_GRACE_DAYS = SYSTEM_CONTRACT.billingDowngradeGraceDays;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
export const STRIPE_WEBHOOK_BODY_BYTE_LIMIT = 1_048_576;

type BillingStatus =
  "not_applicable" | "active" | "grace" | "past_due" | "canceled";

type BillingInterval = "monthly" | "yearly";

type BillingConfig = {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<BillingInterval, string>;
  portalConfigurationId: string;
  publicAppBaseUrl: string;
};

type StripeClient = Pick<Stripe, "checkout" | "billingPortal" | "webhooks">;
type BillingTransactionRunner = typeof runProductTransaction;

export type BillingAccount = {
  account_id: string;
  tier: string;
  billing_status: BillingStatus;
  stripe_customer_id: string | null;
};

type InsertWebhookEventRow = {
  stripe_event_id: string;
  stripe_receipt_order: string | null;
};

type AccountUpdateRow = {
  account_id: string | null;
};

export type BillingCheckoutData = {
  url: string;
};

export type BillingPortalData = {
  url: string;
};

export type BillingWebhookData = {
  processed: boolean;
};

export type StripeEventOutcome =
  | { status: "applied"; accountId: string }
  | { status: "duplicate" | "unhandled_type" | "stale_ordering" }
  | {
      status: "unapplied";
      reason: "invalid_object" | "missing_reference" | "no_matching_account";
      accountId: string | null;
    };

export function requiredBillingConfiguration(
  surface: "checkout" | "portal" | "webhook"
) {
  const required = ["STRIPE_SECRET_KEY"];
  if (surface === "checkout") {
    required.push(
      "STRIPE_PAID_MONTHLY_PRICE_ID",
      "STRIPE_PAID_YEARLY_PRICE_ID",
      "PUBLIC_APP_BASE_URL"
    );
  }
  if (surface === "portal") {
    required.push(
      "PUBLIC_APP_BASE_URL",
      "STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
    );
  }
  if (surface === "webhook") {
    required.push("STRIPE_WEBHOOK_SECRET");
  }

  return required.filter((name) => !process.env[name]?.trim());
}

export function billingRuntimeConfig(
  surface: "checkout" | "portal" | "webhook"
): ApiResult<BillingConfig> {
  const missing = requiredBillingConfiguration(surface);

  if (missing.length > 0) {
    return apiTemporaryUnavailable(
      `Billing configuration is missing required variable names: ${missing.join(", ")}.`
    );
  }

  const usesPublicAppBaseUrl = surface !== "webhook";
  const configuredPublicAppBaseUrl = usesPublicAppBaseUrl
    ? process.env.PUBLIC_APP_BASE_URL?.trim()
    : undefined;
  const publicAppBaseUrl = configuredPublicAppBaseUrl
    ? absoluteHttpOrigin(configuredPublicAppBaseUrl)
    : null;
  if (configuredPublicAppBaseUrl && !publicAppBaseUrl) {
    return apiTemporaryUnavailable(
      "Billing configuration has invalid PUBLIC_APP_BASE_URL; expected an absolute HTTP(S) origin."
    );
  }

  return {
    ok: true,
    data: {
      secretKey: process.env.STRIPE_SECRET_KEY!.trim(),
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
      priceIds: {
        monthly: process.env.STRIPE_PAID_MONTHLY_PRICE_ID?.trim() ?? "",
        yearly: process.env.STRIPE_PAID_YEARLY_PRICE_ID?.trim() ?? ""
      },
      portalConfigurationId:
        process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim() ?? "",
      publicAppBaseUrl: publicAppBaseUrl ?? ""
    }
  };
}

export async function checkoutIntervalFromRequest(
  request: Request
): Promise<ApiResult<BillingInterval>> {
  const body = await readJsonBodyWithLimit(request);
  if (!body.ok) {
    return body;
  }

  return checkoutIntervalFromBody(body.value);
}

function checkoutIntervalFromBody(body: unknown): ApiResult<BillingInterval> {
  if (!isJsonRecord(body)) {
    return invalidBillingRequest(
      'Checkout request body must be a JSON object with interval "monthly" or "yearly".'
    );
  }

  return checkoutIntervalFromValue(recordValue(body, "interval"));
}

export async function createCheckoutSessionForAccount(input: {
  account: BillingAccount;
  interval: unknown;
  context: ApiRequestContext;
  config?: BillingConfig;
  stripe?: StripeClient;
}): Promise<ApiResult<BillingCheckoutData>> {
  const intervalResult = checkoutIntervalFromValue(input.interval);
  if (!intervalResult.ok) {
    return intervalResult;
  }

  const runtime = billingRuntime("checkout", input);
  if (!runtime.ok) {
    return runtime;
  }
  const { config, stripe } = runtime.data;
  const account = input.account;
  if (account.tier === "self_hosted") {
    return invalidBillingRequest("Self-hosted accounts do not use Stripe.");
  }
  if (hasLiveBillingState(account.billing_status)) {
    return invalidBillingRequest(
      "Active billing accounts must use the billing portal."
    );
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: account.stripe_customer_id ?? undefined,
      client_reference_id: account.account_id,
      line_items: [
        { price: config.priceIds[intervalResult.data], quantity: 1 }
      ],
      success_url: `${config.publicAppBaseUrl}/upgrade?checkout=success`,
      cancel_url: `${config.publicAppBaseUrl}/upgrade?checkout=cancelled`,
      metadata: { account_id: account.account_id },
      subscription_data: { metadata: { account_id: account.account_id } }
    });
  } catch (error) {
    return apiTransactionFailure(error, input.context, {
      accountId: account.account_id,
      operation: "stripe_checkout_session_create",
      message: "Stripe checkout session creation failed unexpectedly.",
      unavailableMessage: "Checkout session is temporarily unavailable."
    });
  }

  if (!session.url) {
    return apiTemporaryUnavailable("Checkout session is unavailable.");
  }

  return { ok: true, data: { url: session.url } };
}

export async function createBillingPortalSessionForAccount(input: {
  account: BillingAccount;
  context: ApiRequestContext;
  config?: BillingConfig;
  stripe?: StripeClient;
}): Promise<ApiResult<BillingPortalData>> {
  const runtime = billingRuntime("portal", input);
  if (!runtime.ok) {
    return runtime;
  }
  const { config, stripe } = runtime.data;
  const account = input.account;

  if (!account.stripe_customer_id) {
    return invalidBillingRequest(
      "Billing portal requires an active Stripe customer."
    );
  }

  let session: Stripe.BillingPortal.Session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      return_url: `${config.publicAppBaseUrl}/upgrade`,
      configuration: config.portalConfigurationId
    });
  } catch (error) {
    return apiTransactionFailure(error, input.context, {
      accountId: account.account_id,
      operation: "stripe_billing_portal_session_create",
      message: "Stripe billing portal session creation failed unexpectedly.",
      unavailableMessage: "Billing portal is temporarily unavailable."
    });
  }

  return { ok: true, data: { url: session.url } };
}

export async function handleStripeWebhookRequest(
  request: Request,
  context: ApiRequestContext,
  input: {
    connectionString: string;
    config?: BillingConfig;
    stripe?: StripeClient;
    now?: Date;
    runTransaction?: BillingTransactionRunner;
  }
): Promise<ApiResult<BillingWebhookData>> {
  const runtime = billingRuntime("webhook", input);
  if (!runtime.ok) {
    return runtime;
  }
  const { config, stripe } = runtime.data;
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    emitStripeWebhookWarning(context, {
      operation: "stripe_webhook_signature",
      status_code: 400,
      message: "Stripe webhook signature header is missing."
    });
    return invalidBillingRequest("Stripe signature is required.");
  }

  const body = await readRawRequestBodyWithLimit(
    request,
    STRIPE_WEBHOOK_BODY_BYTE_LIMIT
  );
  if (!body.ok) {
    emitStripeWebhookWarning(context, {
      operation: "stripe_webhook_request_too_large",
      status_code: 413,
      message: "Stripe webhook request body exceeds the size limit."
    });
    return {
      ok: false,
      error: {
        status: 413,
        code: "request_too_large",
        message: "Stripe webhook request body exceeds the 1048576-byte cap."
      }
    };
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body.buffer,
      signature,
      config.webhookSecret
    );
  } catch (error) {
    emitStripeWebhookWarning(context, {
      status_code: 400,
      operation: "stripe_webhook_signature",
      message: "Stripe webhook signature verification failed.",
      error_name: safeErrorName(error)
    });
    return invalidBillingRequest("Stripe signature verification failed.");
  }

  let outcome: StripeEventOutcome;
  try {
    const runTransaction = input.runTransaction ?? runProductTransaction;
    outcome = await runTransaction(
      input.connectionString,
      { requestId: context.requestId, authSurface: "control_plane" },
      (query) => processStripeEventInTransaction(query, event, input.now)
    );
  } catch (error) {
    return apiTransactionFailure(error, context, {
      operation: "stripe_webhook_processing",
      message: "Stripe webhook processing failed unexpectedly.",
      unavailableMessage:
        "Stripe webhook processing is temporarily unavailable."
    });
  }

  if (outcome.status === "unapplied") {
    emitStripeWebhookWarning(context, {
      status_code: 200,
      operation: "stripe_webhook_unapplied",
      drop_reason: outcome.reason,
      stripe_event_type: event.type,
      account_id: outcome.accountId ?? undefined,
      message:
        "Stripe webhook event was acknowledged without changing billing state."
    });
  }

  return { ok: true, data: { processed: outcome.status !== "duplicate" } };
}

function emitStripeWebhookWarning(
  context: ApiRequestContext,
  fields: Pick<RuntimeLogEvent, "operation" | "status_code" | "message"> &
    Partial<
      Pick<
        RuntimeLogEvent,
        "error_name" | "drop_reason" | "stripe_event_type" | "account_id"
      >
    >
) {
  emitRuntimeLog({
    level: "warn",
    error_id: context.correlationId,
    request_id: context.requestId,
    surface: "api",
    route: context.route,
    method: context.method,
    duration_ms: durationSinceMs(context.startedAtMs),
    ...fields
  });
}

export async function processStripeEventInTransaction(
  query: ProductTransactionQuery,
  event: Stripe.Event,
  now: Date = new Date()
): Promise<StripeEventOutcome> {
  const eventCreatedAt = stripeEventCreatedAt(event);
  const inserted = await query<InsertWebhookEventRow>(
    insertStripeWebhookEventStatement(event.id, event.type)
  );
  if (!inserted.rows[0]) {
    return { status: "duplicate" };
  }

  const outcome = await applyStripeEventInTransaction(
    query,
    event,
    eventCreatedAt,
    inserted.rows[0].stripe_receipt_order,
    now
  );
  if (outcome.status === "applied") {
    await query(
      associateStripeWebhookEventAccountStatement(event.id, outcome.accountId)
    );
  }
  return outcome;
}

export function billingAccountStatement(
  accountId: string
): TransactionContextStatement {
  return {
    sql: `
      select
        account_id::text as account_id,
        tier,
        billing_status,
        stripe_customer_id
      from public.agent_outbox_accounts
      where account_id = $1
        and deleted_at is null
    `,
    values: [accountId]
  };
}

export function insertStripeWebhookEventStatement(
  eventId: string,
  eventType: string
): TransactionContextStatement {
  // Omits the transitional processing_status column (and relies on the
  // processed_at default) so this writer stays valid after the contract
  // migration drops that column.
  return {
    sql: `
      insert into public.agent_outbox_stripe_webhook_events as webhook_event(
        stripe_event_id,
        event_type
      )
      values ($1, $2)
      on conflict (stripe_event_id) do nothing
      returning
        stripe_event_id,
        to_jsonb(webhook_event)->>'stripe_receipt_order' as stripe_receipt_order
    `,
    values: [eventId, eventType]
  };
}

export function associateStripeWebhookEventAccountStatement(
  eventId: string,
  accountId: string
): TransactionContextStatement {
  return {
    sql: `
      update public.agent_outbox_stripe_webhook_events
      set account_id = $2
      where stripe_event_id = $1
    `,
    values: [eventId, accountId]
  };
}

const CHECKOUT_ACCOUNT_MATCH_PREDICATE =
  "account_id = $1 and deleted_at is null";

function subscriptionAccountMatchPredicate(accountParameter: number) {
  return `deleted_at is null
        and (
          stripe_subscription_id = $1
          or ($2::text is not null and stripe_customer_id = $2::text)
          or ($${accountParameter}::uuid is not null and account_id = $${accountParameter}::uuid)
        )`;
}

function accountUpdateWithMatchStatement(
  update: TransactionContextStatement,
  matchPredicate: string
): TransactionContextStatement {
  return {
    // Both reads share the UPDATE's statement snapshot. A later concurrent
    // identifier attachment cannot turn a no-match into a stale outcome.
    sql: `
      with updated_account as (
        ${update.sql}
      )
      select account_id from updated_account
      union all
      select null::text as account_id
      where not exists (select 1 from updated_account)
        and exists (
          select 1 from public.agent_outbox_accounts
          where ${matchPredicate}
        )
    `,
    values: update.values
  };
}

export function checkoutCompletedAccountUpdateStatement(input: {
  accountId: string;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  eventCreatedAt: Date | null;
  eventReceiptOrder: string | null;
}): TransactionContextStatement {
  const ordering = stripeEventOrderingClause(input, 7);
  return accountUpdateWithMatchStatement(
    {
      sql: `
      update public.agent_outbox_accounts
      set
        tier = 'hosted_paid',
        billing_status = 'active',
        billing_grace_ends_at = null,
        stripe_customer_id = coalesce($2::text, stripe_customer_id),
        stripe_subscription_id = coalesce($3, stripe_subscription_id),
        stripe_price_id = coalesce($4, stripe_price_id),
        stripe_subscription_status = coalesce($5, stripe_subscription_status),
        stripe_current_period_end = $6,
        ${ordering.assignment}
        updated_at = now()
      where ${CHECKOUT_ACCOUNT_MATCH_PREDICATE}
        ${ordering.predicate}
      returning account_id::text as account_id
    `,
      values: [
        input.accountId,
        input.customerId,
        input.subscriptionId,
        input.priceId,
        input.subscriptionStatus,
        nullableTimestampValue(input.currentPeriodEnd),
        ...ordering.values
      ]
    },
    CHECKOUT_ACCOUNT_MATCH_PREDICATE
  );
}

function stripeEventOrderingClause(
  input: { eventCreatedAt: Date | null; eventReceiptOrder: string | null },
  createdAtParam: number
) {
  if (input.eventCreatedAt === null || input.eventReceiptOrder === null) {
    return { values: [], assignment: "", predicate: "" };
  }
  const createdAt = `$${createdAtParam}`;
  const receiptOrder = `$${createdAtParam + 1}`;
  return {
    values: [input.eventCreatedAt.toISOString(), input.eventReceiptOrder],
    assignment: `stripe_last_event_created_at = ${createdAt},
        stripe_last_event_receipt_order = ${receiptOrder},`,
    predicate: `and (
          stripe_last_event_created_at is null
          or stripe_last_event_created_at < ${createdAt}
          or (
            stripe_last_event_created_at = ${createdAt}
            and stripe_last_event_receipt_order <= ${receiptOrder}
          )
        )`
  };
}

export function subscriptionBillingUpdateStatement(input: {
  subscriptionId: string;
  customerId: string | null;
  priceId: string | null;
  accountId: string | null;
  subscriptionStatus: string;
  billingStatus: BillingStatus;
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  eventCreatedAt: Date | null;
  eventReceiptOrder: string | null;
}): TransactionContextStatement {
  const ordering = stripeEventOrderingClause(input, 9);
  return accountUpdateWithMatchStatement(
    {
      sql: `
      update public.agent_outbox_accounts
      set
        tier = case
          when $5 = 'active' then 'hosted_paid'
          else tier
        end,
        billing_status = $5,
        billing_grace_ends_at = $6,
        stripe_customer_id = coalesce($2, stripe_customer_id),
        stripe_subscription_id = $1,
        stripe_price_id = coalesce($3, stripe_price_id),
        stripe_subscription_status = $4,
        stripe_current_period_end = $7,
        ${ordering.assignment}
        updated_at = now()
      where ${subscriptionAccountMatchPredicate(8)}
        ${ordering.predicate}
      returning account_id::text as account_id
    `,
      values: [
        input.subscriptionId,
        input.customerId,
        input.priceId,
        input.subscriptionStatus,
        input.billingStatus,
        nullableTimestampValue(input.graceEndsAt),
        nullableTimestampValue(input.currentPeriodEnd),
        input.accountId,
        ...ordering.values
      ]
    },
    subscriptionAccountMatchPredicate(8)
  );
}

async function applyStripeEventInTransaction(
  query: ProductTransactionQuery,
  event: Stripe.Event,
  eventCreatedAt: Date,
  eventReceiptOrder: string | null,
  now: Date
): Promise<StripeEventOutcome> {
  switch (event.type) {
    case "checkout.session.completed":
      return applyCheckoutCompleted(
        query,
        event.data.object,
        eventCreatedAt,
        eventReceiptOrder
      );
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscriptionEvent(
        query,
        event.data.object,
        eventCreatedAt,
        eventReceiptOrder,
        now
      );
    case "invoice.payment_failed":
      return applyInvoicePaymentFailed(
        query,
        event.data.object,
        eventCreatedAt,
        eventReceiptOrder,
        now
      );
    default:
      return { status: "unhandled_type" };
  }
}

async function applyCheckoutCompleted(
  query: ProductTransactionQuery,
  session: Stripe.Event.Data.Object,
  eventCreatedAt: Date,
  eventReceiptOrder: string | null
): Promise<StripeEventOutcome> {
  if (!isJsonRecord(session)) {
    return { status: "unapplied", reason: "invalid_object", accountId: null };
  }
  const accountId =
    stringValue(session.client_reference_id) ??
    stringValue(recordValue(session.metadata, "account_id"));
  if (!accountId) {
    return {
      status: "unapplied",
      reason: "missing_reference",
      accountId: null
    };
  }

  const result = await query<AccountUpdateRow>(
    checkoutCompletedAccountUpdateStatement({
      accountId,
      customerId: stripeId(session.customer),
      subscriptionId: stripeId(session.subscription),
      priceId: null,
      subscriptionStatus: "checkout_completed",
      currentPeriodEnd: null,
      eventCreatedAt,
      eventReceiptOrder
    })
  );

  return accountUpdateOutcome(result.rows, accountId);
}

async function applySubscriptionEvent(
  query: ProductTransactionQuery,
  object: Stripe.Event.Data.Object,
  eventCreatedAt: Date,
  eventReceiptOrder: string | null,
  now: Date
): Promise<StripeEventOutcome> {
  if (!isJsonRecord(object)) {
    return { status: "unapplied", reason: "invalid_object", accountId: null };
  }
  const subscriptionId = stringValue(object.id);
  if (!subscriptionId) {
    return {
      status: "unapplied",
      reason: "missing_reference",
      accountId: null
    };
  }
  const match = {
    subscriptionId,
    customerId: stripeId(object.customer),
    accountId: stringValue(recordValue(object.metadata, "account_id"))
  };
  const status = stringValue(object.status) ?? "unknown";
  const currentPeriodEnd = subscriptionCurrentPeriodEnd(object);
  const transition = billingTransitionForSubscription(
    object,
    currentPeriodEnd,
    now
  );
  const result = await query<AccountUpdateRow>(
    subscriptionBillingUpdateStatement({
      ...match,
      priceId: subscriptionPriceId(object),
      subscriptionStatus: status,
      billingStatus: transition.billingStatus,
      graceEndsAt: transition.graceEndsAt,
      currentPeriodEnd,
      eventCreatedAt,
      eventReceiptOrder
    })
  );

  return accountUpdateOutcome(result.rows, match.accountId);
}

async function applyInvoicePaymentFailed(
  query: ProductTransactionQuery,
  object: Stripe.Event.Data.Object,
  eventCreatedAt: Date,
  eventReceiptOrder: string | null,
  now: Date
): Promise<StripeEventOutcome> {
  if (!isJsonRecord(object)) {
    return { status: "unapplied", reason: "invalid_object", accountId: null };
  }
  const subscriptionId = invoiceSubscriptionId(object);
  if (!subscriptionId) {
    return {
      status: "unapplied",
      reason: "missing_reference",
      accountId: null
    };
  }

  const match = {
    subscriptionId,
    customerId: stripeId(recordValue(object, "customer")),
    accountId: null
  };
  const result = await query<AccountUpdateRow>(
    subscriptionBillingUpdateStatement({
      ...match,
      priceId: null,
      subscriptionStatus: "payment_failed",
      billingStatus: "past_due",
      graceEndsAt: graceEndsAt(now),
      currentPeriodEnd: null,
      eventCreatedAt,
      eventReceiptOrder
    })
  );

  return accountUpdateOutcome(result.rows, match.accountId);
}

function accountUpdateOutcome(
  updatedRows: AccountUpdateRow[],
  accountId: string | null
): StripeEventOutcome {
  if (updatedRows[0]?.account_id) {
    return { status: "applied", accountId: updatedRows[0].account_id };
  }
  // A null account id represents a match rejected by the ordering predicate;
  // no rows means no account matched in the update's statement snapshot.
  return updatedRows[0]
    ? { status: "stale_ordering" }
    : { status: "unapplied", reason: "no_matching_account", accountId };
}

function billingTransitionForSubscription(
  subscription: Record<string, unknown>,
  currentPeriodEnd: Date | null,
  now: Date
): { billingStatus: BillingStatus; graceEndsAt: Date | null } {
  const status = stringValue(subscription.status);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end === true;

  if ((status === "active" || status === "trialing") && !cancelAtPeriodEnd) {
    return { billingStatus: "active", graceEndsAt: null };
  }
  if ((status === "active" || status === "trialing") && cancelAtPeriodEnd) {
    if (!currentPeriodEnd) {
      throw new Error(
        "Stripe subscription scheduled to cancel at period end has no current period end."
      );
    }
    return { billingStatus: "grace", graceEndsAt: currentPeriodEnd };
  }
  if (status === "canceled" || status === "incomplete_expired") {
    return { billingStatus: "canceled", graceEndsAt: graceEndsAt(now) };
  }
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return { billingStatus: "past_due", graceEndsAt: graceEndsAt(now) };
  }

  return { billingStatus: "grace", graceEndsAt: graceEndsAt(now) };
}

function billingRuntime(
  surface: "checkout" | "portal" | "webhook",
  input: { config?: BillingConfig; stripe?: StripeClient }
): ApiResult<{ config: BillingConfig; stripe: StripeClient }> {
  const configResult = input.config
    ? { ok: true as const, data: input.config }
    : billingRuntimeConfig(surface);
  if (!configResult.ok) {
    return configResult;
  }
  const config = configResult.data;
  return {
    ok: true,
    data: { config, stripe: input.stripe ?? stripeClient(config) }
  };
}

function stripeClient(config: BillingConfig): StripeClient {
  return new Stripe(config.secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    timeout: 10_000
  });
}

function hasLiveBillingState(status: BillingStatus) {
  return status === "active" || status === "grace" || status === "past_due";
}

function invalidBillingRequest(message: string): ApiResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

function checkoutIntervalFromValue(value: unknown): ApiResult<BillingInterval> {
  if (value === "monthly" || value === "yearly") {
    return { ok: true, data: value };
  }

  return invalidBillingRequest(
    'Checkout interval must be either "monthly" or "yearly".'
  );
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isJsonRecord(value)) {
    return stringValue(value.id);
  }
  return null;
}

function subscriptionPriceId(subscription: Record<string, unknown>) {
  const items = recordValue(subscription, "items");
  if (!isJsonRecord(items) || !Array.isArray(items.data)) {
    return null;
  }
  const firstItem = items.data[0];
  if (!isJsonRecord(firstItem)) {
    return null;
  }
  const price = recordValue(firstItem, "price");
  if (!isJsonRecord(price)) {
    return null;
  }
  return stringValue(price.id);
}

// API versions from 2025-03-31.basil report billing periods per subscription
// item; earlier versions report one subscription-level period. Mixed-interval
// subscriptions cancel at period end on the earliest item period end.
function subscriptionCurrentPeriodEnd(
  subscription: Record<string, unknown>
): Date | null {
  const subscriptionPeriodEnd = stripeTimestamp(
    subscription.current_period_end
  );
  if (subscriptionPeriodEnd) {
    return subscriptionPeriodEnd;
  }
  const items = recordValue(subscription, "items");
  if (!isJsonRecord(items) || !Array.isArray(items.data)) {
    return null;
  }
  let earliest: Date | null = null;
  for (const item of items.data) {
    const itemPeriodEnd = stripeTimestamp(
      recordValue(item, "current_period_end")
    );
    if (itemPeriodEnd && (!earliest || itemPeriodEnd < earliest)) {
      earliest = itemPeriodEnd;
    }
  }
  return earliest;
}

// API versions from 2025-03-31.basil move an invoice's subscription under
// `parent.subscription_details`; earlier versions use `subscription`.
function invoiceSubscriptionId(invoice: Record<string, unknown>) {
  const subscriptionDetails = recordValue(
    recordValue(invoice, "parent"),
    "subscription_details"
  );
  return (
    stripeId(recordValue(subscriptionDetails, "subscription")) ??
    stripeId(invoice.subscription)
  );
}

function recordValue(record: unknown, key: string): unknown {
  return isJsonRecord(record) ? record[key] : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function stripeEventCreatedAt(event: Stripe.Event): Date {
  const created = event.created;
  if (
    typeof created !== "number" ||
    !Number.isInteger(created) ||
    created < 0
  ) {
    throw new Error(
      "Stripe event created timestamp must be a non-negative integer Unix second value."
    );
  }

  const milliseconds = created * 1000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > MAX_DATE_MILLISECONDS
  ) {
    throw new Error(
      "Stripe event created timestamp is outside the supported JavaScript Date range."
    );
  }

  return new Date(milliseconds);
}

function stripeTimestamp(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
}

function graceEndsAt(now: Date) {
  return new Date(now.getTime() + BILLING_GRACE_DAYS * ONE_DAY_MS);
}

function nullableTimestampValue(value: Date | null) {
  return value ? value.toISOString() : null;
}
