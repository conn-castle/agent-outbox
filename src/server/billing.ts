import Stripe from "stripe";

import type { ApiErrorInput, ApiRequestContext } from "./api-errors.ts";
import {
  runProductTransaction,
  type ProductTransactionQuery,
  type TransactionContextStatement
} from "./database.ts";
import { readJsonBodyWithLimit } from "./input-schema.ts";
import { durationSinceMs, emitRuntimeLog, safeErrorName } from "./logging.ts";
import { reportRuntimeFailure } from "./sentry.ts";

const BILLING_GRACE_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
};

type AccountIdRow = {
  account_id: string;
};

export type BillingResult<TData> =
  { ok: true; data: TData } | { ok: false; error: ApiErrorInput };

export type BillingCheckoutData = {
  url: string;
};

export type BillingPortalData = {
  url: string;
};

export type BillingWebhookData = {
  processed: boolean;
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
  surface: "checkout" | "portal" | "webhook" | "all" = "all"
): BillingResult<BillingConfig> {
  const missing =
    surface === "all"
      ? [
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "STRIPE_PAID_MONTHLY_PRICE_ID",
          "STRIPE_PAID_YEARLY_PRICE_ID",
          "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
          "PUBLIC_APP_BASE_URL"
        ].filter((name) => !process.env[name]?.trim())
      : requiredBillingConfiguration(surface);

  if (missing.length > 0) {
    return {
      ok: false,
      error: billingConfigurationError(missing)
    };
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
      publicAppBaseUrl: process.env.PUBLIC_APP_BASE_URL?.trim() ?? ""
    }
  };
}

export async function checkoutIntervalFromRequest(
  request: Request
): Promise<BillingResult<BillingInterval>> {
  const body = await readJsonBodyWithLimit(request);
  if (!body.ok) {
    return body;
  }

  return checkoutIntervalFromBody(body.value);
}

function checkoutIntervalFromBody(
  body: unknown
): BillingResult<BillingInterval> {
  if (!isStripeRecord(body)) {
    return invalidBillingRequest(
      'Checkout request body must be a JSON object with interval "monthly" or "yearly".'
    );
  }

  return checkoutIntervalFromValue(recordValue(body, "interval"));
}

export async function createCheckoutSessionForAccount(input: {
  account: BillingAccount;
  requestId: string;
  interval: unknown;
  context?: ApiRequestContext;
  config?: BillingConfig;
  stripe?: StripeClient;
}): Promise<BillingResult<BillingCheckoutData>> {
  const intervalResult = checkoutIntervalFromValue(input.interval);
  if (!intervalResult.ok) {
    return intervalResult;
  }

  const configResult = input.config
    ? { ok: true as const, data: input.config }
    : billingRuntimeConfig("checkout");
  if (!configResult.ok) {
    return configResult;
  }
  const config = configResult.data;
  const stripe = input.stripe ?? stripeClient(config);
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
    return billingRuntimeFailure(error, {
      context: input.context,
      requestId: input.requestId,
      accountId: account.account_id,
      operation: "stripe_checkout_session_create",
      message: "Stripe checkout session creation failed unexpectedly.",
      responseMessage: "Checkout session is temporarily unavailable."
    });
  }

  if (!session.url) {
    return temporaryUnavailableError("Checkout session is unavailable.");
  }

  return { ok: true, data: { url: session.url } };
}

export async function createBillingPortalSessionForAccount(input: {
  account: BillingAccount;
  requestId: string;
  context?: ApiRequestContext;
  config?: BillingConfig;
  stripe?: StripeClient;
}): Promise<BillingResult<BillingPortalData>> {
  const configResult = input.config
    ? { ok: true as const, data: input.config }
    : billingRuntimeConfig("portal");
  if (!configResult.ok) {
    return configResult;
  }
  const config = configResult.data;
  const stripe = input.stripe ?? stripeClient(config);
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
    return billingRuntimeFailure(error, {
      context: input.context,
      requestId: input.requestId,
      accountId: account.account_id,
      operation: "stripe_billing_portal_session_create",
      message: "Stripe billing portal session creation failed unexpectedly.",
      responseMessage: "Billing portal is temporarily unavailable."
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
): Promise<BillingResult<BillingWebhookData>> {
  const configResult = input.config
    ? { ok: true as const, data: input.config }
    : billingRuntimeConfig("webhook");
  if (!configResult.ok) {
    return configResult;
  }
  const config = configResult.data;
  const stripe = input.stripe ?? stripeClient(config);
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return invalidBillingRequest("Stripe signature is required.");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await request.text(),
      signature,
      config.webhookSecret
    );
  } catch (error) {
    emitRuntimeLog({
      level: "warn",
      error_id: context.correlationId,
      request_id: context.requestId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 400,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation: "stripe_webhook_signature",
      message: "Stripe webhook signature verification failed.",
      error_name: safeErrorName(error)
    });
    return invalidBillingRequest("Stripe signature verification failed.");
  }

  let processed: boolean;
  try {
    const runTransaction = input.runTransaction ?? runProductTransaction;
    processed = await runTransaction(
      input.connectionString,
      { requestId: context.requestId, authSurface: "control_plane" },
      (query) => processStripeEventInTransaction(query, event, input.now)
    );
  } catch (error) {
    reportRuntimeFailure(error, {
      errorId: context.correlationId,
      request_id: context.requestId,
      surface: "api",
      route: context.route,
      method: context.method,
      status_code: 503,
      duration_ms: durationSinceMs(context.startedAtMs),
      operation: "stripe_webhook_processing",
      message: "Stripe webhook processing failed unexpectedly."
    });
    return temporaryUnavailableError(
      "Stripe webhook processing is temporarily unavailable.",
      context.correlationId,
      { reported: true }
    );
  }

  return { ok: true, data: { processed } };
}

export async function processStripeEventInTransaction(
  query: ProductTransactionQuery,
  event: Stripe.Event,
  now: Date = new Date()
): Promise<boolean> {
  const inserted = await query<InsertWebhookEventRow>(
    insertStripeWebhookEventStatement(event.id, event.type)
  );
  if (!inserted.rows[0]) {
    return false;
  }

  const accountId = await applyStripeEventInTransaction(query, event, now);
  if (accountId) {
    await query(
      associateStripeWebhookEventAccountStatement(event.id, accountId)
    );
  }
  return true;
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
  // The explicit processing_status/processed_at writes keep this insert valid
  // on both the pre-V20260711114816 schema (NOT NULL, no default) and the
  // migrated schema, so deploy and migration order are independent. Remove the
  // explicit column write together with the tracked contract migration
  // (ISSUES.md stripe-webhook-status-contract-migration).
  return {
    sql: `
      insert into public.agent_outbox_stripe_webhook_events(
        stripe_event_id,
        event_type,
        processing_status,
        processed_at
      )
      values ($1, $2, 'processed', now())
      on conflict (stripe_event_id) do nothing
      returning stripe_event_id
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

export function checkoutCompletedAccountUpdateStatement(input: {
  accountId: string;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
}): TransactionContextStatement {
  return {
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
        updated_at = now()
      where account_id = $1
        and deleted_at is null
      returning account_id::text as account_id
    `,
    values: [
      input.accountId,
      input.customerId,
      input.subscriptionId,
      input.priceId,
      input.subscriptionStatus,
      nullableTimestampValue(input.currentPeriodEnd)
    ]
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
}): TransactionContextStatement {
  return {
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
        updated_at = now()
      where deleted_at is null
        and (
          stripe_subscription_id = $1
          or ($2::text is not null and stripe_customer_id = $2::text)
          or ($8::uuid is not null and account_id = $8::uuid)
        )
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
      input.accountId
    ]
  };
}

async function applyStripeEventInTransaction(
  query: ProductTransactionQuery,
  event: Stripe.Event,
  now: Date
): Promise<string | null> {
  switch (event.type) {
    case "checkout.session.completed":
      return applyCheckoutCompleted(query, event.data.object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscriptionEvent(query, event.data.object, now);
    case "invoice.payment_failed":
      return applyInvoicePaymentFailed(query, event.data.object, now);
    default:
      return null;
  }
}

async function applyCheckoutCompleted(
  query: ProductTransactionQuery,
  session: Stripe.Event.Data.Object
): Promise<string | null> {
  if (!isStripeRecord(session)) {
    return null;
  }
  const accountId =
    stringValue(session.client_reference_id) ??
    stringValue(recordValue(session.metadata, "account_id"));
  if (!accountId) {
    return null;
  }

  const result = await query<AccountIdRow>(
    checkoutCompletedAccountUpdateStatement({
      accountId,
      customerId: stripeId(session.customer),
      subscriptionId: stripeId(session.subscription),
      priceId: null,
      subscriptionStatus: "checkout_completed",
      currentPeriodEnd: null
    })
  );

  return result.rows[0]?.account_id ?? null;
}

async function applySubscriptionEvent(
  query: ProductTransactionQuery,
  object: Stripe.Event.Data.Object,
  now: Date
): Promise<string | null> {
  if (!isStripeRecord(object)) {
    return null;
  }
  const subscriptionId = stringValue(object.id);
  if (!subscriptionId) {
    return null;
  }
  const status = stringValue(object.status) ?? "unknown";
  const transition = billingTransitionForSubscription(object, now);
  const result = await query<AccountIdRow>(
    subscriptionBillingUpdateStatement({
      subscriptionId,
      customerId: stripeId(object.customer),
      priceId: subscriptionPriceId(object),
      accountId: stringValue(recordValue(object.metadata, "account_id")),
      subscriptionStatus: status,
      billingStatus: transition.billingStatus,
      graceEndsAt: transition.graceEndsAt,
      currentPeriodEnd: stripeTimestamp(
        recordValue(object, "current_period_end")
      )
    })
  );

  return result.rows[0]?.account_id ?? null;
}

async function applyInvoicePaymentFailed(
  query: ProductTransactionQuery,
  object: Stripe.Event.Data.Object,
  now: Date
): Promise<string | null> {
  if (!isStripeRecord(object)) {
    return null;
  }
  const subscriptionId = stripeId(recordValue(object, "subscription"));
  if (!subscriptionId) {
    return null;
  }

  const result = await query<AccountIdRow>(
    subscriptionBillingUpdateStatement({
      subscriptionId,
      customerId: stripeId(recordValue(object, "customer")),
      priceId: null,
      accountId: null,
      subscriptionStatus: "payment_failed",
      billingStatus: "past_due",
      graceEndsAt: graceEndsAt(now),
      currentPeriodEnd: null
    })
  );

  return result.rows[0]?.account_id ?? null;
}

function billingTransitionForSubscription(
  subscription: Record<string, unknown>,
  now: Date
): { billingStatus: BillingStatus; graceEndsAt: Date | null } {
  const status = stringValue(subscription.status);
  const currentPeriodEnd = stripeTimestamp(
    recordValue(subscription, "current_period_end")
  );
  const cancelAtPeriodEnd = subscription.cancel_at_period_end === true;

  if ((status === "active" || status === "trialing") && !cancelAtPeriodEnd) {
    return { billingStatus: "active", graceEndsAt: null };
  }
  if ((status === "active" || status === "trialing") && cancelAtPeriodEnd) {
    return {
      billingStatus: "grace",
      graceEndsAt: currentPeriodEnd ?? graceEndsAt(now)
    };
  }
  if (status === "canceled" || status === "incomplete_expired") {
    return { billingStatus: "canceled", graceEndsAt: graceEndsAt(now) };
  }
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return { billingStatus: "past_due", graceEndsAt: graceEndsAt(now) };
  }

  return { billingStatus: "grace", graceEndsAt: graceEndsAt(now) };
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

function billingConfigurationError(missing: readonly string[]): ApiErrorInput {
  return {
    status: 503,
    code: "temporary_unavailable",
    message: `Billing configuration is missing required variable names: ${missing.join(", ")}.`
  };
}

function invalidBillingRequest(message: string): BillingResult<never> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message
    }
  };
}

function checkoutIntervalFromValue(
  value: unknown
): BillingResult<BillingInterval> {
  if (value === "monthly" || value === "yearly") {
    return { ok: true, data: value };
  }

  return invalidBillingRequest(
    'Checkout interval must be either "monthly" or "yearly".'
  );
}

function temporaryUnavailableError(
  message: string,
  errorId?: string,
  options?: { reported?: boolean }
): BillingResult<never> {
  return {
    ok: false,
    error: {
      status: 503,
      code: "temporary_unavailable",
      message,
      ...(errorId ? { errorId } : {}),
      ...(options?.reported ? { reported: true } : {})
    }
  };
}

export function billingRuntimeFailure(
  error: unknown,
  input: {
    context?: ApiRequestContext;
    requestId: string;
    accountId?: string;
    operation: string;
    message: string;
    responseMessage: string;
  }
): BillingResult<never> {
  const errorId = input.context?.correlationId ?? input.requestId;
  reportRuntimeFailure(error, {
    errorId,
    request_id: input.context?.requestId ?? input.requestId,
    surface: "api",
    route: input.context?.route,
    method: input.context?.method,
    status_code: 503,
    duration_ms: durationSinceMs(input.context?.startedAtMs),
    operation: input.operation,
    account_id: input.accountId,
    message: input.message
  });

  return temporaryUnavailableError(input.responseMessage, errorId, {
    reported: true
  });
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isStripeRecord(value)) {
    return stringValue(value.id);
  }
  return null;
}

function subscriptionPriceId(subscription: Record<string, unknown>) {
  const items = recordValue(subscription, "items");
  if (!isStripeRecord(items) || !Array.isArray(items.data)) {
    return null;
  }
  const firstItem = items.data[0];
  if (!isStripeRecord(firstItem)) {
    return null;
  }
  const price = recordValue(firstItem, "price");
  if (!isStripeRecord(price)) {
    return null;
  }
  return stringValue(price.id);
}

function recordValue(record: unknown, key: string): unknown {
  return isStripeRecord(record) ? record[key] : undefined;
}

function isStripeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
