# Contributing to Guildwise HQ

Thank you for your interest. Contributions of code, documentation, bug reports and ideas are all welcome.

Before you start:

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). It applies in every project space.
- Read [GOVERNANCE.md](GOVERNANCE.md) to understand how decisions are made.
- For security problems, do **not** open a public issue or pull request. Follow [SECURITY.md](SECURITY.md).

## Ways to contribute

| You want to | Go to |
| --- | --- |
| Ask a question or share an idea | [GitHub Discussions](https://github.com/exinarium/GuildwiseHQ/discussions) |
| Report a bug | [Issues: bug report](https://github.com/exinarium/GuildwiseHQ/issues/new/choose) |
| Request a feature | [Issues: feature request](https://github.com/exinarium/GuildwiseHQ/issues/new/choose), after a quick search |
| Change the code or docs | A pull request, described below |

For a large change, open a discussion or an issue first. This saves you from writing code that will not be merged.

## Development setup

**Requirements**

- Node.js 22.23 (`.nvmrc`). Use `nvm use`, or install the version listed there.
- pnpm 12.8.1 (pinned by `packageManager` in `package.json`). Run `corepack enable`, or `npm install -g pnpm@12.8.1`.
- Docker, for the development Postgres database and for the server tests.
- Git 2.40 or later.

**Install and run**

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d postgres   # dev Postgres on 127.0.0.1:5433 (user and password: aom)
pnpm dev                                                  # server on :4600, web app on :5173
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `pnpm runner:dev` | Run the runner from source, with data in `.dev/runner` |
| `pnpm db:migrate` | Apply database migrations to the dev database |
| `pnpm -r typecheck` | TypeScript check of every package (also `pnpm typecheck`) |
| `pnpm lint` | Biome check over the repository |
| `pnpm format` | Biome format and fix (`npx biome check --write <paths>` for specific files) |
| `pnpm package:runner` | Build the runner release tarball |

## Tests

Each package has its own test suite.

```bash
cd packages/shared && npx vitest run     # shared types and logic
cd apps/web && npx vitest run            # web app
cd apps/runner && npx vitest run         # runner
```

The **server** needs Postgres. Give each branch its own test database so parallel work does not collide:

```bash
docker exec aom-postgres createdb -U aom aom_test_mybranch
cd apps/server && AOM_TEST_DB_URL=postgres://aom:aom@127.0.0.1:5433/aom_test_mybranch npx vitest run --maxWorkers=3
```

- The full server run takes about 20 minutes. While you work, run only the files you touched, for example `npx vitest run test/<file>.test.ts`.
- A few runner tests are timing-sensitive under load. If one fails, run it on its own before you look for a bug.
- Before you open a pull request, run the typecheck, lint and the tests for every package you changed.

Some server tests send mail and read it back from a Mailpit instance on SMTP port 1025 and API port 8025 (CI starts one as a service). The development compose file provides one on other ports by default; to use it for the tests, start it as `AOM_MAILPIT_SMTP_PORT=1025 AOM_MAILPIT_UI_PORT=8025 docker compose -f docker-compose.dev.yml up -d`. Apart from `AOM_TEST_DB_URL`, the test run needs no other environment.

## Project rules

These rules keep the event log sound. The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **Event-sourced server.** Change behaviour with new events or new optional fields. Projections must stay replay-safe, so a rebuild gives the same result.
- **Schema changes** are a new numbered SQL file in `apps/server/migrations/`.
- **Data fixes** are data migrations in `apps/server/src/data-migrations/`, registered in its `index.ts`.
- **Runner version** lives in `RUNNER_VERSION` in `apps/runner/src/version.ts`, not in `package.json`.
- **Conventional Commits.** Write commit messages as `feat(web): ...`, `fix(server): ...`, `docs: ...`.
- **The core never imports from a hosted extension.** `scripts/check-no-cloud-imports.sh` runs in CI.
- **Domain state** changes only through events. Operational state (sessions, heartbeats, connection flags) may be written directly, and is documented as such.

## Developer Certificate of Origin (DCO)

Guildwise HQ uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a Contributor License Agreement. You do not sign anything. Instead, each commit carries a `Signed-off-by` line that says you have the right to submit it under the project's license.

Add the line with `-s`:

```bash
git commit -s -m "Explain the change in one line"
```

The line uses the name and email in your Git configuration and looks like this:

```
Signed-off-by: Your Name <you@example.com>
```

Every commit in a pull request needs one. The DCO check on each pull request fails when a commit is missing it.

**Fix commits you already made**

```bash
git commit --amend -s --no-edit             # the last commit
git rebase --signoff origin/main            # every commit on your branch
```

Contributions are licensed under the Apache License 2.0, as described in section 5 of [LICENSE](LICENSE).

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make one logical change per pull request. Keep unrelated cleanup out of it.
3. Add or update tests for the behaviour you change. Update the docs when behaviour or setup changes.
4. Run the checks listed above, and make sure `pnpm lint` and `pnpm -r typecheck` pass.
5. Sign off every commit (see DCO above).
6. Open the pull request and fill in the template. Link the issue or discussion it relates to.
7. CI runs on your pull request. Continuous integration for forks runs with read-only permissions and without secrets. It cannot publish anything.
8. A maintainer reviews it. The maintainer decides what is merged (see [GOVERNANCE.md](GOVERNANCE.md)). Reviews are best-effort, and no response time is guaranteed. Please be patient, and ping the thread if it has been quiet for a while.

Expect review comments. Respond in the thread, push new commits (sign them off too), and mark conversations resolved when you have addressed them.

## Security notice for contributors and maintainers

**Maintainers never run untrusted pull request code with secrets.** Code from a fork is untrusted until a maintainer has read it. The following rules apply:

- Workflows triggered by pull requests from forks have no access to secrets and read-only repository permissions. Do not change that. Do not use `pull_request_target` to check out or run code from a pull request.
- Do not run a fork's code on a machine that holds deploy keys, provider API keys, or a production database. Use a throwaway environment.
- Do not paste secrets, tokens or personal data into issues, discussions, pull requests or logs.

## Code of Conduct

Be kind, be specific, and assume good faith. Unacceptable behaviour, including harassment, is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Report concerns through the channels listed there.
