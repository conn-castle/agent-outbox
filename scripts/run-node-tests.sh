#!/bin/bash
# Write one spec log and a root-stderr sidecar, then replace this process
# with node --test. Arguments, including --test-concurrency=1, are unchanged.
# dash cannot tee stderr and keep exec, so this script is bash.
set -eu
cd "$(dirname "$0")/.."

log_dir=.agent-layer/tmp/node-test-logs
mkdir -p "$log_dir"
log=$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$$.log
stderr_log=${log}.stderr

# A failed create stops here. There is no second way to run the tests.
printf '\n' >"$log"
printf '\n' >"$stderr_log"
printf 'log %s\n' "$log"
printf 'stderr %s\n' "$stderr_log"
exec node --test \
  --test-reporter=spec \
  --test-reporter-destination="$log" \
  --test-reporter=./scripts/node-test-stdio-reporter.mjs \
  --test-reporter-destination=stdout \
  "$@" \
  2> >(tee -i "$stderr_log" >&2)
