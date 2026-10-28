# Agent Outbox lossless website image optimization

Implementation is complete in the designated worktree, with no staged files,
commits, pushes, pull requests, deployments, dependency changes, or edits to the
primary checkout. All retained artifacts belong to this task and may be considered
disposable only after the coordinating owner has finished consuming them. No
artifacts have been deleted.

- Worktree: `../worktree`
- Branch: `perf/website-lossless-20261028`
- Baseline HEAD: `e0aebb42f05004babdeb60b07ca2cb356f66cb6b`
- Scope: static marketing images used by `agent-outbox.dev` only.
- Instructions: the target worktree has no `AGENTS.md`; the supplied instructions
  and ancestor repository `AGENTS.md` were read, along with the target's
  `docs/agent-layer/CONTEXT.md` and repo-specific PR policy. No review dispatches
  were made, as instructed for this invocation.

## Exact source changes

| File | Before bytes | After bytes | Saved bytes | Saved |
| --- | ---: | ---: | ---: | ---: |
| `public/product-review-queue.png` | 245,218 | 191,639 | 53,579 | 21.85% |
| `public/product-review-ipad.png` | 140,831 | 106,137 | 34,694 | 24.64% |
| `public/product-review-mobile.png` | 103,614 | 74,710 | 28,904 | 27.90% |
| Total | 489,663 | 372,486 | 117,177 | 23.93% |

`marketing/screenshots.json` changes only its three `sha256` fields. Release
version, dimensions, asset IDs, URLs, and routes remain identical. No other tracked
files have changed. Final hashes are in `verification.json` and `manifest.patch`.

Used installed sharp 0.35.5, PNG compression level 9, adaptive filtering false,
palette false. Both adaptive filtering choices were measured and retained in
`candidates/`; false produced the smaller file for every asset. Sharp adds a pHYs
density chunk, which the implementation removed because the original PNGs have no
ancillary metadata. The final files retain byte-identical IHDR chunks, RGB8 color
type, no interlacing, no alpha, and no ancillary chunks, like the originals. PNG
scanline encoding and IDAT payloads/chunk boundaries change; decoded pixels do not.

## Evidence and checks

- Originals copied directly from `git show HEAD:<path>` into `baseline/`;
  original hashes checked against the original manifest and worktree files.
- Every compression trial was decoded using sharp into four-channel raw RGBA
  and required exact Buffer equality, including width, height, and channel count.
- Selected final files repeated that exact check after density-chunk removal.
- Existing repository `comparePng` with zero channel and pixel tolerance reports
  `identical` for all three final files: zero differing pixels, zero max channel
  delta, unchanged 1440×960, 768×1024, and 430×932 dimensions.
- Both baseline and final decoded RGBA buffers retained in `raw/`; their
  equality was checked again in the independent Python source audit.
- Python stdlib CRC-32 validation passed for every final PNG chunk.
- Final source audit proves only the four intended tracked files changed, the
  manifest changes only SHA fields, and the index contains no changes.
- `node scripts/marketing-screenshots.mjs check`: passed.
- `node --test tests/marketing-screenshots.test.mjs`: 4 passed, 0 failed.
- `node node_modules/prettier/bin/prettier.cjs --check marketing/screenshots.json`:
  passed.
- `git diff --check`: passed.

All command outputs are retained in `logs/`; structured raw evidence is in
`compression-trials.json`, `verification.json`, and `final-source-audit.json`.
Scripts are retained as `compress.mjs`, `apply-and-verify.mjs`, and `final-audit.py`.
The first two intentionally refuse to overwrite baselines or unexpected working
tree changes; restore the original inputs in a separate disposable worktree to
reproduce the mutation sequence.

## Source assessment and limits

Inspected the landing page, root layout, CSS context, all three actual screenshot
images, capture test, marketing attestation/comparison scripts, release docs,
Next configuration, and public headers. `app/page.tsx` uses these PNG URLs in a
responsive desktop/mobile hero and separate tablet/mobile sections. The same URLs
and dimension attributes remain in place. Composition, fonts, animation, route,
auth, analytics, error handling, and cache policy source are untouched.

No capture workflow change is necessary. `captureForReview` compares decoded
pixels and preserves the committed baseline bytes for identical or insignificant
fresh captures. `verifyFreshCapture` also compares decoded pixels. A future
substantively changed product screenshot will use fresh capture bytes and can be
recompressed separately; optimizing that future case would broaden this task.

No extra cache rules were added: the screenshot URLs are unversioned and no
versioned invalidation proof was established. The byte reduction is verified;
real page timing, browser screenshots, build checks, and full test suites remain
with the coordinating root as requested. There are no unresolved implementation
decisions.

## Process accounting

The first scoped compression launch failed before work because the tool shell
lacked the user bus variables. Its log is retained. The second launch waited on
the shared workload lock. Only this task's waiting flock PID 3154377 was sent
SIGTERM; its owning exec session returned exit 143, and no compression had begun.
The successful compression and apply steps, plus the 74 ms attestation unit tests,
ran at nice priority 19 in `castle-background.slice` through `systemd-run --user
--quiet --scope --same-dir`, with explicit verified user bus paths. These are
lightweight asset operations and narrow tests, not heavy builds/tests. No heavy
build/test, `make check`, browser, capture, or server was launched. All launched
commands have completed; no watcher, server, login session, or dispatch remains
owned by this invocation.
