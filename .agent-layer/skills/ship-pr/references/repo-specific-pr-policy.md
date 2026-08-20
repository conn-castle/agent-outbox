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

Request merge authorization only after a fresh fetch confirms:

- the PR is mergeable;
- every required check named above is `success` on the latest head;
- the working tree has no uncommitted PR changes;
- no new feedback exists; and
- every eligible comment has a posted, validated reply.

Report the required check states, comment disposition summary, and any policy
approval that was required.
