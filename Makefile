SHELL := /bin/bash
.DEFAULT_GOAL := verify-fast

.PHONY: setup dev build start format lint typecheck test test-integration test-e2e image verify-fast verify

setup:
	corepack pnpm install --frozen-lockfile
	corepack pnpm exec husky

dev:
	@node scripts/not-implemented.ts dev

build:
	corepack pnpm build

start:
	@node scripts/not-implemented.ts start

format:
	corepack pnpm format

lint:
	corepack pnpm lint

typecheck:
	corepack pnpm typecheck

test:
	corepack pnpm test

test-integration:
	@node scripts/not-implemented.ts test-integration

test-e2e:
	@node scripts/not-implemented.ts test-e2e

image:
	@node scripts/not-implemented.ts image

verify-fast: lint typecheck test

verify: verify-fast test-integration build test-e2e image
