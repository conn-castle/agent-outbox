#!/usr/bin/env bash
set -euo pipefail
task_root=/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028
cd "$task_root/worktree"
printf 'Candidate build start %s\n' "$(date -u +%FT%TZ)"
systemd-run --user --quiet --scope --slice=castle-background.slice --same-dir -- corepack pnpm exec next build > "$task_root/logs/candidate-build.log" 2>&1
server_pid=''
stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid"
    set +e
    wait "$server_pid"
    server_status=$?
    set -e
    printf 'Server %s terminal status %s at %s\n' "$server_pid" "$server_status" "$(date -u +%FT%TZ)"
    server_pid=''
  fi
}
trap stop_server EXIT
for variant in base worktree; do
  bash "$task_root/serve.sh" "$variant" > "$task_root/logs/$variant-server.log" 2>&1 &
  server_pid=$!
  printf 'Server %s started for %s at %s\n' "$server_pid" "$variant" "$(date -u +%FT%TZ)"
  python3 - <<'PY'
import time,urllib.request
for _ in range(120):
 try:
  with urllib.request.urlopen('http://127.0.0.1:31288/',timeout=2) as r:
   if r.status==200: break
 except (OSError,TimeoutError): pass
 time.sleep(.5)
else: raise SystemExit('Preview failed to become ready')
PY
  bash "$task_root/run-browser-under-lock.sh" "$variant" > "$task_root/logs/$variant-browser.log" 2>&1
  stop_server
done
printf 'Both variants complete; releasing workload lock %s\n' "$(date -u +%FT%TZ)"
python3 "$task_root/parse-cli.py" > "$task_root/logs/parsed-browser.log"
systemd-run --user --quiet --scope --slice=castle-background.slice --same-dir -- "$task_root/worktree/node_modules/node/bin/node" "$task_root/diff.mjs" > "$task_root/logs/visual-diff.log" 2>&1
