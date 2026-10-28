#!/usr/bin/env bash
set -euo pipefail
task_root=/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028
variant="$1"
uptime
ps -eo pid,comm,pcpu,pmem --sort=-pcpu | head -12 || true
for run in 1 2 3; do
  systemd-run --user --quiet --scope --slice=castle-background.slice --same-dir -- playwright-cli -s=outbox-opt-20261028 run-code --filename="$task_root/timing-run.js" > "$task_root/timings/$variant-$run.log" 2>&1
done
sed "s/VARIANT/$variant/g" "$task_root/capture-template.js" > "$task_root/capture-$variant.js"
systemd-run --user --quiet --scope --slice=castle-background.slice --same-dir -- playwright-cli -s=outbox-opt-20261028 run-code --filename="$task_root/capture-$variant.js" > "$task_root/logs/capture-$variant.log" 2>&1
printf 'Completed benchmark %s\n' "$(date -u +%FT%TZ)"
