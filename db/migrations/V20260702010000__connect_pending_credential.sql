-- Two-phase caller connect: connect exchange now mints a pending_activation
-- credential (mirroring rotate) that is linked to its setup request and only
-- becomes active at connect/activate. A connect-pending credential has no prior
-- credential to replace, so pending_replacement_for_credential_id stays null
-- while pending_replacement_setup_request_id is set. The original
-- agent_outbox_pending_replacement_shape check rejected that combination, so it
-- is relaxed to admit a third, connect-specific shape.

alter table public.agent_outbox_caller_credentials
  drop constraint agent_outbox_pending_replacement_shape,
  add constraint agent_outbox_pending_replacement_shape
    check (
      (
        pending_replacement_for_credential_id is null
        and pending_replacement_setup_request_id is null
      )
      or
      (
        status = 'pending_activation'
        and pending_replacement_for_credential_id is not null
        and pending_replacement_setup_request_id is not null
        and expires_at is not null
      )
      or
      (
        status = 'pending_activation'
        and pending_replacement_for_credential_id is null
        and pending_replacement_setup_request_id is not null
        and expires_at is not null
      )
    );

-- Enforce at most one pending credential per caller regardless of whether it is
-- a rotate-pending (pending_replacement_for_credential_id set) or a
-- connect-pending (pending_replacement_for_credential_id null) row. The previous
-- predicate only covered rotate-pending rows.
drop index public.agent_outbox_one_pending_replacement_per_caller;

create unique index agent_outbox_one_pending_replacement_per_caller
  on public.agent_outbox_caller_credentials(caller_id)
  where status = 'pending_activation';

comment on column public.agent_outbox_caller_credentials.pending_replacement_for_credential_id is
  'For rotate flows, the active credential this pending replacement will replace after CLI local storage succeeds. Null for connect-pending credentials, which have no prior credential to replace.';

comment on column public.agent_outbox_caller_credentials.pending_replacement_setup_request_id is
  'The human-approved setup request that produced this pending credential, for both connect and rotate flows.';
