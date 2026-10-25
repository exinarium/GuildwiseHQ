# Contributing

Thank you for helping. Guildwise HQ is a pnpm monorepo: `apps/server` (Fastify, Postgres, event sourced), `apps/web`
(React), `apps/runner` (workstation runner) and `packages/shared`. Read `CLAUDE.md` for how to run each test suite and
`docs/ARCHITECTURE.md` for the design.

- Open an issue before a large change. Keep a change to one concern.
- Commit messages follow Conventional Commits (`feat(web): ...`, `fix(server): ...`).
- Every change comes with tests. `pnpm -r typecheck`, `npx biome check --write <paths>` and the suites of the packages you
  touched must pass.
- The server is event sourced: change behaviour with new events or optional fields, and keep projections replay-safe. A
  schema change is a new numbered file in `apps/server/migrations/` (never edit an applied one).
- The core must not import from any hosted extension: `scripts/check-no-cloud-imports.sh`.
- By contributing you agree that your contribution is licensed under the Apache License 2.0.
