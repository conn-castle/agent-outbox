#!/bin/bash
# Write one spec log and a root-stderr sidecar, then replace this process
# with node --test. Arguments, including --test-concurrency=1, are unchanged.
# dash cannot tee stderr and keep exec, so this script is bash.
set -eu
cd "$(dirname "$0")/.."

# AGENT_OUTBOX_NODE_TEST_LOG is this process's spec file. A nested run inherits
# it and AGENT_OUTBOX_NODE_TEST_LOG_PATH, so both are cleared before a new path
# is chosen. An explicit path applies only to this invocation.
requested=${AGENT_OUTBOX_NODE_TEST_LOG_PATH:-}
unset AGENT_OUTBOX_NODE_TEST_LOG
unset AGENT_OUTBOX_NODE_TEST_LOG_PATH
if [ -n "$requested" ]; then
  log=$requested
  mkdir -p "$(dirname "$log")"
else
  log_dir=.agent-layer/tmp/node-test-logs
  mkdir -p "$log_dir"
  log=$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$$.log
fi
stderr_log=${log}.stderr

# A failed create stops here. There is no second way to run the tests.
printf '\n' >"$log"
printf '\n' >"$stderr_log"
export AGENT_OUTBOX_NODE_TEST_LOG=$log
export AGENT_OUTBOX_NODE_TEST_STDERR=$stderr_log

# Node 24.18.0 skips every file and exits 0 when a test spawns node --test
# with NODE_TEST_CONTEXT still set.
unset NODE_TEST_CONTEXT
unset NODE_TEST_WORKER_ID

printf 'log %s\n' "$log"
printf 'stderr %s\n' "$stderr_log"
exec node --test \
  --test-reporter=spec \
  --test-reporter-destination="$log" \
  --test-reporter=./scripts/node-test-stdio-reporter.mjs \
  --test-reporter-destination=stdout \
  "$@" \
  2> >(tee "$stderr_log" >&2)
