# Agent Outbox PR policy

Evaluate every check, status, label, and comment against fresh GitHub state for
the current PR head SHA.

## Hosted gates

- Required PR checks are `make check`, `make go-check`, `make browser`,
  `make migration-replay`, `make release-check`, and `Policy gates`. All must
  be `success` on the current head.
- This repository does not use a `ready-for-merge` label or a second merge-CI
  phase. Ordinary PR CI already runs the full verification surface.
- Branch protection requires the PR branch to be up to date with `main`. Update
  a conflict-free branch when it is behind. Resolve actual conflicts normally.

## Failure routing

- Inspect a failed `Policy gates` job before routing it. These approvals are
  human-only:

  | Failed gate | Required label |
  | --- | --- |
  | Megachange cap | `megachange-approved` |
  | Destructive migration scanner | `migration-destructive-approved` |
  | Public legal-policy gate | `legal-policy-approved` |

  Report the exact gate and wait for the user to apply its label through the
  GitHub web interface or direct a code or scope change. Never apply these
  labels. Their application retriggers Policy gates; do not manually rerun it.
- Route every other diagnosed hosted failure through `/fix-ci`.
- For a stuck or cancelled run that left no successful exact-head required
  check, rerun interrupted failed jobs with `gh run rerun <run-id> --failed`.
  Do not create an empty commit.
- Never force-push or rewrite history unless the user explicitly asks.

## Readiness

Before applying this gate or completing any other handoff, the publisher must
obtain stop proof from a real invocation of its own native watcher. If no
managed watcher is running, run the step 2 watcher command in a bounded
foreground wait with `--exit-on-change`, reusing the same append-only log and
keeping only one watcher active. Retain the watcher's own returned exit status
before the after-stop fetch, even when the PR is ready on the first fetch.
Evidence that no watcher was started does not satisfy the stop-proof
requirement.

Request merge authorization only after the watcher stop proof below and a fresh
fetch made after that stop confirm:

- the PR is mergeable;
- every required check named above is `success` on the latest head;
- the working tree has no uncommitted PR changes;
- no new feedback exists; and
- every eligible comment has a posted reply that passed both validations below.

If that fetch fails any item above, restart the watcher and return to the
ship-pr feedback step instead of requesting merge.

## Reply validation

Each eligible reply needs two independent validations. Unless the caller names
another validator, use a fresh `claude` dispatch with model `opus` at `high`
reasoning effort that is neither the `pr_worker` nor the shipper session.

- Before posting or editing a reply (PRE), validate its entire final proposed
  body against fresh evidence: every claim, disposition prefix, explanation,
  link, and any Source footer; the exact head, canonical comment IDs and URLs,
  and the caller's source-hash uniqueness requirement; for `Fixed in`, that
  the full pushed SHA contains the fix; and for `Deferred.`, that the tracker
  exists. Compute the source-comment SHA-256 from the original API body encoded
  as UTF-8 before any masking or newline normalization. Any Source footer must
  correctly bind the canonical source kind, ID, URL, and original body digest
  to the intended source. Resolve that identity uniquely; identical source
  bodies require the canonical kind and ID, never an invented identity or a
  claim that their shared digest is unique. Report any unmet caller hash
  uniqueness requirement as a blocker.
- Separately compute the SHA-256 of the exact, complete proposed reply's UTF-8
  bytes for PRE validation. This reply binding is distinct from the original
  source digest; it does not require deduplicating reply bodies across the PR.
- After posting or editing (HOSTED POST), refetch the stored body through the
  API and validate that entire stored body against a fresh evidence snapshot
  covering the same checks as PRE. Compute its own SHA-256 from the entire
  refetched body's UTF-8 bytes before any masking or newline normalization;
  bind POST validation to that stored reply, separately from the original
  source digest.

The canonical `scripts/read-pr-comments.sh` prints API IDs, URLs, and bodies;
it does not determine eligibility from a Source footer. Apply
`references/address-pr-comments.md`: explicit asks remain actionable regardless
of approval or status, older heads, or Source footers.

A validation counts only after its invocation completes and its entire final
answer, read in full, passes that exact body, identified by SHA-256. A running,
failed, cancelled, or unread validation is not a pass. Keep a completed pass
while the body bytes and every fact the body asserts, such as a cited SHA,
head, ID, URL, or tracker, are unchanged. A new PR head alone does not
invalidate a body that asserts nothing about the head.

## Watcher stop proof

A managed watcher has stopped only when both hold after the stop request:

- the retained task's own completion status, such as its exit code or killed
  state, is observed after the stop, not the stop call's return value; and
- `pgrep -af 'watch-pr-event[s][.]sh.*ship-pr-events-<pr-number>[.]jsonl'`
  exits with status 1, meaning no match; any other status is an error, not
  proof. The bracket keeps the pattern from matching its own command line, and
  the log basename matches both relative and absolute paths.

Record the task ID, completion status, UTC check time, and the log's last
event. A provider or tool exit, watchdog or status snapshot, registration state,
stop or kill request alone, null exit status without a terminal task state, or
absence of an unrelated process is not proof. A foreground `--exit-on-change`
wait is proven stopped by its own returned exit status. Also list every other
process, server, and login session you started, and whether each stopped or why
it remains. The publisher must stop and verify its own native watcher before
any completed handoff, including a merge request or a blocker, preserved, or
merged report. Naming a watcher as not stopped discloses failure; it is not an
alternate completion path. If stop proof is unavailable, report an explicit
failed or incomplete handoff with the known watcher state and owner. It cannot
count as completed shipping or merge readiness. The caller must also stop its
own watch before its handoff. These requirements create no recovery or
cancellation authority.

## Handoff

A dispatched shipper's final reply ends its invocation; nothing it promises
afterward happens. A dispatched shipper never ends a turn to wait for checks,
reviews, or watcher events, even with a monitor attached. It waits in a bounded
foreground command that blocks until the watcher log grows past its size at the
last fresh fetch or a timeout passes, then acts on fresh state. Return only a
complete merge-authorization request, a blocker report, or a post-authorization
merged or preserved report. A progress-only reply is a failed handoff. Every
completed handoff requires the native watcher stop proof above. An explicit
failed or incomplete handoff must disclose any unavailable proof and the known
watcher state and owner; that disclosure does not complete the handoff.

Before a completed handoff, every dispatch you own, including the `pr_worker`
and especially validators, must reach a terminal state with durable termination
confirmation, and you must read its entire final output. A hung or unfinished
invocation may be reported as an explicit failure or blocker with its invocation
ID, last observed state, and `termination_confirmed`, but that report is not a
completed successful handoff or validation. It does not waive terminal, durable,
or full-output requirements, permit a progress-only return, or create any
cancellation authority.

A merge-authorization request includes:

- the PR URL and full head SHA;
- the watcher stop proof and activity accounting;
- the after-stop fetch time in UTC and, from it, mergeability, up-to-date
  status, and each required check's state on that head;
- a ledger of every eligible comment with its ID or URL, disposition, posted
  reply URL, and both validation receipts (validator invocation ID, body
  SHA-256, and verdict);
- each owned dispatch's invocation ID and terminal state, other than the
  request validator, which the receipt line reports; and
- any policy approval that was required.

Before returning that request, have an independent validator, chosen as for
replies, check the entire request against fresh GitHub state and the cited
receipts. Return only after its completed report, read in full, passes that
exact text. Return the validated text unchanged, followed by one line naming
the validator invocation ID, terminal state, durable `termination_confirmed`
status, verdict, and SHA-256 of the validated text's UTF-8 bytes with no
trailing newline. Any edit requires revalidation.
