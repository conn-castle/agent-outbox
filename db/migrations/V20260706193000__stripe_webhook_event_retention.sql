create index agent_outbox_stripe_webhook_events_processed_idx
  on public.agent_outbox_stripe_webhook_events(processed_at)
  where processing_status = 'processed'
    and processed_at is not null;

drop policy if exists agent_outbox_stripe_webhook_events_control_plane
  on public.agent_outbox_stripe_webhook_events;

create policy agent_outbox_stripe_webhook_events_control_plane_select
  on public.agent_outbox_stripe_webhook_events
  for select
  using (public.agent_outbox_context_auth_surface() = 'control_plane');

create policy agent_outbox_stripe_webhook_events_control_plane_insert
  on public.agent_outbox_stripe_webhook_events
  for insert
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

create policy agent_outbox_stripe_webhook_events_control_plane_update
  on public.agent_outbox_stripe_webhook_events
  for update
  using (public.agent_outbox_context_auth_surface() = 'control_plane')
  with check (public.agent_outbox_context_auth_surface() = 'control_plane');

create policy agent_outbox_stripe_webhook_events_cleanup_select
  on public.agent_outbox_stripe_webhook_events
  for select
  using (public.agent_outbox_context_auth_surface() = 'cleanup');

create policy agent_outbox_stripe_webhook_events_cleanup_delete
  on public.agent_outbox_stripe_webhook_events
  for delete
  using (public.agent_outbox_context_auth_surface() = 'cleanup');

grant delete on public.agent_outbox_stripe_webhook_events
to agent_outbox_app;

create or replace function public.agent_outbox_prune_stripe_webhook_events(
  p_before timestamptz
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if public.agent_outbox_context_auth_surface() <> 'cleanup' then
    raise exception 'agent_outbox_prune_stripe_webhook_events forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_stripe_webhook_events
  where processing_status = 'processed'
    and processed_at is not null
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
    app_functions constant text := '
    public.agent_outbox_prune_stripe_webhook_events(timestamptz),
    public.agent_outbox_cleanup_account_targets()
  ';
begin
  foreach provider_role in array array[
    'anon',
    'authenticated',
    'service_role'
  ] loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = provider_role
    ) then
      execute format(
        'revoke execute on function %s from %I',
        app_functions,
        provider_role
      );
    end if;
  end loop;
end
$$;

comment on index public.agent_outbox_stripe_webhook_events_processed_idx is
  'Supports scheduled pruning of processed Stripe webhook idempotency events after the billing replay safety window.';

comment on function public.agent_outbox_prune_stripe_webhook_events(timestamptz) is
  'Deletes processed Stripe webhook idempotency ledger rows older than the retention cutoff under the scheduled cleanup auth surface.';
