#!/usr/bin/env bash
set -euo pipefail
variant="$1"
task_root="/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028"
case "$variant" in base|worktree) ;; *) exit 64 ;; esac
cd "$task_root/$variant"
export NODE_ENV=production APP_ENV=test AGENT_OUTBOX_BROWSER_BUILD=1 AGENT_OUTBOX_BROWSER_FIXTURE=1 AGENT_OUTBOX_BROWSER_COVERAGE_FIXTURE=1 AGENT_OUTBOX_CONNECT_CLERK_FIXTURE=1
export APP_BASE_URL=http://127.0.0.1:31288 PUBLIC_APP_BASE_URL=http://127.0.0.1:31288 PORT=31288
export SENTRY_RELEASE=e0aebb42f05004babdeb60b07ca2cb356f66cb6b
unset CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY DATABASE_APP_ROLE_URL SENTRY_AUTH_TOKEN
exec ./node_modules/node/bin/node scripts/node-server.mjs start
