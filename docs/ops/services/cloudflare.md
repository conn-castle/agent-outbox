# Cloudflare

## Tool

Use the official Cloudflare CLI: `wrangler`.

Run `wrangler --help` first, then run command-specific help before using flags
that are not already proven in this repository. Wrangler is platform/operations
tooling and must not be required by normal app CI or app tests.

Cloudflare's documented recommendation is to install Wrangler locally in a
project and invoke that project-local binary. This repository intentionally does
not install Wrangler in normal app setup because app CI must test the app, not
the Cloudflare deployment platform.

For occasional local Cloudflare debugging before deployment tooling exists, use
the pinned on-demand CLI:

```bash
corepack pnpm dlx wrangler@4.105.0 <command>
```

Known-safe read-only checks:

```bash
corepack pnpm dlx wrangler@4.105.0 whoami --env-file /dev/null
corepack pnpm dlx wrangler@4.105.0 deployments status --name agent-outbox --json --env-file /dev/null
```

`--env-file /dev/null` forces Wrangler to ignore repo-local `.env` values and
use the cached Wrangler OAuth login. Before the first Worker deployment,
`deployments status` should reach Cloudflare auth and may report that the Worker
does not exist yet.

Do not install Wrangler globally for this repository. A global install is easy
to drift from the version deployment tooling will eventually pin.

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
