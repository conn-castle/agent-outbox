---
name: release-prep
description: >-
  Prepare an Agent Outbox numbered release locally: obtain the operator's exact
  version, capture every landing-page product screenshot, require human review,
  attest the reviewed images, bump package metadata, verify, and create the
  local release-prep commit. Does not push, merge, or deploy.
---

# release-prep

Invoking this skill authorizes the local release-prep edits and one local
release-prep commit. It does not authorize pushing, opening or merging a pull
request, dispatching production, or approving screenshots on the operator's
behalf.

## Workflow

1. Require a clean worktree and read the current `package.json` version.

2. Always ask the operator:

   *"`current=<current> latest_tag=<latest_tag>`. What should the new version
   be?"*

   Strip a leading `v` from the response and require stable `X.Y.Z`. Version
   selection belongs to the operator; semver history may support a bump-type
   recommendation but never supplies the answer.

3. Run the executable version gate before capture:

   ```bash
   make release-preflight VERSION=<version>
   ```

   This fetches `main` and numbered tags and reports `current`, `latest_tag`,
   and `target`. Stop if the target is not newer than both the package version
   and latest tag, or if its numbered tag already exists.

4. Before editing `package.json`, run `make marketing`. This regenerates every
   tracked screenshot directly in `public/` and writes the comparison report to
   `.agent-layer/tmp/marketing-capture/review/review.html`. Git is the review
   boundary: do not stage or commit the regenerated files yet.

5. Report the three tracked PNG paths and the review report, then ask:

   *"Marketing screenshots regenerated for `<version>`. Review every tracked
   image and confirm to attest them, or tell me what to fix."*

   This checkpoint is unconditional, including when regenerated pixels are
   unchanged. Never infer approval from a prior release, a clean diff, test
   output, or an agent-authored attestation. On rejection, stop or make the
   requested product/capture fixes and regenerate the tracked images.

6. Only after explicit approval, run:

   ```bash
   make marketing-approve VERSION=<version>
   ```

   This repeats the fetched-tag version gate, then records the reviewed hashes
   and release version in the manifest. Set `package.json` to the same version.
   Do not regenerate, replace, or edit screenshots during the remaining release
   workflow.

7. Run `make marketing-check`, `make marketing-verify`, and the repository's
   complete required release verification. The verify command may write only
   ignored evidence under `.agent-layer/tmp`; it must not modify committed
   marketing files.

8. Create one local `chore: release <version>` commit containing the version,
   marketing manifest, and approved screenshot changes. When fresh captures are
   pixel-identical, the manifest version is the release-specific attestation and
   the PNGs need not have artificial byte changes.

9. Report the commit SHA and verification result. Stop without pushing,
   opening a pull request, merging, or dispatching production; those require a
   separate explicit request and the repository's normal controls.

## Failure boundaries

- Missing screenshots, incomplete manifests, hash disagreement, fresh-capture
  drift, or a package/manifest version mismatch is a release blocker.
- A target that is not newer than the current package and latest fetched tag,
  or whose numbered tag exists, is a release blocker.
- Never call `marketing-approve` before the operator approves the current
  tracked screenshots.
- Never bypass the marketing check in `scripts/production-release.mjs`; the
  production workflow intentionally fails before certification or deployment.
