# Build your first human checkpoint

Agent Outbox gives software agents a durable place to ask a person for a
decision. Your agent sends a structured review request, continues other work,
and returns for the answer when it is ready. No request stays open while a
person thinks.

This guide sends an approval request, checks for a decision, reads it, and
acknowledges that your application handled it safely.

## Before you start

You need a connected caller. A caller is one agent or service identity with its
own display-once API credential.

Install the public CLI with Homebrew:

```bash
brew install --cask conn-castle/tap/agent-outbox
```

Or install the latest macOS or Linux release directly without Homebrew or
`sudo`:

```bash
curl -fsSL https://agent-outbox.dev/install.sh | sh
```

Caller connection remains available to invited testers during this pre-release.
[Request caller access](https://agent-outbox.dev/contact) through the public
contact form before running `agent-outbox caller connect my-agent`. An account
is not required to send that request, and creating an account does not provision
a caller credential. The connection flow asks a signed-in person to approve the
caller, displays its credential once, and stores it in the CLI's owner-only
local credentials file.

If you already have a connected caller, the raw HTTP examples below are fully
usable: substitute its display-once value where `<caller_api_key>` appears.
Never put the key in source control, request bodies, logs, or prompts.

## 1. Send a review request

Give the work item an id that stays stable across retries. Action `value` fields
are also caller-owned protocol values: your code receives them back unchanged
when a person decides.

```bash
curl https://app.agent-outbox.dev/api/input/send \
  --request POST \
  --header "Authorization: Bearer <caller_api_key>" \
  --header "Content-Type: application/json" \
  --data '{
    "caller_item_id": "email:thread_123",
    "priority": "high",
    "row_type": { "display": "Email draft", "icon": "mail" },
    "title": "Reply to Acme Corp",
    "subtitle": "A customer response is ready for review.",
    "summary": "Approve the prepared response before it is sent.",
    "link_buttons": [],
    "actions": [
      {
        "display": "Approve to send",
        "icon": "send",
        "value": "approve_send",
        "overflow": false,
        "tone": "success",
        "style": "solid",
        "popup": { "kind": "none" }
      }
    ]
  }'
```

The server derives the account and caller from the bearer credential. Never put
`account_id` or `caller_id` in an input body.

An accepted response confirms whether this call created the item or repeated an
equivalent pending request:

<!-- contract-example:InputSendResponse -->

```json
{
  "ok": true,
  "request_id": "req_123",
  "correlation_id": "corr_123",
  "data": {
    "caller_item_id": "email:thread_123",
    "status": "pending",
    "revision": 1,
    "created": true,
    "duplicate": false
  }
}
```

## 2. Continue other work

The human review happens asynchronously. Persist enough caller-side state to
associate `caller_item_id` with the work that should resume. Do not keep a
network request, process, or model turn open while waiting.

## 3. Check for a decision

Check readiness when your caller is prepared to resume:

```bash
curl "https://app.agent-outbox.dev/api/output/check?limit=25" \
  --header "Authorization: Bearer <caller_api_key>" \
  --header "Accept: application/json"
```

Checking is deliberately non-mutating. It returns result ids and timing, but no
answer content, and it does not disable the person’s ability to undo.

<!-- contract-example:OutputCheckResponse -->

```json
{
  "ok": true,
  "request_id": "req_124",
  "correlation_id": "corr_124",
  "data": {
    "items": [
      {
        "output_result_id": "out_123",
        "caller_item_id": "email:thread_123",
        "answered_at": "2026-06-30T20:00:00Z"
      }
    ],
    "ready_count": 1,
    "has_more": false,
    "next_cursor": null,
    "returned_count": 1,
    "page_limit": 25
  }
}
```

Follow the opaque `next_cursor` while `has_more` is true. `ready_count` is the
total number of live results awaiting acknowledgement, including results you
already read; it is not an unread count.

## 4. Read the decision

```bash
curl https://app.agent-outbox.dev/api/output/out_123/read \
  --request POST \
  --header "Authorization: Bearer <caller_api_key>" \
  --header "Accept: application/json"
```

The result includes the selected action’s stable `value` and a response shaped
by its popup kind. The first successful read disables human undo. The result
remains available, and can be delivered again, until you acknowledge it.

<!-- contract-example:OutputResultResponse -->

```json
{
  "ok": true,
  "request_id": "req_125",
  "correlation_id": "corr_125",
  "data": {
    "output_result_id": "out_123",
    "caller_id": "caller_123",
    "caller_item_id": "email:thread_123",
    "action_value": "approve_send",
    "response": { "kind": "none" },
    "answered_at": "2026-06-30T20:00:00Z",
    "answered_by": "user_123"
  }
}
```

Treat `output_result_id` as the idempotency key for downstream work.

## 5. Acknowledge durable handling

Only acknowledge after your application has durably recorded the decision or
completed its side effect.

```bash
curl https://app.agent-outbox.dev/api/output/out_123/ack \
  --request POST \
  --header "Authorization: Bearer <caller_api_key>" \
  --header "Accept: application/json"
```

Acknowledgement is idempotent. It removes the live input/output pair and any
attached response files.

If a request fails, branch on the stable `error.code`, not its message or status
alone. The
[reliability guide](public-api-reliability.md#handle-errors-by-category)
explains recovery, and the generated reference lists every public code.

## Where to go next

- [Understand the lifecycle](public-api-concepts.md) before designing retries or
  worker state.
- [Choose a review interaction](public-api-capabilities.md) for free text,
  selections, dates, files, and visual context.
- [Build a UI integration](public-api-ui.md) with generated types and a trusted
  credential boundary.
- [Build for reliable delivery](public-api-reliability.md) before shipping a
  production integration.
- Use the [generated API reference](public-api-reference.md) for exact routes,
  schemas, response shapes, and error recovery.
