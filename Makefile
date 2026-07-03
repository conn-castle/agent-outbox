.PHONY: help bootstrap setup doctor dev fix format lint typecheck test browser build smoke smoke-runtime migration-validate migration-migrate migration-replay go-build go-test go-lint go-fmt go-fmt-check go-check package-check check release-check clean

GORELEASER_MODULE := github.com/goreleaser/goreleaser/v2@v2.16.0
CLI_VERSION ?= 0.0.0-dev
CLI_COMMIT ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || printf unknown)
CLI_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
CLI_LDFLAGS := -X agent-outbox/internal/command.version=$(CLI_VERSION) -X agent-outbox/internal/command.commit=$(CLI_COMMIT) -X agent-outbox/internal/command.date=$(CLI_DATE)

help:
	@printf '%s\n' 'Agent Outbox command surface'
	@printf '%s\n' ''
	@printf '%s\n' 'Commands:'
	@printf '%s\n' '  make bootstrap      Alias for make setup.'
	@printf '%s\n' '  make setup          Install pinned development dependencies.'
	@printf '%s\n' '  make doctor         Check local tools, .env, and provider CLI auth.'
	@printf '%s\n' '  make dev            Start the Next.js local development server.'
	@printf '%s\n' '  make fix            Format files with the pinned formatter.'
	@printf '%s\n' '  make format         Format files with the pinned formatter.'
	@printf '%s\n' '  make lint           Run markdown lint.'
	@printf '%s\n' '  make typecheck      Run TypeScript checks for tooling.'
	@printf '%s\n' '  make test           Run Node tests.'
	@printf '%s\n' '  make browser        Run browser smoke tests.'
	@printf '%s\n' '  make build          Build the app with Next.js.'
	@printf '%s\n' '  make smoke          Run structural smoke checks.'
	@printf '%s\n' '  make smoke-runtime  Run provider-backed runtime canary smoke checks.'
	@printf '%s\n' '  make migration-validate Validate Flyway migration history.'
	@printf '%s\n' '  make migration-migrate  Apply pending Flyway migrations.'
	@printf '%s\n' '  make migration-replay   Validate and apply migrations to an empty database.'
	@printf '%s\n' '  make go-build      Build the Go CLI binary to dist/agent-outbox.'
	@printf '%s\n' '  make go-test       Run Go CLI unit tests.'
	@printf '%s\n' '  make go-lint       Run Go CLI vet checks.'
	@printf '%s\n' '  make go-fmt        Format Go CLI source.'
	@printf '%s\n' '  make go-check      Run Go CLI format/lint/test/build gates.'
	@printf '%s\n' '  make package-check Validate non-publishing CLI release/package artifacts.'
	@printf '%s\n' '  make check          Run the single local/CI verification gate.'
	@printf '%s\n' '  make release-check  Run the non-deploying release/package gate.'
	@printf '%s\n' '  make clean          Remove bounded reproducible generated artifacts.'

bootstrap: setup

setup:
	corepack install -g --cache-only pnpm@11.9.0
	corepack pnpm install --frozen-lockfile

doctor:
	corepack pnpm run doctor

dev:
	corepack pnpm run dev

fix: format

format:
	corepack pnpm run format

lint:
	corepack pnpm run lint

typecheck:
	corepack pnpm run typecheck

test:
	corepack pnpm run test

browser:
	corepack pnpm run browser

build:
	corepack pnpm run build

smoke:
	corepack pnpm run smoke

smoke-runtime:
	corepack pnpm run smoke-runtime

migration-validate:
	corepack pnpm run migration:validate

migration-migrate:
	corepack pnpm run migration:migrate

migration-replay:
	corepack pnpm run migration:replay

go-build:
	mkdir -p dist
	cd cli && go build -ldflags "$(CLI_LDFLAGS)" -o ../dist/agent-outbox ./cmd/agent-outbox

go-test:
	cd cli && go test ./...

go-lint:
	cd cli && go vet ./...

go-fmt:
	cd cli && gofmt -w $$(find . -name '*.go')

go-fmt-check:
	@test -z "$$(cd cli && gofmt -l .)"

go-check: go-fmt-check go-lint go-test go-build

package-check:
	go run $(GORELEASER_MODULE) check .goreleaser.yaml
	go run $(GORELEASER_MODULE) release --snapshot --clean

check:
	corepack pnpm run check

release-check: check go-check package-check

clean:
	corepack pnpm run clean
