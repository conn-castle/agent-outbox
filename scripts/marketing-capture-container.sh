#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
case "$mode:$#" in
  capture:2|verify:2|retire-cache:1|retire-cache:2) ;;
  *)
    echo "usage: marketing-capture-container.sh <capture|verify> <output-dir> | retire-cache [absolute-owner-worktree-path]" >&2
    exit 64
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
owner_root="$repo_root"
if [[ "$mode" == "retire-cache" && $# -eq 2 ]]; then
  owner_root="$2"
  if [[ "$owner_root" != /* || "$owner_root" == / || "$owner_root" == */ ||
        "$owner_root" == *//* || "$owner_root/" == */./* ||
        "$owner_root/" == */../* || "$owner_root" =~ [[:cntrl:]] ]]; then
    echo "Expected an exact absolute worktree owner path without trailing/repeated slashes, dot components, or control characters; no cleanup performed." >&2
    exit 64
  fi
fi
worktree_id="$(printf '%s' "$owner_root" | git hash-object --stdin)"
worktree_id="${worktree_id:0:16}"
cache_volumes=(
  "agent-outbox-marketing-node-modules-amd64-${worktree_id}"
  "agent-outbox-marketing-next-browser-amd64-${worktree_id}"
)

require_owned_cache() {
  local project ownership lifecycle
  project="$(docker volume inspect --format '{{index .Labels "agent-outbox.dev-project"}}' "$1")"
  ownership="$(docker volume inspect --format '{{index .Labels "agent-outbox.dev-worktree"}}' "$1")"
  lifecycle="$(docker volume inspect --format '{{index .Labels "agent-outbox.dev-lifecycle"}}' "$1")"
  if [[ "$project" != "agent-outbox" || "$ownership" != "$owner_root" || "$lifecycle" != "temporary-cache" ]]; then
    echo "Refusing marketing cache $1: ownership/lifecycle conflicts with worktree owner $owner_root; do not relabel or delete it." >&2
    return 1
  fi
}

if [[ "$mode" != "retire-cache" ]]; then
  output_dir="$2"
  if [[ "$mode" == "capture" && "$output_dir" == "$repo_root" ]]; then
    container_output_dir="/workspace"
  else
    case "$output_dir" in
      "$repo_root"/.agent-layer/tmp/marketing-capture/*) ;;
      *)
        echo "marketing verify output must be under .agent-layer/tmp/marketing-capture" >&2
        exit 64
        ;;
    esac
    relative_output_dir="${output_dir#"$repo_root"/}"
    container_output_dir="/workspace/$relative_output_dir"
  fi
fi

# Preflight existing names before allocating either cache. Never adopt an
# unknown volume, including a name returned by a substring name filter.
owned_caches=()
for volume in "${cache_volumes[@]}"; do
  existing="$(docker volume ls --quiet --filter "name=$volume")"
  while IFS= read -r candidate; do
    [[ "$candidate" == "$volume" ]] || continue
    require_owned_cache "$volume"
    owned_caches+=("$volume")
  done <<< "$existing"
done

# Owner invokes this only after completion, evidence preservation, and stopping
# new captures for the target owner. Directory absence never proves completion.
if [[ "$mode" == "retire-cache" ]]; then
  # Older Bash treats an empty array as unset under nounset.
  if [[ -n "${owned_caches[*]:-}" ]]; then
    for volume in "${owned_caches[@]}"; do
      consumers="$(docker ps --all --quiet --filter "volume=$volume")"
      if [[ -n "$consumers" ]]; then
        echo "Cannot retire marketing cache $volume: containers still reference it: $consumers" >&2
        exit 1
      fi
    done
    docker volume rm "${owned_caches[@]}"
  elif [[ $# -eq 2 ]]; then
    echo "No cache volumes found for exact owner path $owner_root; no cleanup performed. Verify the recorded path or prior retirement." >&2
    exit 1
  else
    printf 'No cache volumes found for owning checkout %s; no cleanup performed.\n' "$owner_root"
  fi
  exit 0
fi

# Reuse only caches explicitly owned by this worktree. Native create returns
# an existing name unchanged, so verify its metadata before mounting anything.
for volume in "${cache_volumes[@]}"; do
  docker volume create \
    --label agent-outbox.dev-project=agent-outbox \
    --label "agent-outbox.dev-worktree=$repo_root" \
    --label agent-outbox.dev-lifecycle=temporary-cache \
    "$volume" > /dev/null
  require_owned_cache "$volume"
done

# Keep output directories and Docker cache mountpoints writable by the host.
mkdir -p -- "$output_dir/public" "$repo_root/node_modules" "$repo_root/.next-browser" "$repo_root/test-results"
# Next.js rewrites this generated file; create it as the host user first.
touch -- "$repo_root/next-env.d.ts"

image="agent-outbox-marketing-playwright:1.63.0-${worktree_id}"
# This tag is a reusable toolchain input; cache retirement keeps it warm.
mkdir -p -- "$repo_root/.agent-layer/tmp/marketing-capture"
run_dir="$(mktemp -d "$repo_root/.agent-layer/tmp/marketing-capture/docker-run.XXXXXXXX")"
task_id="${run_dir##*/}"
docker build --platform linux/amd64 --file "$repo_root/Dockerfile.marketing" --tag "$image" \
  --iidfile "$run_dir/image-id" "$repo_root"
image_id="$(<"$run_dir/image-id")"
# Mount test-results separately so Playwright clears its contents without
# replacing the host-owned directory with a root-owned directory.
docker run --rm --platform linux/amd64 \
  --name "agent-outbox-marketing-${worktree_id}-${task_id}" \
  --label agent-outbox.dev-project=agent-outbox \
  --label "agent-outbox.dev-worktree=$repo_root" \
  --label "agent-outbox.dev-task=$task_id" \
  --label agent-outbox.dev-lifecycle=temporary \
  --volume "$repo_root:/workspace" \
  --volume "$repo_root/test-results:/workspace/test-results" \
  --volume "${cache_volumes[0]}:/workspace/node_modules" \
  --volume "${cache_volumes[1]}:/workspace/.next-browser" \
  --env AGENT_OUTBOX_MARKETING_OUTPUT_DIR="$container_output_dir" \
  --env PLAYWRIGHT_HTML_OPEN=never \
  "$image_id" \
  bash -euc '
    mkdir -p /workspace/.agent-layer/tmp
    marketing_store="$(mktemp -d /workspace/.agent-layer/tmp/marketing-pnpm-store.XXXXXX)"
    cleanup() { rm -rf -- "$marketing_store"; }
    trap cleanup EXIT
    pnpm install --frozen-lockfile --store-dir "$marketing_store" --config.confirmModulesPurge=false
    cleanup
    trap - EXIT
    pnpm exec playwright test --config playwright.marketing.config.ts
  ' 2>&1 | tee "$run_dir/capture.log"
