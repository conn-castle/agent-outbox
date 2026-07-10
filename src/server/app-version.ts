import { runtimeRelease } from "./observability.ts";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Footer build label: the semantic version plus the short deployed build id
 * when one is available.
 *
 * `version` is passed in from `package.json` (the single source of truth for the
 * version number) so this function stays free of the JSON import and unit
 * testable. `release` defaults to `runtimeRelease()` — the deployed build id
 * (`SENTRY_RELEASE` / `GITHUB_SHA`); a 40-character git SHA is shortened to 7
 * characters, and any other release identifier is shown verbatim. In local
 * development neither release env is set, so only the version shows.
 *
 * Examples: `v0.1.0 · a1b2c3d` (deployed), `v0.0.0` (local dev).
 *
 * @param {string} version
 * @param {string | undefined} release
 */
export function formatVersionLabel(
  version: string,
  release = runtimeRelease()
): string {
  const label = `v${version}`;
  if (typeof release !== "string" || release.length === 0) {
    return label;
  }
  const build = FULL_GIT_SHA.test(release) ? release.slice(0, 7) : release;
  return `${label} · ${build}`;
}
