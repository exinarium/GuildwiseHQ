# End-to-end tests

Playwright specs that run against a real server, a real database, a mock-adapter runner and a real browser. They share one
stack and run in one worker, in the order the projects in `playwright.config.ts` declare.

## Tester shift setup

Follow these steps in order. Run every command from the repository root (the worktree). Nothing here needs a question to
anyone: when a check fails, step 10 says whom to ask for what.

1. **Toolchains.** `node-nvm 22.23.4`, `pnpm-12.8.1`, `gwp-core-caa6a44` (cached dependencies), `playwright-browsers`,
   `gwp98-hosted-app` (the hosted build). Do not run `pnpm install`.
2. **Copy the cached dependencies** (instead of installing): `bash e2e/scripts/copy-cached-deps.sh`. It refuses when the
   cache's `pnpm-lock.yaml` differs from this worktree's and says so. Then build once:
   `env pnpm_config_verify_deps_before_run=false pnpm build`.
3. **Environment.** In a tester shift the runner already sets `AOM_E2E_DIR`, `AOM_AGENT_TMP_ROOT` and
   `PLAYWRIGHT_HTML_OUTPUT_DIR`; do not override them. Add `AOM_E2E_RESULTS="$TMPDIR/e2e-results"` and
   `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright` (the `playwright-browsers` toolchain). Outside a shift set
   `AOM_E2E_DIR` yourself.
4. **Services and ports.** The project's *Local test services* setting must declare the ports the suite connects to, and
   must not declare the ports the harness listens on (every shell of a shift bridges each declared port, so a declared port
   cannot be bound).

   | Service | Port | Declared? |
   |---|---|---|
   | Postgres | 127.0.0.1:5433 | yes |
   | Mailpit web / SMTP | 127.0.0.1:8025 / 1025 | yes |
   | Hosted build | 127.0.0.1:4710 | yes |
   | E2E server | 4601 | **no** (the suite starts it) |
   | TLS proxy | 4711 | **no** (the suite starts it) |
   | Docker journey containers | 4720-4723 | no (Docker runs outside tester shifts) |

   Docker is not available in tester shifts. The Docker projects are run by DevOps (step 6a).
5. **Preflight** (one `ready` / `NOT READY` line per check, exit code 1 when any check is not ready):
   `aom-env --timeout 5 -- pnpm -C e2e preflight --no-docker`. Every line must be `ready` (docker shows `skipped`). If not,
   go to step 10. `--no-hosted` skips the hosted build and TLS proxy checks.
6. **Full suite**, in one Bash call (the harness's own listeners live only in that call):
   `aom-env --timeout 40 -- sh -c 'pnpm -C e2e full:shift; pnpm -C e2e summary'`.
   `full:shift` sets `AOM_E2E_NO_DOCKER=1`, which leaves the Docker projects out and lists them in the report as
   "not run here". Baseline outside the sandbox at `caa6a44f`: 154 passed, 5 failed, 19 skipped, 201 did not run, 13.2 min
   (that includes the Docker projects).
   - **6a. Docker projects.** `aom devops "run pnpm -C e2e docker outside the sandbox at <commit> and send me the pnpm -C e2e summary output"`.
     Record DevOps's counts as a separate line in your report. Do not wait for the answer; finish the rest first.
7. **Regression subset:** `aom-env --timeout 20 -- pnpm -C e2e regression -- --project=<name> [--project=<name>]`. Dependencies
   of a project run automatically; `pnpm -C e2e regression -- --list` shows the names. A Docker project goes to DevOps (6a).
8. **Results and logs.** `$AOM_E2E_RESULTS/results.json` (counts), `$AOM_E2E_RESULTS/test-results/` (traces, screenshots),
   `$AOM_E2E_RESULTS/screenshots/`, `$AOM_E2E_RESULTS/report/` (HTML; in a shift `$PLAYWRIGHT_HTML_OUTPUT_DIR` wins and
   lies inside `$AOM_E2E_DIR`, which the next run deletes). Server log `$AOM_E2E_DIR/server.log`, runner logs
   `$AOM_E2E_DIR/runner*.out.log`. `$TMPDIR` is emptied at shift end: attach what must be kept.
9. **Report.** `pnpm -C e2e summary` prints `passed N, failed N, skipped N, did not run N, flaky N, duration N min`, the
   failed titles, the did-not-run count per project and the "not run here" lines. Paste it with DevOps's Docker result.
   Known failures that also occur outside the sandbox (ceo-chat "Archive all", devops AC4, release-docs-prep AC2/AC9,
   business-card-types Software view) are reported as failures. Never skip or change a spec to make a run green.
10. **When a preflight line is `NOT READY`:**

    | Line | Ask | For |
    |---|---|---|
    | dependencies, build | yourself, then DevOps | step 2; if the lockfile differs: `aom devops "refresh the gwp-core cache"` |
    | scratch | DevOps | `aom devops "check the runner version: AOM_E2E_DIR is not writable"` |
    | test services | the project Owner | add or remove the port in Project settings > Local test services (applies from the next shift) |
    | postgres, mailpit, smtp, hosted build | DevOps | `aom devops "start <service> on <port>"` |
    | app port, tls proxy | yourself | a stale E2E server or proxy still runs, or the port is declared (remove it, see 4) |
    | docker | DevOps | run `pnpm -C e2e docker` outside the sandbox |

    Do not stall: send the request, record that part of the run as not run, and carry on with the rest.
11. **Hosted build and HSTS.** The HSTS spec is `hosted-edge.spec.ts` in guildwise-cloud. `e2e/support/tls-proxy.ts` is a
    transparent TLS proxy: it terminates TLS with a per-run certificate (trusted through `NODE_EXTRA_CA_CERTS`) and never
    adds, changes or removes a response header, so the check passes or fails on the hosted build's own
    `Strict-Transport-Security` header. A hosted build started with an `http` public origin sends none, and the check then
    fails on the missing header: that is the build's real behaviour. Use it as
    `node e2e/with-tls-proxy.ts -- <command>` (it sets `HOSTED_TLS_URL`), or as `e2e/hosted-global-setup.ts` in a hosted
    Playwright config.
12. **Seeding.** The setup creates `admin@e2e.test` (owner of an organization) and `platform@e2e.test` through the server's own
    CLIs, only when they are missing, so `pnpm -C e2e seed` can be repeated. For a hosted database run
    `pnpm -C e2e seed --database-url <url> --app <built app dir>`. Test-only passwords are in `support/env.ts`.

## Unit tests of the harness

`pnpm -C e2e test:unit` (node:test): seeding, test-services declaration, TLS proxy, preflight, summary, journey containers
and the Docker switch in `playwright.config.ts`.
