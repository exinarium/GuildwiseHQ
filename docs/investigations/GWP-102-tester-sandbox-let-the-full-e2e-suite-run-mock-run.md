# GWP-102: let the full E2E suite run in the tester sandbox

Status: design, ready to build. Runner only (`apps/runner`). No change to the server, the web app, `packages/shared`, guildwise-cloud or `e2e/**`.

## 1. Questions

1. Why did the GWP-61 approval for Postgres 5433 not open the port in the next tester shift?
2. What in the tester sandbox stops the mock runner that the E2E harness starts?
3. Does the existing test-services setting cover the hosted build (4710) and the Docker-published ports, or must it be extended?
4. Where should a per-shift scratch directory for the suite live, and is it in the write allow-list?
5. How does a tester shift learn which declared service is unreachable, and why?

## 2. Findings

### 2.1 How a tester shift reaches a local port today (GWP-41)

- The project's Owner declares `{name, host, port}` entries (`packages/shared/src/projects/test-services.ts`, stored in `projects.test_services`, set with `PUT /api/projects/:id/test-services` from Project settings).
- When a builder, reviewer or tester claims a card shift, the server sends the list (`apps/server/src/runner-gateway/brief.ts` `testServicesFor`).
- `ShiftSupervisor.decideTestServices` (`supervisor.ts:872`) calls the pure `decideTestServices` (`sandbox/test-services.ts`).
- Each allowed entry becomes one exact `host:port` in `sandbox.network.allowedDomains` (`claude-policy.ts:388`, role-gated again at `:753`). Claude Code's proxy enforces it. `AOM_TEST_SERVICES` is set in the shift env (`supervisor.ts:1450`).
- Every Bash call runs in its own network namespace (bwrap `--unshare-net`) with `NO_PROXY=localhost,127.0.0.1,::1,...`. A host port is therefore reachable only through `aom-env -- <cmd>` (`shims.ts` `AOM_ENV_SCRIPT`). That wrapper starts one `socat TCP-LISTEN:<port>` per entry inside the call and tunnels it through the sandbox proxy.

### 2.2 Why the GWP-61 approval did not reach the tester (question 1)

There are two independent causes. Either one alone gives "Connection refused".

1. **The approval never became a setting.** GWP-61 was answered in the ledger ("Allow the port to open in the sandbox", id 00b22933). A ledger answer changes no project setting, and no code turns an answer into a `test_services` entry. The only way to open a port is the Owner's Project settings > Local test services list. Unless someone entered 5433 there, the server sent no `testServices` and the runner opened nothing. `aom-runner doctor` then prints `test services: none declared ...`.
2. **A plain command never uses the opening.** Even with 5433 declared, `psql`, `curl`, the `pg` driver or Playwright run directly in a Bash call connect to `127.0.0.1:5433` inside an empty network namespace. `NO_PROXY` sends them past the proxy, nothing listens, and the result is ECONNREFUSED or curl exit 7. Only a command wrapped in `aom-env` gets the bridge. Reproduced in this shift's own sandbox, which is built the same way:
   - `curl -sS http://127.0.0.1:4710/` gives exit 7, "Could not connect to server";
   - `NO_PROXY` contains `127.0.0.1`.

These refusal paths also exist. Each one already adds a progress line:

- the runtime is not `claude-code`;
- Claude Code is older than 2.1.229 or its version is unknown;
- the port belongs to a runner run environment. This matters for 4710 if the hosted build is ever started as a runner-managed environment rather than by DevOps;
- the port is already forwarded to the tester's environment.

Conclusion: the setting is read and applied to the tester role correctly. What is missing is (a) the Owner entering the ports and (b) a bridge that every tester command gets, not only `aom-env` ones. Nothing has to be added to the setting for 4710, 5433 or Mailpit: they are fixed loopback ports, which is exactly what it models.

### 2.3 Why the mock runner cannot start (question 2)

- The E2E harness spawns `node apps/runner/dist/aom-runner.mjs start --mock --data-dir <E2E_DIR>/runner` (`e2e/support/runner.ts:53`).
- Process creation is not the problem: the Claude Code sandbox does not block `spawn`. Unix sockets are open for testers (`runsBrowsers` sets `allowAllUnixSockets`), and loopback binding is on (`allowLocalBinding: shell`).
- **The problem is writes outside the allow-list.** A tester's sandbox may write only its cwd, agent home, scratch, TMPDIR (`/tmp/aom-<10 hex>`), the git dirs, the shared caches and `/tmp/.dotnet`. `/tmp` itself is read-only. Reproduced here: `mkdir /tmp/aom-gwp102-probe` gives "Read-only file system".
  - The nested runner puts each mock agent's TMPDIR at a hard-coded `/tmp/aom-<hash>` (`sandbox/sandbox.ts:142` `agentTmpDir`). `ensureSandbox` runs `mkdir(sb.tmp)` (`:187`) at every shift start. So every mock shift fails with a "cannot create" error. Every spec that waits for a mock shift then fails, and its dependent Playwright projects do not run: 12 failed, 273 not run.
  - A run environment's tmp has the same hard-coded root: `runs/manager.ts:1157` `/tmp/aom-run-<env>`.
  - The suite's own `E2E_DIR` defaults to `/tmp/aom-e2e` (`e2e/support/env.ts:5`). That is also not writable. The tester had to set `AOM_E2E_DIR` by hand to get the 75 passes.

### 2.4 Hosted build 4710, Mailpit, Postgres (question 3, item 3)

These are fixed loopback ports. The existing setting covers them. Two things are missing: the Owner's entries, and the bridge for plain commands (2.2).

The Owner should declare all four for GWP. That is an owner action, not code:

| Name | Host:port |
|---|---|
| `postgres-test` | `127.0.0.1:5433` |
| `mailpit-api` | `127.0.0.1:8025` |
| `mailpit-smtp` | `127.0.0.1:1025` |
| `hosted-build` | `127.0.0.1:4710` |

The suite's own server (4601) and any private stack port are bound inside the Bash call. `allowLocalBinding` already allows that, and a browser in the same call reaches them directly. They must **not** be declared: a bridge would occupy the port.

### 2.5 Docker (question 3, item 4)

`deploy-setup-journey.spec.ts` (and `deploy-setup`, `deploy-connect`, `deploy-move`) needs more than the reach side:

- It runs `docker build/run/exec/port/cp`, so it needs the Docker socket. The socket is root-equivalent on the workstation, and it is masked for every tester today: `BROWSER_MASKED` and `HOME_SECRETS` `.docker`.
- It publishes **random** host ports (`127.0.0.1::22`, `::5500`, `::8090`, and a `freePort()` for the registry). An exact `host:port` entry cannot cover these.
- It then reaches those ports over ssh from the runner the spec starts. ssh ignores proxies, so it needs a bridge for a port that is not known in advance.

Extending the setting would mean handing the Docker socket to the tester sandbox and opening a port range. That is the "blanket access" the card forbids. **Recommendation: Docker stays out of every tester sandbox.**

- The four Docker specs run outside the sandbox through DevOps (`aom devops`). DevOps shifts are unsandboxed and have Docker.
- The runner tells the tester shift precisely that Docker is not available in this sandbox and how to get those specs run.
- GWP-103 writes this into the setup procedure.

This is an owner decision. It was asked on the card (non-blocking, option 1 recommended). If the owner chooses the opt-in instead, see 4.7.

### 2.6 Scratch directory (question 4)

- The agent's TMPDIR (`sb.tmp`, `/tmp/aom-<10 hex>`) is already private (0700) and in `allowWrite`.
- It is swept at the end of every shift: `supervisor.ts:648-650` `releaseTmp` + `cleanAgentTmp`, keeping only `node-compile-cache`.
- It is the right per-shift scratch. Using `AOM_SCRATCH` instead would be wrong: that folder is kept for 3 days on purpose.
- The suite only has to be pointed at the TMPDIR.

## 3. Options compared

| Topic | Option | Verdict |
|---|---|---|
| Plain commands reach declared ports | A. Keep `aom-env` only and reword AC1 to `aom-env -- curl` | Fails AC1 and AC2 as written. Every tester keeps tripping on it, which is what happened after GWP-61. |
| | **B. Start the same bridges automatically in every tester Bash call (`BASH_ENV`)** | **Chosen.** The proxy still enforces the exact entries, so editing the script or `AOM_TEST_SERVICES` widens nothing. |
| | C. Drop `--unshare-net` for testers | Rejected: gives every host port. |
| Nested runner tmp | A. `agentTmpDir` uses `os.tmpdir()` | Rejected: it moves every agent tmp on macOS (`/var/folders/...`, long Unix-socket paths) and changes production. |
| | **B. Optional root override `AOM_AGENT_TMP_ROOT` (default `/tmp`), set only in tester shifts** | **Chosen.** Production is byte-identical; only a runner started inside a tester shift reads it. |
| E2E dir | A. The tester exports it by hand | Today's state: easy to forget (GWP-103 documents it anyway). |
| | **B. The runner sets `AOM_E2E_DIR=<tmp>/e2e` in tester shifts** | **Chosen.** Inside the allow-list and swept by the existing cleanup. |
| Docker | **A. Outside the sandbox through DevOps, precise message** | **Recommended** (owner question). |
| | B. Owner opt-in: Docker socket plus port range | Possible later; root-equivalent. Sketch in 4.7. |
| Unreachable service message | **Host-side probe at shift start, plus a settings pointer in every refusal line and the tester note** | **Chosen.** Cheap and runner-side. A client error inside the sandbox cannot be rewritten. |

## 4. Design

### 4.1 Auto-bridge in every tester Bash call

**`apps/runner/src/shims.ts`**

- Factor the `AOM_TEST_SERVICES` block of `AOM_ENV_SCRIPT` into a shared bash fragment `TEST_SERVICE_BRIDGE` used by both scripts:
  - `aom-env` keeps working.
  - a new `bin/aom-bridges.sh` (written by `writeShims`, mode 0644, meant to be sourced) contains only the fragment.
- The fragment must:
  - **be idempotent**: skip a port that already has a listener (the existing `/proc/net/tcp(6)` check). `aom-env` inside an auto-bridged call, or a nested `bash script.sh`, must not fail or start a second socat;
  - **guard the whole fragment** with `[ -n "${AOM_TEST_SERVICES:-}" ] && [ "${AOM_BRIDGES_PID:-}" != "$$" ]`, and export a marker after starting. Also skip silently when `socat` or the proxy is missing. In sourced mode it must print nothing on the success path, so command output does not change;
  - **detach socat completely**: `</dev/null >/dev/null 2>&1 &`. Otherwise the Bash tool waits for the inherited pipe and hangs;
  - **never leak socat processes**: start each socat with `setpriv --pdeathsig KILL` when `setpriv` exists, so it dies with the shell. Do not install an `EXIT` trap in the sourced file: it would replace the user command's own trap. `aom-env` keeps its own trap;
  - **keep the bounded wait** for the listener (at most about 5 s per port, normally under 100 ms). A command that connects at once must not race the bridge.

**`apps/runner/src/shifts/supervisor.ts`**, next to line 1451

When `testSpec` is set **and** `msg.agent.roleKey === 'tester'`, also set:

```ts
s.env.BASH_ENV = join(paths.bin, 'aom-bridges.sh');
```

- Builders and reviewers keep exactly today's env. They still use `aom-env`. This keeps non-tester shifts unchanged; widening to them later is a one-line change.
- `paths.bin` is already readable in the sandbox (`aomReadPaths`) and not writable.

**Verification required during build.** Bash reads `BASH_ENV` for non-interactive shells, login or not. Claude Code runs each command as a child of its own process, so the variable is inherited.

- The unit test proves the fragment: `bash -c 'curl ...'` with `BASH_ENV` set and a fake proxy, reusing the harness in `apps/runner/test/test-services.test.ts:282-390`.
- Test plan step 2 proves the Claude Code path on a workstation.
- If Claude Code strips `BASH_ENV`, the fallback is the agent home's `.bashrc`/`.bash_profile` written for tester shifts only, with the same fragment. Say in the handoff which one worked.

### 4.2 Nested runner tmp root (mock runner start)

**`apps/runner/src/sandbox/sandbox.ts`**

```ts
/** Root of the agents' short tmp dirs: `/tmp`, or `AOM_AGENT_TMP_ROOT` (a runner started inside a tester shift). */
export function agentTmpRoot(env: NodeJS.ProcessEnv = process.env): string {
  const r = env.AOM_AGENT_TMP_ROOT;
  return r && isAbsolute(r) ? r : '/tmp';
}
// agentTmpDir: `${agentTmpRoot()}/aom-${h.slice(0, 10)}` (POSIX). Windows is unchanged.
```

- Use the same root in `runs/manager.ts:1157` (`/tmp/aom-run-<env>` becomes `<root>/aom-run-<env>`).
- `cleanAgentTmp`'s safety checks still hold: the last segment is `aom-*`.
- `ensureDotnetShm` stays `/tmp/.dotnet`. It already swallows a failure, and the outer sandbox lets `/tmp/.dotnet` be written.

**`supervisor.ts`**: for tester shifts only, set

```ts
AOM_AGENT_TMP_ROOT = join(sandbox.tmp, 'e2e', 'agent-tmp')   // mkdir -p before start
```

- The outer runner never reads its shift's env, so production paths stay `/tmp/aom-*`.
- Keep the path short: Unix socket paths have a limit of about 108 bytes. `/tmp/aom-<10>/e2e/agent-tmp/aom-<10>/...` is fine.
- Do not add more directory levels.

### 4.3 Per-shift E2E scratch

For tester shifts, in the same block (create the directory before start):

| Variable | Value |
|---|---|
| `AOM_E2E_DIR` | `<sandbox.tmp>/e2e` |
| `PLAYWRIGHT_HTML_OUTPUT_DIR` | `<sandbox.tmp>/e2e/playwright-report` |

- Both are swept by the existing end-of-shift `cleanAgentTmp`. Nothing new to clean.
- Playwright's `outputDir` (traces, `test-results`) has no environment variable. The tester note (4.4) tells the tester to pass `--output "$AOM_E2E_DIR/test-results"`, and GWP-103's procedure repeats it.
- Do not edit `e2e/**`: testers own it, and the guard rejects builder edits.

### 4.4 Messages: name the port and the setting

**`sandbox/test-services.ts`**, all pure:

- Add `export const TEST_SERVICES_SETTING = 'Project settings > Local test services';`.
- `refusedProgress` ends with `... not opened: <reason>. The project Owner changes this in ${TEST_SERVICES_SETTING}.`
- `testServicesNote`:
  - When something is allowed: say that **in a tester shift every Bash command reaches them directly** (no `aom-env` needed), and that `aom-env` remains for builders and reviewers. Pass the role in as a parameter.
  - Always add one line: "Any other local port is closed in this shift (connection refused). Only the project Owner can open one, in Project settings > Local test services. You cannot open it yourself."
- New `noTestServicesNote()` for a **tester** shift whose project declared nothing. It says that only the suite's own ports in the same Bash call are reachable, and where the Owner declares a service. The supervisor appends it only when `roleKey === 'tester'` and `msg.testServices` is empty. Other roles: unchanged, empty.
- New `testerScratchNote(e2eDir)` (tester only): `AOM_E2E_DIR`, `--output "$AOM_E2E_DIR/test-results"`, "swept when the shift ends", and the Docker line:
  > Docker is not available in this sandbox; specs that run docker (deploy-setup-journey, deploy-setup, deploy-connect, deploy-move) are run by DevOps: ask with `aom devops`.

  Keep the runner generic: the spec names come from the instructions, not from hard-coded logic. A one-line list in the note is acceptable. Better: the generic sentence "specs that run docker" without names, so the runner does not encode this repository's file names.

**Reachability probe**:

- `supervisor.ts`, after `decideTestServices`: for each **allowed** service, the runner (outside the sandbox) tries `net.connect(host, port)` with a 1 s timeout, all in parallel, so it costs at most about 1 s per shift start.
- Make the probe injectable for tests: `deps.probePort?` defaulting to a small `probeLocalPort` helper in `sandbox/test-services.ts` or a sibling file.
- For one that does not answer:
  - add a progress line `Local test service hosted-build (127.0.0.1:4710) is declared in Project settings > Local test services but nothing answers on this workstation: start it or ask DevOps (aom devops).`
  - add the same sentence to the note.
- Record `answering: false` on the decision, as an optional field on the allowed variant of `TestServiceDecision`, so the doctor shows it:
  - `testServiceDoctorLines`: `warn test service: GWP hosted-build 127.0.0.1:4710 opened but not answering (as of ...)`.
- The doctor already lists what is open per project (AC7 doctor part). Keep that wording, and append the setting name to refused lines.

### 4.5 What must not change

- Non-tester shifts: no `BASH_ENV`, no `AOM_AGENT_TMP_ROOT`, no `AOM_E2E_DIR`, same note text for builder and reviewer, apart from the added settings pointer on refused lines, which is wording only.
- With no declared services, the generated `settings.json` stays byte-identical (existing test `test-services.test.ts:192`).
- `allowedDomains` gets only exact `host:port` entries. Nothing new opens in the policy: this card adds **no** domain, no Unix-socket change and no write path beyond the tester's own TMPDIR.
- Production runner paths (`/tmp/aom-*`, `/tmp/aom-run-*`) are unchanged when `AOM_AGENT_TMP_ROOT` is unset.

### 4.6 Data model and API

No change: no `LocalTestService` field, no migration, no server route, no web UI. The setting already models fixed loopback ports. The `answering` flag lives only in the runner's `status.json` (`TestServicesSeen`, runner-local type).

### 4.7 If the owner chooses the Docker opt-in instead (not to build unless answered so)

- Add `docker?: { enabled: boolean; publishedPorts: { from: number; to: number } }` to the project setting. Shared schema, server command and route, `TestServicesPanel`, Owner only.
- Tester shifts: unmask `/var/run/docker.sock` only, keep `.docker` masked, and bridge each port in the range like a test service, in both `allowedDomains` and the auto-bridge.
- The four specs must publish into the declared range: an e2e change for the tester.
- This is a separate card. It should not block this one.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Claude Code does not pass `BASH_ENV` to its Bash tool | Fallback in 4.1 (agent home rc file, tester only). Test plan step 2 is the gate. |
| A socat bridge left running after the Bash call ends | `setpriv --pdeathsig KILL`. A unit test checks that no socat remains after `bash -c true` (look for the listener in `/proc/net/tcp` or by pid). |
| A declared port equals a port the suite binds itself (the bridge takes it first) | The note says not to declare suite ports. The bridge skips a port that is already listening, but it starts first, so the Owner list must not contain 4601 or the private stack ports. |
| 4710 is refused as "belongs to the runner" if the hosted build is started as a runner run environment | Report shows the reason. DevOps starts it as a plain container today (`gwp98-app`), so no conflict. |
| Wait time added to every Bash call | One `/proc` read per port when bridges are up. Under 100 ms with 4 ports. Zero for non-tester shifts. |
| Owner never fills the setting | Not code. The handoff must say the Owner has to enter the four entries in 2.4; nothing opens without them. |

The fix reaches a workstation only after a runner release that contains it is installed. Say so in the card's result.

## 6. Acceptance criteria mapped to the design

| AC | How it is met | Test |
|---|---|---|
| 1. `curl -sS http://127.0.0.1:4710/` connects in a tester shift when 4710 is declared | Owner entry (2.4) + exact `allowedDomains` entry (existing) + auto-bridge via `BASH_ENV` (4.1) | Unit: fragment with fake proxy, `bash -c 'curl ...'` without `aom-env` reaches the declared port. Manual: test plan 2 |
| 2. Declared port (5433) reachable from shell and Playwright; undeclared stays closed | Same bridge, inherited by every child of the Bash call. Undeclared: no listener in the namespace, and the proxy refuses it anyway | Unit: declared reachable, undeclared refused (proxy 403 or no listener); policy has only exact entries |
| 3. Mock runner starts without "cannot create" | `AOM_AGENT_TMP_ROOT` (4.2) + `AOM_E2E_DIR` (4.3) | Unit: `agentTmpDir` honours the root (absolute only) and defaults to `/tmp`; `ensureSandbox` creates under the root; tester shift env carries both inside `sandbox.tmp`; non-tester env does not |
| 4. Suite binds its private app port; the browser loads it | Already allowed (`allowLocalBinding`, same Bash call). Now no longer masked by the mock-runner failure | Unit: the tester policy keeps `allowLocalBinding: true` and `allowAllUnixSockets`. Manual: full run |
| 5. deploy-setup-journey reaches its Docker port | Per owner answer. Recommended: outside the sandbox through DevOps, with a precise tester message (2.5, 4.4) | Unit: the tester note contains the Docker line. Manual: test plan 4 through DevOps. **Not met as written unless the owner picks the opt-in (4.7)** |
| 6. Playwright output, traces and mock runner files in a per-shift scratch dir, swept at the end | `<tmp>/e2e`, `PLAYWRIGHT_HTML_OUTPUT_DIR`, `--output` in the note; swept by the existing `cleanAgentTmp` | Unit: env paths are inside `sandbox.tmp`; `cleanAgentTmp` removes `e2e/` and keeps `node-compile-cache` |
| 7. Ports only through the owner setting; the tester cannot widen; doctor lists what is open | No code path adds a port. The proxy enforces `settings.json`, which the agent cannot write (`denyWithinAllow`). Editing `AOM_TEST_SERVICES` or the script opens nothing. Doctor lines exist (+ answering flag) | Unit: a tester changing `AOM_TEST_SERVICES` to an undeclared port gets no connection (proxy refuses); doctor lines |
| 8. Unreachable declared service is named, with the setting | Refused: `refusedProgress` + setting pointer. Allowed but down: host-side probe line. Undeclared: the note line | Unit: messages contain the name, `host:port` and `Project settings > Local test services`; probe stub false gives a progress line and a note |
| 9. Full suite in a tester shift: no sandbox-caused failures; counts compared with 154/5/19/201 | All of the above, minus Docker (2.5) | Manual: test plan 3 (tester). Record the counts; the 4 Docker specs are reported separately |
| 10. Unit tests: setting gives the opened ports, undeclared closed, mock spawn allowed | The tests above | `apps/runner/test/test-services.test.ts` (+ a sandbox tmp-root test file) |

Out of scope, as the card says: seeded users, HSTS proxy and the written procedure (GWP-103), and the four failures that also happen outside the sandbox.

## 7. Files to change

- `apps/runner/src/shims.ts`: shared bridge fragment, `bin/aom-bridges.sh`, `aom-env` idempotent.
- `apps/runner/src/shifts/supervisor.ts`: tester-only env (`BASH_ENV`, `AOM_AGENT_TMP_ROOT`, `AOM_E2E_DIR`, `PLAYWRIGHT_HTML_OUTPUT_DIR`), mkdirs, notes, reachability probe.
- `apps/runner/src/sandbox/test-services.ts`: setting pointer, notes, `answering`, probe helper.
- `apps/runner/src/sandbox/sandbox.ts`: `agentTmpRoot`, `agentTmpDir`.
- `apps/runner/src/runs/manager.ts`: run tmp root.
- `apps/runner/src/adapters/claude-policy.ts`: `testServiceDoctorLines` answering and refused-line pointer only. Do not touch `sandboxBlock`.
- `docs/RUNNER.md`, section "Local test services": the auto-bridge for testers, the tmp root, the E2E scratch, Docker not available in tester sandboxes.
- Tests: `apps/runner/test/test-services.test.ts`, plus a new `apps/runner/test/agent-tmp-root.test.ts`.
