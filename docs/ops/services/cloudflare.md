# Cloudflare

## Tool

Use the official Cloudflare CLI: `wrangler`.

Run `wrangler --help` first, then run command-specific help before using flags
that are not already proven in this repository.

## Owns

- DNS and routes for `agent-outbox.dev` and `app.agent-outbox.dev`.
- Cloudflare Workers/OpenNext runtime.
- Worker runtime secrets.
- Workers logs and runtime observability.
- Cloudflare Web Analytics.
- Edge safety controls such as WAF, challenge, route block, or rate-limit rules.

## Safe Checks

- Verify the configured account, Worker name, routes, and zone before inspecting
  or changing anything.
- Use Wrangler for Worker deployment inspection, log checks, and runtime secret
  operations.
- Use read-only commands first when debugging production issues.
- Keep the DNS-management token in `.env` as `CLOUDFLARE_DNS_API_TOKEN`. Store
  its canonical SSM copy at `/agent-outbox/shared/cloudflare-dns-api-token`.
  Wrangler auto-loads `CLOUDFLARE_API_TOKEN`; do not use that generic name for a
  DNS-only token.
- For local Worker inspection/deployment, prefer the cached Wrangler OAuth login
  or pass `--env-file /dev/null` when a local `.env` contains non-Wrangler
  Cloudflare variables. Store a true Worker deploy token separately when CI
  deployment is wired.

## Guardrails

- GitHub Actions is the canonical deployment path; do not manually deploy unless
  the task explicitly calls for operator intervention.
- Do not create edge blocks, challenges, or rate limits as product behavior.
  They are incident controls.
- Do not print runtime secret values into chat, issues, logs, or docs.
