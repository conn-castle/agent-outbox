# How Agent Outbox works

Agent Outbox is a human-decision queue for software agents. It is useful when
automation can prepare work independently but a person should choose, approve,
edit, schedule, or supply something before the agent proceeds.

It is not a synchronous confirmation dialog. The API separates the agent’s
execution from the person’s response time, so either side can stop and resume
without losing the handoff.

## The lifecycle

Every review follows the same durable sequence:

1. **Send.** The caller creates a structured input with a stable
   `caller_item_id`.
2. **Review.** A person sees the request in Agent Outbox and chooses an action.
3. **Check.** The caller discovers ready output without reading its contents.
4. **Read.** The caller receives the selected action and typed response.
5. **Acknowledge.** After downstream handling is durable, the caller removes the
   live queue pair.

The separation between check, read, and acknowledge is intentional. Checking is
safe and non-mutating. Reading tells Agent Outbox the decision has crossed the
caller boundary and disables human undo. Acknowledging says the caller no longer
needs Agent Outbox to retain the result.

## Identity and ownership

A caller credential belongs to exactly one account and one caller. The server
derives both identities from the bearer key on every request.

`caller_item_id` belongs to your application. Choose a deterministic value that
identifies the logical work—not an individual HTTP attempt. Examples include an
email thread id, deployment id, invoice id, or a namespaced workflow id.

While an item is live, `(caller, caller_item_id)` is its identity. This makes a
same-content send retry safe and prevents two different requests from silently
occupying the same slot.

## Inputs and outputs

An input describes what the person should understand and what actions are
available. It can include concise HTML text, context links, a visual summary,
and one or more typed interactions.

An output contains:

- the originating `caller_item_id`;
- a unique `output_result_id` for delivery idempotency;
- the selected caller-defined `action_value`;
- a response whose shape matches the selected interaction;
- UTC answer timing and non-secret actor metadata.

Files are different from JSON values. Output JSON contains authenticated file
metadata; a separate endpoint returns the bytes.

## Delivery model

Output delivery is at least once until acknowledgement. Your caller may receive
the same `output_result_id` repeatedly after a timeout, restart, or retry. Make
downstream handling idempotent with that id before acknowledging.

Unacknowledged output is retained for a bounded period, not forever. Agent
Outbox is the handoff layer, not your system of record.

## When to use it

Agent Outbox fits work where:

- an agent can pause without holding a synchronous request open;
- the decision can be represented by named actions and typed follow-up input;
- the caller can persist a stable work id and resume later;
- downstream handling can be made idempotent.

For immediate, blocking confirmation inside an already active user interface, a
local dialog may be simpler. For durable decisions that outlive one process or
model turn, use Agent Outbox.
