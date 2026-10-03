# Agent Org Manager

A self-hosted site for running an organization of AI coding agents. A manager creates projects and cards; builder, reviewer and other agents claim cards exclusively, work in git worktrees on the manager's own workstations (through a small runner), and hand work off through a board. State is event sourced in Postgres.

- Product: `docs/SPEC.md`
- Design (the contract): `docs/ARCHITECTURE.md`
- Build order: `docs/PLAN.md`

## Layout

```
packages/shared   @aom/shared: zod schemas (events, API, protocol), workflows, roles, prompt rendering
apps/server       Fastify API, event store, dispatcher
apps/runner       aom-runner + in-session `aom` CLI
apps/web          React SPA
e2e               Playwright tests
```

## Requirements

Node 22.23 (`nvm use`), pnpm 12 (`corepack enable`), Docker (for dev Postgres).

## Run in development

```sh
cp .env.example .env                         # optional; defaults match the values below
docker compose -f docker-compose.dev.yml up -d   # Postgres on 127.0.0.1:5433 (user/password aom, dbs aom and aom_test)
pnpm install
pnpm db:migrate                              # once the server lane has landed migrations
pnpm dev                                     # server on :4600 and web on :5173 (proxies /api)
```

## Workspace scripts

| Script | Does |
| --- | --- |
| `pnpm dev` | server and web in watch mode |
| `pnpm runner:dev` | runner against `.dev/runner` |
| `pnpm test` | all vitest suites |
| `pnpm e2e` | Playwright end-to-end tests |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | Biome check (`pnpm format` to fix) |
| `pnpm db:migrate` | apply SQL migrations |
