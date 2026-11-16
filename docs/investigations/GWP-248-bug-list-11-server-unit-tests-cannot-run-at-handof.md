# GWP-248: server unit tests at handoff (test Postgres in the check sandbox)

## Question

A builder's handoff runs the unit tests of the changed files in the check sandbox (`runHandoffChecks`,
`apps/runner/src/checks/run.ts`). The `apps/server` vitest suite needs the test Postgres (`127.0.0.1:5433`,
database `aom_test`), and the check sandbox cannot reach it, so server unit failures only show up at regression.
How should the check sandbox reach a declared test database, and nothing else? How is "database unreachable"
reported? How do concurrent runs keep their data apart? And should the route go through the HTTP egress proxy
(test services) or use a Postgres local to the sandbox?

## Findings

### Where the handoff checks run

- `ShiftSupervisor` (handoff path, `apps/runner/src/shifts/supervisor.ts` ~3341) calls `runHandoffChecks` with
  `launch = runs.checkLaunch({ ..., network: 'none' })`.
- `RunsManager.checkLaunch` (`apps/runner/src/runs/manager.ts` ~1236) builds a bubblewrap command from
  `sandboxCommand` (`apps/runner/src/runs/sandbox.ts`). The flags are `--unshare-pid --unshare-ipc --unshare-net`, the
  check's private tmp dir `<agentTmpRoot>/aom-check-<key>` is bound over `/tmp`, and the env is the offline
  package-manager env. `--unshare-net` gives the check its own network namespace, which has only an empty loopback.
  So `127.0.0.1:5433` inside the check is *connection refused*. Where the host forbids unprivileged network
  namespaces (`networkIsolationAvailable() === false`), the check falls back to the host network and can already
  reach the database.
- Regression unit suites (`startRegressionUnits`, ~3430) use the same `checkLaunch` with `network: 'host'`. That is
  why the server suite works there.
- At handoff a unit suite runs its **handoff command** (`handoffCmd` with `{files}`, for example
  `vitest related --run {files}`), limited to the changed files in its folder (`checks/units.ts handoffUnitRuns`). A
  suite with no handoff command is recorded as `regression_only`. The whole handoff has one deadline,
  `HANDOFF_WORK_BUDGET_MS` = 8 min (checks, then units). Each unit run is capped at `handoffTimeoutMin ??
  UNIT_HANDOFF_TIMEOUT_MIN` (5 min).

### The existing test-services mechanism (GWP-41, GWP-102, GWP-152)

- `packages/shared/src/projects/test-services.ts`: the owner declares `{ name, host, port }` in *Project settings >
  Local test services*. The host must be loopback (`127.0.0.1`, `::1` or `localhost`) and only the exact port is
  opened. Credentials are never part of the setting. The server sends the list as `msg.testServices` on
  `shift.start` for builder, reviewer and tester card shifts.
- In the **agent's** shell the opening is a `host:port` entry in Claude Code's sandbox proxy (or in the runner's
  egress proxy for harness runtimes). `aom-env` starts `socat TCP-LISTEN:<port> PROXY:<proxy>:<host>:<port>` inside the
  command's namespace.
- **Can the egress proxy carry a database connection?** Yes. `startEgressProxy` answers `CONNECT host:port` for a
  listed test service with a plain TCP tunnel (`server.on('connect')` → `tunnel()`), and `aom-env`'s socat `PROXY:`
  address already carries Postgres that way. The proxy is HTTP only for the handshake. After `200 Connection
  Established` the bytes are raw TCP.
- **But the check sandbox has no proxy.** A check is not an agent session: no Claude Code proxy, no harness egress
  proxy, `HTTPS_PROXY` is not set and the network is `none`. Reusing the proxy route would mean starting an egress
  proxy per check, binding its socket, and running socat in `PROXY:` mode with credentials. That is a lot of moving
  parts for one TCP port.
- `apps/runner/src/runs/forward.ts` (`startForwards`) already solves the same problem for a tester's local
  environment (design D6): the runner listens on **one Unix socket per allowed port** inside the agent's private tmp
  dir and connects each connection to `127.0.0.1:<port>`, and nothing else. Inside the namespace, `aom-env` runs
  `socat TCP-LISTEN:<port>,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:<sock>`, so the port works as it does on the
  workstation. Spike (b) (docs/RUNNER.md, 2026-10-14) confirmed that a socat bridge works inside a real
  `bwrap --unshare-net`. `socat` is a documented Linux runner dependency (installer step 4).

### The server suite's database handling

- `apps/server/vitest.config.ts`: `TEST_DB = AOM_TEST_DB_URL ?? postgres://aom:aom@127.0.0.1:5433/aom_test`, then sets
  `DATABASE_URL`. `fileParallelism: false` (one database per run, files one after the other).
- `apps/server/test/helpers/db.ts` and `test/global-setup.ts` accept only `/aom_test(_[a-z0-9]+)?$`, so a database
  for each run (`aom_test_<id>`) is already allowed. `resetDb()` TRUNCATEs every table, so two runs on the same
  database corrupt each other.
- `global-setup.ts` runs `migrate(url)` (262 migrations), but does **not** create the database. CONTRIBUTING.md and
  CLAUDE.md tell people to run `createdb aom_test_<branch>` by hand. Postgres is `postgres:18` (docker-compose.dev.yml,
  user `aom`, a superuser in the container), so `CREATE DATABASE` and `DROP DATABASE ... WITH (FORCE)` are available.
- When the database is down, node-postgres fails with `connect ECONNREFUSED 127.0.0.1:5433` in `globalSetup`.
  Vitest prints the error, names no failing test file and exits 1. Today `judgeUnit` turns that into
  `error: failed (exit 1) without naming a failing test`, which hides the real cause.

### Doctor

`aom-runner doctor` (`apps/runner/src/cli.ts` ~468, async) prints `sandboxDoctorLines` → `testServiceDoctorLines`
from the decisions recorded in `status.json`. `answering` is only the probe made when the last shift started.

## Options

| | (a1) Egress proxy route | (a2) Unix-socket forwarder per declared service (recommended) | (b) Postgres local to the sandbox |
|---|---|---|---|
| How | Start `startEgressProxy` per check with `testServices`; bind its socket; socat `PROXY:` bridge inside | Runner listens on `<checkTmp>/svc/<port>.sock` → declared `host:port`; socat `UNIX-CONNECT` bridge inside the namespace on the same port | `initdb` + `postgres -k /tmp` inside each check, Unix socket only |
| Carries raw TCP | Yes (CONNECT tunnel) | Yes (plain pipe) | n/a |
| Reach | Exactly the declared pairs | Exactly the declared pairs; the runner connects to nothing else | Nothing outside |
| New dependencies | none (socat) | none (socat, already required) | Postgres server binaries of the right major version on every workstation |
| Start-up cost | proxy start, under 0.1 s | under 0.1 s | initdb plus start, 3 to 8 s, then 262 migrations |
| Moving parts | proxy, credentials, CONNECT parsing | ~60 lines, the same as `forward.ts` | lifecycle, cleanup, version drift from the dev database |
| Generic for other projects | yes | yes (any TCP test service: Postgres, Redis, Mailpit) | Postgres only |
| Concurrency | per-check namespace | per-check namespace and socket dir | per-check instance |

**Recommendation: (a2).** It uses the project's existing declaration (no schema change), keeps the reachable set to
exactly the declared `host:port` pairs, reuses a pattern that already exists (`forward.ts` plus a socat bridge), and adds
no per-check start-up cost. (a1) works, but brings a proxy and credentials for no gain. (b) adds a heavy
per-workstation dependency, and Docker is never allowed in checks.

**Isolation:** a separate database for each check run, named by a runner-provided id (`AOM_TEST_RUN_ID`). The server
test setup creates the database, migrates it and drops it. Regression keeps `aom_test`, so a check never touches
regression's data and two checks never share one.

**Which services:** every service the project declared that passes the check decision (the same list the builder's
own shell may already reach through `aom-env`). This is the "declared test database" from the card. If the owner also
declares Mailpit (some server tests send mail), those tests work too. Nothing undeclared is ever reachable. If the
owner later wants a narrower list for checks than for shells, a per-service "handoff checks" flag is a small follow-up.
It is not needed for this card.

## Design

### 1. Runner: forwarders for declared services (`apps/runner/src/runs/forward.ts`)

Add a sibling of `startForwards` that forwards to a declared host and records failures:

```ts
export interface ServiceForward { name: string; host: string; port: number; socket: string }
export interface ServiceForwards {
  /** `host:port=<socket inside the sandbox>` pairs for the bridge script. */
  spec: string;
  forwards: ServiceForward[];
  /** host:port pairs whose upstream connect failed during the run (once each, in order). */
  failures(): string[];
  close(): void; // idempotent: stop listening, remove the sockets
}
/** One Unix socket per allowed service under `<checkTmp>/svc/<port>.sock`, connected to that host:port only. */
export async function startServiceForwards(
  checkTmp: string,
  services: readonly LocalTestService[],
): Promise<ServiceForwards>
```

- The upstream is `{ host: s.host === 'localhost' ? '127.0.0.1' : s.host, port: s.port }`, always a loopback
  literal (the decision below already refused anything else). On upstream `error`, add `testServiceDomain(s)` to
  `failures` and destroy the client.
- Socket dir mode 0700, sockets 0600, as in `startForwards`. In the sandbox the path is `/tmp/svc/<port>.sock`
  (because `runTmp` is bound over `/tmp`).

### 2. Runner: which services a check gets (`apps/runner/src/sandbox/test-services.ts`)

A pure function, separate from `decideTestServices` (the Claude Code version and runtime gates are about the agent's
proxy and do not apply: the runner opens this route itself):

```ts
export function decideCheckServices(i: {
  services: LocalTestService[] | undefined; kind: string; roleKey: string; isDevops: boolean;
  platform: NodeJS.Platform; runnerPorts: ReadonlySet<number>;
}): TestServiceDecision[]
```

- Empty unless `kind === 'card'`, the role is `builder` (the only role whose handoff runs unit tests) and not DevOps.
- Refuse (with the reason) when the host is not loopback, the port is invalid, the port is a runner or run-environment
  port, the port is in `RESERVED_RUN_PORTS`, or the platform is not Linux ("no network namespace for the checks on
  this platform").
- Export a constant `CHECK_SERVICE_NOTE` for docs and messages.

### 3. Runner: launch with bridges (`RunsManager.checkLaunch`, `apps/runner/src/runs/manager.ts`)

New optional input `services?: LocalTestService[]` (the allowed ones) and `runId?: string`. New optional output
`forwards?: ServiceForwards`.

- Only when `kind === 'sandboxed'`, the resolved `network === 'none'` and `services.length > 0`: call
  `startServiceForwards(tmp, services)` and wrap the argv:
  `['bash', '-c', CHECK_BRIDGE_SCRIPT, 'aom-check-bridge', forwards.spec, ...offlineArgv]`.
- With the host network (no namespace possible) or unsandboxed: no forwarders and no wrapper. The suite reaches the
  database directly, as regression does today. Never fall back to a wider opening.
- `runId` → `env.AOM_TEST_RUN_ID` (also outside the sandbox).
- `CHECK_BRIDGE_SCRIPT` (new, `apps/runner/src/shims.ts` next to `TEST_SERVICE_BRIDGE`, so it can be unit tested as a
  string). Sketch:

```bash
spec="$1"; shift
if ! command -v socat >/dev/null 2>&1; then
  echo "aom-check: environment: socat is not installed on this workstation, so the test services ($spec) cannot be reached" >&2; exit 125
fi
pids=()
IFS=',' read -r -a items <<<"$spec"
for it in "${items[@]}"; do
  hp="${it%%=*}"; sock="${it#*=}"; port="${hp##*:}"; host="${hp%:*}"
  case "$host" in
    '[::1]') listen="TCP6-LISTEN:$port,bind=[::1],fork,reuseaddr"; hex="00000000000000000000000001000000:$(printf '%04X' "$port")"; tbl=/proc/net/tcp6 ;;
    *)       listen="TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr"; hex="0100007F:$(printf '%04X' "$port")"; tbl=/proc/net/tcp ;;
  esac
  socat "$listen" "UNIX-CONNECT:$sock" </dev/null >/dev/null 2>&1 & pids+=($!)
  for _ in $(seq 1 50); do grep -qi "$hex 0*:0000 0A" "$tbl" 2>/dev/null && break; sleep 0.1; done
done
"$@"; rc=$?
for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
exit "$rc"
```

  (`--unshare-pid` also kills any leftover socat when the check ends.) `localhost` services bind `127.0.0.1`, the same
  as `TEST_SERVICE_BRIDGE`. The listener reuses the declared port number, so the project's default URL
  (`127.0.0.1:5433`) works unchanged.

### 4. Runner: handoff checks (`apps/runner/src/checks/run.ts`)

- `RunChecksInput.launch` gets a third argument: `launch(argv, key, { unit: boolean })`. `CheckLaunch` gets an optional
  `forwards?: Pick<ServiceForwards, 'failures' | 'close' | 'forwards'>` and `services?: TestServiceDecision[]` (the
  decisions, including refused ones, so a message can say why a port is closed).
- After `capture()`, always call `l.forwards?.close()` (in a `finally`).
- New `environmentProblem(c: Captured, failing: string[], l: CheckLaunch): string | undefined`, used for unit jobs
  before `judgeUnit` and only when the run did not exit 0 and is not aborted, timed out or failed to spawn:
  1. **Strong signal:** `l.forwards.failures()` is not empty → "the test service <name> (<host:port>), declared in
     Project settings > Local test services, did not accept a connection on this workstation".
  2. **Bridge signal:** exit 125 with an `aom-check: environment:` line → that line.
  3. **Weak signal** (only when no failing test file is named): the output has
     `/ECONNREFUSED\s+(127\.\d+\.\d+\.\d+|::1|\[::1\]):(\d+)/`. If that `host:port` is declared but refused for checks,
     say "not reachable from handoff checks: <reason>". If it is not declared: "the tests tried <host:port>, which is
     not declared in Project settings > Local test services; handoff checks can reach only declared test services".
- An environment problem gives `status: 'error'` (it still refuses, as every result without a verdict does under
  policy 2, and it is never `passed`), `summary: 'environment problem: <text>'`, a new optional field
  `environment: '<host:port>'`, and `tail`. No `FAIL` lines are attributed to the builder.
- `refusalText`: for evidence with `environment`, write *"This is an environment problem on this workstation, not a
  failure in your code: <summary>. Ask DevOps to start it (`aom devops "start the test database <host:port>"`) or ask
  with `aom question --topic environment`, quoting this. Do not change or skip tests to get around it."* instead of
  the generic "did not produce a verdict" line.
- **Real counts** (AC1): a new `unitCounts(output)` in `checks/units.ts` parses vitest
  (`Tests  1 failed | 11 passed (12)`, `Test Files  ...`) and jest (`Tests: 1 failed, 11 passed, 12 total`). The
  summary becomes `passed: 12 tests in 3 files` or `1 test file failing (1 failed, 11 passed)`. If nothing can be
  parsed, keep today's wording.

### 5. Runner: wiring (`apps/runner/src/shifts/supervisor.ts`, handoff path ~3374)

- Before `runHandoffChecks`: `const checkSvc = decideCheckServices({ services: msg.testServices, kind: msg.kind,
  roleKey, isDevops, platform: process.platform, runnerPorts })`. Use the same `runnerPorts` as `decideTestServices`
  (the IPC port and `runs.ownedPorts()`); factor that out into a small private helper.
- In `launch`, for `opts.unit`: pass `services: allowed(checkSvc)`, `runId: checkRunId(msg.shiftId, headSha)`, and
  attach `services: checkSvc` to the returned launch. Lint, format and typecheck jobs get no services and no run id.
- `checkRunId` (new, `checks/units.ts`): `` `c${shiftId.replace(/-/g, '').slice(0, 8)}${sha.slice(0, 8)}${randomBytes(2).toString('hex')}` ``,
  lowercase `[a-z0-9]`, 21 characters, so `aom_test_<id>` stays well under Postgres's 63-character limit and
  matches the server's `aom_test(_[a-z0-9]+)?` guard.
- If one of the allowed services does not answer when the forwarders start, add a progress line (reuse
  `notAnsweringLine`). It is informational only: the verdict comes from §4.
- `startRegressionUnits` is **not** changed (host network, no run id, `aom_test` as today) → AC5.

### 6. Shared (`packages/shared/src/cards/lean-v6.ts`)

- `CheckEvidenceSchema`: add `environment: z.string().max(200).optional()` with the doc comment "the
  environment problem that kept a check from a verdict: the unreachable test service host:port (`error` only)".
  It is optional, so older servers strip it and older runners never send it. No protocol change: `msg.testServices`
  already carries the declaration. `LocalTestServiceSchema` is unchanged.
- `checkStatusLabel` is unchanged. The summary carries the text.

### 7. Server test configuration (apps/server, test files only)

- `vitest.config.ts`:

```ts
const RUN = /^[a-z0-9]{1,40}$/.test(process.env.AOM_TEST_RUN_ID ?? '') ? process.env.AOM_TEST_RUN_ID : undefined;
const TEST_DB =
  process.env.AOM_TEST_DB_URL ?? `postgres://aom:aom@127.0.0.1:5433/aom_test${RUN ? `_${RUN}` : ''}`;
```

  An explicit `AOM_TEST_DB_URL` still wins. Without `AOM_TEST_RUN_ID` (regression, developers) nothing changes.
- `test/global-setup.ts`: before `migrate(url)`, `ensureDatabase(url)`. Connect to the same server with database
  `postgres`, run `CREATE DATABASE "<name>"`, and ignore `42P04` (it already exists). Only when `AOM_TEST_RUN_ID` is
  set and this setup created the database:
  - `COMMENT ON DATABASE "<name>" IS 'aom-test-run <ISO time>'`;
  - in teardown and in the `exit` handler: `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)`;
  - at setup, sweep stale run databases: `SELECT d.datname FROM pg_database d JOIN pg_shdescription s ON s.objoid =
    d.oid WHERE s.description LIKE 'aom-test-run %'`, then drop those older than 12 h (the same `STALE_MS` as the
    tmp-root sweep). A killed check (timeout) leaves its database behind until a later run sweeps it.
  A database that was created by hand (`aom_test_mybranch`) or the shared `aom_test` is never dropped.
  `ensureDatabase` also removes the manual `createdb` step for developers (a bonus; CONTRIBUTING.md and CLAUDE.md can
  say it is optional now).
- The name is validated by the existing regex before it is used in SQL (it is `[a-z0-9_]` only). Quote it anyway.

### 8. Doctor (`apps/runner/src/adapters/claude-policy.ts`, `apps/runner/src/cli.ts`)

- In `doctor`, refresh `answering` for the recorded allowed services with `withReachability` (the runner probes from
  outside the sandbox, 1 s each) before calling `sandboxDoctorLines`.
- `testServiceDoctorLines`: one extra line per allowed service of a project:
  `ok   handoff checks: GWP postgres-test 127.0.0.1:5433 reachable now (bridged into builder unit test runs)` or
  `warn handoff checks: GWP postgres-test 127.0.0.1:5433 not answering now: handoff unit runs that need it will
  report an environment problem`. On non-Linux: `warn ... not bridged: no network namespace for checks on this
  platform`. Add the `socat` presence to the same block (`warn handoff checks: socat not installed`).

### 9. Docs

- `docs/RUNNER.md`, "Handoff checks" → new bullet **Test services in unit runs (GWP-248)**, and a cross-reference from
  the "Local test services (GWP-41)" bullet. Content: how the route works, that only declared pairs are reachable,
  `AOM_TEST_RUN_ID`, the environment-problem result, the doctor lines, the start-up cost, and that regression is
  unchanged.
- **Setup for a workstation or project** (in the same section, also as a short note in CONTRIBUTING.md under Tests):
  1. Postgres running on the workstation: `docker compose -f docker-compose.dev.yml up -d postgres`
     (`127.0.0.1:5433`, user `aom`, test-only password as in `docker-compose.dev.yml`; the user needs `CREATEDB`).
  2. Project settings > Local test services: name `postgres-test`, host `127.0.0.1`, port `5433` (plus Mailpit
     `1025` and `8025` if the server mail tests should run at handoff).
  3. Project settings > checks: the `apps/server` unit suite with a handoff command, for example
     `pnpm exec vitest related --run {files}` (cwd `apps/server`). Without it the suite stays `regression_only`.
  4. Each handoff run uses the database `aom_test_<AOM_TEST_RUN_ID>`, which it creates and drops itself. Regression
     uses `aom_test`.
  5. Check with `guildwise-runner doctor` → `handoff checks: ... reachable now`.

## Acceptance criteria → design

| AC | Covered by |
|---|---|
| 1. Server suite runs in the check sandbox with real counts | §3 bridge, §5 wiring, §7 per-run DB, §4 `unitCounts`; setup step 3 makes sure the suite has a handoff command |
| 2. A failing server test fails the handoff and names the test | Existing `failingTestFiles` / `judgeUnit` (`FAIL apps/server/test/x.test.ts`) once the database is reachable; no new code beyond §3 |
| 3. Database stopped or not declared → environment problem naming host:port | §4 `environmentProblem` (forwarder failures, bridge exit 125, `ECONNREFUSED` host:port), `environment` field, refusal text; never `passed` and no FAIL lines |
| 4. Nothing else reachable; sandbox and egress tests green | `--unshare-net` unchanged; a socket only for each allowed declared pair; the forwarder connects to that pair only; §2 refusals; egress proxy untouched |
| 5. Concurrent checks, or a check during regression: no collisions | One network namespace and socket dir per check; `AOM_TEST_RUN_ID` → `aom_test_<id>` created and dropped per run; regression on `aom_test` |
| 6. Regression unchanged | `startRegressionUnits` untouched; no `AOM_TEST_RUN_ID` → `aom_test` exactly as today |
| 7. Documented; doctor shows reachability | §9 docs and setup; §8 doctor lines with a live probe |

## Tests the builder adds

- `apps/runner/test/forward.test.ts` (or next to the existing forward tests): `startServiceForwards` pipes to a
  local TCP server; records a failure for a closed port; closes idempotently and removes the sockets.
- `apps/runner/test/test-services.test.ts`: `decideCheckServices` (builder only; non-Linux refused; runner and
  reserved ports refused; non-loopback refused).
- `apps/runner/test/handoff-checks.test.ts` with a fake spawn and launch:
  - (1) a unit launch receives `{ unit: true }` and the check jobs `{ unit: false }`;
  - (3) forwarder failures → `error` + `environment` + "environment problem" summary; no `introduced`;
  - exit 125 with an `aom-check: environment:` line → environment problem;
  - `ECONNREFUSED 127.0.0.1:5433` with no FAIL lines → environment problem; with FAIL lines → `failed`, as today;
  - an undeclared port → the "not declared" text;
  - `close()` is called after every unit run, also on timeout;
  - `unitCounts` for vitest and jest outputs.
- A `checkLaunch` test (where `RunsManager` is tested): with `services` and network `none`, the argv is wrapped with
  the bridge script and the spec, and `AOM_TEST_RUN_ID` is set; with network `host` or unsandboxed, no wrapper; with
  no services, argv and env are byte-identical to today.
- (2) "any other host:port is still refused": a real bwrap test, skipped when bwrap or socat is missing (the same as
  `claude-sandbox-real.test.ts`). Start a local TCP server on port A and another on port B, run a check with only A
  declared, and assert that connecting to A succeeds and connecting to B is refused.
- (4) parallel checks: `checkRunId` gives different ids for two shifts at the same head and for two calls in one
  shift. The runner test covers the namespace side with two concurrent real-bwrap launches that bind the same port.
- `apps/runner/test/*doctor*` / `sandbox-state.test.ts`: the new handoff-check lines (reachable, not answering,
  non-Linux, socat missing).
- `packages/shared/test/lean-v6.test.ts`: `CheckEvidenceSchema` accepts and strips correctly with and without
  `environment`.
- Server test config has no unit test of its own. The builder runs one server test file with
  `AOM_TEST_RUN_ID=c0test` and checks that the database is created and then dropped, and that a run without it
  still uses `aom_test`.

Manual workstation checks (testers or DevOps, per the card's test plan a–d) cannot run in a build sandbox, so they
are listed for the tester.

## Time budget

- Bridge start-up: under 0.1 s per service (socat listen poll).
- Database: `CREATE DATABASE` (about 0.3 s from `template1`) plus 262 migrations on an empty database. The estimate
  is 5 to 15 s per server unit run. The builder measures it once on the workstation and states it in the handoff and
  in RUNNER.md. If it is over 30 s, the follow-up is a migrated template (`CREATE DATABASE ... TEMPLATE
  aom_test_tpl`, about 1 s). Do not build that now.
- It counts against the existing unit-run budget (`HANDOFF_WORK_BUDGET_MS`, 8 min total). No budget constant changes.

## Risks

- **Broad server changes time out.** `vitest related` on a core server file can select most of the 501 test files
  (the full suite takes about 20 min, files run one after the other). That run times out at handoff, and a `timeout`
  refuses. Today such a run fails fast on the missing database. This is the existing "files changed" policy, but it
  becomes visible now. Not fixed here; I am suggesting a backlog item (a timeout of a large related set reported as
  "left to regression").
- **A failing server test that only logs ECONNREFUSED to another loopback port** could be misread as an environment
  problem. That is why the weak signal applies only when no failing test file is named, and the strong signal comes
  from the runner's own forwarder.
- **socat missing** → a clear environment problem (exit 125), never a test failure.
- **Hosts without unprivileged network namespaces** run checks on the host network: the database is reachable
  directly, so no forwarder is needed. This is documented.
- **Leaked databases** from killed runs: removed by the 12 h sweep (the comment marker), never by name pattern alone.
- **Old server with a new runner**: `environment` is stripped and the summary still says "environment problem".
- No credentials are added anywhere: the URL with test-only values stays in the project's test configuration, as
  today.

## Files to change (summary)

- `apps/runner/src/runs/forward.ts`: `startServiceForwards`.
- `apps/runner/src/sandbox/test-services.ts`: `decideCheckServices`.
- `apps/runner/src/shims.ts`: `CHECK_BRIDGE_SCRIPT`.
- `apps/runner/src/runs/manager.ts`: `checkLaunch` gets `services`, `runId` and returns `forwards`.
- `apps/runner/src/checks/run.ts`: the launch option, `environmentProblem`, refusal text, `close()`, counts.
- `apps/runner/src/checks/units.ts`: `unitCounts`, `checkRunId`.
- `apps/runner/src/shifts/supervisor.ts`: handoff launch wiring and a `runnerPorts` helper.
- `apps/runner/src/adapters/claude-policy.ts`, `apps/runner/src/cli.ts`: doctor lines and the live probe.
- `packages/shared/src/cards/lean-v6.ts`: `CheckEvidence.environment`.
- `apps/server/vitest.config.ts`, `apps/server/test/global-setup.ts`: per-run database.
- `docs/RUNNER.md`, `CONTRIBUTING.md`, `CLAUDE.md` (the `createdb` step is optional now).
- Tests as listed above.
