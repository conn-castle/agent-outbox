#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: marketing-capture-container.sh <capture|verify> <output-dir>" >&2
  exit 64
fi

mode="$1"
output_dir="$2"
case "$mode" in
  capture|verify) ;;
  *)
    echo "marketing-capture-container.sh: unsupported mode $mode" >&2
    exit 64
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
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

image="agent-outbox-marketing-playwright:1.61.1"
docker build --platform linux/amd64 --file "$repo_root/Dockerfile.marketing" --tag "$image" "$repo_root"
docker run --rm --platform linux/amd64 \
  --volume "$repo_root:/workspace" \
  --volume agent-outbox-marketing-node-modules-amd64:/workspace/node_modules \
  --volume agent-outbox-marketing-next-amd64:/workspace/.next \
  --env AGENT_OUTBOX_MARKETING_OUTPUT_DIR="$container_output_dir" \
  --env PLAYWRIGHT_HTML_OPEN=never \
  "$image" \
  bash -euc '
    mkdir -p /workspace/.agent-layer/tmp
    marketing_store="$(mktemp -d /workspace/.agent-layer/tmp/marketing-pnpm-store.XXXXXX)"
    cleanup() { rm -rf -- "$marketing_store"; }
    trap cleanup EXIT
    pnpm install --frozen-lockfile --store-dir "$marketing_store" --config.confirmModulesPurge=false
    cleanup
    trap - EXIT
    pnpm exec playwright test --config playwright.marketing.config.ts
  '
