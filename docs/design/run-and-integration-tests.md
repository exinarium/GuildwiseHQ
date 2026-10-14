# Run a branch (#58) and integration/E2E tests by testers (#59)

Status: design, 2026-10-14. Covers backlog #58 and #59. Touches #9/#10/#13 (workflows), #11/#12 (DevOps requests), #23/#24 (sandbox, toolchains), #53/#55 (hangs). It includes server changes, so the owner must approve it before it is built.

## 1. Decision summary

| # | Decision | Rejected alternatives (one line each) |
|---|---|---|
| D1 | **The DevOps agent works out how to run; the runner runs and supervises.** On the first start (or when the stored plan fails) the workstation's DevOps agent reads `BUILD.md` and the Project settings instructions. It starts every service through `aom run ...`, so the **runner** spawns and supervises the processes, never the Claude session. When all services are healthy, the steps that worked are saved as a **run plan in Guildwise** (never in the repo). Later starts replay the plan with no model call. On failure the runner falls back to DevOps, which repairs the plan and saves a new version. | DevOps starts processes itself (they die or leak with its session, and every start costs a model run); fixed commands only in settings (the owner chose DevOps); plan stored in the repo (leaves a trace). |
| D2 | **Every service runs from its own detached worktree per environment** (`worktrees/<KEY>-<pid>/run-<envSlug>/<repo>`, detached HEAD, no branch created). | Running in the card worktree (build outputs collide with the agent's work and the guard; a tester commit would move the app under test). |
| D3 | **Environments are an operational table plus a few audit events.** Process state, ports and health go in `run_environments`, updated from runner messages. Start, stop and end go out as events, so the chat, notifications and audit see them. Logs are **not stored**: they stream on demand and only a tail is buffered on the runner. | Fully event-sourced status (very noisy); logs in Postgres (volume, and secrets). |
| D4 | **Lifetime is a TTL, not idle detection.** Manual environments stop after N hours (project setting, default 8 h) with an Extend button. Test environments stop when the tester's verdict lands (kept 1 h on failure for inspection). | Idle detection (traffic goes straight to localhost; the runner cannot see it). |
| D5 | **Ports.** Each service declares named ports with a default and, where the app supports it, the environment variable that overrides the port. The default port is used when free; otherwise a port from `runPortRange` (default 20000-29999) is allocated and injected through that variable. Values in `env` can use `${svc.port}` templates. A service whose port cannot be configured limits that project to one environment on the workstation. Starting a second one offers "Stop <branch> and start". | Always random ports (breaks apps with hard-coded cross-service URLs); always fixed ports (no concurrency). |
| D6 | **Testers reach a local environment through per-port forwarders, not the proxy.** The runner listens on one Unix socket per environment port in the tester's tmp dir and connects it only to `127.0.0.1:<that port>`. A sandbox-side wrapper `aom-env <cmd>` starts `socat TCP-LISTEN:<port>,bind=127.0.0.1,fork UNIX-CONNECT:<sock>` for each port inside the command's network namespace, then runs the command. Inside the sandbox `http://localhost:5173` works exactly as on the host (same port numbers, so cookies, CORS and hard-coded URLs keep working), and only the environment's ports are reachable. Needs `allowAllUnixSockets` (already on for testers as a browser role) and `allowLocalBinding` (already on for shell roles). | Adding `localhost` to `allowedDomains` (does nothing: it is in `NO_PROXY`, and the sandbox has its own network namespace); our own proxy via `httpProxyPort` (Chromium always bypasses proxies for loopback, so browser E2E against localhost would still fail). |
| D7 | **Remote environments come from the existing `deploy_targets`**, with new test opt-in columns. The tester's `allowedDomains` gets exactly that target's host(s) (hostname level; the sandbox cannot filter ports). Production targets are never tested. Destructive suites need a per-target opt-in. Private-address targets (for example the 192.168.x UAT) are phase 4 behind a spike, because `NO_PROXY` sends private ranges past the proxy. | A new `test_environments` table (duplicates `deploy_targets`); opening a whole network range (breaks "exactly that host"). |
| D8 | **Integration tests reuse the existing `test` stage**, which is already the tester's E2E stage. `code` v3 adds a skip guard on it (`when {field: integrationTests, equals: true}`); the new card field `integrationTests` is copied from the project setting when the card is specified and can be changed per card. A new stage property, `environment: 'none' or 'project'`, makes any custom stage an environment stage (variants #10, builder #13). | A separate "Integration tests" stage after `test` (two tester stages on every card; `hasTestStage`, regression and the tester bottleneck all key on the id `test`); a new project-setting guard type in the schema (the `when` card field is enough and allows per-card overrides). |
| D9 | **Server-driven provisioning before dispatch.** For an environment stage the dispatcher first asks the runner to start a test environment for the card's commit. It parks the card (candidate query skips it) until the environment is `healthy`, then lets a tester on **that workstation** claim it. If there is no plan or the plan fails, the existing `environment_not_ready` path raises a DevOps request and parks the card (new problems `run_plan_missing` and `run_failed`). | Provisioning inside `shift.start` (the reaper releases a claim not accepted within 30 s); the tester starting the app itself (unsandboxed processes started by a sandboxed agent). |
| D10 | **Branch code runs in a service sandbox.** The runner starts plan steps and services under its own bubblewrap profile: host network (no `--unshare-net`); the same `denyRead` set agents get (`HOME_SECRETS`, the runner data dir); writes only to the run worktree, the shared caches and a run tmp dir. Docker steps (`docker`, `compose`) need the project opt-in "Branch code may use Docker" and are listed as unsandboxed in the UI. | Running unsandboxed (an agent-written `package.json` script or `BUILD.md` would run as the user, bypassing "agents run sandboxed"). |
| D11 | **Secrets stay on the workstation.** Env files are referenced by absolute path on the workstation; the runner reads them and injects their values, and only the path goes to the server. Test accounts for remote targets live in the runner's secret store, are set like `sudo.set` (command payload cleared after delivery), and reach the tester as a 0600 dotenv file (`AOM_ENV_SECRETS_FILE`). Known secret values are redacted from streamed logs and from test evidence before anything leaves the runner. | Credentials in project settings (the server would hold them); credentials as agent environment variables (the env allowlist refuses credential names, and they would be visible to every subprocess). |
| D12 | **Retire `.aom/test-env.json`.** The health URL comes from the run plan. The old file is read for one more runner version and then ignored. | Keep it (a Guildwise trace in user repos). |

## 2. Run definitions

### 2.1 Inputs, in order of precedence
1. **Project settings, "Run instructions"**: `projects.run_instructions` (project-wide) and `project_repos.run_instructions` (per repo). Free text; it overrides `BUILD.md` where they conflict. It is also the fallback when there is no `BUILD.md`.
2. **`BUILD.md`** in the repo. The runner looks first in `project_repos.project_path` (subfolder projects, #7), then at the repo root, case-insensitively. The runner finds the file and puts its content into the DevOps brief; the agent never has to search for it.
3. **Optional structured fields** (Project settings > Run & test > Services, per repo). These pre-fill the plan the agent produces, and the agent may not contradict them: service name, start command, working dir, env file path, ports (name, default, override variable), health check, `after` dependencies.
4. **The repo itself** (README, compose files, package scripts), which DevOps reads when 1 to 3 say nothing.

### 2.2 Run plan schema (`packages/shared/src/runs/plan.ts`, new)
```ts
RunPlan = {
  version: 1,
  repos: [{ repoId, subdir?: string }],
  setup: [{ name, repoId, cwd, cmd: string[], timeoutSec (default 1200), when?: 'always'|'first'|'changed:<glob>' }],
  services: [{
    name, repoId, cwd, cmd: string[], envFile?: string /* absolute path on the workstation */,
    env: Record<string,string> /* no secrets; ${svc.port} templates */,
    ports: [{ name, default: number, envVar?: string, url?: string /* "http://localhost:${port}/" */ }],
    health: { kind:'http', url, expect?: '2xx'|'2xx3xx' } | { kind:'tcp', port } | { kind:'log', regex } | { kind:'none', graceSec },
    startTimeoutSec (default 300), after: string[], stopCmd?: string[], docker: boolean,
  }],
  notes: string, // what DevOps learned, shown in settings
}
```
Validation is shared and also done by the runner: `cwd` must resolve inside the run worktree, `envFile` must be absolute and outside every worktree and the data dir (`fs-safe.ts` style `realpath` checks), and `env` must pass the existing credential-name filter from `toolchain/registry.ts`. `cmd` is an argv array, never run through a shell (the agent can wrap in `bash -lc` explicitly; the UI shows it).

**Fingerprint.** sha256 of `BUILD.md`, the run instructions and the structured fields at the time the plan was saved. If any of these changes, the plan is marked `stale` and the next start goes through DevOps (D1). Changes elsewhere in the repo (manifests and so on) do not: the plan is tried first, and its failure is the signal.

**Scope.** One plan per project and workstation (`run_plans.workstation_id`): env-file paths and toolchains differ by machine. "Copy from <other workstation>" in settings is phase 3.

### 2.3 How DevOps turns instructions into a running environment
DevOps request kind `run`. Origin `card` or `project`; the context carries `cardId`, `projectId`, `envId`. The brief contains the `BUILD.md` content, the run instructions, the structured fields, the current plan if any (with failure logs if it failed), the run worktree paths and the allocated port range. DevOps then:
- `aom run step --env <id> --name "npm ci" --repo web --cwd . -- npm ci`: the runner runs it in the service sandbox, streams the output and records it as a candidate setup step;
- `aom run service --env <id> --name api --repo api --cwd src/Api --port http:5000:ASPNETCORE_HTTP_PORTS --health http://localhost:${port}/health [--env-file ~/.config/acme/api.env] [--after db] -- dotnet run`;
- `aom run status|logs <service>` to diagnose;
- `aom run ready --notes "..."`: the runner checks that every chosen service is healthy, then saves the recorded steps and services as the new plan version (`RunPlanSaved`);
- `aom run fail --reason "..."`: the environment ends as `failed` and the request is done with that reason.

Only the DevOps agent of the environment's workstation may call `aom run step|service|ready|fail`, and only for an environment of its current request.

## 3. Start action: UX and lifecycle

### 3.1 Where
- **Card page**: a "Run this branch" button for cards with a repo and a worktree. The card repo runs at the card branch's local HEAD (card branches stay local, #28); the project's other repos run at their working branch. A service picker is shown when the project has more than one service.
- **Project page**: "Run branch…" dialog with a branch picker per repo (from `known_branches`; the primary repo is chosen first, the others default to their working branch), service checkboxes (`after` dependencies are ticked automatically and greyed out), and a workstation picker (a workstation with a DevOps agent and the repo cloned; default: the user's own).
- **Workstations page**: a "Running environments" list per workstation (all projects) with Stop.
- **Environment panel** (all three places): state, services with state, URL links (`http://localhost:<port>/`), ports, the commit per repo, expiry with **Extend**, **Restart** (same commit), **Update & restart** (fast-forward the run worktree to the branch head), **Stop**, and **Logs** (live tail per service, 500 lines of history).

### 3.2 Who may start and stop
- **Start, restart, extend, stop a manual environment**: project members allowed to send DevOps requests to that workstation. This is the same check as "Ask DevOps" (`commands/devops.ts`): the workstation owner, or a member the workstation is shared with, plus the org owner.
- **Stop** is also allowed to the environment's starter and the workstation owner.
- **Test environments**: started and stopped by the server only. The tester may call `aom env restart` (same commit) and `aom env logs`.
- **Run settings, plans and integration tests**: same permission as the other Project settings.

### 3.3 Concurrency and resources
- At most one **manual** environment per (workstation, project, branch set). Starting again offers Restart.
- Test environments are keyed by (card, commit).
- Workstation cap `runner.maxRunEnvironments` (default 2, counting test environments). A start beyond the cap is refused with the list of running environments.
- Test environments wait in the queue (card parked) rather than evicting manual ones.

### 3.4 Lifecycle and state machine
`requested -> preparing (worktrees, rebase for test environments, setup steps) -> starting (services in `after` order, each waits for health) -> healthy -> stopping -> stopped`, plus `failed` and `degraded` (a service exited after being healthy; it is restarted at most 3 times with backoff, then the environment goes to `failed`).

- **Supervision** (`apps/runner/src/runs/manager.ts`): each service is spawned with `setsid` in its own process group. Logs go to `<data dir>/runs/<envId>/<service>.log` (rotated at 20 MB, 2 files). State goes to `runs/<envId>/state.json` (PIDs with process start times).
- **Stop**: run `stopCmd` if given, then SIGTERM to the process group, SIGKILL after 10 s.
- **Runner restart** (update #1, crash; systemd kills the cgroup): on start the runner re-adopts processes that are still alive (pid and start time match). Otherwise the environment is reported `stopped (runner restarted)`. Phase 3: automatic restart of manual environments from the plan.
- **Cleanup**: on stop the run worktrees of a test environment are removed. A manual environment's worktrees are kept 24 h for fast restarts (incremental builds). `worktrees.sweep` extends to `run-*` folders whose environment the server reports as not live (same conservative rules: no answer means no delete; uncommitted changes are reported, not deleted).
- **Remote access**: URLs are localhost on the workstation. If the browser is on another machine (cloud workstation), the panel shows an `ssh -L <port>:localhost:<port>` hint. Tunnels are out of scope.
- **Chat and notifications**: start, healthy (with URLs), failed (with the log tail) and stopped are posted to the DevOps request's thread, plus a notification to the starter. Test environments post a card note.

### 3.5 Who runs what (owner choice honoured)
| Situation | Runs it |
|---|---|
| First start, no plan / plan stale / plan failed | DevOps shift (request kind `run`), services spawned by the runner via `aom run` |
| Plan exists and is current | runner replays the plan (no model call); falls back to DevOps on any failure |
| Stop / TTL / restart | runner |

## 4. Integration and E2E tests

### 4.1 Project setting (`projects.integration_tests jsonb`, event `ProjectIntegrationTestsSet`)
```ts
{ mode: 'off'|'local'|'remote',
  deployTargetId?: uuid,                 // remote: an existing deploy target with testEnabled
  services?: string[],                   // local: which services to start (default: all in the plan)
  suites: [{ name, repoId, cwd, cmd: string[], kind: 'integration'|'e2e',
             timeoutMin (default 20), destructive: boolean, junit?: string /* report path glob */ }],
  keepOnFailureMin: 60, flakyRetry: 1 }
```
- **Discovery**: when `suites` is empty, the tester reads `TESTING.md`, then `BUILD.md`, then the repo's test config, and runs what it finds. It reports what it ran with `aom env suites propose ...`, which shows up in settings as "Discovered (not confirmed)" with Confirm.
- **Builders and reviewers** run unit tests only. Their handoff names the suites left out (#55 owner decision); there is no change to their sandbox.

### 4.2 Workflow
- **`code` v3** = v2 plus, on stage `test`: `when: { field: 'integrationTests', equals: true }`, `environment: 'project'`, `maxShiftMinutes: 120`. v1 and v2 cards are unchanged.
- **New card field** `integrationTests` (boolean, code field set): set at specify from `mode !== 'off'`; the BA or manager may switch it off per card (for example docs-only cards).
- **Schema**: `StageSchema.environment: z.enum(['none','project']).default('none')`. Variant validation (#10) allows `environment: 'project'` on inserted stages claimed by a role with `shell`. The workflow builder (#13) shows it as the checkbox "Needs a running environment (Run & test settings)". Example custom step: "Smoke test on staging" after finalize, with `environment: 'project'`.
- **Suite and regression cards** (`targetUrl`, `FullSuiteStarted`) use the same environment mechanism: `mode: remote`, or `local` on the working branch.

### 4.3 Provisioning (D9)
1. Dispatcher pass (`dispatcher/candidates.ts`): a queued card at an environment stage with no healthy environment for (card, current commit). The server picks the workstation of the card's worktree (local mode) and inserts `run_environments{purpose:'test', card_id}`. It sends `run.start` with `rebaseCard: true`: the runner runs the existing rebase-on-working-branch step first, so the test stage's `rebaseBefore` finds nothing to do and the environment runs the rebased commit. Candidate filter: `NOT EXISTS (env for card not healthy)` and, once healthy, `workstation_id = env.workstation_id`.
2. `run.status healthy` triggers a pass, and the tester on that workstation claims the card. The shift brief gets `environment: {envId, mode, urls, ports, services, secretsFile?}`.
3. Plan missing or failed: `shift`-less rejection path. `commands/testing.ts` (the existing `environment_not_ready` handler) gets new problems `run_plan_missing` and `run_failed`: it raises a DevOps `run` request with the card in context (#12) and the failure log tail, and parks the card. When DevOps saves the plan and the environment becomes healthy, the card is un-parked.
4. Remote mode: no provisioning. The brief carries the target URL and hosts, and the shift is refused (`environment_not_ready / target_unreachable`) if the runner's own probe of the health URL fails.
5. End: when `TestPassed` or `TestFailed` is appended, or the card leaves the stage, the server sends `run.stop`. On failure it waits `keepOnFailureMin` first, and the card shows "Environment kept until 14:20 [Stop]".

### 4.4 Tester sandbox changes (`apps/runner/src/adapters/claude-policy.ts`)
New `SandboxProfile.environment?: { forwards: {port, socket}[]; hosts: string[] }`:
- **local**: for each environment port the runner creates `<agent tmp>/env/<port>.sock` (listening in the runner, connecting to `127.0.0.1:<port>` only; refused when the environment stops) and sets `AOM_ENV_FORWARDS=5173=<sock>,5000=<sock>`. `allowAllUnixSockets` (already on for testers) and `allowLocalBinding` (on for shell roles) are required; a custom role with `environment` stages gets them through the profile. Ports 3128 and 1080 are refused for services (Claude's in-sandbox proxy bridges).
- **remote**: `allowedDomains = REGISTRY_DOMAINS + target hosts` (D7; see open question Q3 on the registries).
- **`aom-env`** (new script in the runner `bin/`, readable inside the sandbox): starts the forwarders, waits until they listen, runs `"$@"` with `--timeout <min>` enforced (kills its own process group: #55 hang protection, independent of #53), and exits with the command's status. The tester instructions say: "run every command that talks to the app as `aom-env --timeout 20 -- <cmd>`". Both the forwarders and the command live in the same per-command network namespace (Claude wraps each Bash call separately), which is why a wrapper is needed rather than a long-lived forwarder.
- macOS (Seatbelt, no network namespace): phase 4; until then the environment stage is refused there with a clear message.

### 4.5 Remote targets (`deploy_targets` additions)
`test_enabled bool default false`, `production bool default false` (a production target can never be test-enabled: CHECK constraint), `destructive_ok bool default false` (a suite marked `destructive` only runs against a target with this on; otherwise it is skipped and reported `skipped (destructive)`), `test_hosts text[]` (extra hosts, for example a separate API host), `secret_names text[]` (names only).
- Test-account values: set per workstation on the Integrations page (#34) through the durable command `env.secret.set` (payload emptied after the runner answers, like `sudo.set`), or with `aom-runner secrets set target:<id>:<NAME>`.
- Remote mode tests whatever is deployed on the target. Per-card remote testing therefore needs the card branch deployed there first (see Q2).

### 4.6 Results on the card
- `aom test suite --name <n> --status passed|failed|flaky|timeout|skipped --passed N --failed N --skipped N --duration-ms N [--junit <path>] [--log <path>] [--commit]`. The runner parses JUnit for the counts when given and attaches the log (or JUnit) as a card attachment (#21), redacted. The event is `TestSuiteReported`, which feeds the `test_suite_results` table.
- `aom test pass|fail` are unchanged. `pass` is refused while a confirmed, non-skipped suite has no `passed` or `flaky` result in this shift.
- **Flaky**: a failing suite is re-run once (`flakyRetry`). If it then passes it is reported `flaky`, which counts as a pass with a card notice. A suite flaky 3 or more times in 7 days raises a desk notice for the project.
- The card shows a "Integration tests" table: suite, kind, environment (local commit `abc123` / target "staging"), status, counts, duration, log link, plus a link to the environment's logs while it is kept.

### 4.7 Timeouts and hangs (#55, #53)
| Layer | Limit |
|---|---|
| Setup step | `timeoutSec` (default 20 min); the process group is killed |
| Service start | `startTimeoutSec` (default 5 min) to healthy |
| Suite | `timeoutMin` enforced by `aom-env`; status `timeout` |
| Tester shift | stage `maxShiftMinutes` 120; the #53 watchdog when built |
| Environment | TTL (manual), stopped at the verdict (test) |
| Orphans | the environment's processes are never children of the Claude session; the session ends and the runner keeps or stops the environment as above |

## 5. Server, runner, protocol and data changes (all additive)

### 5.1 Migrations
| Number | Content |
|---|---|
| 1880_run_settings.sql | `projects.run_instructions text`, `projects.run_settings jsonb default '{}'` (`ttlHours`, `allowDocker`, structured services), `project_repos.run_instructions text`, `projects.integration_tests jsonb default '{"mode":"off"}'` |
| 1890_run_plans.sql | `run_plans(id, org_id, project_id, workstation_id, version, status 'active'|'stale'|'superseded', plan jsonb, fingerprint, saved_by_agent_id, devops_request_id, created_at)`, unique active per (project, workstation). Projection of `RunPlanSaved`, `RunPlanMarkedStale`, `RunPlanRemoved` |
| 1900_run_environments.sql | **operational**: `run_environments(id, org_id, project_id, workstation_id, purpose 'manual'|'test', card_id, sources jsonb [{repoId, branch, commit}], services text[], state, services_status jsonb, ports jsonb, plan_id, plan_version, requested_by, devops_request_id, created_at, healthy_at, expires_at, stopped_at, stop_reason, last_error)`; partial unique index for live manual environments per (workstation, project, branch-set hash); index on (card_id) |
| 1910_test_suite_results.sql | projection of `TestSuiteReported`: `(id, card_id, shift_id, suite, kind, env_mode, deploy_target_id, commit, status, passed, failed, skipped, duration_ms, attachment_id, event_seq, created_at)` |
| 1920_deploy_targets_testing.sql | the five `deploy_targets` columns in 4.5 |

### 5.2 Events (`packages/shared/src/events/run.ts`, new; audience `project`)
`ProjectRunSettingsSet`, `ProjectIntegrationTestsSet`, `RunPlanSaved {planId, projectId, workstationId, version, plan, fingerprint, requestId}`, `RunPlanMarkedStale`, `RunEnvironmentRequested {envId, purpose, cardId?, sources, services, requestedBy}`, `RunEnvironmentStopRequested {envId, by}`, `RunEnvironmentEnded {envId, reason: 'stopped'|'ttl'|'failed'|'verdict'|'runner_restarted', detail}`, `TestSuiteReported`. `TestEnvProblem` gets `run_plan_missing`, `run_failed`, `target_unreachable`. `DevOpsRequested.context` gains `envId` and `requestKind: 'run'`.

### 5.3 Runner protocol (`packages/shared/src/protocol/runner.ts`)
- **Commands**: `run.start {envId, projectId, purpose, plan|null, sources, services, ports: {range}, ttlAt, rebaseCard?, allowDocker}`, `run.stop {envId}`, `run.extend {envId, ttlAt}`, `run.logs {envId, service, follow: boolean}`, `env.secret.set`.
- **Messages**: `run.status {envId, state, services:[{name, state, ports, urls, health, restarts, exitCode?, lastError?}], at}` (on every change), `run.log {envId, service, lines[]}` (only while a browser follows), `run.plan.saved` (from `aom run ready`).
- **Capability**: `hello.capabilities` gets `runs:1`; the server hides the buttons for workstations without it.
- **`worktrees.query`** answer includes live environment ids for the `run-*` sweep.

### 5.4 Server (`apps/server/src/`)
`commands/runs.ts` (new: start, stop, extend, plan CRUD, authorization), `runner-gateway/handlers.ts` (`run.status`, `run.log`, `run.plan.saved`), `dispatcher/candidates.ts` and `dispatcher/pass.ts` (environment gating and provisioning), `commands/testing.ts` (new problems, suite results, `pass` precondition), `commands/devops.ts` (`run` request kind with brief), `commands/cards.ts` (`integrationTests` at specify), a scheduler tick for TTL expiry, browser WS topic `run:<envId>` for logs and status, REST in `packages/shared/src/api/runs.ts`.

### 5.5 Runner (`apps/runner/src/`)
`runs/manager.ts`, `runs/service-sandbox.ts` (bwrap argv from the `claude-policy.ts` deny lists), `runs/ports.ts`, `runs/discovery.ts` (`BUILD.md`/`TESTING.md`, fingerprint), `runs/forward.ts` (Unix-socket-to-TCP bridges), `runs/redact.ts`, `bin/aom-env`, `aom/aom-cli.ts` (`aom run ...` for DevOps; `aom env info|logs|restart|suites`, `aom test suite` for testers), the IPC handlers, `adapters/claude-policy.ts` (environment profile), `shifts/supervisor.ts` (brief, forwards, secrets file), `testing/environment.ts` (retire `.aom/test-env.json`), `secrets/` (target secrets).

### 5.6 Roles and instructions
The tester role (new version) gets an "Environment" section: `aom env info`, `aom-env`, suites, flaky handling, never printing secrets, `aom env logs` for diagnosing. DevOps gets "Running a project" (the `aom run` workflow, prefer configurable ports, never put secrets in `env`, put env files outside the repo). Builder and reviewer keep "unit tests only; name the suites you left out".

### 5.7 Web (`apps/web/src/`)
`pages/ProjectSettings.tsx`: new "Run & test" tab (`components/runs/RunSettings.tsx`, `RunPlanView.tsx`, `IntegrationTestsSettings.tsx`). `DeployTargetsPanel.tsx` (the test opt-ins). `CardDetail.tsx` (`RunPanel`, `SuiteResults`). Project page `RunBranchDialog.tsx`. `Workstations.tsx` (running environments). `components/runs/RunLogs.tsx`.

## 6. Risks
- **Workstation resources**: several environments plus builds. Mitigated by the cap, TTL and stop-at-verdict; each environment shows its memory use (from `/proc`) in phase 3.
- **Ports**: conflicts with the user's own dev servers. Mitigated by "default port only when free", allocation and the one-environment limit for fixed-port apps; a stale port held by an orphan is detected because the start fails, and shown with its PID.
- **Branch code executing on the host**: mitigated by the service sandbox (D10). Docker breaks the sandbox (the socket is root-equivalent), hence the explicit opt-in; the same applies today when DevOps deploys.
- **Secrets in env files and logs**: only paths reach the server; values are redacted from logs and evidence before leaving the runner. Residual risk: secrets transformed by the app (base64, partial values) are not caught.
- **Destructive suites against remote targets**: per-target `destructive_ok`, production never test-enabled, the default is off, and the UI shows the target name on every run.
- **A tester sees test-account secrets**: they are low-privilege accounts; the network is limited to the target host(s) plus registries (see Q3).
- **Plan replay drifts** (new migration step, new service): the failure falls back to DevOps; the fingerprint catches instruction changes. Cost: one DevOps shift per drift.
- **Unverified technical bets** (spike in phase 1): (a) socat forwarders inside a real tester Bash call, including Playwright Chromium to `localhost:<port>`; (b) whether Node fetch, Playwright's `request` and Chromium honour `HTTPS_PROXY` for remote hosts inside the sandbox (Node needs `NODE_USE_ENV_PROXY=1`, which `aom-env` sets); (c) whether the sandbox proxy accepts an IP literal in `allowedDomains` (needed for private remote targets).
- **The runner self-update stops environments** (systemd cgroup): accepted for the MVP; restart from the plan comes in phase 3.

## 7. Phasing
| Phase | Scope | Size |
|---|---|---|
| **P1 MVP (one builder run)** | Manual start from the card page and the project page through a DevOps `run` request; `aom run step|service|ready|fail`; runner supervision, ports, health, log files; `run.status`; environment panel with URLs, ports, log tail, Stop, TTL and Extend; migrations 1880 and 1900; plan **recorded** (1890, `RunPlanSaved`) but not yet replayed. Spike (a) runs alongside. | server, runner, web: small but cross-cutting |
| P2 | Plan replay with DevOps fallback, fingerprint and stale handling, service sandbox (D10), Docker opt-in, run worktree sweep, Restart and Update & restart | runner-heavy |
| P3 | Integration tests local: `code` v3, `integrationTests` field, `environment` stage property, dispatcher provisioning (D9), forwarders and `aom-env`, `aom test suite`, 1910, suite results UI, flaky handling, retire `.aom/test-env.json`; auto-restart after runner restart | full stack |
| P4 | Remote targets: 1920, secrets, `allowedDomains` per target, destructive guard, private-address targets after spike (c), macOS testers, copy a plan between workstations, tunnel (only if asked) | full stack |

**Status (2026-10-14): P1 is built** (backlog #58). Differences from the table above: `aom run` waits at most about 100 seconds per call
and answers "still running" (exit code 3), because of Claude's Bash time limit; `run.start` is a durable command and the DevOps `run`
request is filed in the same transaction; `projects.integration_tests` is not added yet (P3); services run unsandboxed (P2); the
`run.status` message is not acknowledged but is resent for every environment after each `welcome`; the browser follows logs with
`run.watch`, the server tells the runner with a `run.follow` message (instead of a `run.logs` command). Spike (a) was skipped (P3).

**P2 is built** (backlog #58, capability `runs:2`, migration 1940). Differences and additions: the plan fingerprint is stored as two
hashes on `run_plans` (`build_hash` from the runner, `settings_hash` from the server) so the server can decide to replay without
reading a repository, and the runner re-checks the BUILD.md half after it prepared the worktrees; a stale plan is marked when the
settings are saved or when a start finds the mismatch (`RunPlanMarkedStale`); a failed replay is the acknowledged runner message
`run.replay.failed` (the server files the DevOps request then, with the failure in its context and brief, not at the start);
Restart and Update & restart are the command `run.restart` (event `RunEnvironmentRestarted`); a manual environment with a plan
keeps its run worktrees 24 hours after a stop and Restart revives it; the sweep asks `worktrees.query` about `run-<env>` folders;
services start in a `systemd-run --user --scope` unit when the user manager is reachable (outside the runner service's cgroup).
Phase 3 keeps: automatic restart after a reboot or crash.

## 8. Open questions for the owner
1. **Replay the saved plan, or ask DevOps every time?** You chose the DevOps agent to run the start. The recommendation is that DevOps works out the first start (and any failed one) and saves a plan, and the runner replays it after that: starts take seconds instead of a shift, and there is no model cost. DevOps is still the one who decides how to run the project. Is that acceptable?
2. **Remote mode per card.** A remote target only tests what is deployed on it. Recommendation: per-card integration tests always run **local**; remote targets serve suite, regression and phase follow-up cards (which already deploy first). The alternative is DevOps deploying each card branch to the target before the test, which serializes cards on one target.
3. **"Exactly that host, nothing else" and package registries.** Recommendation: a tester in an environment stage keeps the package registries every shell role has (to install Playwright and test dependencies) plus exactly the environment's ports or host. Strict mode (environment only) breaks `npm ci` in the tester shift unless the builder already installed everything.
4. **Existing projects when `code` v3 ships.** With mode `off` the test stage is skipped. Recommendation: projects that already have a tester hired get mode `local` (the environment is set up by DevOps on first use); all others default to `off`. The alternative is everyone `off` until you switch it on.
5. **Docker for branch code.** Recommendation: off by default per project; switching it on runs Docker-based plans outside the service sandbox, and the UI says so on every environment. Is that the right default?
6. **TTL for manual environments.** Recommendation: 8 hours with Extend, and test environments kept 1 hour after a failure. Different numbers?

## 9. Findings from the code that shaped this design

- The tester sandbox cannot reach the workstation's localhost today: every Bash call runs in its own network namespace
  (`--unshare-net`), the in-sandbox proxy bridges only 3128/1080, and `NO_PROXY` covers localhost and private ranges, so
  `localhost:<port>` hits the sandbox's own empty loopback. `allowedDomains` with `localhost` does nothing (hence D6).
- `allowedDomains` matches hostnames, not ports.
- `.aom/test-env.json` (`apps/runner/src/testing/environment.ts`) is a Guildwise trace in user repos (D12 retires it); the
  reaper's 30 s accept timeout rules out starting an environment inside shift start (D9).
- `deploy_targets` (migration 1303) already exists; remote targets extend it (D7).

## 10. Owner decisions (2026-10-14)

The owner asked to proceed on recommendations unless a question truly needs him. Taken: Q1 DevOps works out the first
start and saves a plan, the runner replays it (DevOps on failure); Q2 per-card integration tests run local, remote
targets serve suite/regression cards; Q3 testers keep package registries plus exactly the environment; Q5 Docker off by
default per project; Q6 TTL 8 h with Extend, failed test environments kept 1 h. **Q4 differs from the recommendation:**
the owner said integration and E2E tests are enabled per project, so every existing project starts with mode `off`
until he switches it on. Production deploys wait for the owner; builds go to local/UAT.

**P3 is built** (backlog #59, capability `runs:3`, migrations 1910 and 1990). Differences and additions: workflow `code` **v4**
(`code` v3 is the manual QA version, see manual-qa.md) carries the guard and `environment: 'project'`; cards on v1 to v3 move to
v4 as Review approves them (`ReviewApproved.workflowVersionId` and `.integrationTests`), a card already in Test or beyond is left alone
(`reviewApprovedPlan`); `integrationTests` is a code card field (`fields.integrationTests`), defaulted from the project setting
at creation and when the review approves a card that never had it, changed per card with `PATCH /api/cards/:id
{integrationTests}` until the Test stage starts. The setting is `projects.integration_tests` (event
`ProjectIntegrationTestsSet`, `GET|PUT /api/projects/:id/integration-tests`, owner only). Provisioning is
`commands/test-environments.ts` called from the dispatcher pass: `run_environments` gets `verdict_at` (the card's verdict was
given: the copy is no longer its to use; kept until `expires_at` after a failure) and `failure_handled`; the candidate query's
`envReady` clause keeps a card at an environment stage back until its environment is healthy on the agent's workstation (not for
suite and regression cards, cards that opted out, projects not in `local` mode, runners without `runs:3`). A failed environment parks the
card on its DevOps request (`TestEnvironmentParked`, `env_parks`) and retries; the third failure is a blocking desk item. The
shift-time problems `run_plan_missing`, `run_failed` and `target_unreachable` are accepted on `shift.rejected`; a tester shift the
runner turned away for a missing environment starts a new one through the DevOps engineer (forced request). `aom test pass` is
refused by the server while a confirmed suite lacks a passing result in the shift (`suitesWithoutPass`); a pass after a failure of the
same suite is recorded as `flaky` (the server counts attempts); a suite flaky three times in seven days raises one desk notice
(`flaky_suite`) per project and suite. Not built in P3: "Update & restart" for a test environment, automatic restart after a reboot
or crash (a test environment that lost its services ends as `runner_restarted` and the card gets a new one).
**Spike (a)** (2026-10-14) passed with a real bubblewrap `--unshare-net` call: `socat` bridging a Unix socket to the host's app,
`curl` and Playwright Chromium reach `http://localhost:<port>` inside it (RUNNER.md, "Integration tests by the tester").

