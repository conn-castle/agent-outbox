create sequence public.agent_outbox_stripe_webhook_receipt_order_seq
  as bigint;

revoke all on sequence public.agent_outbox_stripe_webhook_receipt_order_seq
from public;

grant usage, select on sequence public.agent_outbox_stripe_webhook_receipt_order_seq
to agent_outbox_app;

alter table public.agent_outbox_stripe_webhook_events
  add column stripe_receipt_order bigint not null
    default nextval('public.agent_outbox_stripe_webhook_receipt_order_seq');

alter sequence public.agent_outbox_stripe_webhook_receipt_order_seq
  owned by public.agent_outbox_stripe_webhook_events.stripe_receipt_order;

alter table public.agent_outbox_stripe_webhook_events
  add constraint agent_outbox_stripe_webhook_events_receipt_order_unique
  unique (stripe_receipt_order);

alter table public.agent_outbox_accounts
  add column stripe_last_event_created_at timestamptz,
  add column stripe_last_event_receipt_order bigint,
  add constraint agent_outbox_accounts_stripe_event_order_pair
    check (
      (stripe_last_event_created_at is null)
      = (stripe_last_event_receipt_order is null)
    );

with latest_applied_event as (
  select distinct on (account_id)
    account_id,
    date_trunc('second', processed_at) as created_at_floor,
    stripe_receipt_order
  from public.agent_outbox_stripe_webhook_events
  where account_id is not null
    and processed_at is not null
  order by account_id, processed_at desc, stripe_receipt_order desc
)
update public.agent_outbox_accounts as account
set
  stripe_last_event_created_at = latest.created_at_floor,
  stripe_last_event_receipt_order = latest.stripe_receipt_order
from latest_applied_event as latest
where account.account_id = latest.account_id;

create function public.agent_outbox_clear_stripe_event_order_on_legacy_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.stripe_last_event_receipt_order is not distinct from old.stripe_last_event_receipt_order
    and row(
      new.tier,
      new.billing_status,
      new.billing_grace_ends_at,
      new.stripe_customer_id,
      new.stripe_subscription_id,
      new.stripe_subscription_status,
      new.stripe_price_id,
      new.stripe_current_period_end
    ) is distinct from row(
      old.tier,
      old.billing_status,
      old.billing_grace_ends_at,
      old.stripe_customer_id,
      old.stripe_subscription_id,
      old.stripe_subscription_status,
      old.stripe_price_id,
      old.stripe_current_period_end
    ) then
    new.stripe_last_event_created_at := null;
    new.stripe_last_event_receipt_order := null;
  end if;

  return new;
end;
$$;

revoke execute on function public.agent_outbox_clear_stripe_event_order_on_legacy_update()
from public;

create trigger agent_outbox_accounts_clear_stripe_order_on_legacy_update
before update on public.agent_outbox_accounts
for each row
execute function public.agent_outbox_clear_stripe_event_order_on_legacy_update();

comment on column public.agent_outbox_stripe_webhook_events.stripe_receipt_order is
  'Database receipt order used to preserve delivery order between distinct Stripe events created in the same second.';

comment on column public.agent_outbox_accounts.stripe_last_event_created_at is
  'Created time of the last Stripe event applied to this account billing projection. Existing projections use the latest known ledger receipt as a conservative rollout floor.';

comment on column public.agent_outbox_accounts.stripe_last_event_receipt_order is
  'Receipt-order tie-breaker for the last Stripe event applied to this account billing projection.';

comment on function public.agent_outbox_clear_stripe_event_order_on_legacy_update() is
  'Clears the ordering floor when a rollback-compatible writer changes billing state without advancing the receipt-order tie-breaker.';
