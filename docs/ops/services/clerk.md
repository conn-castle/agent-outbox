# Clerk

## Tool

Use the official Clerk CLI: `clerk`.

Run `clerk --help` first, then run command-specific help before using flags that
are not already proven in this repository.

## Owns

- Human authentication.
- Signup and sign-in configuration.
- Auth-adjacent domains and sender configuration.
- Bot sign-up protection and disposable-email blocking.
- Clerk application and instance configuration.

## Configuration To Verify

- The selected Clerk application belongs to Agent Outbox.
- Development and production instances are distinct.
- Production domains, mail sender records, and OAuth providers match the hosted
  service domains.
- Local `.env` values come from approved secret stores.

Store Clerk application ids, instance ids, secret keys, and OAuth credential
values only in approved operator-controlled systems. Do not commit those values
to Markdown.

## Safe Checks

- Use the Clerk CLI for application listing, config inspection, deployment
  status, Backend API access, and diagnostics.
- Verify the configured application or instance before inspecting production.
- Keep plus-addressed emails allowed by default unless the owner approves an
  abuse-response change.

## Guardrails

- Do not pull secrets into tracked files.
- Do not change signup posture, auth requirements, domains, or sender
  configuration without owner approval.
- Do not add app-owned CAPTCHA in front of Clerk signup unless the owner changes
  the signup design.
