do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'agent_outbox_app'
  ) then
    create role agent_outbox_app
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      noinherit
      nobypassrls;
  end if;
end
$$;

alter role agent_outbox_app
  with login
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  noinherit
  nobypassrls;

revoke all privileges on database postgres from agent_outbox_app;
grant connect on database postgres to agent_outbox_app;

revoke all privileges on schema public from agent_outbox_app;
grant usage on schema public to agent_outbox_app;

comment on role agent_outbox_app is
  'Restricted Agent Outbox application role. Password is provisioned outside migrations.';
