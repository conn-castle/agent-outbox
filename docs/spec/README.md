# Agent Outbox API Contract

This directory is the durable HTTP contract for Agent Outbox caller
integrations. The source product spec lives in the `castle-steward` repository
at `project-ideas/agent-outbox/README.md`.

Raw HTTP is canonical. The `agent-outbox` CLI must be a wrapper over these
documented endpoints and must not add hidden product behavior, queue semantics,
or error states that are unavailable through HTTP.

## Contract Index

- [http-api.md](http-api.md) - routes, authentication, request headers, response
  envelopes, status, data-plane commands, file downloads, and future
  human-approved caller registration flows.
- [input-schema.md](input-schema.md) - typed input submission model, validation
  rules, normalization, and input send/replace/delete semantics.
- [output-schema.md](output-schema.md) - typed output result model, readiness
  checks, reads, read-all pagination, acknowledgement, and file metadata.
- [errors.md](errors.md) - stable success/error envelopes, field errors,
  request/correlation ids, limit metadata, and error-code catalog.

## Contract Principles

- Do not use versioned paths such as `/api/v1` for the MVP.
- Caller data-plane routes use only Agent Outbox caller API keys. They do not
  trust Clerk session state.
- Caller request bodies never include `caller_id`; the server derives
  `account_id` and `caller_id` from `Authorization: Bearer <caller_api_key>`.
- Non-file API responses use the shared JSON success/error envelopes in
  [errors.md](errors.md). The file-download route returns raw bytes.
- Output delivery is asynchronous and at least once until acknowledgement.
- Output `check` is non-mutating. Output `read` and `read-all` mark only
  returned results as read. Output `ack` is idempotent and destructive for the
  live queue pair.
- File bytes never appear in JSON responses, logs, diagnostics, or CLI metadata.
  Raw bytes are available only from the dedicated file-download endpoint.
- Times are UTC ISO-8601 strings unless a schema field explicitly says it is a
  civil date or displayed IANA timezone.
- CLI commands that talk to the hosted app must map to the HTTP contract below.
  Local utility commands such as `docs`, `doctor`, `upgrade`, and `version` do
  not create additional HTTP route contracts.

## CLI Foundation Contract

The CLI foundation defines global selection inputs for data-plane,
control-plane, and diagnostic commands.

Global flags:

- `--base-url <origin>` selects the Agent Outbox app/API origin for the command.
  The value must be an `https` origin — or an `http` origin whose host is
  loopback (`localhost`, `127.0.0.1`, or `::1`) — with no path, query, userinfo,
  or fragment. Cleartext `http` to non-loopback hosts is rejected so caller API
  keys never travel unencrypted off the local machine. This loopback allowance
  is a transport rule only. Caller connect, rotate, and revoke control-plane
  routes still require the server's trusted-client-IP policy from
  [http-api.md](http-api.md#caller-connect-control-plane); direct localhost
  control-plane requests fail unless the local ingress or test fixture supplies
  that trusted IP signal.
- `--config <path>` selects the local Agent Outbox config file for the command.
- `--caller <caller>` selects a locally configured caller by the local caller
  name.

Environment variables:

- `AGENT_OUTBOX_BASE_URL` optionally selects the Agent Outbox app/API origin for
  automation.
- `AGENT_OUTBOX_CONFIG_PATH` optionally selects the local Agent Outbox config
  file for automation.
- `AGENT_OUTBOX_CALLER` optionally selects the local caller for commands that
  operate on caller-owned data.

Precedence:

- Config path selection is `--config`, then `AGENT_OUTBOX_CONFIG_PATH`, then the
  platform-standard Agent Outbox config path.
- Base URL selection is `--base-url`, then `AGENT_OUTBOX_BASE_URL`, then local
  CLI config `base_url` from the selected config file, then
  `https://app.agent-outbox.dev`.
- Caller selection is `--caller`, then `AGENT_OUTBOX_CALLER`, then the single
  locally configured caller only when exactly one exists.
- If `--caller` and `AGENT_OUTBOX_CALLER` are both set, the command fails with
  `caller_selection_conflict` even when the values match.
- If no explicit caller selector is set and multiple local callers exist, the
  command fails with `ambiguous_caller`. If the selected caller name is not
  present in local config, the command fails with `unknown_caller`.

Caller API keys are not configured through environment variables. Plaintext
caller credentials live only in local secure storage after human-approved caller
connect or rotate.

## CLI To HTTP Map

The repository ships a Go `agent-outbox` CLI. This map constrains the CLI so it
remains a wrapper over raw HTTP rather than becoming a second product contract.
Rows for local utilities identify their local behavior and any HTTP contracts
they inspect.

| CLI command                                    | Canonical HTTP contract                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `caller connect <caller>`                      | Human-approved connect routes in [http-api.md](http-api.md#caller-connect-control-plane).                                        |
| `caller rotate`                                | Human-approved rotate routes in [http-api.md](http-api.md#caller-credential-operations-control-plane).                           |
| `caller revoke <caller>`                       | Human-approved revoke routes in [http-api.md](http-api.md#caller-credential-operations-control-plane).                           |
| `caller disconnect [--revoke]`                 | Local config/secret removal, with optional human-approved revoke routes before removal.                                          |
| `caller list`                                  | Local config only; there is no remote account caller-list route.                                                                 |
| `caller status`                                | `GET /api/caller/status`.                                                                                                        |
| `account status`                               | `GET /api/account/status` with an existing local caller credential; no browser/device-code fallback.                             |
| `input send --file <input.json>`               | `POST /api/input/send`.                                                                                                          |
| `input replace --file <input.json>`            | `POST /api/input/replace`.                                                                                                       |
| `input delete <caller_item_id>`                | `POST /api/input/delete`.                                                                                                        |
| `output check`                                 | `GET /api/output/check`. The CLI auto-pages by default.                                                                          |
| `output read <output_result_id>`               | `POST /api/output/{output_result_id}/read`.                                                                                      |
| `output read --all`                            | `POST /api/output/read-all`. The CLI auto-pages by default.                                                                      |
| `output file get <output_result_id> <file_id>` | `GET /api/output/{output_result_id}/files/{file_id}`.                                                                            |
| `output ack <output_result_id>`                | `POST /api/output/{output_result_id}/ack`.                                                                                       |
| `upgrade`                                      | Local utility that opens the selected app origin plus `/upgrade`; it does not require a status-returned URL or mutate data.      |
| `docs [topic]`                                 | Local built-in terminal docs with pointers to this spec.                                                                         |
| `doctor [--caller]`                            | Local diagnostics plus `GET /api/caller/status` and `GET /api/account/status` when a selected local caller credential is loaded. |
| `version`, `--version`                         | Local build metadata only.                                                                                                       |
