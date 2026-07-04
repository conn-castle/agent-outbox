create or replace function public.agent_outbox_cleanup_account_targets()
returns table(account_id uuid, tier text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.agent_outbox_context_auth_surface() <> 'cleanup' then
    raise exception 'agent_outbox_cleanup_account_targets forbidden'
      using errcode = '42501';
  end if;

  return query
  select account.account_id, account.tier
  from public.agent_outbox_accounts account
  order by account.account_id;
end;
$$;

revoke execute on function public.agent_outbox_cleanup_account_targets() from public;
grant execute on function public.agent_outbox_cleanup_account_targets() to agent_outbox_app;

comment on function public.agent_outbox_cleanup_account_targets() is
  'Lists account ids and tiers only for the scheduled cleanup auth surface so account-scoped cleanup can run without bypassing row-level security in application code.';
