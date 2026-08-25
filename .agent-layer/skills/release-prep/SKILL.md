---
name: release-prep
description: >-
  Prepare or ship an Agent Outbox numbered release. Handles fresh and resumed
  preparation, mandatory human review of new marketing captures, verification,
  the release commit, an explicitly requested push to main, production workflow
  dispatch, monitoring, and final tag/release proof.
---

# Agent Outbox numbered release

Use [the release runbook](../../../docs/ops/release.md) as the canonical source
for repository and recovery details. This skill supplies the execution order,
authorization boundaries, and completion checks an agent must not infer.

## Authorization

Match mutations to the operator's request:

- **Prepare** or **prep** authorizes release files and one local release commit.
- **Push** authorizes pushing the prepared commits to `main` only when the
  operator says to push or otherwise explicitly names that remote mutation.
- **Release**, **ship**, or **deploy** authorizes dispatching the production
  workflow and monitoring it. Production dispatch requires the candidate to be
  on `origin/main`; it does not by itself authorize pushing local commits.

Never approve marketing screenshots for the operator, approve a protected
GitHub environment, apply a human-only label, deploy with Wrangler locally, or
create the numbered tag/release by hand. The production workflow owns deploy,
rollback, tagging, and GitHub Release creation.

## Release driver

Run the checked driver from the repository root instead of reconstructing the
push, dispatch, run-selection, or proof commands:

```bash
release_driver=.agent-layer/skills/release-prep/scripts/release.sh
```

Its commands are intentionally fail-fast and composable:

- `"$release_driver" verify <version>` verifies an approved release diff before
  commit.
- `"$release_driver" prepared <version>` proves that the attestation and PNGs
  are committed and deterministic.
- `"$release_driver" certify <version>` runs the complete local release and
  Worker dry-run gates against a committed release.
- `"$release_driver" push <version>` certifies, pushes `main`, and proves the
  remote SHA.
- `"$release_driver" dispatch <version>` dispatches production for the exact
  `origin/main` SHA and prints the selected run ID and URL.
- `"$release_driver" prove <version> <candidate-sha>` proves the final tag and
  GitHub Release.
- `"$release_driver" ship <version>` performs certify, push, dispatch, wait, and
  final proof as one operation when all those mutations are explicitly
  authorized.

Do not replace a driver failure with unchecked manual commands. Inspect the
failure and use the runbook's recovery procedure. The only intentionally manual
preparation steps are screenshot review, attestation, the version edit, diff
review, and commit creation.

## Establish the candidate

1. Use the exact version in the operator's request when supplied. Otherwise
   report `current=<package version> latest_tag=<latest numbered tag>` and ask
   for the exact stable version. Strip one leading `v`; require `X.Y.Z`. Never
   choose the version from semver history.
2. Inspect `git status --short --branch`, the current branch, and recent commits.
   Preserve unrelated work. Stop if pre-existing changes overlap release files
   or make the candidate ambiguous. Production releases must ultimately use the
   exact tip of `origin/main`.
3. Run `make release-preflight VERSION=<version>`. It fetches `main` and
   numbered tags. Stop on any version-gate failure; do not work around it.

The preflight intentionally accepts a target equal to `package.json` and
fetched `main` when its numbered tag is absent. That is the supported resume
path for an unpublished prepared release.

## Classify preparation state

After preflight, choose exactly one path:

### Already prepared

Treat the target as already prepared only when all of these are true:

- `package.json` and `marketing/screenshots.json` both contain the target;
- `make marketing-check` succeeds;
- the attestation and tracked PNGs are committed; and
- no release-file change is needed for this request.

Run `"$release_driver" prepared <version>`, but do **not** run `make marketing`, request a new
visual approval, rewrite the attestation, or manufacture a second release
commit. The committed manifest is the evidence that the current pixels were
already reviewed for this exact release.

### Needs preparation

For a new target or an incomplete/uncommitted attestation:

1. Before changing `package.json`, run `make marketing`. It regenerates all
   tracked PNGs in `public/` and writes
   `.agent-layer/tmp/marketing-capture/review/review.html`.
2. Report the review HTML and these three files:
   `public/product-review-queue.png`, `public/product-review-ipad.png`, and
   `public/product-review-mobile.png`.
3. Stop and ask the operator to review every image and explicitly approve the
   current capture. This checkpoint applies even when the pixel diff is empty.
4. Only after that approval, run
   `make marketing-approve VERSION=<version>` and set `package.json` to the same
   version. Do not alter the PNGs after approval.
5. Run `"$release_driver" verify <version>`. A real failure blocks release; a
   genuinely unavailable external prerequisite must be reported rather than
   disguised as success.
6. Review the diff and create one `chore: release <version>` commit containing
   only the required version, manifest, and approved screenshot changes. If the
   release files were committed as part of the candidate already, do not create
   an empty or artificial release commit.

Do not continue from rejected screenshots, capture drift, hash disagreement,
package/manifest mismatch, a dirty release-file diff, or failed verification.

## Push when authorized

Before pushing, inspect the commits that will enter `main` and confirm they are
all in scope. Then run:

```bash
"$release_driver" push <version>
```

Record the emitted `CANDIDATE_SHA`. The driver fails unless
`refs/remotes/origin/main` equals that SHA.

## Dispatch and monitor when authorized

Immediately before dispatch, rerun
`make release-preflight VERSION=<version>` and confirm:

- the worktree is clean;
- local `HEAD` and `origin/main` equal the recorded candidate;
- `package.json` and the marketing manifest contain the target; and
- `v<version>` still does not exist.

Dispatch only from `main` using the driver:

```bash
"$release_driver" dispatch <version>
```

It selects the newly created **Release Production** run whose `headSha` equals
the candidate and whose event is `workflow_dispatch`, then prints `RUN_ID` and
`RUN_URL`. Monitor that exact run with `gh run watch <id> --exit-status`.

If GitHub reports that protected-environment approval is required, give the
operator the exact run URL and wait. Never approve it on their behalf. If the
workflow fails, inspect the failed job logs, follow the recovery rules in the
release runbook, and redispatch only when the failure is safely retryable. Do
not create or move tags manually to turn a failed run green.

## Prove completion

The release is complete only after the workflow is green and all of these
checks agree:

- `refs/tags/v<version>` resolves to the recorded candidate SHA;
- `gh release view v<version>` reports a published, non-draft GitHub Release;
- `origin/main` still resolves to the candidate; and
- the production workflow's deploy and live runtime verification succeeded.

Use `"$release_driver" prove <version> <candidate-sha>` for the tag, release, and
remote-SHA checks. When certify, push, dispatch, and release are all authorized
at once, prefer `"$release_driver" ship <version>` so the same candidate SHA is
carried through the whole operation automatically.

When configured operator env files are available, also run the post-release
`make smoke-runtime` and `make hosted-health` checks from the runbook. Report an
exit code `2` as missing owner evidence, not success.

Report the candidate SHA, pushed branch, workflow URL/result, tag, GitHub
Release URL, and post-release check results. Never report completion merely
because dispatch succeeded.
