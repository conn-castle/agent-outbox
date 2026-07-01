create or replace function public.agent_outbox_context_clerk_user_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('agent_outbox.clerk_user_id', true), '')
$$;

-- This security-definer bootstrap writes the first human user/account/member
-- rows before normal account Row Level Security context exists. Its owner must
-- be the bypass-capable migration owner; agent_outbox_app only receives execute.
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
    or public.agent_outbox_context_auth_surface() <> 'human'
    or public.agent_outbox_context_clerk_user_id() is null
    or public.agent_outbox_context_clerk_user_id() <> p_clerk_user_id then
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

revoke execute on function public.agent_outbox_context_clerk_user_id() from public;
revoke execute on function public.agent_outbox_bootstrap_clerk_human(text) from public;

grant execute on function public.agent_outbox_context_clerk_user_id() to agent_outbox_app;
grant execute on function public.agent_outbox_bootstrap_clerk_human(text) to agent_outbox_app;

do $$
declare
  provider_role text;
  app_functions constant text := '
    public.agent_outbox_context_clerk_user_id(),
    public.agent_outbox_bootstrap_clerk_human(text)
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
