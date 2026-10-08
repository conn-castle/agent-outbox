# Agent Outbox PR policy

Evaluate every check, status, label, and comment against fresh GitHub state for
the current PR head SHA.

## Hosted gates

- Required PR checks are `make check`, `make go-check`, `make browser`,
  `make migration-replay`, `make release-check`, and `Policy gates`. All must
  be `success` on the current head. Each context comes from exactly one
  workflow: the five `make …` contexts from CI, and `Policy gates` from its own.
- A run cancelled because a newer commit or label event superseded it is not
  a failure. Evaluate the newest run of each context on the current head.
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

## Eligible requests

A request embedded in an automated approval, review summary, survey or feedback
invitation, configuration or settings suggestion, or pre-merge checklist is
eligible regardless of review state, a no-findings verdict, an older head, or a
source footer. Give each a canonical disposition; use `Disagreed.` with reasons
when declining an external survey or setting. Status text, generic help text,
and unchecked optional bot controls are not requests.

## Handoff completeness

In dispatched (non-interactive) sessions, the watcher rule below replaces
ship-pr step 2's persistent watcher. Before every return to the caller, including
a merge-authorization request, blocker, or progress report, complete steps 1–3.
A merge-authorization request additionally requires steps 4–5:

1. **Dispatches:** Nothing you started may still be running. For each dispatch
   (`pr_worker`, reply validators), call `dispatch_wait` until terminal (if
   `running`, wait again), then until `termination_confirmed`. Read the complete
   `final_answer` of completed invocations. For failed or cancelled invocations,
   read `dispatch_inspect` and the `events` output and report them. Never inspect,
   wait on, cancel, or continue your own invocation, or launch another shipper.
2. **Watcher:** In a dispatched session, never start a persistent watcher. Each
   wait is one bounded ship-pr watcher command prefixed with `timeout 540` and
   using `--exit-on-change --interval-seconds 60`. It ends at the first event or
   after nine minutes, below common ten-minute foreground caps; exit 124 means
   no change in that window. Set the tool's own command timeout above 540
   seconds (for example, `600000` ms in Claude Code). If the harness backgrounds
   the command, wait on that task until completion; its exit status is the
   completion receipt. After every exit, including 124, re-evaluate fresh state
   (ship-pr step 3) before waiting again. If a persistent watcher was started
   anyway, stop it through its managed session. If there is no terminal
   receipt, or the absence check still finds a process, terminate the PIDs of
   your own watcher for this PR and keep the outputs. Verify absence:
   `pgrep -af -- 'watch-pr-events\.sh .*--repo <owner/name> --pr <number>( |$)'`
   must exit 1.
3. **Fresh readiness:** After step 2, refetch head, base, mergeability, every
   required check, labels, and all comment pages. Readiness claims must come
   only from this refetch.

4. **Reply validation:** If the caller's prompt or context names a reply
   validator anywhere, including inside an `implementation_input`, every posted
   or edited reply needs two fresh dispatches of that exact target; one PRE or
   POST dispatch may cover several bodies if it validates each in full. Before
   posting (PRE), validate the entire exact proposed body against fresh evidence:
   every claim, disposition prefix, explanation, link, and source reference;
   the exact head; canonical comment IDs/URLs; the full pushed SHA for `Fixed in`;
   and a real tracker for `Deferred.`. After posting (POST), validate the entire
   stored body read back from GitHub. A changed body needs new validation;
   unchanged validated bodies keep theirs. Never substitute another target or
   self-validation. Without a named validator, use ship-pr's own reply checks
   and report what was checked.
5. **Request content:** Include a ledger of every eligible request: source link,
   request text, disposition, posted reply link, and PRE/POST validator invocation
   IDs when step 4 applies. Include each dispatch with its terminal state,
   watcher evidence from step 2, and exact-head required-check states from step 3.

A blocker or progress return reports what remains, each dispatch with its
terminal state, and the watcher evidence.

## Readiness

Request merge authorization only after a fresh fetch confirms:

- the PR is mergeable;
- every required check named above is `success` on the latest head;
- the working tree has no uncommitted PR changes;
- no new feedback exists;
- every eligible comment has a posted, validated reply; and
- the request includes all Handoff completeness content above.

Report the required check states, comment disposition summary, and any policy
approval that was required.
