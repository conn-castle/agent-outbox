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
  safeErrorCode,
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

type StripeClient = Pick<
  Stripe,
  "checkout" | "billingPortal" | "webhooks" | "subscriptions"
>;
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
      reason:
        | "invalid_object"
        | "missing_reference"
        | "no_matching_account"
        | "billing_conflict";
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

export type CheckoutTransactionRunner = <T>(
  callback: (query: ProductTransactionQuery) => Promise<T>
) => Promise<T>;

type CheckoutAccount = BillingAccount & {
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
  stripe_terminal_subscription_id: string | null;
};

type CheckoutAttempt = {
  account_id: string;
  attempt_id: string;
  billing_interval: BillingInterval;
  creation_parameters: Stripe.Checkout.SessionCreateParams;
  stripe_api_version: string;
  stripe_session_id: string | null;
  stripe_subscription_id: string | null;
  created_at: Date | string;
};

class CheckoutUnavailable extends Error {
  readonly status: 400 | 503;
  constructor(message: string, status: 400 | 503 = 503) {
    super(message);
    this.status = status;
  }
}

function terminalSubscription(status: string | null) {
  return status === "canceled" || status === "incomplete_expired";
}

function hasTerminalSubscription(account: CheckoutAccount) {
  return (
    !!account.stripe_subscription_id &&
    (account.stripe_terminal_subscription_id ===
      account.stripe_subscription_id ||
      terminalSubscription(account.stripe_subscription_status))
  );
}

async function lockedCheckoutState(
  query: ProductTransactionQuery,
  accountId: string
) {
  const accounts = await query<CheckoutAccount>({
    sql: `select account_id::text, tier, billing_status, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_status, stripe_terminal_subscription_id
      from public.agent_outbox_accounts
      where account_id = $1 and deleted_at is null for update`,
    values: [accountId]
  });
  const account = accounts.rows[0];
  if (!account)
    throw new CheckoutUnavailable("Billing account is unavailable.");
  const attempts = await query<CheckoutAttempt>({
    sql: `select * from public.agent_outbox_billing_checkout_attempts where account_id = $1`,
    values: [accountId]
  });
  return { account, attempt: attempts.rows[0] ?? null };
}

function assertCheckoutEligible(account: CheckoutAccount) {
  if (account.tier === "self_hosted") {
    throw new CheckoutUnavailable(
      "Self-hosted accounts do not use Stripe.",
      400
    );
  }
  if (hasLiveBillingState(account.billing_status)) {
    throw new CheckoutUnavailable(
      "Active billing accounts must use the billing portal.",
      400
    );
  }
  if (account.stripe_subscription_id && !hasTerminalSubscription(account)) {
    throw new CheckoutUnavailable(
      "We could not confirm that your previous subscription has ended. Please try again or contact support."
    );
  }
}

export async function createCheckoutSessionForAccount(input: {
  account: BillingAccount;
  interval: unknown;
  context: ApiRequestContext;
  config?: BillingConfig;
  stripe?: StripeClient;
  runCheckoutTransaction?: CheckoutTransactionRunner;
  now?: () => Date;
}): Promise<ApiResult<BillingCheckoutData>> {
  const intervalResult = checkoutIntervalFromValue(input.interval);
  if (!intervalResult.ok) return intervalResult;
  const runtime = billingRuntime("checkout", input);
  if (!runtime.ok) return runtime;
  const { config, stripe } = runtime.data;
  const run = input.runCheckoutTransaction;
  if (!run)
    return apiTemporaryUnavailable(
      "Checkout is temporarily unavailable. Please try again."
    );
  const accountId = input.account.account_id;
  const interval = intervalResult.data;
  const now = input.now ?? (() => new Date());
  const checkoutLog: Pick<
    RuntimeLogEvent,
    | "billing_attempt_id"
    | "billing_attempt_created_at"
    | "checkout_failure_reason"
    | "stripe_session_status"
    | "stripe_payment_status"
  > = {};
  const recordSessionState = (session: Stripe.Checkout.Session) => {
    // Only fixed provider enums are safe; unexpected values may contain secrets.
    checkoutLog.stripe_session_status =
      session.status === "open"
        ? "open"
        : session.status === "complete"
          ? "complete"
          : session.status === "expired"
            ? "expired"
            : "unknown";
    checkoutLog.stripe_payment_status =
      session.payment_status === "paid"
        ? "paid"
        : session.payment_status === "unpaid"
          ? "unpaid"
          : session.payment_status === "no_payment_required"
            ? "no_payment_required"
            : "unknown";
  };
  try {
    let state = await run((query) => lockedCheckoutState(query, accountId));
    if (state.attempt) {
      checkoutLog.billing_attempt_id = state.attempt.attempt_id;
      checkoutLog.billing_attempt_created_at = new Date(
        state.attempt.created_at
      ).toISOString();
    }
    // Grace cleanup can clear provider status without terminating the subscription.
    // Retrieve outside the account lock, then revalidate the same identity inside it.
    const previousId = state.account.stripe_subscription_id;
    if (
      previousId &&
      !hasLiveBillingState(state.account.billing_status) &&
      !hasTerminalSubscription(state.account)
    ) {
      checkoutLog.checkout_failure_reason =
        "previous_subscription_retrieve_failed";
      const previous = await stripe.subscriptions.retrieve(previousId);
      checkoutLog.checkout_failure_reason = "previous_subscription_not_ended";
      if (
        previous.id !== previousId ||
        !terminalSubscription(previous.status)
      ) {
        throw new CheckoutUnavailable(
          "Your previous subscription has not ended. Contact support."
        );
      }
      checkoutLog.checkout_failure_reason =
        "previous_subscription_confirmation_failed";
      state = await run(async (query) => {
        const current = await lockedCheckoutState(query, accountId);
        if (current.account.stripe_subscription_id !== previousId) {
          throw new CheckoutUnavailable(
            "Billing changed while confirming the previous subscription. Retry checkout."
          );
        }
        await query({
          sql: `update public.agent_outbox_accounts set stripe_terminal_subscription_id = $2
            where account_id = $1 and stripe_subscription_id = $2`,
          values: [accountId, previousId]
        });
        current.account.stripe_terminal_subscription_id = previousId;
        return current;
      });
    }
    assertCheckoutEligible(state.account);

    const reserve = async (observed: CheckoutAttempt | null) => {
      const attemptId = crypto.randomUUID();
      let reserved = false;
      const mutation = async (query: ProductTransactionQuery) => {
        const current = await lockedCheckoutState(query, accountId);
        assertCheckoutEligible(current.account);
        if (
          (current.attempt?.attempt_id ?? null) !==
          (observed?.attempt_id ?? null)
        ) {
          throw new CheckoutUnavailable(
            "Your billing selection changed. Please try again with your preferred billing interval."
          );
        }
        const metadata = {
          account_id: accountId,
          billing_attempt_id: attemptId
        };
        const parameters: Stripe.Checkout.SessionCreateParams = {
          mode: "subscription",
          ...(current.account.stripe_customer_id
            ? { customer: current.account.stripe_customer_id }
            : {}),
          client_reference_id: accountId,
          line_items: [{ price: config.priceIds[interval], quantity: 1 }],
          success_url: `${config.publicAppBaseUrl}/upgrade?checkout=success`,
          cancel_url: `${config.publicAppBaseUrl}/upgrade?checkout=cancelled`,
          metadata,
          subscription_data: { metadata }
        };
        // The account lock serializes insertion and conditional replacement.
        const result = await query<CheckoutAttempt>({
          sql: `insert into public.agent_outbox_billing_checkout_attempts
            (account_id, attempt_id, billing_interval, creation_parameters, stripe_api_version)
            values ($1, $2, $3, $4::jsonb, $5)
            on conflict (account_id) do update set attempt_id = excluded.attempt_id,
              billing_interval = excluded.billing_interval, creation_parameters = excluded.creation_parameters,
              stripe_api_version = excluded.stripe_api_version, stripe_session_id = null,
              stripe_subscription_id = null, created_at = now()
            where agent_outbox_billing_checkout_attempts.attempt_id = $6::uuid
            returning *`,
          values: [
            accountId,
            attemptId,
            interval,
            JSON.stringify(parameters),
            Stripe.API_VERSION,
            observed?.attempt_id ?? null
          ]
        });
        if (!result.rows[0])
          throw new CheckoutUnavailable(
            "Your billing selection changed. Please try again."
          );
        reserved = true;
        return result.rows[0];
      };
      try {
        return await run(mutation);
      } catch (error) {
        if (!reserved) throw error;
        // COMMIT acknowledgement loss is not evidence of rollback. Never dispatch
        // until a fresh transaction proves this exact reservation is current.
        const current = await run((query) =>
          lockedCheckoutState(query, accountId)
        );
        assertCheckoutEligible(current.account);
        if (current.attempt?.attempt_id !== attemptId) throw error;
        return current.attempt;
      }
    };

    let attempt = state.attempt;
    if (!attempt) {
      checkoutLog.checkout_failure_reason = "reservation_unconfirmed";
      try {
        attempt = await reserve(null);
      } catch (error) {
        // Another request can win the first reservation. Reuse its key; never
        // overwrite it merely because our initial read saw no attempt.
        const current = await run((query) =>
          lockedCheckoutState(query, accountId)
        );
        assertCheckoutEligible(current.account);
        if (!current.attempt) throw error;
        attempt = current.attempt;
      }
    }

    checkoutLog.billing_attempt_id = attempt.attempt_id;
    checkoutLog.billing_attempt_created_at = new Date(
      attempt.created_at
    ).toISOString();
    let session: Stripe.Checkout.Session;
    if (!attempt.stripe_session_id) {
      // Recheck just before dispatch. Never replay outside the ORIGINAL window,
      // even if Stripe returned a cached error or the first response was lost.
      const current = await run((query) =>
        lockedCheckoutState(query, accountId)
      );
      assertCheckoutEligible(current.account);
      if (current.attempt?.attempt_id !== attempt.attempt_id) {
        throw new CheckoutUnavailable(
          "Your billing selection changed. Please try again."
        );
      }
      if (
        now().getTime() >=
        new Date(attempt.created_at).getTime() + ONE_DAY_MS
      ) {
        checkoutLog.checkout_failure_reason = "creation_retention_exceeded";
        throw new CheckoutUnavailable(
          "We could not confirm your previous checkout. Contact support before starting another purchase."
        );
      }
      checkoutLog.checkout_failure_reason = "creation_unresolved";
      const created = await stripe.checkout.sessions.create(
        attempt.creation_parameters,
        {
          idempotencyKey: attempt.attempt_id,
          apiVersion: attempt.stripe_api_version
        }
      );
      if (!created.id)
        throw new CheckoutUnavailable(
          "Stripe did not identify the checkout. Retry the same interval or contact support."
        );
      checkoutLog.checkout_failure_reason = "session_attachment_unconfirmed";
      const attach = async (query: ProductTransactionQuery) => {
        const current = await lockedCheckoutState(query, accountId);
        assertCheckoutEligible(current.account);
        if (
          current.attempt?.attempt_id !== attempt.attempt_id ||
          (current.attempt.stripe_session_id &&
            current.attempt.stripe_session_id !== created.id)
        ) {
          throw new CheckoutUnavailable(
            "We could not confirm your checkout. Please try again."
          );
        }
        await query({
          sql: `update public.agent_outbox_billing_checkout_attempts set stripe_session_id = $3
            where account_id = $1 and attempt_id = $2 and (stripe_session_id is null or stripe_session_id = $3)`,
          values: [accountId, attempt.attempt_id, created.id]
        });
      };
      try {
        await run(attach);
      } catch (error) {
        const current = await run((query) =>
          lockedCheckoutState(query, accountId)
        );
        assertCheckoutEligible(current.account);
        if (
          current.attempt?.attempt_id !== attempt.attempt_id ||
          current.attempt.stripe_session_id !== created.id
        )
          throw error;
        // Do not expire: another request may already have returned this shared URL.
      }
      attempt = { ...attempt, stripe_session_id: created.id };
    }
    checkoutLog.checkout_failure_reason = "session_retrieve_failed";
    session = await stripe.checkout.sessions.retrieve(
      attempt.stripe_session_id!
    );
    recordSessionState(session);
    checkoutLog.checkout_failure_reason = "session_identity_mismatch";
    if (
      session.id !== attempt.stripe_session_id ||
      session.client_reference_id !== accountId ||
      session.metadata?.billing_attempt_id !== attempt.attempt_id ||
      session.metadata?.account_id !== accountId
    ) {
      throw new CheckoutUnavailable(
        "Checkout identity could not be confirmed. Contact support."
      );
    }
    const terminalPriorPurchase =
      hasTerminalSubscription(state.account) &&
      stripeId(session.subscription) === state.account.stripe_subscription_id;
    const terminalAuthorizedAttempt =
      hasTerminalSubscription(state.account) &&
      attempt.stripe_subscription_id === state.account.stripe_subscription_id;
    if (session.status === "complete") {
      checkoutLog.checkout_failure_reason = "session_complete";
      if (terminalPriorPurchase) {
        checkoutLog.checkout_failure_reason =
          "replacement_reservation_unconfirmed";
        await reserve(attempt);
        return createCheckoutSessionForAccount(input);
      }
      throw new CheckoutUnavailable(
        "Checkout is complete and billing is settling. Refresh your account or contact support."
      );
    }
    if (
      session.status === "open" &&
      (attempt.billing_interval !== interval ||
        terminalPriorPurchase ||
        terminalAuthorizedAttempt)
    ) {
      if (session.payment_status !== "unpaid") {
        checkoutLog.checkout_failure_reason = "payment_not_unpaid";
        throw new CheckoutUnavailable(
          "Checkout payment is settling. Refresh your account before purchasing."
        );
      }
      // A completion can win against expiration. Even timeout requires live proof.
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (error) {
        emitRuntimeLog({
          level: "error",
          surface: "api",
          route: input.context.route,
          method: input.context.method,
          request_id: input.context.requestId,
          error_id: input.context.correlationId,
          duration_ms: durationSinceMs(input.context.startedAtMs),
          account_id: accountId,
          operation: "stripe_checkout_session_expire",
          ...checkoutLog,
          checkout_failure_reason: "expiration_failed",
          error_name: safeErrorName(error),
          error_code: safeErrorCode(error),
          message:
            "Checkout expiration failed; live confirmation is required before replacement."
        });
      }
      // On retrieval failure, logs retain the last successfully retrieved state.
      checkoutLog.checkout_failure_reason = "expiration_confirmation_failed";
      session = await stripe.checkout.sessions.retrieve(session.id);
      recordSessionState(session);
      checkoutLog.checkout_failure_reason = "expired_session_identity_mismatch";
      if (session.id !== attempt.stripe_session_id) {
        throw new CheckoutUnavailable(
          "Expired checkout identity could not be confirmed. Contact support."
        );
      }
    }
    if (session.status === "expired") {
      checkoutLog.checkout_failure_reason =
        "replacement_reservation_unconfirmed";
      await reserve(attempt);
      // Reservation has committed. Reenter through the same protocol and key.
      return createCheckoutSessionForAccount(input);
    }
    if (
      session.status !== "open" ||
      session.payment_status !== "unpaid" ||
      attempt.billing_interval !== interval ||
      !session.url
    ) {
      checkoutLog.checkout_failure_reason =
        session.status === "complete"
          ? "session_complete"
          : session.status !== "open"
            ? "session_status_unknown"
            : session.payment_status !== "unpaid"
              ? "payment_not_unpaid"
              : attempt.billing_interval !== interval
                ? "interval_mismatch"
                : "session_url_missing";
      throw new CheckoutUnavailable(
        "Checkout state could not be confirmed. Retry your selected interval or contact support."
      );
    }
    checkoutLog.checkout_failure_reason = "final_eligibility_unconfirmed";
    await run(async (query) => {
      const current = await lockedCheckoutState(query, accountId);
      assertCheckoutEligible(current.account);
      if (
        current.attempt?.attempt_id !== attempt.attempt_id ||
        current.attempt.stripe_session_id !== session.id
      ) {
        throw new CheckoutUnavailable(
          "Your billing selection changed. Please try again with your preferred billing interval."
        );
      }
    });
    return { ok: true, data: { url: session.url } };
  } catch (error) {
    if (error instanceof CheckoutUnavailable) {
      if (error.status === 400) return invalidBillingRequest(error.message);
      return apiTransactionFailure(error, input.context, {
        accountId,
        operation: "stripe_checkout_session_create",
        message: error.message,
        unavailableMessage: error.message,
        checkout: checkoutLog
      });
    }
    const previousSubscriptionFailure =
      checkoutLog.checkout_failure_reason?.startsWith("previous_subscription_");
    return apiTransactionFailure(error, input.context, {
      accountId,
      operation: "stripe_checkout_session_create",
      message: previousSubscriptionFailure
        ? "Previous subscription confirmation failed; no checkout was created."
        : "Checkout could not be confirmed; the persisted attempt must be reused or reconciled.",
      unavailableMessage: previousSubscriptionFailure
        ? "We could not confirm your previous subscription. Please try again; if this persists, contact support with the error ID."
        : "Checkout could not be confirmed. Retry the same interval; if this persists, contact support with the error ID.",
      checkout: checkoutLog
    });
  }
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
        stripe_subscription_id = $3,
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
  // Terminal truth wins equal-created-second receipt permutations, while
  // genuinely older terminal events retain the timestamp ordering check.
  ordering.predicate = ordering.predicate.replace(
    "stripe_last_event_receipt_order <= $10",
    "(stripe_last_event_receipt_order <= $10 or $4 in ('canceled', 'incomplete_expired'))"
  );
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
        stripe_terminal_subscription_id = case when $4 in ('canceled', 'incomplete_expired')
          then $1 else stripe_terminal_subscription_id end,
        stripe_current_period_end = $7,
        ${ordering.assignment}
        updated_at = now()
      where account_id::text = $8 and deleted_at is null
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
    "account_id::text = $8 and deleted_at is null"
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

type BillingEventReferences = {
  accountId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  attemptId: string | null;
  sessionId?: string | null;
  status: string;
};

function billingConflict(accountId: string | null): StripeEventOutcome {
  return { status: "unapplied", reason: "billing_conflict", accountId };
}

async function authorizeBillingEvent(
  query: ProductTransactionQuery,
  references: BillingEventReferences
): Promise<{ accountId: string } | StripeEventOutcome> {
  // Resolve all available references in ONE statement snapshot. A contradictory
  // customer/subscription/account must never retarget or partially update accounts.
  const matches = await query<CheckoutAccount>({
    sql: `select account_id::text, tier, billing_status, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_status, stripe_terminal_subscription_id
      from public.agent_outbox_accounts where deleted_at is null and (
        ($1::text is not null and account_id::text = $1) or
        ($2::text is not null and stripe_customer_id = $2) or
        ($3::text is not null and stripe_subscription_id = $3)
      ) order by account_id for update`,
    values: [
      references.accountId,
      references.customerId,
      references.subscriptionId
    ]
  });
  if (matches.rows.length === 0) {
    return {
      status: "unapplied",
      reason: "no_matching_account",
      accountId: references.accountId
    };
  }
  if (matches.rows.length !== 1) return billingConflict(references.accountId);
  const account = matches.rows[0];
  const accountId = account.account_id;
  if (
    (references.accountId && references.accountId !== accountId) ||
    (references.customerId &&
      account.stripe_customer_id &&
      references.customerId !== account.stripe_customer_id)
  ) {
    return billingConflict(accountId);
  }
  const attempts = await query<CheckoutAttempt>({
    sql: `select * from public.agent_outbox_billing_checkout_attempts where account_id = $1`,
    values: [accountId]
  });
  const attempt = attempts.rows[0];
  const authorizedAttempt =
    !!references.attemptId && references.attemptId === attempt?.attempt_id;
  if (references.attemptId && !authorizedAttempt)
    return billingConflict(accountId);
  if (
    authorizedAttempt &&
    references.sessionId !== undefined &&
    !references.sessionId
  )
    return billingConflict(accountId);
  if (
    authorizedAttempt &&
    ((references.sessionId &&
      attempt.stripe_session_id &&
      references.sessionId !== attempt.stripe_session_id) ||
      (attempt.stripe_subscription_id &&
        references.subscriptionId !== attempt.stripe_subscription_id))
  ) {
    return billingConflict(accountId);
  }
  const canonicalId = account.stripe_subscription_id;
  const sameCanonical =
    !!canonicalId && references.subscriptionId === canonicalId;
  const canonicalTerminal = hasTerminalSubscription(account);
  if (sameCanonical) {
    if (canonicalTerminal && !terminalSubscription(references.status))
      return billingConflict(accountId);
  } else if (canonicalId) {
    // Late cancellation is never authorization for a new attachment.
    if (
      !canonicalTerminal ||
      !authorizedAttempt ||
      terminalSubscription(references.status)
    ) {
      return billingConflict(accountId);
    }
  } else if (
    terminalSubscription(references.status) ||
    (attempt && !authorizedAttempt)
  ) {
    return billingConflict(accountId);
  }
  // Legacy initial attachment is supported only without a conflicting attempt.
  // A checkout without subscription identity must not activate paid entitlement.
  if (!references.subscriptionId) return billingConflict(accountId);
  return { accountId };
}

async function retainAuthorizedAttempt(
  query: ProductTransactionQuery,
  references: BillingEventReferences,
  accountId: string
) {
  if (!references.attemptId) return;
  await query({
    sql: `update public.agent_outbox_billing_checkout_attempts
      set stripe_subscription_id = $3, stripe_session_id = coalesce(stripe_session_id, $4)
      where account_id = $1 and attempt_id::text = $2`,
    values: [
      accountId,
      references.attemptId,
      references.subscriptionId,
      references.sessionId ?? null
    ]
  });
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
  const clientAccountId = stringValue(session.client_reference_id);
  const metadataAccountId = stringValue(
    recordValue(session.metadata, "account_id")
  );
  if (
    clientAccountId &&
    metadataAccountId &&
    clientAccountId !== metadataAccountId
  ) {
    return billingConflict(clientAccountId);
  }
  const accountId = clientAccountId ?? metadataAccountId;
  if (!accountId)
    return {
      status: "unapplied",
      reason: "missing_reference",
      accountId: null
    };
  const references: BillingEventReferences = {
    accountId,
    customerId: stripeId(session.customer),
    subscriptionId: stripeId(session.subscription),
    attemptId: stringValue(recordValue(session.metadata, "billing_attempt_id")),
    sessionId: stringValue(session.id),
    status: "checkout_completed"
  };
  const authorized = await authorizeBillingEvent(query, references);
  if ("status" in authorized) return authorized;
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

  const outcome = accountUpdateOutcome(result.rows, accountId);
  if (outcome.status === "applied")
    await retainAuthorizedAttempt(query, references, accountId);
  return outcome;
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
  const status = stringValue(object.status) ?? "unknown";
  const references: BillingEventReferences = {
    subscriptionId,
    customerId: stripeId(object.customer),
    accountId: stringValue(recordValue(object.metadata, "account_id")),
    attemptId: stringValue(recordValue(object.metadata, "billing_attempt_id")),
    status
  };
  const authorized = await authorizeBillingEvent(query, references);
  if ("status" in authorized) return authorized;
  const match = {
    ...references,
    subscriptionId,
    accountId: authorized.accountId
  };
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

  const outcome = accountUpdateOutcome(result.rows, match.accountId);
  if (outcome.status === "applied")
    await retainAuthorizedAttempt(query, references, match.accountId);
  return outcome;
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

  const details = recordValue(
    recordValue(object, "parent"),
    "subscription_details"
  );
  const nestedSubscription = stripeId(recordValue(details, "subscription"));
  const legacySubscription = stripeId(object.subscription);
  if (
    nestedSubscription &&
    legacySubscription &&
    nestedSubscription !== legacySubscription
  ) {
    return billingConflict(null);
  }
  const references: BillingEventReferences = {
    subscriptionId,
    customerId: stripeId(object.customer),
    accountId: stringValue(
      recordValue(recordValue(details, "metadata"), "account_id")
    ),
    attemptId: stringValue(
      recordValue(recordValue(details, "metadata"), "billing_attempt_id")
    ),
    status: "payment_failed"
  };
  const authorized = await authorizeBillingEvent(query, references);
  if ("status" in authorized) return authorized;
  const match = {
    ...references,
    subscriptionId,
    accountId: authorized.accountId
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

  const outcome = accountUpdateOutcome(result.rows, match.accountId);
  if (outcome.status === "applied")
    await retainAuthorizedAttempt(query, references, match.accountId);
  return outcome;
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
