alter table public.agent_outbox_input_actions
  add column action_tone text,
  add column action_style text,
  add constraint agent_outbox_input_actions_appearance_pair_check
    check ((action_tone is null) = (action_style is null)),
  add constraint agent_outbox_input_actions_tone_check
    check (
      action_tone is null
      or action_tone in ('neutral', 'brand', 'success', 'warning', 'danger')
    ),
  add constraint agent_outbox_input_actions_style_check
    check (
      action_style is null
      or action_style in ('solid', 'outline', 'ghost')
    );

comment on column public.agent_outbox_input_actions.action_tone is
  'Optional fixed semantic color token for the human-review action button.';

comment on column public.agent_outbox_input_actions.action_style is
  'Optional fixed visual treatment paired with action_tone.';
