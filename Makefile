.PHONY: help bootstrap setup doctor dev fix format lint typecheck test build smoke smoke-runtime migration-validate migration-migrate migration-replay check release-check clean

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
	@printf '%s\n' '  make build          Build the app with Next.js.'
	@printf '%s\n' '  make smoke          Run structural smoke checks.'
	@printf '%s\n' '  make smoke-runtime  Run provider-backed runtime canary smoke checks.'
	@printf '%s\n' '  make migration-validate Validate Flyway migration history.'
	@printf '%s\n' '  make migration-migrate  Apply pending Flyway migrations.'
	@printf '%s\n' '  make migration-replay   Validate and apply migrations to an empty database.'
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

check:
	corepack pnpm run check

release-check:
	corepack pnpm run release-check

clean:
	corepack pnpm run clean
