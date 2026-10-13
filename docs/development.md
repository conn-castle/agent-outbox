# Repository development

Run `make setup` in each checkout or worktree, then use `make help` for the
repository's build and verification commands. `package.json` pins pnpm and the
Node runtime; setup installs the frozen lockfile and downloads the pinned
runtime when needed. The application remains Next.js with OpenNext for
Cloudflare.

## Dependency reuse across worktrees

`pnpm-workspace.yaml` enables pnpm's
[global virtual store](https://pnpm.io/global-virtual-store) with
`virtualStoreType: global`. Fresh worktrees link suitable installed dependencies
from the same store instead of constructing another dependency tree. This is
distinct from pnpm's existing shared download cache.

Store locations follow pnpm's native defaults on macOS and Linux. Inspect the
content store with `corepack pnpm store path`; the installed virtual store lives
in its `links` directory. No personal paths are configured in the repository.
Keep Go, npm, and uv caches at their native locations too.

pnpm identifies installed packages by their dependency graphs, including peer
dependencies, resolution integrity, and patches. Packages with build scripts,
and their dependents, additionally use the OS, architecture, and Node major
version. The exact Node runtime comes from the lockfile. Changing a dependency
graph therefore selects another installed target while unchanged compatible
packages remain reusable.

The store is shared writable state within a trusted user and job boundary. Treat
installed dependency files as shared: editing one can affect another checkout.
Keep application source, `.next`, `.next-browser`, `.open-next`, TypeScript
build information, and other writable outputs in their own worktree. Do not run
an install concurrently with a build in the same worktree. The Release Check
workflow explicitly selects `PNPM_CONFIG_VIRTUAL_STORE_TYPE=project` for
ordinary jobs. pnpm's CI default only disables the global store when the setting
is unspecified; the workspace's explicit `global` setting overrides that
default. Other automation that needs a local installed store must also
explicitly select `project`.

The native `packageExtensions` entries declare missing React type peers in Next
and DnD Kit. Their declarations need the project's `@types/react` alongside
their installed graph because the shared store is outside the checkout. This
follows [pnpm's TypeScript guidance](https://pnpm.io/typescript) and keeps
normal TypeScript symlink resolution.

## Next filesystem cache and build outputs

Next.js is pinned to 16.4.0. Its experimental `turbopackAdditionalRoots` admits
only the installed virtual store recorded in pnpm's `.modules.yaml` when that
store is outside the project. The pinned pnpm writes that metadata as JSON.
`make setup` must complete before loading Next configuration. The Turbopack
project root remains the checkout; it never expands to the home directory.

Native `turbopackFileSystemCacheForDev` and `turbopackFileSystemCacheForBuild`
are enabled. `turbopackSeedCacheFromWorktree` can seed an empty,
version-compatible cache from the newest usable cache in this Git repository's
main checkout or linked worktrees. Immutable cache files are hardlinked; mutable
files are copied. Seeding is best effort in Next and may provide no reuse when a
suitable cache is absent. Next tracks build inputs and invalidates changed work;
changing the framework/cache format can select a different cache version.
Seeding does not copy final build artifacts or promise a particular speedup.

Keep each worktree's writable output directories independent. Use the canonical
build entrypoints in that worktree. Do not run two builds targeting the same
`.next` directory at once; separate worktrees may build concurrently. Browser
builds retain their existing `.next-browser` output. OpenNext writes
`.open-next` and performs its own Next build; do not package another tree's Next
output.

## Hosted compatibility proof

The PR-only `cache compatibility (Linux)` job in Release Check explicitly sets
`PNPM_CONFIG_VIRTUAL_STORE_TYPE=global` while keeping `CI=true`. This supported
pnpm environment setting overrides the workspace/CI default. pnpm's native
run/exec child environment supplies its Node resolution paths and ESM loader; no
hand-maintained loader or CI-detection bypass is used. Ordinary CI builds with a
project store do not establish global-store compatibility.

`node scripts/cache-proof.mjs` is restricted to Linux GitHub Actions with the
pinned Node and pnpm. It creates two linked worktrees at the candidate SHA,
checks matching final package/runtime/lock/config inputs, verifies
`.modules.yaml` and every direct dependency/runtime's global realpath and inode,
and exercises a deliberately changed Next type-peer graph before restoring final
inputs. Unchanged compatible packages must retain their targets.

The proof runs canonical builds in both final setups. It invokes the exact
installed native cache-seed function used by Next builds and records immutable
hardlink identities, byte counts, mutable copies, CURRENT metadata, and command
times before the unchanged seeded build. Native task hit/miss statistics must
show fewer misses in the seeded unchanged build than the cold build, with actual
hits. These proof-only diagnostics follow Next 16.4's upstream cache tests;
cache files alone cannot satisfy the job. It checks matching rendered home-page
content, then concurrently builds changed source in one tree and runs canonical
OpenNext packaging/Worker dry-run in the other. Output identities and rendered
content must demonstrate isolation; shared direct dependency file hashes must
remain unchanged. It uses four Next builds total, including OpenNext's build.
The temporary source/peer fixtures never alter the candidate checkout or shared
installed files.

The pinned artifact action uploads only sanitized proof metadata and command
logs, including on failure, with seven-day retention. A passing job supplies
Linux acceptance for its exact SHA; configuration assertions alone do not.
macOS, another architecture, and another runtime require actual separate runtime
evidence. Existing Release Check test, browser, database, package, and marketing
gates remain independent acceptance requirements.

## Agent Layer

The repository pins the stable
[Agent Layer v1.0.0 release](https://github.com/conn-castle/agent-layer/releases/tag/v1.0.0)
in `.agent-layer/al.version`. Run `al sync` from the checkout to regenerate
client projections. Edit source instructions, skills, and
`.agent-layer/config.toml`; generated client files are not the source of truth.

Local instructions have explicit ordering in `instructions.local`. Local skills
live in `.agent-layer/skills`; imported skills and their lock are tracked in
`.agent-layer/skills-imported` and `.agent-layer/skills.lock.json`.
`al skills status --all` inspects them offline. Sync preserves the repository's
custom instructions and client settings, including repository-local Claude/Codex
configuration, `model_fallback = false`, and `whimsy = false`.

Before a future upgrade, read its native help, prefetch the exact release, and
review `al upgrade plan --version <version>`. Apply only reviewed managed
updates, then regenerate with `al sync`. Preserve source, settings, history,
credentials, and `.agent-layer/tmp`; unknown-data and temporary-file deletion
flags can remove unique data or affect live sessions. Credential stores belong
to their owning project and are not worktree setup inputs.
