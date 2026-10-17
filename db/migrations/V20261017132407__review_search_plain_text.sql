alter table public.agent_outbox_input_items
  add column title_text text,
  add column subtitle_text text,
  add column summary_text text,
  add column review_text_source_sha256 text;

create function public.agent_outbox_clear_stale_review_text()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if TG_OP = 'UPDATE' then
    if row(new.title_html, new.subtitle_html, new.summary_html,
           new.title_text, new.subtitle_text, new.summary_text, new.review_text_source_sha256)
       is not distinct from
       row(old.title_html, old.subtitle_html, old.summary_html,
           old.title_text, old.subtitle_text, old.summary_text, old.review_text_source_sha256) then
      return new;
    end if;
  end if;
  if new.title_text is null or new.subtitle_text is null or new.summary_text is null
     or new.review_text_source_sha256 is distinct from
       encode(pg_catalog.sha256(convert_to(jsonb_build_array(new.title_html, new.subtitle_html, new.summary_html)::text, 'UTF8')), 'hex') then
    new.title_text := null;
    new.subtitle_text := null;
    new.summary_text := null;
    new.review_text_source_sha256 := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.agent_outbox_clear_stale_review_text() from public;
create trigger agent_outbox_input_items_clear_stale_review_text
before insert or update on public.agent_outbox_input_items
for each row execute function public.agent_outbox_clear_stale_review_text();

comment on column public.agent_outbox_input_items.title_text is
  'Application-decoded caller title HTML; null until derived; never the source of truth.';
comment on column public.agent_outbox_input_items.subtitle_text is
  'Application-decoded caller subtitle HTML; null until derived; never the source of truth.';
comment on column public.agent_outbox_input_items.summary_text is
  'Application-decoded caller summary HTML; null until derived; never the source of truth.';
comment on column public.agent_outbox_input_items.review_text_source_sha256 is
  'Digest of source HTML for application-decoded text; null until derived; never the source of truth.';
comment on function public.agent_outbox_clear_stale_review_text() is
  'Clears projections written for different HTML so rollback-compatible writers cannot leave stale search text.';
