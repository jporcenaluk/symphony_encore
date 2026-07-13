SHELL := /bin/bash
.DEFAULT_GOAL := verify-fast

.PHONY: setup dev build start format lint typecheck test test-integration test-e2e image verify-fast verify conformance

setup:
	corepack pnpm install --frozen-lockfile
	node scripts/install-gitleaks.ts
	node --import ./scripts/typescript-source-loader.mjs scripts/verify-gitleaks.ts
	corepack pnpm exec husky

dev:
	corepack pnpm dev

build:
	corepack pnpm build

start:
	corepack pnpm start

format:
	corepack pnpm format

lint:
	corepack pnpm lint

typecheck:
	corepack pnpm typecheck

test:
	corepack pnpm test

test-integration:
	corepack pnpm test:integration

test-e2e:
	corepack pnpm test:e2e

image:
	corepack pnpm run image

verify-fast: lint typecheck test

verify: verify-fast test-integration build test-e2e image

conformance: verify-fast
	corepack pnpm conformance
