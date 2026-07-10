# Cloudflare

## Tool

Use the official Cloudflare Workers CLI: `wrangler`.

Run `wrangler --help` first, then run command-specific help before using flags
that are not already proven in this repository. Wrangler and the OpenNext
Cloudflare adapter are pinned project dev dependencies for explicit platform
verification and deployment work, but normal app CI and app tests must not
require Cloudflare credentials, deployment artifacts, or platform emulation.

Use the pinned project invocation:

```bash
pnpm exec wrangler <command>
```

Known-safe read-only checks:

```bash
pnpm exec wrangler whoami --env-file /dev/null
pnpm exec wrangler deployments status \
  --name agent-outbox \
  --json \
  --env-file /dev/null
```

`--env-file /dev/null` forces Wrangler to ignore repo-local `.env` values and
use the cached Wrangler OAuth login. If a Worker has not been deployed,
`deployments status` can still verify Cloudflare auth before reporting that the
Worker does not exist.

Do not install Wrangler globally for this repository. A global install is easy
to drift from the pinned project dependency used by project operations.

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
- The Worker name is `agent-outbox`, the custom domain is
  `app.agent-outbox.dev`, and the cron schedule is `17 * * * *`.
- The account plan or approved limit must support the built OpenNext Worker
  size. The current Agent Outbox OpenNext bundle is above the Cloudflare Workers
  Free 3 MB Worker-size limit and must either run on a plan/limit that supports
  it or be reduced before production deploy.
- `wrangler.jsonc` owns the Worker custom-domain route via
  `routes[].custom_domain=true`; do not create a separate proxied DNS record for
  `app.agent-outbox.dev` unless the Cloudflare custom-domain flow changes.
- `workers.dev` is disabled for the production Worker; `app.agent-outbox.dev` is
  the only intended hosted app/API surface.
- Local `.env` uses project-specific Cloudflare variable names for operator
  convenience and does not define generic `CLOUDFLARE_API_TOKEN`.
- GitHub Actions deploy environments map the Worker deploy token into
  `CLOUDFLARE_API_TOKEN` only for the deploy job that invokes Wrangler.
- Production database access is through the `AGENT_OUTBOX_DATABASE` Hyperdrive
  binding. The deploy wrapper injects the Hyperdrive config id into a temporary
  Wrangler config and sets `AGENT_OUTBOX_DATABASE_CONNECTION_MODE=hyperdrive` so
  a missing binding fails loud instead of falling back to plain Worker TCP.
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
| WAF/rate-limit activation              | Cloudflare Rulesets API      | Narrow WAF/Rulesets token stored locally as `CLOUDFLARE_WAF_API_TOKEN` only during activation             | Approved secret store; load into an operator shell only for the activation command     |
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
pnpm exec wrangler whoami --env-file /dev/null
```

Verify a Worker deploy token with Wrangler without printing the token:

```bash
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN:?}" \
  pnpm exec wrangler whoami --env-file /dev/null
```

Check the Worker deployment status with a Worker deploy token:

```bash
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_WORKERS_DEPLOY_API_TOKEN:?}" \
  pnpm exec wrangler deployments status \
    --name agent-outbox \
    --json \
    --env-file /dev/null
```

Build and dry-run the OpenNext/Wrangler Worker bundle without uploading it:

```bash
pnpm run worker:dry-run
```

The production deploy entrypoint is:

```bash
pnpm run worker:deploy
```

This is an external write. Use it only after explicit owner approval and after
loading production runtime values from approved operator-controlled stores. The
wrapper builds a fresh OpenNext bundle, writes true runtime secrets to a
temporary secrets file outside the repo, writes a temporary Wrangler config with
the `AGENT_OUTBOX_DATABASE` Hyperdrive binding, invokes pinned Wrangler with
`--env-file /dev/null`, `--secrets-file`, deploy-time `--var NAME:value`
bindings, and no `--keep-vars`, then removes the temporary files. Wrangler
4.107.0 dry-run did not hard-fail or warn when a dummy `--secrets-file` omitted
one `secrets.required` name, so the repo deploy wrapper and structural smoke
guard are the enforcement points for the complete runtime inventory.

Check the prepared inactive `/api/client-events` rate-limit rule without
changing Cloudflare state:

```bash
node scripts/cloudflare-ratelimit.mjs --check
```

This requires `CLOUDFLARE_ZONE_ID` and activation-time
`CLOUDFLARE_WAF_API_TOKEN`.

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
  the task explicitly calls for operator intervention. The manual deploy command
  is `pnpm run worker:deploy` after production runtime configuration has been
  loaded through approved operator-controlled stores; the script builds a fresh
  OpenNext bundle before the external deploy write. The production GitHub
  Actions workflow is manual-only, uses the `production` environment, dry-runs
  the Worker bundle first, and then calls the same deploy wrapper.
- Wrangler is for local agent/developer operations and for the deployment
  command inside GitHub Actions. Normal app CI and app tests must not require
  Wrangler, OpenNext Cloudflare, provider credentials, deployment artifacts, or
  platform runtime emulation.
- CI/CD must use API-token authentication through GitHub environment secrets,
  not cached Wrangler OAuth.
- Do not set `keep_vars` in `wrangler.jsonc` or pass `--keep-vars` for the
  production deploy path. The deploy wrapper supplies the full intended runtime
  public/config variable inventory each deploy so stale dashboard-managed vars
  are removed instead of preserved.
- Do not rely on Wrangler dry-run alone to prove every `secrets.required` name
  is present in the deploy secrets file. The deploy wrapper fails before
  invoking Wrangler when any required true secret is missing.
- Do not create edge blocks, challenges, or rate limits as product behavior.
  They are incident controls.
- Do not print runtime secret values into chat, issues, logs, or docs.

## Client Events Rate Limit

`scripts/cloudflare-ratelimit.mjs` contains the prepared inactive Cloudflare
Rulesets API definition for `/api/client-events`. The rule uses the
`http_ratelimit` phase, path-only expression, `cf.colo.id` plus `ip.src`
characteristics, a 10-second period, and `enabled: false`. The script uses the
path-only expression because the Cloudflare Free plan supports only a path
predicate; a POST-method predicate (`... and http.request.method eq "POST"`)
requires Pro or higher and must be authored at activation time if the zone plan
supports it.

The prepared disabled rule is an incident-control asset. Keep it disabled during
normal launch-readiness checks unless the owner explicitly decides to activate
or modify it for abuse response. At inspection time:

1. Mint or load a narrow Cloudflare WAF/Rulesets token into
   `CLOUDFLARE_WAF_API_TOKEN`.
2. Run `node scripts/cloudflare-ratelimit.mjs --check` and confirm whether the
   prepared rule already exists.
3. Run `node scripts/cloudflare-ratelimit.mjs --apply` only when the operator
   intends to write the prepared disabled rule.
4. Run `node scripts/cloudflare-ratelimit.mjs --check` again and verify
   `present: true` and `enabled: false`. `--check` exits non-zero unless the
   rule is present and disabled, so an accidentally activated rule fails the
   check instead of reporting success.
5. Enable or adjust the rule in Cloudflare only as an incident-control decision,
   after confirming the zone plan supports the desired predicate and behavior.
   After an intentional incident activation, `--check` will exit non-zero by
   design because the rule is no longer in its prepared disabled state.
