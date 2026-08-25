#!/usr/bin/env bash

set -euo pipefail

readonly release_files=(
  package.json
  marketing/screenshots.json
  public/product-review-queue.png
  public/product-review-ipad.png
  public/product-review-mobile.png
)

usage() {
  cat <<'EOF'
Usage: release.sh <command> <version> [candidate-sha]

Commands:
  verify    Verify a newly approved release diff before committing it.
  prepared  Prove that the version and reviewed screenshots are release-ready.
  certify   Run prepared checks, the complete release gate, and Worker dry-run.
  push      Certify, then push the exact clean main candidate to origin/main.
  dispatch  Dispatch production for the exact origin/main candidate; print run data.
  prove     Prove the tag and published GitHub Release point to candidate-sha.
  ship      Certify, push, dispatch, wait, and prove one release end to end.
EOF
}

fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

normalize_version() {
  local value=${1#v}
  [[ $value =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "version must be stable X.Y.Z, got '$1'"
  printf '%s\n' "$value"
}

require_repo_root() {
  [[ -f package.json && -f marketing/screenshots.json ]] ||
    fail 'run from the Agent Outbox repository root'
}

json_version() {
  node --input-type=module -e \
    "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))[process.argv[2]])" \
    "$1" "$2"
}

require_clean_worktree() {
  [[ -z $(git status --porcelain=v1) ]] || fail 'worktree must be clean'
}

require_main() {
  [[ $(git branch --show-current) == main ]] || fail 'current branch must be main'
}

run_attestation() {
  local version=$1 package_version manifest_version

  make release-preflight VERSION="$version"
  package_version=$(json_version package.json version)
  manifest_version=$(json_version marketing/screenshots.json releaseVersion)
  [[ $package_version == "$version" ]] ||
    fail "package.json version is $package_version, expected $version"
  [[ $manifest_version == "$version" ]] ||
    fail "marketing manifest version is $manifest_version, expected $version"
  make marketing-check
  make marketing-verify
}

run_verify() {
  run_attestation "$1"
  make release-check
  corepack pnpm run worker:dry-run
}

run_prepared() {
  run_attestation "$1"
  [[ -z $(git status --porcelain=v1 -- "${release_files[@]}") ]] ||
    fail 'release files must be committed before treating the release as prepared'
}

run_certify() {
  run_verify "$1"
  [[ -z $(git status --porcelain=v1 -- "${release_files[@]}") ]] ||
    fail 'release files must be committed before certifying the release'
}

record_candidate() {
  git rev-parse HEAD
}

push_candidate() {
  local version=$1 candidate remote_candidate

  require_main
  require_clean_worktree
  run_certify "$version"
  require_clean_worktree
  git fetch origin main --tags
  git merge-base --is-ancestor refs/remotes/origin/main HEAD ||
    fail 'origin/main is not an ancestor of the local candidate'
  candidate=$(record_candidate)
  git push origin HEAD:main
  git fetch origin main --tags
  remote_candidate=$(git rev-parse refs/remotes/origin/main)
  [[ $remote_candidate == "$candidate" ]] ||
    fail "origin/main is $remote_candidate, expected $candidate"
  printf 'CANDIDATE_SHA=%s\n' "$candidate"
}

dispatch_candidate() {
  local version=$1 candidate remote_candidate started_at run_line attempt

  require_main
  require_clean_worktree
  make release-preflight VERSION="$version"
  make marketing-check
  candidate=$(record_candidate)
  remote_candidate=$(git rev-parse refs/remotes/origin/main)
  [[ $remote_candidate == "$candidate" ]] ||
    fail "origin/main is $remote_candidate, expected local candidate $candidate"
  ! git show-ref --verify --quiet "refs/tags/v$version" ||
    fail "tag v$version already exists"

  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run deploy-production.yml --ref main

  run_line=''
  attempt=0
  while ((attempt < 30)); do
    ((attempt += 1))
    run_line=$(gh run list --workflow deploy-production.yml --event workflow_dispatch \
      --limit 20 --json databaseId,url,headSha,createdAt \
      --jq ".[] | select(.headSha == \"$candidate\" and .createdAt >= \"$started_at\") | [.databaseId, .url] | @tsv" \
      | head -n 1)
    [[ -n $run_line ]] && break
    sleep 2
  done
  [[ -n $run_line ]] || fail 'could not identify the newly dispatched production run'

  RELEASE_RUN_ID=${run_line%%$'\t'*}
  RELEASE_RUN_URL=${run_line#*$'\t'}
  printf 'CANDIDATE_SHA=%s\nRUN_ID=%s\nRUN_URL=%s\n' \
    "$candidate" "$RELEASE_RUN_ID" "$RELEASE_RUN_URL"
}

prove_release() {
  local version=$1 candidate=$2 tag_candidate remote_candidate release_json

  [[ $candidate =~ ^[0-9a-f]{40}$ ]] || fail 'candidate-sha must be a full Git SHA'
  git fetch origin main --tags
  tag_candidate=$(git rev-list -n 1 "v$version" 2>/dev/null) ||
    fail "tag v$version does not exist"
  remote_candidate=$(git rev-parse refs/remotes/origin/main)
  [[ $tag_candidate == "$candidate" ]] ||
    fail "v$version resolves to $tag_candidate, expected $candidate"
  [[ $remote_candidate == "$candidate" ]] ||
    fail "origin/main resolves to $remote_candidate, expected $candidate"

  release_json=$(gh release view "v$version" --json url,isDraft,isPrerelease,tagName)
  node --input-type=module -e '
    const release = JSON.parse(process.argv[1]);
    const tag = process.argv[2];
    if (release.tagName !== tag || release.isDraft || release.isPrerelease) process.exit(1);
  ' "$release_json" "v$version" || fail "GitHub Release v$version is absent, draft, or prerelease"
  printf 'CANDIDATE_SHA=%s\nTAG=v%s\nRELEASE_URL=%s\n' \
    "$candidate" "$version" \
    "$(node --input-type=module -e 'console.log(JSON.parse(process.argv[1]).url)' "$release_json")"
}

main() {
  local command=${1:-} raw_version=${2:-} version candidate
  [[ -n $command && -n $raw_version ]] || {
    usage >&2
    exit 64
  }
  require_repo_root
  version=$(normalize_version "$raw_version")

  case $command in
    verify)
      run_verify "$version"
      ;;
    prepared)
      run_prepared "$version"
      ;;
    certify)
      run_certify "$version"
      ;;
    push)
      push_candidate "$version"
      ;;
    dispatch)
      dispatch_candidate "$version"
      ;;
    prove)
      candidate=${3:-}
      [[ -n $candidate ]] || fail 'prove requires candidate-sha'
      prove_release "$version" "$candidate"
      ;;
    ship)
      push_candidate "$version"
      candidate=$(record_candidate)
      dispatch_candidate "$version"
      printf 'Waiting for production run %s (%s)\n' "$RELEASE_RUN_ID" "$RELEASE_RUN_URL"
      gh run watch "$RELEASE_RUN_ID" --exit-status
      prove_release "$version" "$candidate"
      ;;
    *)
      usage >&2
      exit 64
      ;;
  esac
}

main "$@"
