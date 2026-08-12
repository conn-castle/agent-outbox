create or replace function public.agent_outbox_bootstrap_clerk_human(
  p_clerk_user_id text
)
returns table (
  user_id uuid,
  account_id uuid,
  role text,
  provisioned_account boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_user_id uuid;
  target_account_id uuid;
  target_role text;
  created_account boolean := false;
begin
  if nullif(btrim(p_clerk_user_id), '') is null
    or public.agent_outbox_context_auth_surface() is distinct from 'human'
    or public.agent_outbox_context_clerk_user_id() is distinct from p_clerk_user_id then
    raise exception 'agent_outbox_bootstrap_clerk_human forbidden'
      using errcode = '42501';
  end if;

  insert into public.agent_outbox_users(clerk_user_id, last_seen_at)
  values (p_clerk_user_id, now())
  on conflict (clerk_user_id) do update
    set last_seen_at = excluded.last_seen_at
  returning agent_outbox_users.user_id into target_user_id;

  select
    m.account_id,
    m.role
  into
    target_account_id,
    target_role
  from public.agent_outbox_account_members m
  join public.agent_outbox_accounts a
    on a.account_id = m.account_id
  where m.user_id = target_user_id
    and a.deleted_at is null
  order by m.created_at, m.account_id
  limit 1;

  if target_account_id is null then
    insert into public.agent_outbox_accounts default values
    returning agent_outbox_accounts.account_id into target_account_id;

    insert into public.agent_outbox_account_members(account_id, user_id, role)
    values (target_account_id, target_user_id, 'owner')
    returning agent_outbox_account_members.role into target_role;

    created_account := true;
  end if;

  return query
  select
    target_user_id,
    target_account_id,
    target_role,
    created_account;
end
$$;

create or replace function public.agent_outbox_prune_ip_quota_windows(
  p_before timestamptz
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if public.agent_outbox_context_auth_surface() is distinct from 'cleanup' then
    raise exception 'agent_outbox_prune_ip_quota_windows forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_ip_quota_windows
  where updated_at < p_before;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_prune_caller_setup_requests(
  p_before timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if public.agent_outbox_context_auth_surface() is distinct from 'cleanup' then
    raise exception 'agent_outbox_prune_caller_setup_requests forbidden'
      using errcode = '42501';
  end if;

  delete from public.agent_outbox_caller_setup_requests setup
  where (
      (
        setup.status in ('exchanged', 'expired', 'denied')
        and setup.updated_at < p_before
      )
      or (
        setup.status in ('pending', 'approved')
        and setup.expires_at < p_before
      )
    )
    and not exists (
      select 1
      from public.agent_outbox_caller_credentials credential
      where credential.pending_replacement_setup_request_id = setup.setup_request_id
    );

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.agent_outbox_cleanup_account_targets()
returns table(account_id uuid, tier text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.agent_outbox_context_auth_surface() is distinct from 'cleanup' then
    raise exception 'agent_outbox_cleanup_account_targets forbidden'
      using errcode = '42501';
  end if;

  return query
  select account.account_id, account.tier
  from public.agent_outbox_accounts account
  order by account.account_id;
end;
$$;

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
  if public.agent_outbox_context_auth_surface() is distinct from 'cleanup' then
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
