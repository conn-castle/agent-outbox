# Agent Outbox API Contract

This directory is the durable HTTP contract for Agent Outbox caller
integrations. The source product spec is
`/Users/nicholasjconn/Local/git-repos/conn-castle/castle-steward/project-ideas/agent-outbox/README.md`.

Raw HTTP is canonical. The `agent-outbox` CLI must be a wrapper over these
documented endpoints and must not add hidden product behavior, queue semantics,
or error states that are unavailable through HTTP.

## Contract Index

- [http-api.md](http-api.md) - routes, authentication, request headers, response
  envelopes, caller registration, status, data-plane commands, and file
  downloads.
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

## CLI To HTTP Map

| CLI command                                    | Canonical HTTP contract                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caller connect <caller>`                      | Human-approved caller registration flow in [http-api.md](http-api.md#caller-registration-contract).                                                 |
| `caller status`                                | `GET /api/caller/status`.                                                                                                                           |
| `account status`                               | `GET /api/account/status` when caller credentials are available. Human-approved fallback is a control-plane flow, not a caller-key data-plane call. |
| `input send --file <input.json>`               | `POST /api/input/send`.                                                                                                                             |
| `input replace --file <input.json>`            | `POST /api/input/replace`.                                                                                                                          |
| `input delete <caller_item_id>`                | `POST /api/input/delete`.                                                                                                                           |
| `output check`                                 | `GET /api/output/check`. The CLI auto-pages by default.                                                                                             |
| `output read <output_result_id>`               | `POST /api/output/{output_result_id}/read`.                                                                                                         |
| `output read --all`                            | `POST /api/output/read-all`. The CLI auto-pages by default.                                                                                         |
| `output file get <output_result_id> <file_id>` | `GET /api/output/{output_result_id}/files/{file_id}`.                                                                                               |
| `output ack <output_result_id>`                | `POST /api/output/{output_result_id}/ack`.                                                                                                          |
| `upgrade`                                      | Opens the hosted upgrade URL returned by status or `upgrade_required`; it is not a data-plane mutation.                                             |
| `docs`, `doctor`, `version`                    | Local CLI behavior plus documented status/error contracts where remote checks are needed.                                                           |
