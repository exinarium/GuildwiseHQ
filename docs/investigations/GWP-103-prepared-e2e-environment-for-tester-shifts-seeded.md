# GWP-103: Prepared E2E environment for tester shifts

Seeded E2E users, a TLS proxy for the hosted-build HSTS check, harness-owned Docker containers for
deploy-setup-journey, a preflight command and one written setup procedure (`e2e/README.md`).

Base read: GuildwiseHQ `release/1.5.0` at `caa6a44f`, the same commit as the outside-sandbox baseline. guildwise-cloud
`main` and its `aom/gwp-98-web-regression-cannot-run-core-submodule` branch were read for the hosted run.

**Revision 2026-11-04, after GWP-102 landed (`d81aa42f`).** The assumptions in section 8 were checked against the landed
code. A1, A5 and A6 hold. A2, A3 and A4 did not hold as written. Section 9 lists what changed, and the affected sections
(2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5, 6.1) are updated in place. Everything else stands.

## 1. Questions

1. How are the E2E users and organisation created today, and what has to change so that seeding is idempotent and also works
   for the hosted build?
2. Which spec performs the HSTS check, and in which repository? What does a local TLS proxy have to do so that the check
   passes or fails on the hosted build's real behaviour?
3. How can deploy-setup-journey's containers be started and removed by the harness on declared ports?
4. What does a tester shift need to know and check before it runs the suite?

## 2. Findings

### 2.1 Seeding today

- `e2e/global-setup.ts` drops and recreates `aom_e2e` (`recreateDb`), then runs the server's own CLI twice:
  `pnpm --filter @aom/server admin:create` for `ADMIN` (`admin@e2e.test`, owner of a new organisation) and
  `superadmin:create` for `SUPER` (`platform@e2e.test`). Every other E2E user is created by its spec
  (`inviteAndAccept` in `e2e/support/api.ts`, which also calls `admin:create`, or through the invitation UI).
- `apps/server/scripts/admin-create.ts` and `superadmin-create.ts` **refuse** an existing email and set exit code 1
  (`a user with email ... already exists`). `execFileSync` then throws. So the setup is idempotent today only because it
  drops the database first. On a database that is not dropped (the hosted build's database, a re-used database) a second
  run fails.
- The CLIs append events (`UserRegistered`, `OrganizationCreated{createdVia:'cli'}`, `OrgMemberAdded(owner)`,
  `SuperAdminCreated`). They are the only correct way to create accounts: a direct `INSERT` into the projection tables
  would bypass the event store. The seed helper must keep calling the CLIs and only decide **whether** to call them.
- Tables for the existence check: `users(email, kind)`, `organizations(owner_user_id)`,
  `org_members(org_id, user_id, role, status)` (`apps/server/migrations/1310_organizations.sql`).
- `e2e/guide-global-setup.ts` has its own copy of the same seeding (ADMIN plus `SUPER_DEMO`). It can share the helper.
- Hosted build: guildwise-cloud's `docs/E2E-HOSTED-RUN.md` (GWP-98 branch) tells the operator to seed `admin@e2e.test` by
  hand with the app's `dist/admin-create.mjs`, because the hosted Playwright config has no global setup.

### 2.2 The HSTS check: it is in guildwise-cloud, not in GuildwiseHQ

- **GuildwiseHQ has no HSTS spec.** `git grep -i strict-transport` finds only `apps/server/src/app.ts:441-443`
  (`if (config.secureCookies) reply.header('strict-transport-security', ...)`, true when `AOM_PUBLIC_ORIGIN` is https),
  the unit tests in `apps/server/test/serve-web.test.ts`, `deploy/Caddyfile` and docs.
- **The HSTS check is `e2e/tests/hosted-edge.spec.ts` in guildwise-cloud**, test
  `the proxy adds HSTS and keeps the security headers the app sends`:
  `GET ${HOSTED_BASE_URL}/login`, expects 200, `strict-transport-security` containing `max-age=31536000`, a CSP and
  `x-frame-options: DENY`. It exists only on the unmerged branch `aom/gwp-98-web-regression-cannot-run-core-submodule`
  (not on guildwise-cloud `main`). It runs from `core/e2e` with `scripts/e2e/playwright.hosted.config.ts` (no global setup,
  `baseURL = HOSTED_BASE_URL`), after `scripts/e2e-hosted-setup.sh` copies the specs and the config into the pinned core.
- That doc already says: "The app runs without its proxy, so the hosted-edge HSTS check fails the same way as against the
  bare container".
- Where HSTS comes from on the hosted service: (a) the app itself when its public origin is https, and (b) guildwise-cloud's
  `deploy/Caddyfile` (`@public not host localhost 127.0.0.1 ::1` -> adds HSTS for a real domain only). So a local Caddy on
  `localhost` would add no HSTS either.
- The hosted build container `gwp98-app` runs with `AOM_PUBLIC_ORIGIN=http://localhost:4710` (ledger b73a88aa,
  E2E-HOSTED-RUN.md step 3). It therefore sends no HSTS, by design.

Consequence: per the card's own rule, **the change in guildwise-cloud becomes a separate card** (wiring the proxy into
its hosted config and run script, bumping its core pin to a commit with this card's helpers). This card delivers the proxy
and the hosted setup in GuildwiseHQ `e2e/`, which the hosted specs already import from (they run inside `core/e2e`).

### 2.3 What the proxy must be

The acceptance criterion is that the check "passes or fails on the hosted build's actual Strict-Transport-Security
behaviour, not on a connection or certificate error". So the proxy must:

- terminate TLS with a certificate the test process trusts (no certificate error);
- be **transparent**: never add, change or remove a response header. If it added HSTS, a pass would be the proxy's doing,
  not the hosted build's. This is a hard rule of the design and has its own unit test;
- forward to the hosted build (`http://127.0.0.1:4710`), keeping `Host`, and set `X-Forwarded-Proto: https`,
  `X-Forwarded-Host`, `X-Forwarded-For` (the app runs Fastify with `trustProxy: true`);
- pass WebSocket upgrades through (the landing pages may open `/api/ws`; cheap to support with `net` piping on `upgrade`);
- listen only on a port that is free in the command's network namespace and is **not** declared as a test service
  (revised, see 2.5 and section 9).

With such a proxy the result reflects the build: a hosted build started with `AOM_PUBLIC_ORIGIN=https://localhost:<tls
port>` sends HSTS and the check passes; the `gwp98-app` container (http origin) sends none and the check fails on a missing
header, which is the real behaviour. Which of the two the hosted run uses is the guildwise-cloud card's decision (see 6.2).

Certificate: generated per run with `openssl` (present at `/usr/bin/openssl`) into the run's E2E folder, self-signed, SAN
`DNS:localhost, IP:127.0.0.1, IP:::1`, valid 2 days, key never committed and removed with the folder. The test process
trusts it through `NODE_EXTRA_CA_CERTS` (set in `process.env` by the global setup before Playwright forks its workers, which
inherit it; the wrapper CLI sets it for its child). Certificate checking stays on, so a wrong certificate is still a clear
error instead of being hidden by `ignoreHTTPSErrors`.

### 2.4 deploy-setup-journey and Docker

`e2e/tests/deploy-setup-journey.spec.ts` starts two containers inside its first test and removes them in `afterAll`:

| Container | Today | Host ports |
|---|---|---|
| `aom-e2e-journey-registry-<pid>` (`registry:2`) | `-p 127.0.0.1:<freePort>:5000 -p 172.17.0.1:<same>:5000` | 1 random |
| `aom-e2e-journey-box-<pid>` (image `aom-test-sshd:1`, built from `apps/runner/test/fixtures/sshd`, `FROM alpine:3.20`) | `-p 127.0.0.1::22 -p 127.0.0.1::5500 -p 127.0.0.1::8090` | 3 random (Docker picks) |

The original reasoning was that random ports cannot be declared in the test-services setting. After GWP-102 the ports
do not need to be declared, because Docker is not available in tester shifts (2.5). The container start still moves into
the harness (AC3) on fixed, env-overridable ports, so the containers are named, owned and cleaned up by setup and
teardown. `localPort` (line 338) is not a container port (it is a fake-docker state file), so it stays a free port.

The sshd image is built with `apk add` (network). In a shift without registry access the build only works from Docker's
layer cache, so the preflight checks that `alpine:3.20` (or `aom-test-sshd:1`) and `registry:2` are present locally.

(Added in the revision.) Other specs also call the Docker daemon directly: `deploy-setup.spec.ts`,
`deploy-connect.spec.ts` and `deploy-move.spec.ts` (`execFileSync('docker', ...)`), projects `deploy-setup`,
`deploy-connect` and `deploy-move`. This card does not change them, but they matter for the tester procedure (4.4).

### 2.5 The tester sandbox after GWP-102 (landed at `d81aa42f`)

- `packages/shared/src/projects/test-services.ts`: unchanged. `LocalTestService {name, host, port}`, loopback hosts
  only, at most **10** services (`MAX_TEST_SERVICES`), each port once, never 3128/1080.
- `AOM_TEST_SERVICES` keeps its `host:port,...` format (`testServicesSpec`). The bridge (`apps/runner/src/shims.ts`
  `TEST_SERVICE_BRIDGE`) starts one `socat TCP-LISTEN:<port>` per entry inside the command's network namespace and tunnels
  it through the sandbox proxy. It is shared by `aom-env` and the new `bin/aom-bridges.sh`.
- **Auto-bridge in tester shifts**: a tester card shift with at least one allowed service gets
  `BASH_ENV=<bin>/aom-bridges.sh` and `SHLVL=1`, so **every bash** of the shift bridges every declared port. A plain
  `curl`, Node or Playwright reaches them without `aom-env`. `aom-env --timeout` still works and adds a hang limit. The
  bridge skips a port that already listens.
- **No bind list.** There is no `AOM_TEST_BIND_PORTS` or any other separation between bind and connect ports. Every
  declared service is a connect service. Because of the auto-bridge, a declared port gets a socat listener in every bash of
  the shift, so the harness can never bind a declared port (the E2E server on 4601, the TLS proxy on 4711). A server the
  suite starts itself on 127.0.0.1 is reachable from the same Bash call (`noTestServicesNote`). The tester role has
  `allowLocalBinding`.
- **Per-shift scratch**: the runner sets `AOM_E2E_DIR=<tmp>/e2e`, `AOM_AGENT_TMP_ROOT=<tmp>/e2e/agent-tmp` and
  `PLAYWRIGHT_HTML_OUTPUT_DIR=<tmp>/e2e/playwright-report` in every tester card shift (`testerShiftEnv`). `<tmp>` is the
  shift's TMPDIR: writable and swept at shift end. A nested runner (the suite's mock runner) puts its agent tmp dirs under
  `AOM_AGENT_TMP_ROOT` (`agentTmpRoot()`) and creates them with `mkdir -p` (`ensureSandbox`). That still works after
  `global-setup.ts` runs `rmSync(E2E_DIR)`.
- **Docker is not available in any tester sandbox** (`testerScratchNote`: "specs that run docker are run by DevOps; ask
  with `aom devops` and record their result separately"; docs/RUNNER.md "Tester shifts and the E2E suite (GWP-102)").
- At shift start the runner connects to each allowed service (1 s). One that does not answer adds a note line and a
  progress line naming `Project settings > Local test services` (`TEST_SERVICES_SETTING`).

### 2.6 Other facts the procedure needs

- Node 22.23 (`.nvmrc`), which runs `.ts` files directly (type stripping is on by default since 22.18), so helper CLIs
  need no `tsx`. Tooling present: `rsync`, `socat`, `openssl`, `docker`.
- Cached core dependencies (owner decision on GWP-61, 2026-11-03, ledger 00b22933): `~/devbox-cache/gwp-core-caa6a44`
  (toolchain `gwp-core-caa6a44`, found in a sandboxed shell through its `PATH` entry `<cache>/node_modules/.bin`, because
  the sandbox has its own `HOME`). Browsers: `~/.cache/ms-playwright` (toolchain `playwright-browsers`). Hosted build:
  toolchain `gwp98-hosted-app` (`~/devbox-cache/gwp98-hosted-app`), base URL `http://localhost:4710`, health
  `/api/health`.
- `pnpm_config_verify_deps_before_run=false` stops pnpm from trying to install before `pnpm exec` (E2E-HOSTED-RUN.md).
- `AOM_E2E_DIR` defaults to `/tmp/aom-e2e` outside a shift. In a tester shift the runner sets it (2.5).
- `playwright.config.ts` has only the `list` reporter, so a run leaves no machine-readable result for counts.
- Playwright's HTML reporter reads `PLAYWRIGHT_HTML_OUTPUT_DIR` from the environment before the config's `outputFolder`.
  In a tester shift the HTML report therefore lands in `$AOM_E2E_DIR/playwright-report`, and the next run's global setup
  wipes it.
- **Builder guard**: the post-shift guard rejects any builder edit under `e2e/**` (ledger aadf93f9, 69b39b28 and others;
  the CEO grants no exception). Every file of this card is under `e2e/`. See section 7.

## 3. Options compared

### 3.1 Seeding

| Option | For | Against |
|---|---|---|
| A. Keep drop-and-recreate only | No code | Not idempotent on a kept or hosted database; hosted seeding stays a manual step |
| **B. `seedE2eAccounts()` helper: check `users`/`org_members` with `pg`, call the CLI only for missing accounts** | Idempotent on any database; one helper for global setup, guide setup and the hosted database; still uses the app's own CLI (events) | A user that exists without its organisation cannot be repaired without app code: report it clearly and stop |
| C. Insert rows directly | Fast | Bypasses the event store; projections and events disagree. Rejected |

Recommended: **B**. Keep `recreateDb()` in the default setup (the specs assume a clean database); the helper makes the
seed step itself idempotent, so running it on a fresh database twice, or on a kept or hosted database, leaves one copy.

### 3.2 TLS proxy

| Option | For | Against |
|---|---|---|
| A. Run Caddy with guildwise-cloud's Caddyfile | The real edge | No `caddy` binary on the workstation; the Caddyfile adds HSTS only for non-localhost hosts, so locally it never would; guildwise-cloud file |
| B. Proxy that adds HSTS like the edge | Check always passes | Tests the proxy, not the build. Rejected by the AC |
| **C. Transparent Node `https` + `http` proxy in `e2e/support/tls-proxy.ts`, per-run self-signed cert, `NODE_EXTRA_CA_CERTS`** | No new dependency; outcome is the build's own; works in the sandbox (binds in the namespace, connects through the bridge to 4710) | Needs `openssl` (present); the hosted run must start the build with an https origin for a pass |

Recommended: **C**.

### 3.3 Journey containers

| Option | For | Against |
|---|---|---|
| A. Global setup starts them for every run | Simple | Every run (also a 2-spec regression subset) needs Docker; a run without Docker fails at setup |
| **B. Playwright setup project `journey-containers` with `teardown: 'journey-containers-teardown'`; `deploy-setup-journey` depends on it** | Starts only when the journey runs (also with `--project=deploy-setup-journey`, dependencies run automatically); teardown runs even when the spec fails; idiomatic Playwright "project setup and teardown" | The spec must read names and ports from a state file instead of its own `docker run` |
| C. Leave it in the spec, only fix the ports | Smallest diff | AC3 asks for the harness to start and stop it |

Recommended: **B**.

## 4. Design

### 4.1 Files

| File | Change |
|---|---|
| `e2e/support/env.ts` | Add port constants (env-overridable): `TLS_PORT` (`AOM_E2E_TLS_PORT`, 4711), `HOSTED_URL` (`AOM_E2E_HOSTED_URL`, `http://localhost:4710`), `JOURNEY_PORTS` (`AOM_E2E_JOURNEY_PORTS`, `4720,4721,4722,4723` = registry, ssh, http, shop), `RESULTS_DIR` (`AOM_E2E_RESULTS`, default `${E2E_DIR}-results`, **outside** `E2E_DIR`, which the setup deletes; in a tester shift that is `<tmp>/e2e-results`, still in the shift's TMPDIR). Export `SEED_ACCOUNTS` (ADMIN as org owner, SUPER as platform account). No new credentials: the existing test-only constants. |
| `e2e/support/test-services.ts` (new) | **Revised (A2).** `declaredServices(env = process.env)` parses `AOM_TEST_SERVICES` (`host:port,...`, `[::1]:p` included) into `{connect: Set<number>, inShift: boolean}`. `inShift` is true when `AOM_TEST_SERVICES` or `AOM_AGENT_TMP_ROOT` is set (a tester shift with no declared service has only the latter). Two checks: `requireDeclared(port, what)` for a port the suite **connects** to (in a shift a missing port throws `port 4710 (hosted build) is not declared: ask the project Owner to add "hosted-build 127.0.0.1:4710" in Project settings > Local test services`; outside a shift any port is allowed); `requireBindable(port, what)` for a port the harness **listens** on (4601, 4711): in a shift a **declared** port throws `port 4711 (TLS proxy) is declared as a local test service, so every shell of the shift bridges it and the harness cannot listen on it: ask the project Owner to remove it from Project settings > Local test services`; otherwise allowed. No bind list is read (there is none). The setting name comes from one constant `TEST_SERVICES_SETTING = 'Project settings > Local test services'`, the runner's wording. It is the only file that knows the env format. |
| `e2e/support/seed.ts` (new) | `seedE2eAccounts({databaseUrl, accounts, run})`. For each account: `SELECT u.id, u.kind, EXISTS(SELECT 1 FROM org_members m WHERE m.user_id=u.id AND m.role='owner' AND m.status='active') AS owns FROM users u WHERE lower(u.email)=lower($1)`. Missing -> run the CLI (`admin:create` with `--org` for an owner, `superadmin:create` for a platform account). Present and right (owner owns an org / platform account has `kind='super_admin'`) -> skip, log `exists`. Present but wrong -> throw naming the email and what is wrong. `run` is injected: default `pnpm --filter @aom/server <script>` in `ROOT` (core), or `node <appDir>/server/dist/admin-create.mjs` for a built hosted app (`--app <dir>`). Passwords go through `AOM_ADMIN_PASSWORD` in the child env, not argv. Pure `planSeed(existing, accounts)` returns the actions, for unit tests. CLI: `node support/seed.ts [--database-url <url>] [--app <dir>]`. |
| `e2e/global-setup.ts` | Replace the two `sh('pnpm', [... 'admin:create' ...])` / `superadmin:create` blocks with `await seedE2eAccounts({...})`, keeping `AOM_E2E_ADMIN_NAME` / `AOM_E2E_ADMIN_ORG`. `recreateDb()` stays. Add `requireBindable(4601, 'E2E server')` before the server starts. Respect `AOM_E2E_DIR` from the shell (already does). Nothing else changes. |
| `e2e/guide-global-setup.ts` | Use `seedE2eAccounts` with its own accounts (ADMIN, `SUPER_DEMO`). Keep `AOM_GUIDE_KEEP` / `AOM_GUIDE_REUSE` behaviour. |
| `e2e/support/tls-proxy.ts` (new) | `makeCert(dir)` (openssl, SAN localhost/127.0.0.1/::1) -> `{certPath, keyPath}`; `startTlsProxy({target, port, host='127.0.0.1', certDir})` -> `{url: 'https://localhost:<port>', caPath, close()}`. `https.createServer` + `http.request` pipe; copies status and headers **unchanged**; adds only request headers `x-forwarded-proto/host/for`; `upgrade` handled with `net.connect` piping; 502 with a plain body naming the target when the upstream refuses (so a dead build shows as `502 hosted build at http://127.0.0.1:4710 refused the connection`, not a TLS error). Checks its own port with `requireBindable(port, 'TLS proxy')` and the target with `requireDeclared(targetPort, 'hosted build')`; on `EADDRINUSE` it fails fast with a message naming the two causes (the port is declared and bridged, or a stale proxy). |
| `e2e/hosted-global-setup.ts` (new) | A global setup for a hosted Playwright config: `requireDeclared` for the hosted build port, wait for `<HOSTED_URL>/api/health`, `seedE2eAccounts` into `DATABASE_URL` with `--app` when `AOM_E2E_HOSTED_APP` is set (otherwise skip seeding with a note), start the TLS proxy to `HOSTED_URL`, set `process.env.NODE_EXTRA_CA_CERTS` and `process.env.HOSTED_TLS_URL`, return a teardown that closes the proxy and removes the cert. Not used by `playwright.config.ts`; guildwise-cloud's hosted config wires it (separate card). |
| `e2e/with-tls-proxy.ts` (new) | CLI for today's hosted config without any guildwise-cloud change: `node with-tls-proxy.ts [--target <url>] [--port <n>] -- <command...>`. Starts the proxy, runs the command with `NODE_EXTRA_CA_CERTS` and `HOSTED_TLS_URL` set, stops the proxy on exit and on SIGINT/SIGTERM, exits with the command's code. |
| `e2e/support/journey-containers.ts` (new) | **Revised (A3).** `startJourneyContainers(ports)`: first `docker version` (5 s). If the daemon is unreachable it throws `Docker is not reachable here. Tester shifts have no Docker: DevOps runs the Docker projects (README "Docker projects")`. Then it builds `aom-test-sshd:1` (`docker build -q`), runs the registry `-p 127.0.0.1:<reg>:5000 -p 172.17.0.1:<reg>:5000` and the box `-p 127.0.0.1:<ssh>:22 -p 127.0.0.1:<http>:5500 -p 127.0.0.1:<shop>:8090`, names `aom-e2e-journey-registry` / `aom-e2e-journey-box` (fixed names plus a run id), removes leftovers with the same name prefix first, and writes `${E2E_DIR}/journey-containers.json` `{registry, box, regPort, sshPort, httpPort, shopPort}`. `stopJourneyContainers()`: reads the file, `docker rm -f` both, removes the pushed `127.0.0.1:<reg>/*` images, deletes the file; honours `AOM_JOURNEY_KEEP=1`. **No `requireDeclared` call**: the ports are Docker-published on the host where Docker runs (DevOps, outside the sandbox), so they are not declared as test services. A port already in use fails with Docker's own message, which names the port. Code moved from the spec, not rewritten. |
| `e2e/tests/journey-containers.setup.ts`, `e2e/tests/journey-containers.teardown.ts` (new) | One `test()` each, calling start / stop. |
| `e2e/playwright.config.ts` | Projects `{name: 'journey-containers', testMatch: 'journey-containers.setup.ts', teardown: 'journey-containers-teardown'}`, `{name: 'journey-containers-teardown', testMatch: 'journey-containers.teardown.ts'}`; `deploy-setup-journey` gets `dependencies: ['auth', 'journey-containers']`. Reporters: `list` plus `json` (`${RESULTS_DIR}/results.json`) and `html` (`${RESULTS_DIR}/report`, `open: 'never'`; `PLAYWRIGHT_HTML_OUTPUT_DIR`, which a tester shift sets, wins over this, see 2.6); `outputDir: ${RESULTS_DIR}/test-results`. **Added (A3):** `DOCKER_PROJECTS = ['deploy-setup', 'deploy-connect', 'deploy-move', 'journey-containers', 'journey-containers-teardown', 'deploy-setup-journey']`. When `AOM_E2E_NO_DOCKER=1` these projects are left out of `projects` and listed in `metadata.excludedProjects` (`{name, reason: 'Docker is not available in tester shifts: run by DevOps'}`), so the JSON report says what was not run and why. The switch is never on by default, and no spec, timeout or retry changes. |
| `e2e/tests/deploy-setup-journey.spec.ts` | Setup test only: replace the two `docker run` blocks and `freePort()`/`portOf()` for the registry and box with reading `journey-containers.json` (fail with a clear message if missing: "run with the journey-containers setup project"). `afterAll` keeps `killRunner`, the image cleanup and `rmSync(DIR)`, but no longer removes the containers (the teardown project does). `docker cp` of the fake docker, the sshd wait, all `expect`s and every later test unchanged. |
| `e2e/support/preflight.ts` (new) | See 4.3. |
| `e2e/support/summary.ts` (new) | Reads `results.json`; counts per test by its last result: passed, failed (`failed`/`timedOut`/`interrupted`), flaky, skipped (a result with status `skipped`), **did not run** (no result: a dependency failed or the run stopped), plus duration from `stats`. Prints one line `passed 154, failed 5, skipped 19, did not run 201, flaky 0, duration 13.2 min`, then the failed titles with file:line, then the did-not-run count per project, then **(added)** one line per `config.metadata.excludedProjects` entry: `not run here: deploy-connect (Docker is not available in tester shifts: run by DevOps)`. `--json` for the thread. |
| `e2e/scripts/copy-cached-deps.sh` (new) | Finds the cache (`GWP_CORE_CACHE`, else the `*/gwp-core-*/node_modules/.bin` entry on `PATH`); refuses when the cache's `pnpm-lock.yaml` differs from the worktree's (names both hashes and says "ask DevOps to refresh the gwp-core cache"); `rsync -a --ignore-existing --exclude .git` of every `node_modules` folder (root, `apps/*`, `packages/*`, `e2e`) into the worktree. Never runs `pnpm install`. |
| `e2e/package.json` | Scripts: `preflight` (`node support/preflight.ts`), `seed` (`node support/seed.ts`), `full` (`playwright test`), `full:shift` (**added**: `AOM_E2E_NO_DOCKER=1 playwright test`, the tester shift's full run), `docker` (**added**: `playwright test --project=deploy-setup --project=deploy-connect --project=deploy-move --project=deploy-setup-journey`, the part DevOps runs), `regression` (`playwright test` + the args after `--`), `summary` (`node support/summary.ts`), `deps:cache` (`bash scripts/copy-cached-deps.sh`), `test:unit` (`node --test 'support/*.test.ts'`). Keep `e2e`, `e2e:run`, `video`, `typecheck`. |
| `e2e/support/*.test.ts` (new) | Unit tests (node:test, no new dependency), see 4.5. |
| `e2e/README.md` (new) | See 4.4. |

The proxy port, the journey ports and the services are configuration in `env.ts`; nothing else hard-codes a port.

### 4.2 Ports (the test-services declaration the owner makes)

**Revised (A2, A3).** Only the ports the suite *connects to* on the workstation are declared. Ports the harness listens
on must **not** be declared, because the tester auto-bridge would take them in every bash. The Docker-published journey
ports are not declared, because Docker does not run in tester shifts.

| Name (suggested) | Host:port | Declare? | Used by |
|---|---|---|---|
| `postgres` | 127.0.0.1:5433 | yes | global setup, specs (`AOM_E2E_PG_HOSTPORT`) |
| `mailpit` | 127.0.0.1:8025 | yes | `support/mail.ts` |
| `smtp` | 127.0.0.1:1025 | yes | the server's mail |
| `hosted-build` | 127.0.0.1:4710 | yes | hosted run, TLS proxy target, preflight |
| (E2E server) | 127.0.0.1:4601 | **no**, the harness listens on it | E2E server |
| (TLS proxy) | 127.0.0.1:4711 | **no**, the harness listens on it | TLS proxy |
| (journey) | 127.0.0.1:4720-4723 | **no**, Docker-published, used where Docker runs (DevOps) | journey containers |

Four declared services, well inside the limit of 10, which is unchanged.

### 4.3 Preflight (`pnpm -C e2e preflight`)

One line per check, `ready` or `NOT READY`, with the fix for a not-ready line; exit code 1 when any check is not ready, 0
otherwise. `--json` writes the same list. Each network check has a 3 s timeout. In a tester shift every Bash call bridges
the declared ports itself (2.5). Run the preflight in the **same Bash call** as the suite anyway: the harness's own
listeners (4601, 4711) exist only in the call that starts them.

| Check | Ready when | Not ready says |
|---|---|---|
| node | version >= `.nvmrc` | use the `node-nvm 22.23.4` toolchain |
| dependencies | `@playwright/test` and `pg` resolve from `e2e/`; worktree `pnpm-lock.yaml` equals the cache's | run `pnpm -C e2e deps:cache`; if the lockfile differs, ask DevOps to refresh the gwp-core cache |
| browsers | `chromium.executablePath()` exists | `PLAYWRIGHT_BROWSERS_PATH` to the `playwright-browsers` toolchain; ask DevOps |
| build | `apps/server/dist/main.mjs`, `apps/runner/dist/aom-runner.mjs`, `apps/web/dist/index.html` exist | run `pnpm build` (with `pnpm_config_verify_deps_before_run=false`) |
| scratch | `AOM_E2E_DIR`, `RESULTS_DIR` and (when set) `AOM_AGENT_TMP_ROOT` are writable (mkdir + write + remove a probe file) | in a tester shift the runner sets these: if one is missing or read-only, ask DevOps (`aom devops`) to check the runner version; outside a shift set `AOM_E2E_DIR` |
| test services | in a shift: 5433, 8025, 1025, 4710 are in `AOM_TEST_SERVICES`, and 4601 and 4711 are **not** | ask the project Owner to add (or remove) `<name> 127.0.0.1:<port>` in Project settings > Local test services (applies from the next shift) |
| postgres | `SELECT 1` on `PG_ADMIN_URL` | DevOps: start the dev Postgres on 5433 (`docker-compose.dev.yml`) |
| mailpit | `GET <MAILPIT_API>/api/v1/info` is 200 | DevOps: start Mailpit (8025/1025) |
| smtp | TCP connect and a `220` greeting on 1025 | same |
| app port | 4601 can be bound and released | a stale E2E server is still running: stop it (`pids.json`); or 4601 is declared (remove it, see above) |
| hosted build | `GET <HOSTED_URL>/api/health` is 200 | DevOps: start the hosted build (toolchain `gwp98-hosted-app`) on 4710 |
| TLS proxy | `openssl` present; 4711 can be bound; a short-lived proxy answers `GET https://localhost:4711/api/health` with 200 through TLS (shows `HSTS present`/`absent` as information, never as the verdict) | as above for 4710; port in use: 4711 declared or a stale proxy |
| docker | `docker version` reaches the daemon; `registry:2` and `alpine:3.20` (or `aom-test-sshd:1`) are present; no leftover `aom-e2e-journey-*` container | ask DevOps (`aom devops`) to run `pnpm -C e2e docker` outside the sandbox and send the summary, or to pull the two images when they are missing |

`--no-hosted` and `--no-docker` exist for a run that does not include those parts; the skipped checks are still printed as
`skipped (<reason>)`, never as ready. **Revised (A3):** a tester shift has no Docker, so the README's tester procedure
runs `preflight --no-docker` (line `docker: skipped (no Docker in tester shifts: DevOps runs pnpm -C e2e docker)`) and
the full run without the Docker projects (`full:shift`). DevOps runs the full preflight and the Docker projects. Every
other check runs in the tester shift.

Structure for testing: `checks: Check[]` (`{name, target, run(): Promise<{ok, detail, fix?}>}`), `runChecks()`,
`formatReport()`, `exitCodeOf()`; network helpers `tcpReady(host, port)`, `httpOk(url)`, `canBind(port)`.

### 4.4 `e2e/README.md`, section "Tester shift setup"

Order the tester follows, each step one command:

1. **Toolchains**: `node-nvm 22.23.4`, `pnpm-12.8.1`, `gwp-core-caa6a44` (cached dependencies), `playwright-browsers`,
   `gwp98-hosted-app` (hosted build). No `pnpm install`.
2. **Copy the cached dependencies**: `bash e2e/scripts/copy-cached-deps.sh` (owner decision 2026-11-03). Then
   `pnpm_config_verify_deps_before_run=false pnpm build`.
3. **Environment** (revised, A4): the runner already sets `AOM_E2E_DIR` (`$TMPDIR/e2e`), `AOM_AGENT_TMP_ROOT` and
   `PLAYWRIGHT_HTML_OUTPUT_DIR` in a tester shift. Do not override them. Export only
   `AOM_E2E_RESULTS="$TMPDIR/e2e-results" pnpm_config_verify_deps_before_run=false`. Outside a shift set
   `AOM_E2E_DIR` yourself.
4. **Services and ports**: the table of 4.2, including which ports must *not* be declared and why.
5. **Preflight**: `aom-env --timeout 5 -- pnpm -C e2e preflight --no-docker`. Every line must be `ready` (docker shows
   `skipped`). Otherwise stop here and go to step 10. (`aom-env` is not needed for reachability in a tester shift; it is
   used for its hang limit.)
6. **Full suite**: `aom-env --timeout 40 -- sh -c 'pnpm -C e2e preflight --no-docker && pnpm -C e2e full:shift; pnpm -C e2e summary'`
   (one Bash call). Baseline outside the sandbox: 154 passed, 5 failed, 19 skipped, 201 did not run, 13.2 min at
   `caa6a44f`. That baseline includes the Docker projects, so compare after adding DevOps's result (step 6a).
   6a. **Docker projects** (added, A3): `aom devops "run pnpm -C e2e docker outside the sandbox at <commit> and send me the pnpm -C e2e summary output"`.
   Record DevOps's counts as a separate line in the report (standing order: DevOps runs, the tester records).
   Do not wait idle for the answer: finish the rest of the report first.
7. **Regression subset**: `aom-env --timeout 20 -- pnpm -C e2e regression -- --project=<name> [--project=<name>]`, with
   the projects that cover the card (dependencies run automatically; list them with `--list`). Example with the names. A
   Docker project in the subset goes to DevOps as in 6a.
8. **Results and logs**: `$AOM_E2E_RESULTS/results.json`, `$AOM_E2E_RESULTS/test-results/` (traces, screenshots). In a
   tester shift the HTML report goes to `$PLAYWRIGHT_HTML_OUTPUT_DIR` (`$AOM_E2E_DIR/playwright-report`). The next run's
   setup wipes it and the runner removes `$TMPDIR` at shift end, so attach what must be kept. Server log
   `$AOM_E2E_DIR/server.log`, runner logs `$AOM_E2E_DIR/runner*.out.log`.
9. **Report**: `pnpm -C e2e summary` and paste its line, the failed titles, and the "not run here" lines with DevOps's
   result for them. The four known outside-sandbox failures (ceo-chat Archive all, devops AC4, release-docs-prep AC2/AC9,
   business-card-types Software view) are reported as failures. Never skip or change a spec to turn the run green.
10. **When a preflight line is not ready**: table check -> who to ask -> exact request (Owner: Project settings > Local
    test services to add or remove a port; DevOps via `aom devops` for a service that is down, images, browsers, the
    cache, or the Docker projects). Do not stall: send the request, and record the run as not run for that part.
11. **Hosted build and HSTS**: the hosted specs live in guildwise-cloud; how the proxy is used there
    (`node e2e/with-tls-proxy.ts -- pnpm exec playwright test -c playwright.hosted.config.ts hosted-edge` with
    `HOSTED_BASE_URL=$HOSTED_TLS_URL`), what a pass and a fail mean (section 2.3), and a pointer to
    guildwise-cloud `docs/E2E-HOSTED-RUN.md`.
12. **Seeding**: `pnpm -C e2e seed` is safe to repeat; how to seed the hosted build's database.

Plain operator wording, no credentials (the README points at `support/env.ts` for the test-only passwords).

### 4.5 Unit tests (node:test, `pnpm -C e2e test:unit`)

- `seed.test.ts`: `planSeed` on empty -> create both; on both present -> no action; owner without an organisation ->
  error; email present as a normal user where a platform account is wanted -> error. `seedE2eAccounts` with a fake `query`
  and a recording `run`, called twice on a fake store that records creations: the CLI runs once per account (AC1).
- `tls-proxy.test.ts`: a local `http` upstream that sends `strict-transport-security` on one path and not on another, and a
  custom header; through the proxy (client with `ca: caPath`) the headers arrive byte-identical in both cases and the proxy
  adds none (AC2); `x-forwarded-proto: https` reaches the upstream; an upstream that refuses gives 502 with the target named;
  a port in use gives the clear error; a WebSocket-style `upgrade` is piped.
- `test-services.test.ts` (revised): parsing of `AOM_TEST_SERVICES` (`127.0.0.1:5433,[::1]:6379`); `inShift` from
  `AOM_TEST_SERVICES` or `AOM_AGENT_TMP_ROOT`; `requireDeclared` inside and outside a shift; `requireBindable` refuses a
  declared port in a shift and allows an undeclared one (AC3).
- `preflight.test.ts`: report formatting and exit code (all ready -> 0; one not ready -> 1 and the line names the port and
  the fix; a `--no-docker` skip -> `skipped`, exit 0); `tcpReady` against a live and a closed ephemeral port; `canBind`
  on a port in use (AC5).
- `summary.test.ts`: a fixture `results.json` with each outcome, including a test with no results (did not run) and a
  `metadata.excludedProjects` entry (AC6).
- `journey-containers.test.ts`: the `docker` argument lists built from the ports, and the clear error when `docker version`
  fails (injected `docker` function; no daemon).
- `playwright-config.test.ts` (added): importing the config with and without `AOM_E2E_NO_DOCKER=1`: the six Docker projects
  are absent or present, `metadata.excludedProjects` lists them, and every other project is unchanged (AC7).

`pnpm -C e2e typecheck` must pass. Full E2E runs are for the tester shift.

## 5. Acceptance criteria -> design

| AC | Met by | Verified by |
|---|---|---|
| 1 Seeded users and organisation, idempotent | `support/seed.ts` in both global setups; the CLI only for missing accounts | `seed.test.ts`; test plan step 1 (setup twice, `SELECT count(*) FROM users WHERE email IN (...)` = 1 each, one active owner row in `org_members`) |
| 2 HSTS check through the local TLS proxy, real behaviour | Transparent `tls-proxy.ts`, trusted per-run cert, `with-tls-proxy.ts`, `hosted-global-setup.ts`, preflight TLS line | `tls-proxy.test.ts`. The end-to-end run of `hosted-edge.spec.ts` is in guildwise-cloud: it needs that repository's follow-up card (wiring, core pin bump); until then a GuildwiseHQ tester shift verifies the TLS path with the preflight line and `with-tls-proxy.ts` + `curl`. **Partly outside this card, named here** |
| 3 Proxy and journey containers started/stopped by setup/teardown, declared ports only | `hosted-global-setup.ts` teardown, `with-tls-proxy.ts`, setup/teardown projects. The proxy connects only to the declared 4710 and listens on an undeclared in-namespace port (`requireDeclared` / `requireBindable`). The journey containers run where Docker runs (DevOps, outside the sandbox), on the fixed ports in `env.ts` | `test-services.test.ts`, `journey-containers.test.ts`; test plan step 4 run by DevOps (`docker ps` empty afterwards) |
| 4 README section | `e2e/README.md` "Tester shift setup", items 1-12 | review checklist against the AC list |
| 5 Preflight lists ready/not-ready, non-zero exit | `support/preflight.ts` | `preflight.test.ts`; test plan step 2 (stop 4710 -> `NOT READY hosted-build`, exit 1) |
| 6 A tester shift following only the README completes a run with counts and duration | README + `full:shift` + `summary.ts`; the Docker projects through DevOps (6a) | `summary.test.ts`; the real run in a tester shift |
| 7 No spec skipped or weakened | Only the journey's container start moves; no assertion, timeout, retry or skip changes; the four known failures stay red. `AOM_E2E_NO_DOCKER` moves the Docker projects to DevOps's run and names them in the report: they are run, not skipped | Review of the spec diff; `playwright-config.test.ts`; summary shows the known failures as failed and the Docker projects as "not run here" with DevOps's result |

## 6. Risks and follow-ups

### 6.1 Risks

- **Declared harness ports (revised, A2)**: there is no bind list. With the tester auto-bridge a declared 4601 or 4711
  is taken by socat in every bash of the shift, so the harness cannot listen on it. `requireBindable` and the preflight
  "test services" line catch this and name the fix (remove the port from the setting). The README says so in the ports
  table.
- **Docker in the sandbox (revised, A3)**: tester shifts never get Docker (landed rule). Four projects
  (`deploy-setup`, `deploy-connect`, `deploy-move`, `deploy-setup-journey`) run through DevOps (`pnpm -C e2e docker`).
  A tester who runs `full` instead of `full:shift` sees them fail at their first `docker` call. That failure comes from
  the sandbox, and `journey-containers` names the cause and the fix.
- **Fixed container names and ports**: two parallel E2E runs on one workstation would collide. The suite already runs with
  one worker against one database; the setup removes leftovers by name prefix first.
- **Images offline**: `apk add` in the sshd image needs network unless the layer is cached; preflight checks the images.
- **`NODE_EXTRA_CA_CERTS` timing**: Node reads it at process start; the global setup sets it before Playwright forks the
  workers. If a later Playwright version reused a worker started before global setup, the hosted config must set it in the
  command instead (the wrapper already does). Covered by the wrapper as the primary path.
- **HTML report location (A4)**: `PLAYWRIGHT_HTML_OUTPUT_DIR` (set by the runner) wins over the config, so in a tester
  shift the HTML report is inside `AOM_E2E_DIR` and does not survive the next run's setup. The JSON results stay in
  `RESULTS_DIR`, outside it. The README says this.
- **Builder guard**: section 7.

### 6.2 Follow-up card for guildwise-cloud (backlog suggestion raised)

1. Bump the core pin to the GuildwiseHQ commit with this card.
2. `scripts/e2e/playwright.hosted.config.ts`: `globalSetup: './hosted-global-setup.ts'` (core's), and the hosted-edge test
   to run against `HOSTED_TLS_URL` (a separate project or invocation, so the sign-in specs keep their http origin).
3. Decide how the hosted build is run for the HSTS check: with `AOM_PUBLIC_ORIGIN=https://localhost:<tls port>`
   (`e2e-hosted-local.sh` can do this for the hosted-edge pass), so the build's own HSTS is checked; or accept that the
   container with its http origin fails that test on a missing header (real behaviour).
4. Replace the manual `admin-create.mjs` step in `docs/E2E-HOSTED-RUN.md` with `pnpm -C core/e2e seed --app <dir>`.

## 7. Who builds this (routing)

Every changed file is under `e2e/**`. The post-shift guard rejects builder edits there and the CEO has refused builder
exceptions many times (ledger aadf93f9, 69b39b28, 6cf91cb2, e4409289). If this card goes to a normal builder shift, the
handoff will be refused. A non-blocking question to the manager asks for the build to run as a tester-role shift (the
pattern the CEO set: the tester owns `e2e/**`). The design does not depend on the answer.

## 8. Assumptions about GWP-102 (checked against `d81aa42f`)

| # | Assumption | Result | Evidence |
|---|---|---|---|
| A1 | `AOM_TEST_SERVICES` keeps its `host:port,...` format for connect services, and aom-env tunnels each of them in the command's namespace | **Holds** (and more: tester shifts bridge in every bash through `BASH_ENV`) | `testServicesSpec`, `shims.ts` `TEST_SERVICE_BRIDGE`, `AOM_BRIDGES_SCRIPT`, `testerShiftEnv` |
| A2 | GWP-102 separates bind ports from connect ports and exposes a bind list (`AOM_TEST_BIND_PORTS`) | **Did not hold**: no bind list; every declared port is bridged in every tester bash | `apps/runner/src/sandbox/test-services.ts`, `shims.ts`; no `AOM_TEST_BIND_PORTS` anywhere |
| A3 | Docker-published ports are declared as connect services, and a tester shift can reach the Docker daemon | **Did not hold**: Docker is not available in any tester sandbox; docker specs run through DevOps | `testerScratchNote`, docs/RUNNER.md "Tester shifts and the E2E suite (GWP-102)" |
| A4 | The mock runner can be spawned and a per-shift writable scratch exists, with `$TMPDIR` inside it | **Holds in substance, path differs**: the runner itself sets `AOM_E2E_DIR=<tmp>/e2e`, `AOM_AGENT_TMP_ROOT` and `PLAYWRIGHT_HTML_OUTPUT_DIR`; the README's `export AOM_E2E_DIR=$TMPDIR/aom-e2e` was wrong | `testerShiftEnv`, `agentTmpRoot()` |
| A5 | The 10-service limit stays, or rises | **Holds** (unchanged; the revised declaration uses 4) | `MAX_TEST_SERVICES = 10` |
| A6 | Hosted build 4710 stays reachable through an ordinary connect declaration | **Holds** | 4710 is not reserved; bridged like any declared service; probed at shift start |

## 9. Revision after GWP-102 landed (what changed and why)

- **A2, no bind list**: `support/test-services.ts` no longer reads a bind list. It gains `requireBindable`, which
  *refuses* a declared port in a shift, because the auto-bridge would hold it. The ports table (4.2) declares only 5433,
  8025, 1025 and 4710. 4601 and 4711 must not be declared. The preflight "test services" line checks both directions.
- **A3, no Docker in tester shifts**: the journey ports are not declared and `journey-containers.ts` has no
  `requireDeclared`. It checks the daemon first and fails with a message naming DevOps. A config switch
  `AOM_E2E_NO_DOCKER=1` (script `full:shift`) leaves the three other Docker projects and the journey with its
  setup/teardown out of the tester run, and records them in the JSON report's metadata. `summary.ts` prints them as "not
  run here". A `docker` script runs exactly those projects for DevOps. The tester preflight uses `--no-docker`. The
  README gains step 6a: DevOps runs the Docker projects and the tester records the result. The journey's setup/teardown
  projects (AC3) stay as designed and run in DevOps's run.
- **A4, scratch path named by GWP-102**: the README no longer exports `AOM_E2E_DIR`. It uses the runner's values and
  names where the HTML report lands (`PLAYWRIGHT_HTML_OUTPUT_DIR` wins over the config). `RESULTS_DIR` still defaults to
  `${E2E_DIR}-results`, which is `<tmp>/e2e-results` in a shift.
- **A1 side effect**: `aom-env` is no longer needed for reachability in tester shifts. The README keeps it for its hang
  limit and runs preflight, suite and summary in one Bash call, because the harness's own listeners live only in that call.
