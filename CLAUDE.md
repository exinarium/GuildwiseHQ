# Guildwise HQ (agent-org-manager)

pnpm monorepo: `apps/server` (Fastify, Postgres, event-sourced), `apps/web` (React), `apps/runner` (workstation runner),
`packages/shared` (types, schemas, shared logic). Architecture: `docs/ARCHITECTURE.md`.

## Running the tests

- **Server** (`apps/server`) needs Postgres. The dev database runs in Docker as `aom-postgres` on `127.0.0.1:5433`
  (user and password `aom`; start it with `docker compose -f docker-compose.dev.yml up -d postgres` if it is not running).
  Use a database of your own so parallel cards do not collide:
  ```
  docker exec aom-postgres createdb -U aom aom_test_<card>
  cd apps/server && AOM_TEST_DB_URL=postgres://aom:aom@127.0.0.1:5433/aom_test_<card> npx vitest run --maxWorkers=3
  ```
  The full server run takes about 20 minutes; run the test files you touched first (`npx vitest run test/<file>.test.ts`).
- **Web**: `cd apps/web && npx vitest run`
- **Shared**: `cd packages/shared && npx vitest run`
- **Runner**: `cd apps/runner && npx vitest run` (a few tests are timing-sensitive under load: rerun a failure on its own)
- **Typecheck**: `pnpm -r typecheck`. **Lint and format**: `npx biome check --write <paths>`.

## Rules of the codebase

- The server is event-sourced. Change behaviour with new events or new optional fields; projections must stay
  replay-safe. A data fix is a data migration in `apps/server/src/data-migrations/` (registered in `index.ts`), a schema
  change a new numbered file in `apps/server/migrations/`.
- The runner's version is `RUNNER_VERSION` in `apps/runner/src/version.ts` (not `package.json`).
