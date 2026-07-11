lock table public.agent_outbox_stripe_webhook_events in access exclusive mode;

do $$
begin
  if exists (
    select 1
    from public.agent_outbox_stripe_webhook_events
    where processing_status <> 'processed'
      or processed_at is null
  ) then
    raise exception 'Stripe webhook ledger contains a non-completed row; preserve the row and investigate before retrying this migration'
      using errcode = '23514';
  end if;
end
$$;

alter table public.agent_outbox_stripe_webhook_events
  alter column processing_status set default 'processed',
  alter column processed_at set default now(),
  alter column processed_at set not null;

create or replace function public.agent_outbox_prune_stripe_webhook_events(
  p_before timestamptz
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  if public.agent_outbox_context_auth_surface() <> 'cleanup' then
    raise exception 'agent_outbox_prune_stripe_webhook_events forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_stripe_webhook_events
  where processing_status = 'processed'
    and processed_at < p_before;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function public.agent_outbox_prune_stripe_webhook_events(timestamptz) from public;
grant execute on function public.agent_outbox_prune_stripe_webhook_events(timestamptz) to agent_outbox_app;

do $$
  declare
    provider_role text;
  begin
    foreach provider_role in array array[
      'anon',
      'authenticated',
      'service_role'
    ] loop
      if exists (
        select 1 from pg_catalog.pg_roles where rolname = provider_role
      ) then
        execute format(
          'revoke execute on function public.agent_outbox_prune_stripe_webhook_events(timestamptz) from %I',
          provider_role
        );
      end if;
    end loop;
  end
$$;

comment on function public.agent_outbox_prune_stripe_webhook_events(timestamptz) is
  'Deletes completed Stripe webhook idempotency ledger rows older than the retention cutoff under the scheduled cleanup auth surface.';

comment on table public.agent_outbox_stripe_webhook_events is
  'Completed Stripe webhook idempotency ledger. Stores event ids, types, receipt and completion timestamps, temporary rollout-compatible status, and account linkage only; never raw payloads or customer billing data.';

comment on column public.agent_outbox_stripe_webhook_events.processing_status is
  'Temporary expand/rollback compatibility column. The new writer explicitly writes processed (schema-tolerant across the deploy window); the prior writer explicitly transitions processing to processed inside the same transaction.';
