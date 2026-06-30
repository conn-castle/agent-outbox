# Cloudflare

## Tool

Use the official Cloudflare Workers CLI: `wrangler`.

Run `wrangler --help` first, then run command-specific help before using flags
that are not already proven in this repository. Wrangler is platform/operations
tooling and must not be required by normal app CI or app tests.

This repository intentionally does not install Wrangler in normal app setup
because app CI must test the app, not the Cloudflare deployment platform. Use a
versioned Wrangler invocation for occasional local Cloudflare debugging:

```bash
corepack pnpm dlx wrangler@4.105.0 <command>
```

Known-safe read-only checks:

```bash
corepack pnpm dlx wrangler@4.105.0 whoami --env-file /dev/null
corepack pnpm dlx wrangler@4.105.0 deployments status \
  --name agent-outbox \
  --json \
  --env-file /dev/null
```

`--env-file /dev/null` forces Wrangler to ignore repo-local `.env` values and
use the cached Wrangler OAuth login. If a Worker has not been deployed,
`deployments status` can still verify Cloudflare auth before reporting that the
Worker does not exist.

Do not install Wrangler globally for this repository. A global install is easy
to drift from the documented invocation used by project operations.

`cloudflared` is not part of the Agent Outbox setup. It is for Cloudflare
Tunnels; use this doc for Cloudflare DNS and Workers/OpenNext runtime
operations.

## Owns

- DNS and routes for the public application domains.
- Cloudflare Workers/OpenNext runtime.
- Worker runtime secrets.
- Workers logs and runtime observability.
- Cloudflare Web Analytics.
- Edge safety controls such as WAF, challenge, route block, or rate-limit rules.

## Configuration To Verify

- The selected Cloudflare account and zone belong to Agent Outbox.
- The Worker name, routes, and zone match the intended environment before
  inspecting or changing anything.
- Local `.env` uses project-specific Cloudflare variable names for operator
  convenience and does not define generic `CLOUDFLARE_API_TOKEN`.
- GitHub Actions deploy environments map the Worker deploy token into
  `CLOUDFLARE_API_TOKEN` only for the deploy job that invokes Wrangler.
- Account ids, zone ids, token ids, token values, exact secret-store paths, and
  current environment state live only in approved operator-controlled systems.
  Do not commit those values to Markdown.

## Auth Model

Cloudflare access is split by purpose. Do not try to make one token cover every
job.

| Purpose                                | Tool                         | Auth                                                                                                      | Storage                                                                                |
| -------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Local agent/developer Worker debugging | Wrangler                     | Cached Wrangler OAuth login from `wrangler login`                                                         | Local machine only; do not mirror to shared secret stores or GitHub                    |
| DNS management                         | Cloudflare REST API          | DNS-scoped API token                                                                                      | Approved secret store; optional local `.env` value under a project-specific name       |
| CI/CD Worker deploys                   | GitHub Actions plus Wrangler | Worker deploy API token exposed to the deploy job as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID` | GitHub environment secret and approved secret store                                    |
| API token minting or rotation          | Cloudflare REST API          | Dedicated token for minting narrower Cloudflare API tokens                                                | Approved secret store only; never GitHub, runtime environment, or committed repository |

Root `.env` must not define generic `CLOUDFLARE_API_TOKEN`. Wrangler auto-loads
that name and may use it instead of the cached local OAuth session. For local
operator tests of the deploy token, store it under a project-specific name such
as `CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN` and map it into `CLOUDFLARE_API_TOKEN`
only for the single Wrangler process that needs it, without printing the value.

Wrangler OAuth can be broad enough for local Worker inspection, deployment,
logs, and secret operations, but it is not the durable credential for CI/CD and
it is not the API-token-management path. Keep any token-management credential in
an approved secret store, give it no unrelated permissions, and load it into a
local shell only for the specific token-management command being run.

## Safe Checks

Verify local Wrangler OAuth without loading repo `.env`:

```bash
corepack pnpm dlx wrangler@4.105.0 whoami --env-file /dev/null
```

Verify a Worker deploy token with Wrangler without printing the token:

```bash
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN:?}" \
  corepack pnpm dlx wrangler@4.105.0 whoami --env-file /dev/null
```

Check the Worker deployment status with a Worker deploy token:

```bash
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN:?}" \
  corepack pnpm dlx wrangler@4.105.0 deployments status \
    --name agent-outbox \
    --json \
    --env-file /dev/null
```

## Operations

- Verify the configured account, Worker name, routes, and zone before inspecting
  or changing anything.
- Use Wrangler for Worker deployment inspection, log checks, and runtime secret
  operations.
- Use read-only commands first when debugging production issues.
- Keep any local DNS-management token in `.env` under a project-specific name.
  Wrangler auto-loads `CLOUDFLARE_API_TOKEN`; do not use that generic name for a
  DNS-only token.
- For local Worker inspection/deployment, prefer the cached Wrangler OAuth login
  or pass `--env-file /dev/null` when a local `.env` contains non-Wrangler
  Cloudflare variables. Store a true Worker deploy token separately from DNS and
  token-management credentials.

When rotating Cloudflare tokens:

1. Load the token-management token from the approved secret store only in an
   operator-controlled shell.
2. Mint the narrower DNS or Worker deploy token with the Cloudflare REST API.
3. Verify the new token against Cloudflare before replacing the old one.
4. Update the approved secret store immediately.
5. Update GitHub environment secrets when the Worker deploy token changes.
6. Revoke the old Cloudflare token after the new token is verified in its
   consuming path.
7. Keep root `.env` names project-specific; never add generic
   `CLOUDFLARE_API_TOKEN` there.

## Guardrails

- GitHub Actions is the canonical deployment path; do not manually deploy unless
  the task explicitly calls for operator intervention.
- Wrangler is for local agent/developer operations and for the deployment
  command inside GitHub Actions. Normal app CI and app tests must not require
  Wrangler, OpenNext Cloudflare, provider credentials, deployment artifacts, or
  platform runtime emulation.
- CI/CD must use API-token authentication through GitHub environment secrets,
  not cached Wrangler OAuth.
- Do not create edge blocks, challenges, or rate limits as product behavior.
  They are incident controls.
- Do not print runtime secret values into chat, issues, logs, or docs.
