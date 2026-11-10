# GWP-130: macOS shell roles can connect to any localhost port (`allowLocalBinding`)

## Question

On macOS (Seatbelt), `sandbox.network.allowLocalBinding: true` lets a sandboxed command listen on ports and connect to
**any** localhost port: the runner's IPC HTTP port, databases, debuggers, the Docker TCP API, and so on. The runner sets
it for every role with a shell. Is that already fixed on the working branch? If not, which roles really need it on
macOS, and how do we turn it off for the rest without changing Linux/WSL2 or breaking the `aom` CLI?

## Step 0: what the working branch has today

The working branch is `main` (the project's working branch; `release/1.6.0` is not a separate line here). Checked at
`b648d067`.

| Check | Finding | Evidence |
| --- | --- | --- |
| (a) What `sandboxBlock` sets | `network.allowLocalBinding: shell` for every role, with no platform or role check. `shell` is true when the tool set has `shell`/`bash`. Chat (`buildChatSettings`) and CEO (`buildCeoSettings`, via chat) pass `new Set(['shell'])`, so they get `true` too. Mention work shifts (`buildMentionWorkSettings` → `buildShiftSettings(..., 'mention')`) get `true` when the agent has a shell. Only the DevOps scan overrides it to `false`. Non-scan DevOps is unsandboxed (no `sandbox` block). | `apps/runner/src/adapters/claude-policy.ts:320`, `:396`, `:625`, `:703`, `:758-766`, `:793`, `:813`, `:847-853` |
| (b) How shell roles reach the runner | `aom` is in `sandbox.excludedCommands` for **every** sandboxed role on every platform (`aomExcluded`), so a standalone `aom ...` call runs outside Seatbelt/bubblewrap and does not need loopback from the sandbox. The CLI uses the Unix socket whenever `AOM_IPC_SOCKET` is set (`socketFetch`) and falls back to `AOM_IPC_URL` (TCP `127.0.0.1`) only when the socket fails. The runner starts the socket on every non-Windows platform, macOS included. The socket path is also in `allowUnixSockets`, which Seatbelt honours on macOS, so even an `aom` call that stays sandboxed (piped) reaches the socket on macOS. Nothing in a shift needs the loopback TCP URL from inside the sandbox. | `claude-policy.ts:389`, `:394`, `:475-480`; `apps/runner/src/aom/aom-cli.ts:2935-2966`, `:3042`; `apps/runner/src/ipc/server.ts:54-71`; `apps/runner/src/runner.ts:1161-1162`; env set in `apps/runner/src/shifts/supervisor.ts:1459-1460`, `chat/chat.ts:1015-1016`, `delegate/delegate.ts:410-411` |
| (c) `docs/RUNNER.md` | No section on the macOS loopback trade-off. The `sandbox.network` row only says "`allowLocalBinding` for `shell` roles". The test-services text says macOS Seatbelt has no per-port loopback rule, and the `aom-env` forwarders are "not available on macOS". | `docs/RUNNER.md:1606`, `:2388`, `:2390` |

**Result: not done.** The risk is open on macOS for every shell role, chat and CEO. (b) is already fine: no IPC change
is needed (requirement 5 is met by the current design; the builder adds a test that pins it).

## Findings

### What the key does (Claude Code docs, sandboxing page, read 2026-11-08)

- **macOS:** "set `network.allowLocalBinding` to `true`. Sandboxed commands can then listen on network ports and connect
  to any port on localhost, which includes every other service listening there. A localhost service that doesn't require
  authentication, such as a debugger, can then act for the command outside the sandbox."
  Bind and connect come as a pair. There is no way to allow "listen on my own port" without "connect to every port".
- **Linux and WSL2:** "a sandboxed command's `localhost` is private to that command. The command can listen on a port and
  reach servers it started itself. A direct connection to `localhost` or `127.0.0.1` doesn't reach servers on the host,
  and `allowLocalBinding` has no effect."
- Excluded commands "run unsandboxed". With `allowUnsandboxedCommands: false`, "commands Claude runs are then sandboxed
  unless they match an `excludedCommands` entry". So `aom` keeps running outside the sandbox.
- The sandbox's own proxy stays reachable on macOS whatever this key says ("Seatbelt ... by default blocks connections
  other than the one to the sandbox proxy"). Registries keep working with the key off.

So on Linux the key does nothing either way, and keeping today's value there is free. On macOS, turning it off takes
away two things: (1) connecting to host services on localhost and (2) **listening on any port**, including a server the
command starts itself.

### Who needs local binding on macOS

What a role loses with it off on macOS is any command that opens a loopback listener or connects to one. In practice:

- **Unit test suites that start servers.** These are very common. In this repository alone more than 50 test files call
  `listen(0)`/`createServer(...)` or start the IPC server on `127.0.0.1` (for example
  `apps/runner/test/aom-cli.test.ts`, `runs.test.ts`, `fake-server.ts`, `apps/server/test/media-proxy.test.ts`). A builder
  on macOS without the key could not run the project's own unit tests, which is the core of its stage and a standing
  order ("Write or update tests ... run them before handing off").
- **Dev servers and browsers against the app under test.** On macOS there is no `aom-env` forwarder and no local test
  service opening (both are Linux only: `RUNNER.md:2388`, `test-services.ts:88`). So a direct loopback connection is the
  only way a tester reaches the app on macOS.

Built-in roles (`packages/shared/src/roles/builtin.ts`) and whether they need it:

| Role | Shell | Runs tests / servers / browsers? | macOS decision |
| --- | --- | --- | --- |
| `builder` | yes | yes: runs the unit tests it writes (standing order) | **keep** |
| `reviewer` | yes | no: "you never build or test it", "Never build the project and never run its tests" (`builtin.ts:65`, `:92`); read-only worktree; reads untrusted diffs | off (changed in review: first drafted as keep) |
| `tester` | yes | yes: suites, Playwright, the app under test on localhost | **keep** |
| custom role with `browser: true` (`runsBrowsers`) | yes | yes: browsers against localhost (same reason as tester) | **keep** (via the existing owner-granted flag) |
| `pre_reviewer` | yes | no: "you never build or run tests" (`builtin.ts:296`, `:309`) | off |
| `planner`, `ba` | yes | no: read-only research, `aom` | off |
| `architect` | yes | rarely: may run code in a scratch copy; a loopback-binding suite would fail on macOS (acceptable, see Risks) | off |
| `writer` | yes | no: docs only | off |
| `ceo` (shift and chat) | `aom` only | no | off |
| any chat (`buildChatSettings`) | `aom` only | no | off |
| mention work shift (`roleKey: 'mention'`) | per agent | no: a comment never runs the suite; the server grants no browser | off |
| DevOps scan | yes | no: no network at all | off (already `false`) |
| DevOps (not scan) | n/a | unsandboxed by design | unchanged (no sandbox block) |
| `analyst`, `researcher`, `checker`, `scout`, `curator` | no | n/a | off (already `false`: no shell) |

The allow-list is `builder`, `tester`. The planning note proposed tester and browser roles only. I add builder because
without it unit tests that bind loopback break on macOS. Those are the most common kind in this repo and in typical
Node/.NET/Python projects. The first draft also kept `reviewer` (to match `TEST_SERVICE_ROLES` in
`apps/runner/src/sandbox/test-services.ts:20`), but the built-in reviewer never builds or runs the tests (`builtin.ts:65`,
`:92`) and reads untrusted diffs, so review dropped it, the same reasoning as for `pre_reviewer`. `TEST_SERVICE_ROLES` is
Linux-only and stays as it is.

## Options

| Option | What | For | Against |
| --- | --- | --- | --- |
| A. Leave as is, document only | Keep `true` for all shell roles; add the RUNNER.md section | no code | Every shell role, chat and CEO on macOS keeps reach to every localhost service. Fails AC 2. |
| B. Off on darwin for everyone except tester/browser roles | Planning note's candidate list | smallest list | Builders cannot run loopback-binding unit tests on macOS. That is a real regression of the build stage. |
| **C. Off on darwin except an explicit allow-list: builder, tester, plus roles with `browser: true`** | One constant with a reason per role; platform read at generation time | Closes the hole for planner, BA, architect, reviewer, pre-reviewer, writer, chat, CEO and mentions (the roles that never need it); no stage loses what it needs; Linux unchanged | The test-running roles keep full localhost reach on macOS (inherent to Seatbelt: bind and connect cannot be split). Documented as residual risk. |
| D. Off for everyone on darwin; run tests through DevOps on macOS | Strictest | | Breaks the build/review/test loop on every Mac workstation. Not proportionate. |

## Recommendation

**Option C.** It closes the exposure for every role that has no reason to touch localhost. It keeps the build, review
and test stages working on macOS, leaves Linux/WSL2 byte-identical, and needs no IPC change because `aom` already runs
outside the sandbox and prefers the Unix socket.

## Design

### Files to change

1. `apps/runner/src/adapters/claude-policy.ts` (the only source file).
2. Tests: new `apps/runner/test/macos-local-binding.test.ts`. Existing `claude-args.test.ts`, `tester-sandbox.test.ts`
   and `scan-guard.test.ts` stay as they are and must keep passing.
3. `docs/RUNNER.md`: table row at `:1606`, a new subsection, and one clause at `:2388`.
4. `docs/design/run-and-integration-tests.md` D6 (`:14`) and `:128`: "on for shell roles" becomes "on for shell roles on
   Linux; on macOS for builder, tester and browser roles".

### Code (snippets for the builder)

**Context:** add an injectable platform, following the pattern of `uid` and `tmpEntries`. Production callers never set
it; the runner builds this object itself, so no config key or environment variable reaches it:

```ts
// ClaudePolicyContext
/**
 * The runner's own OS (default `process.platform`, read when the settings are generated). Injectable for tests only:
 * no production caller sets it, and no config key or environment variable feeds it.
 */
platform?: NodeJS.Platform;
```

**Allow-list** (exported so tests and docs can name it):

```ts
/**
 * macOS only (GWP-130). Under Seatbelt, `allowLocalBinding` opens BOTH listening on a port and connecting to ANY localhost
 * port (the runner's IPC TCP endpoint, databases, debuggers, the Docker API, ...); the two cannot be split. On Linux/WSL2
 * the key has no effect (each Bash call has a private network namespace), so it stays as it always was there.
 * On macOS only these roles keep it. Each one runs the project's tests or the app itself:
 */
export const DARWIN_LOCAL_BINDING_ROLES: ReadonlyMap<string, string> = new Map([
  // runs the unit tests it writes; many suites start a server on 127.0.0.1 and connect to it (listen(0), supertest, mock servers)
  ['builder', 'runs the unit tests it writes, which start and connect to loopback servers'],
  // runs the suites and browsers against the app under test on localhost; macOS has no aom-env forwarder or test-service opening
  ['tester', 'runs suites and browsers against the app under test on localhost'],
]);
// A custom role with `browser: true` (runsBrowsers, an owner-granted permission) keeps it for the tester's reason.

/** Whether a shift of this role keeps local binding on macOS. Never a mention: a comment does not run the suite. */
export const keepsLocalBindingOnDarwin = (
  p: Pick<AgentPermissions, 'browser'>,
  roleKey?: string,
): boolean => roleKey !== 'mention' && (runsBrowsers(p, roleKey) || DARWIN_LOCAL_BINDING_ROLES.has(roleKey ?? ''));
```

**Profile:** add one field to `SandboxProfile`, default false:

```ts
export interface SandboxProfile {
  browser: boolean;
  readOnlyWorktree: boolean;
  /** macOS: keeps `allowLocalBinding` (DARWIN_LOCAL_BINDING_ROLES / browser roles). Ignored on Linux. */
  darwinLocalBinding?: boolean;
}
```

**`sandboxBlock` network** (replace `allowLocalBinding: shell` at `:396`):

```ts
// Linux/WSL2: unchanged (the key has no effect there). macOS: only the allow-listed roles (see DARWIN_LOCAL_BINDING_ROLES).
allowLocalBinding: shell && ((ctx.platform ?? process.platform) !== 'darwin' || profile.darwinLocalBinding === true),
```

**`buildShiftSettings`** (`:764`): pass the flag:

```ts
{
  browser: runsBrowsers(p, roleKey),
  readOnlyWorktree: isReadOnlyWorktreeRole(p),
  darwinLocalBinding: keepsLocalBindingOnDarwin(p, roleKey),
}
```

`buildChatSettings` (and so `buildCeoSettings`) uses the default profile, so it gets `false` on darwin with no change.
`buildMentionWorkSettings` passes `'mention'`, so it gets `false`. `scanSandboxBlock` keeps its explicit `false`.
`buildDevopsSettings` (not scan) has no sandbox block. **Do not** touch `allowedDomains`, `allowUnixSockets`,
`allowAllUnixSockets`, `excludedCommands` or the filesystem lists (card constraint: nothing else is widened).

No change in `claude-code.ts`, `ipc/server.ts` or `aom-cli.ts`. The builder checks that `claude-code.ts:~540`, where
the context is built, does **not** pass `platform` (so production always uses `process.platform`).

### Data model / API

No data model, wire or config change. The generated `settings.json` differs only in `sandbox.network.allowLocalBinding`,
only on darwin, and only for roles off the list.

### Expected values (the tests assert these)

| Settings builder / role | linux | darwin |
| --- | --- | --- |
| `buildShiftSettings` builder | true | true |
| `buildShiftSettings` reviewer | true | **false** |
| `buildShiftSettings` tester | true | true |
| `buildShiftSettings` custom role `{browser: true}` with shell | true | true |
| `buildShiftSettings` ba / planner / architect / pre_reviewer / writer | true | **false** |
| `buildShiftSettings` role without shell | false | false |
| `buildMentionWorkSettings` (builder permissions) | true | **false** |
| `buildChatSettings` | true | **false** |
| `buildCeoSettings` / `buildShiftSettings(..., 'ceo')` | true | **false** |
| `buildShiftSettings(..., isDevops=true)` with `readOnlyScan` | false | false |
| `buildShiftSettings(..., isDevops=true)` no scan | no sandbox | no sandbox |

### Tests (new `apps/runner/test/macos-local-binding.test.ts`)

Use `policyCtx`/`POLICY_PATHS` from `test/policy-fixtures.ts` and `BUILTIN_ROLES`, with `policyCtx({ platform })`. The
test is table-driven over `['linux', 'darwin']` and the rows above:

1. Every row of the table, for both platforms (AC 2, 3, 4, 7).
2. Linux snapshot guard: for each built-in role, `buildShiftSettings` with `platform: 'linux'` gives the same
   `allowLocalBinding` as with no platform field on a Linux CI host. Also assert `allowLocalBinding === hasShell` for
   every built-in role on linux, which is exactly today's rule (AC 4).
3. Nothing else changes: for one off-list role (BA), the darwin and linux `sandbox` blocks are deep-equal once
   `network.allowLocalBinding` is removed (constraint: no other setting widened or narrowed).
4. The `aom` route on darwin (AC 5): for an off-list role (BA) and chat, `excludedCommands` still contains `aom` and
   `aom *`, and `allowUnixSockets` equals `[ipcSocket]` when `ipcSocket` is set.
5. `DARWIN_LOCAL_BINDING_ROLES` keys are exactly `builder`, `tester`, and every value is a non-empty reason.
   This pins the list so a widening needs a deliberate test change (AC 3).
6. Run `settingsProblem` (role smoke, `apps/runner/src/health/role-smoke.ts:110`) for every built-in role and expect
   `null`. It checks only permission rules, so it is unaffected, but this pins it (test plan item 3).

Existing asserts that must stay green unchanged: `claude-args.test.ts:359-375` (builder `true`, no-shell `false`),
`tester-sandbox.test.ts:79-83` (tester `true`) and `scan-guard.test.ts:417` (scan `false`). They do not set `platform`.
On a Linux CI they hit the Linux branch. On a Mac developer machine they still pass, because builder and tester are on
the list and the other two are `false` anyway.

Run: `pnpm --filter @aom/runner exec vitest run test/macos-local-binding.test.ts test/claude-args.test.ts
test/tester-sandbox.test.ts test/scan-guard.test.ts` (unit only; `*-real.test.ts` suites need real CLIs and are left
for the testers).

### `docs/RUNNER.md`

- Row `:1606`: replace "`allowLocalBinding` for `shell` roles" with "`allowLocalBinding` for `shell` roles on
  Linux/WSL2 (no effect there); on macOS only for builder, tester and browser roles (see 'macOS: local binding
  per role')".
- New subsection right after the "Effective sandbox state" / `scrubSubprocessEnv` text, before "### Browser roles
  (testers) and Unix sockets":

  > ### macOS: local binding (loopback) per role
  >
  > `sandbox.network.allowLocalBinding` means different things per platform. Under macOS Seatbelt it lets a sandboxed
  > command listen on ports **and connect to any port on localhost**: the runner's IPC HTTP endpoint, databases,
  > debuggers, the Docker API, and any other local service. Seatbelt cannot allow one without the other. On Linux and
  > WSL2 every Bash call has its own network namespace, so `localhost` is private to the command and the key has no
  > effect. The runner keeps it as before there (`true` for shell roles).
  >
  > On macOS the runner sets it only for roles that run the project's tests or the app:
  > builder (its unit tests start and connect to loopback servers), tester (suites and browsers
  > against the app under test; macOS has no `aom-env` forwarder or test-service opening), and any role with
  > `"browser": true`. The list is `DARWIN_LOCAL_BINDING_ROLES` in `claude-policy.ts`. Every other shift, and every chat,
  > CEO session, @mention work and DevOps scan, gets `false`.
  >
  > What a role loses with it off: it cannot start a server on a local port, connect to one, or reach a host service on
  > localhost from its shell. The package registries still work (they go through the sandbox proxy). `aom` still works:
  > it is an excluded command that runs outside the sandbox, and it talks over the Unix socket in `AOM_IPC_SOCKET`.
  >
  > Residual risk: on macOS the builder, tester and browser roles can still reach every localhost service. The
  > runner's IPC endpoint needs the shift's own bearer token. An unauthenticated local service (a debugger, a database
  > without a password, Docker on TCP) is reachable from those shifts. Run the runner as the dedicated unprivileged user
  > recommended below, and do not leave unauthenticated services listening on a Mac that runs agents.

- `:2388`: change "The tester role already has `allowAllUnixSockets` (browsers) and `allowLocalBinding`." to "... and
  `allowLocalBinding` (on macOS see 'macOS: local binding per role')."

### Acceptance criteria → design

| AC | How it is met |
| --- | --- |
| 1. Step 0 recorded with file references | "Step 0" table above; also posted on the card |
| 2. darwin: off-list roles have `allowLocalBinding = false` | `sandboxBlock` network line + `darwinLocalBinding` defaulting false; tests 1 |
| 3. darwin: allow-listed roles keep `true`; list explicit with a reason per role | `DARWIN_LOCAL_BINDING_ROLES` (Map role → reason, plus comment) + `keepsLocalBindingOnDarwin`; tests 1, 5 |
| 4. linux/WSL2 unchanged | Linux branch is `shell`, exactly today's value; tests 1, 2; existing tests unchanged |
| 5. macOS off-list role still runs `aom` | `aom` is an excluded command (unsandboxed) and the CLI prefers `AOM_IPC_SOCKET`, both untouched; test 4. Manual Mac check is outstanding (see Risks) |
| 6. RUNNER.md section | New subsection + row and `:2388` edits |
| 7. Unit tests for darwin and linux, allow-listed and not | `macos-local-binding.test.ts` |

## Risks

- **No Mac in CI or on this workstation.** The darwin branch is tested by injecting `platform`. The real Seatbelt
  behaviour (connection refused for BA, still allowed for builder/tester, `aom card` works from a BA shift) is test plan
  item 4 and stays a manual check until a macOS workstation is available (ask DevOps). The handoff must say so.
- **Architect on macOS** loses loopback for code it runs in a scratch copy. Its instructions already limit running code
  to read-only use. If it bites, the owner can add `architect` to the list with a reason (one line plus a test change).
- **Custom roles** that run tests but do not have `browser: true` lose local binding on macOS. This is deliberate
  (smallest list). The fix is to tick "runs browsers" or to add the role key to the list with a reason.
- **Residual exposure** for the three test-running roles on macOS is inherent to Seatbelt. It is documented, not closed.
- Linux regression risk is nil by construction: the Linux expression reduces to today's `shell`.

## Follow-ups (not in this card)

None required. The IPC TCP endpoint is token-protected and only used as a fallback, so it does not need to be removed
for this card.
