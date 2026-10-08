# Agent Outbox PR policy

Evaluate every check, status, label, and comment against fresh GitHub state for
the current PR head SHA.

## Hosted gates

- Required PR checks are `make check`, `make go-check`, `make browser`,
  `make migration-replay`, `make release-check`, and `Policy gates`. All must
  be `success` on the current head.
- Judge each check name by its newest run on the current head SHA. An older
  success never satisfies a newer failed, cancelled, or pending run.
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

## Feedback eligibility

Apply these rules as authoritative for both shipper and `pr_worker`, overriding
the per-comment exclusions in `address-pr-comments.md` where they differ.

- Classify each request inside a body. Status, summary, and walkthrough wrappers
  never exclude embedded requests; exclude only their request-free passages.
- Treat recommendations, suggestions, questions, and invitations addressed to
  authors or maintainers to change code, tests, docs, PR metadata, repository or
  tool configuration, or take action as eligible. Include bot settings requests
  such as setting `reviews.review_status` to `false`, "check the settings" in the
  UI or `.coderabbit.yaml`, and external-action invitations such as surveys.
- Exclude request-free status (review started/skipped/completed, rate-limit or
  allowance notices, "no actionable comments"), CI/check results,
  walkthroughs/summaries, pre-merge check tables, facts, verdicts without a
  request, optional unchecked controls (checkboxes/buttons: "Trigger review",
  "Commit to this branch", "Create a new PR", "Autopilot"), command-help
  footers, and this workflow's own replies. Never tick optional controls.
- Treat unclear text as eligible, except this workflow's own replies.
- Post one reply per eligible item, naming every request and its outcome.
  Prefix mixed outcomes with `Fixed in <sha>.` if any request was fixed in the
  PR, else `Deferred.` if any was deferred, else `Disagreed.`. Dispose of settings
  requests by fixing configuration in the PR or giving a disagreement/deferral
  reason.
- Treat a changed body digest as new feedback and re-classify it. Reuse an
  existing validated reply if it covers every eligible request in the edited
  body; record it again. Otherwise post a new reply disposing of every eligible
  request in the current body.

## Feedback rounds

Keep all agent artifacts under `.agent-layer/tmp`, never `/tmp`. Use round
directory `.agent-layer/tmp/ship-pr-<pr>/`, inventories `inventory-<label>.tsv`,
ledger `ledger.tsv`, and validated bodies `replies/<kind>-<source-id>.md` there.
Mask tokens, signed URLs, and opaque IDs in bot links before quoting fetched
bodies in prompts, stored files, or reports.

- Own mechanical coverage as shipper; leave classification to `pr_worker`.
- Create the round directory. In the same shell command, set `repo` to
  `owner/name`, `pr` to the PR number, and `out` to the round's
  `inventory-<label>.tsv`, then run this read-only inventory command; it writes
  only the named output and its `.partial` file:

```bash
bash -s -- "$repo" "$pr" "$out" <<'INVENTORY'
set -euo pipefail
unset GH_FORCE_TTY CLICOLOR_FORCE
export NO_COLOR=1 GH_PAGER=cat
repo="$1" pr="$2" out="$3"
[[ $repo == */* && $pr =~ ^[0-9]+$ && $out == .agent-layer/tmp/ship-pr-* ]] ||
  { echo "inventory: invalid repo, pr, or out" >&2; exit 2; }
rm -f -- "$out" "$out.partial"
{
  gh api --paginate "repos/$repo/issues/$pr/comments?per_page=100" |
    jq -r '.[] | ["conversation", .id, (.user.login // "(deleted)"), ((.body // "") | @base64)] | @tsv'
  gh api --paginate "repos/$repo/pulls/$pr/reviews?per_page=100" |
    jq -r '.[] | ["review", .id, (.user.login // "(deleted)"), ((.body // "") | @base64)] | @tsv'
  gh api --paginate "repos/$repo/pulls/$pr/comments?per_page=100" |
    jq -r '.[] | [(if .in_reply_to_id then "inline-reply" else "inline" end), .id, (.user.login // "(deleted)"), ((.body // "") | @base64)] | @tsv'
} | while IFS=$'\t' read -r kind id author body; do
  digest="$(printf "%s" "$body" | base64 -d | sha256sum)"
  printf "%s\t%s\t%s\t%s\n" "$kind" "$id" "$author" "${digest:0:16}"
done | sort -t $'\t' -k1,1 -k2,2n >"$out.partial"
mv "$out.partial" "$out"
INVENTORY
```

- Read columns as kind, ID, author, and first 16 hex of the full body's SHA-256.
  Key items by kind + ID; use digests to detect edits, never to validate replies.
  A non-zero exit means no inventory: never use missing, partial, or stale files
  as coverage proof.
- Keep exactly one ledger line per item: seven tab-separated single-line columns,
  `-` for empty: `kind`, `id`, `digest`, `classification` (`eligible` or
  `excluded:<reason>`), `requests` (short `;`-separated labels for every request,
  e.g. `settings:reviews.review_status`), `disposition` (`fixed`, `deferred`,
  `disagreed`), `reply` (`<reply-kind>:<reply-id>`). Store full bodies in `replies/`.
- Run the inventory before each dispatch; no separate full worker inventory is
  required. Read the required references and `read-pr-comments.sh` for context;
  its rendered output is not the raw API body used for hashing. For each listed
  kind + ID, the worker fetches one complete canonical API snapshot: conversation
  from `repos/<repo>/issues/comments/<id>`, review from
  `repos/<repo>/pulls/<pr>/reviews/<id>`, inline or inline-reply from
  `repos/<repo>/pulls/comments/<id>` (verify `in_reply_to_id` matches the kind).
  Verify the source PR and ID. Compute the first 16 hex of SHA-256 from that
  snapshot's exact raw `.body // ""` bytes, without adding a newline (e.g.
  `jq -j '.body // ""'`), before masking or rendering. Classify a scope-masked
  rendering derived from those same bytes, never a separately fetched body.
  Return exactly one ledger line per listed key with the computed digest, never
  blindly copy the supplied digest. Before accepting ledger lines or proposals,
  require that digest to match the listed inventory; reject mismatches and
  refetch the affected inventory/body. Missing, truncated, wrong-kind/ID bodies
  or keys without body classification are incomplete, never exclusions. The
  after-stop comparison also remains required, including for in-place edits.
- After posting and POST validation, regenerate the inventory and append a
  ledger line for the reply itself as `excluded:own-reply`, copying its kind,
  ID, and digest from the inventory row. A native inline reply also creates an
  empty-body `review` item (the reply's `pull_request_review_id`); record it the
  same way. These are the only lines the shipper writes without worker
  classification; posting an own reply alone never requires another worker
  round or watcher restart.
- Dispatch `pr_worker` for every fresh key or changed digest missing from the
  ledger, except recorded own replies. Never pre-filter or classify feedback as
  shipper, even apparent status-only items. Continue the same worker session when
  available; list only new or changed keys on later rounds.
- Write every worker prompt to `prompt-<n>.md` in the round directory and
  dispatch it from that file. Include all caller context verbatim (including
  `ship_pr_context` and `<implementation_input>`), exact PR/head/base, this
  policy's absolute path with instructions to read and apply Feedback eligibility
  and Feedback rounds over the generic reference, all skill-required references,
  inventory path and keys to classify, and one ledger line per listed key plus
  proposed replies for eligible items. Wait for terminal state and read the
  complete final answer before acting. Continue incomplete answers with exactly
  the missing, unclassified, or mismatched keys.

## Replies

- PRE: write the entire exact proposed body to `replies/<kind>-<source-id>.md`.
  Validate the whole body: canonical first words `Fixed in <40-hex SHA>.`,
  `Deferred.`, or `Disagreed.` using prefix precedence; every ledger request
  addressed with its outcome; and a source-item link for issue-comment replies
  to conversation comments or review summaries. For `Fixed in`, prove the SHA is
  pushed, contained in the PR head, and contains the claimed change. Post one
  reply at a time; failed PRE blocks posting.
- POST: fetch each posted reply by ID, require its stored body to equal the
  validated file exactly, then record the reply in the ledger. Correct failed
  POST before requesting merge authorization.

## Handoff

Before every merge-authorization request, blocker, or other return to the caller:

1. Finish every local validator, local check, and dispatched worker started by
   this workflow; read each full result. Never hand off running work or
   partially read output.
2. Stop a background watcher through its native managed task/session and record
   its task ID and native completed/stopped status; for a foreground
   `--exit-on-change` run, record that it exited and its exit status. Then
   prove absence for the workflow's OS login user by running this as its own
   command (the anchor excludes agent shell wrappers; `--repo` and the log name
   scope it to this PR):
   `pgrep -u "$(id -un)" -af '^([^ ]*/)?bash [^ ]*watch-pr-events\.sh .*--repo <owner/name> .*ship-pr-events-<pr>\.jsonl'`.
   Exit 1 means absent, 0 means a watcher for this log remains, any other exit
   means inspection failed. Stop only watchers this workflow started. On residual
   watchers or inspection failure, start no replacement; return a blocker with
   evidence. Create `.agent-layer/tmp/ship-pr-<pr>/tmp` first and run every
   watcher with `TMPDIR="$PWD/.agent-layer/tmp/ship-pr-<pr>/tmp"`, the skill's
   argument order, and the skill's log `.agent-layer/tmp/ship-pr-events-<pr>.jsonl`.
3. After stopping, fetch fresh head SHA, mergeability, up-to-date status, newest
   run of every required check on that head, and regenerate `inventory-final.tsv`.

Request merge authorization only when that after-stop fetch proves:

- Every inventory key is in the ledger with the same digest; every `eligible`
  line has a disposition and reply; every other line is `excluded:<reason>`.
  Fetch every referenced reply again: it must still exist and its stored body
  must equal its validated file exactly.
- The PR is mergeable and up to date; all six required checks have newest-run
  `success` on the head; no uncommitted PR changes exist; no human-only approval
  gate is pending.

If any requirement fails or the head changed, restart the watcher and continue
instead of requesting authorization, subject to the stop/inspection blocker
above; return a blocker instead when continuing requires user action. For
blocker handoffs, name each unresolved key or failed requirement and missing
evidence.

Report only verified evidence: PR and full head SHA; each required check's name,
conclusion, and run ID; mergeability; inventory/ledger paths and item, eligible,
excluded, and replied-line counts; each reply's source key, disposition, ID, and
PRE/POST results; each worker round's prompt path, handle, invocation, and
terminal state; watcher task ID or foreground exit, native stop status, and
`pgrep` result; after-stop fetch time in UTC; required human-only approval; and
unresolved items for blockers.
