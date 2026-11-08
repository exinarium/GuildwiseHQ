# GWP-152: Local test services for the Gemini CLI, opencode and Codex runtimes

Base checked: release/1.6.0 (b648d067), which is contained in the card branch head (02d3b1c6).

## The question

Since GWP-41, a builder, reviewer or tester shift on Claude Code can reach the project's declared loopback test services
(`127.0.0.1:5433` and the like): each allowed service becomes one exact `host:port` entry in Claude Code's sandbox
`allowedDomains`, and `aom-env` tunnels a local `socat` listener through that sandbox's proxy. Shifts on the harness
runtimes (Gemini CLI, opencode, Codex in the runner's bubblewrap box) are told the service is "not reachable with the
<runtime> runtime". The card asks to map the same decision onto the runner's own egress proxy, as exact `host:port`
entries kept apart from `privateEndpoints`, so `aom-env`'s tunnel through the box bridge on `127.0.0.1:3128` works there
too.

## Requirement 0: what release/1.6.0 already does

| Point | State on release/1.6.0 | Evidence |
|---|---|---|
| 1. The harness shift gets the same decided list | **Half there.** The supervisor already decides once and passes `testServiceDomains` in `ShiftStartInput` to *every* adapter (`supervisor.ts:1583`, `adapters/types.ts:133`). But the decision itself refuses every runtime except `claude-code` (`test-services.ts:86`), so for a harness runtime the list is always empty, and the three harness adapters ignore the field anyway. | `decideTestServices`, `GeminiAdapter.run` (`gemini.ts:967`), `OpencodeAdapter.run` (`opencode.ts:~480`), `CodexAdapter.runHarness` (`codex.ts:1248`) |
| 2. A separate exact `host:port` field on the egress proxy | **Missing.** `EgressProxyOptions` has `privateEndpoints` only; `HarnessLaunch` too. | `egress-proxy.ts:42`, `harness-session.ts:29` |
| 3. Exact host and port matching, everything else refused and logged | **Missing.** A CONNECT to a loopback address is refused twice: the port is not 80/443 (`portOk`) and `publicAddress` refuses loopback outside a route. | `egress-proxy.ts:120-133`, `:267-271` |
| 4. `aom-env` reaches the service end to end | **Missing**, for the reasons above. The rest of the path already exists: `AOM_TEST_SERVICES` is in the shift env for every runtime when the list is non-empty (`supervisor.ts:1507`) and the three adapters forward the whole env to the CLI and its shell; `HTTPS_PROXY=http://127.0.0.1:3128` (no credential) matches `TEST_SERVICE_BRIDGE`'s proxy pattern; `socat` is a precondition of the harness sandbox (`probeHarnessSandbox`); `setpriv` and `/proc/net/tcp` exist in the box. | `shims.ts:40-75`, `harness-sandbox.ts:288-331` |
| 5. Note, progress and doctor lines correct for harness runtimes | **Missing**, but only because of point 1. `testServicesNote`, `refusedProgress`, `notAnsweringLine` and the doctor lines are runtime-neutral: they print whatever the decision says. Fixing the decision fixes them. | `test-services.ts:131-170`, `supervisor.ts:1413-1425` |
| 6. No declared services: nothing changes | **Holds today** and must keep holding: `decideTestServices` returns `[]` for an empty list, so nothing is added. | `test-services.ts:76` |

Conclusion: the card is **not** done; build points 1 to 5. Point 6 is a regression guard.

## Findings that shape the design

1. **The wiring to the adapters is already there.** `ShiftStartInput.testServiceDomains` reaches every adapter. No new
   supervisor-to-adapter plumbing is needed: the harness adapters read the field and hand it to `launchInHarnessSandbox`.
   This answers the planner's open point (a).
2. **Codex is not always a harness runtime.** `CodexAdapter.sandboxKind()` is `harness` on Linux by default but `native`
   on macOS or when the owner sets `sandbox: native`; then Codex uses its own permission profile and there is no egress
   proxy at all. Gemini CLI and opencode always run in the harness box. So the decision cannot be keyed on the runtime
   name alone: it needs to know whether the runtime's shell goes through the runner's egress proxy.
3. **`claudeVersion` is the adapter's version, not Claude Code's.** The supervisor fills `claudeVersion` from
   `adapter.capabilities().version`; for Gemini that is the Gemini CLI version. The Claude Code minimum-version gate
   must therefore apply to the Claude Code path only. For the harness path the equivalent gate is the harness sandbox
   probe itself (`capabilities().sandbox === 'enforced'`, which already requires Linux, bubblewrap and socat). The runner
   owns the proxy, so there is no third-party version to check.
4. **The whole harness box shares one network namespace.** Unlike Claude Code (one namespace per Bash call), every
   command the CLI starts sees the same loopback. The bridge on `127.0.0.1:3128` lives there, and `aom-env` (or the
   tester's `BASH_ENV` bridge) starts its `socat` listener there. The nested shim sandbox does not unshare the network.
   `RESERVED_RUN_PORTS` (3128, 1080) already keeps a declared port off the bridge port.
5. **How a refusal is "logged" in the egress proxy.** `deny(host)` adds the host to `proxy.denied()` and calls `onDeny`
   once per host. No harness adapter sets `onDeny` today. "Logged the same way as other refusals" therefore means: the
   refusal goes through the same `deny()` call, and nothing new is invented.
6. **WHATWG URL quirk.** `new URL('http://[::1]:6379/').hostname` is `[::1]` (with brackets), while `parseHostPort` on a
   CONNECT target strips them. The matcher must normalise both forms the same way.
7. **Ledger constraints.** GWP-102: random host ports cannot be covered by exact entries; do not try. Earlier
   `out_of_scope_test_change` decisions (GWP-1, GWP-3, GWP-15): a modified existing test file whose full path is not in the
   card's Affected areas trips the flag. Only `apps/runner/test/test-services.test.ts` is named by full path here, so new
   tests go into **new** test files (the AC also says the existing egress-proxy and private-endpoint tests pass
   *unchanged*).

## Options compared

### A. Where the "harness may have test services" rule lives

| Option | For | Against |
|---|---|---|
| A1. A list of runtime names (`gemini`, `opencode`, `codex`) in `test-services.ts` | Simple | Wrong for Codex on macOS or `sandbox: native`: it would be told "reachable" when nothing is opened |
| **A2. The adapter says whether its shell goes through the egress proxy** (new optional `RuntimeAdapter.usesEgressProxy?(): boolean`), passed into `decideTestServices` as `egressProxy` | Correct for Codex in both modes; no wire or server change; the decision stays one pure function | One more optional adapter method |
| A3. A new field on `RuntimeCapabilities` | Visible in status | `RuntimeCapabilities` is reported to the server; adding a field there is a wider change than the card allows |

**Recommendation: A2.**

### B. How the proxy lets a declared entry through

| Option | For | Against |
|---|---|---|
| B1. Put the entries into `privateEndpoints` | No new code path | Forbidden by the card: it widens `privateEndpoints` and the org credential endpoint check (`orgCredentialEndpointProblem` reads that list) |
| B2. Add the entries to `allowedHosts` and relax `portOk`/`publicAddress` | Small diff | `allowedHosts` is host-only (any port 80/443) and `publicAddress` would need a loopback exemption that is easy to get wrong for other destinations |
| **B3. A separate `testServices` option with its own exact matcher, checked before the existing checks and bypassing only `publicAddress` for a hit** | The privateEndpoints path, `publicAddress`, `hostAllowed` and the org guard are untouched; a non-hit falls through to exactly today's code | A second branch in the CONNECT and plain-HTTP handlers |

**Recommendation: B3.**

### C. Where the in-box listener comes from

| Option | For | Against |
|---|---|---|
| **C1. Keep `aom-env` / `BASH_ENV` as they are** (they already read `AOM_TEST_SERVICES` and `HTTPS_PROXY`) | No shim change; the card names this path; same behaviour and instructions as Claude Code | Shared network namespace: if two commands run at the same time, the second skips starting a listener (it sees the first one's), and loses it when the first command ends. Rare (needs parallel tool calls); a re-run works |
| C2. Start one listener per service at box level in `wrapInHarnessSandbox` (next to the bridge), alive for the whole session | No race; services reachable without `aom-env` | Changes the box's launcher, which the card asks to leave alone apart from the proxy; makes builders' and reviewers' reach differ from Claude Code's |

**Recommendation: C1** for this card. Record the concurrency edge as a known limitation and offer C2 as a backlog
suggestion.

## Design

### 1. `apps/runner/src/sandbox/test-services.ts`

- `TestServiceInput` gets `egressProxy?: boolean`: "the runtime's CLI and its shell reach the network only through the
  runner's egress proxy (the harness box)".
- The shift-wide check becomes runtime-aware. The Claude Code branch stays exactly as it is:

```ts
const path = i.runtime === 'claude-code' ? 'claude' : i.egressProxy ? 'egress' : undefined;
const shiftWide = !i.hasShell
  ? 'this role has no shell'
  : path === undefined
    ? `not reachable with the ${i.runtime} runtime (no per-port opening there)`
    : i.platform !== 'linux' || i.sandbox !== 'enforced'
      ? "this platform's sandbox cannot open a single loopback port; nothing was opened"
      : path === 'claude' && !versionAtLeast(i.claudeVersion, MIN_CLAUDE_FOR_TEST_SERVICES)
        ? `Claude Code ${i.claudeVersion ?? '(unknown version)'} cannot limit the sandbox to one port (needs ${MIN_CLAUDE_FOR_TEST_SERVICES} or newer)`
        : null;
```

  The per-port checks (host, port range, runner ports, environment forward ports, reserved proxy ports) are unchanged
  and so give the same refusals, with the same reasons, for both paths.
- Update the module comment: the opening is an `allowedDomains` entry for Claude Code, and a `testServices` entry of the
  egress proxy for the harness runtimes.

### 2. `apps/runner/src/adapters/types.ts`, the three adapters, the supervisor

- `RuntimeAdapter` gets an optional `usesEgressProxy?(): boolean`.
  - `GeminiAdapter`, `OpencodeAdapter`: `return true`.
  - `CodexAdapter`: `return this.sandboxKind() === 'harness'`.
  - Claude Code, direct-model, mock: not implemented (undefined, so false).
- `ShiftSupervisor.decideTestServices` (`supervisor.ts:917`) passes
  `egressProxy: adapter?.usesEgressProxy?.() === true`. Nothing else in the supervisor changes: `testServiceDomains`,
  `AOM_TEST_SERVICES`, the note, the progress lines, `recordTestServices` and the doctor already follow the decision.

### 3. `apps/runner/src/adapters/harness-session.ts`

- `HarnessLaunch` gets `testServices?: string[]`: "the shift's local test services, exact `host:port` entries
  (`testServiceDomain` form), kept apart from `privateEndpoints`".
- `launchInHarnessSandbox` passes it next to `privateEndpoints`:

```ts
...(l.privateEndpoints?.length ? { privateEndpoints: l.privateEndpoints } : {}),
...(l.testServices?.length ? { testServices: l.testServices } : {}),
```

- A small shared helper keeps the three adapters identical (and repeats the role filter that `claude-policy.ts:757`
  does for Claude Code, as defence in depth):

```ts
/** The shift's test services for the egress proxy: a card shift of a builder, reviewer or tester only, never a chat. */
export function harnessTestServices(
  input: { testServiceDomains?: string[] } | object,
  roleKey: string,
  chat: boolean,
): string[] | undefined {
  const list = 'testServiceDomains' in input ? input.testServiceDomains : undefined;
  return !chat && TEST_SERVICE_ROLES.has(roleKey) && list?.length ? list : undefined;
}
```

### 4. `gemini.ts` (~978), `opencode.ts` (~486), `codex.ts` (~1257, `runHarness` only)

Next to the existing `privateEndpoints` line, in each `launch` object:

```ts
...(() => { const t = harnessTestServices(input, opts.roleKey, opts.chat); return t ? { testServices: t } : {}; })(),
```

(or an equivalent local `const`). Codex's native path (`buildCodexCommand` with a profile) gets nothing: its decision
already refused the services because `usesEgressProxy()` is false there.

### 5. `apps/runner/src/sandbox/egress-proxy.ts`

New option, documented as separate from `privateEndpoints`:

```ts
/**
 * The shift's local test services (GWP-41): exact loopback `host:port` entries (`127.0.0.1:5433`, `[::1]:6379`,
 * `localhost:4000`). A CONNECT or plain request to exactly one of them is let through to this machine; any other port,
 * host or loopback address is refused as before. Never read by the private-endpoint or org credential checks.
 */
testServices?: string[];
```

New exported matcher (uses `normaliseTestServiceHost`, `isTestServiceHost`, `testServiceDomain` from `@aom/shared`):

```ts
/** True only when host and port both exactly match an entry. No wildcard, range or whole-host form exists. */
export function testServiceListed(host: string, port: number, entries: readonly string[]): boolean {
  if (entries.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const h = normaliseTestServiceHost(host); // lower-case, `[::1]` -> `::1`
  if (!isTestServiceHost(h)) return false; // 127.0.0.2, 0x7f.1, ::ffff:127.0.0.1, localhost., 10.x: never
  return entries.includes(testServiceDomain({ host: h, port }));
}
```

At `startEgressProxy` start, canonicalise the entries once and drop anything that is not a loopback test-service host
with a valid port (parse with `parseHostPort`, then rebuild with `testServiceDomain`). So a stray `10.0.0.5:5432`,
`*:5433` or bare `127.0.0.1` in the list can never open anything.

CONNECT handler (`:267`): check the test-service entry first; a hit connects straight to the loopback literal and skips
`publicAddress` (which would refuse loopback). A miss runs today's code unchanged.

```ts
const ts = !!hp && testServiceListed(hp.host, hp.port, testServices);
if (ts && hp) return tunnel(normaliseTestServiceHost(hp.host), hp.port); // 127.0.0.1 | ::1 | localhost
const listed = !!hp && endpointListed(hp.host, hp.port, o.privateEndpoints ?? []);
... // unchanged
```

`tunnel(ip, port)` is the existing `netConnect` / `200 Connection Established` / pipe block, pulled out so both paths
use it. `localhost` is connected by name with `net.connect`, the same call `probeLocalPort` makes at shift start, so
"answering" and "reachable" agree. `o.resolve` (the test hook) is never used for a test-service hit.

Plain HTTP handler (`:212`): the same check before the `listed` line. `target.hostname` can be `[::1]`; the matcher
normalises it. On a hit, skip `publicAddress` and use the loopback literal as `ip`. A miss runs today's code unchanged.
Routes (paths starting with `/`) never consult `testServices`.

What does not change: `hostAllowed`, `publicAddress`, `isPrivateAddress`, `isNeverReachable`, the route checks,
`orgCredentialEndpointProblem`, and anything in `packages/shared/src/models/private-endpoints.ts`. A refused request
still goes through `deny(host)` (so `proxy.denied()` and `onDeny` record it as any other refusal) and answers 403.

### 6. `apps/runner/src/sandbox/harness-sandbox.ts`, `shims.ts`

No change. `proxyEnv` already points `HTTPS_PROXY` at `http://127.0.0.1:3128`, and `TEST_SERVICE_BRIDGE` turns that into
`socat ... PROXY:127.0.0.1:<host>:<port>,proxyport=3128`, which the egress proxy now lets through for a declared entry.
`NO_PROXY` keeps covering loopback, which is right: the client talks to the in-box listener directly, and only the
listener talks to the proxy.

### 7. Docs

`docs/RUNNER.md`, "Local test services (GWP-41)" (line ~2458): replace "the runtime is not `claude-code`" and "The
harness runtimes (Gemini CLI, opencode, Codex) get no opening" with: harness runtimes whose shell goes through the
runner's egress proxy (Gemini CLI, opencode, Codex in the harness box) get each allowed service as an exact entry in the
proxy's `testServices` list (separate from `privateEndpoints`); `aom-env` tunnels through the box bridge on
`127.0.0.1:3128`; Codex with its native sandbox still gets none. Add one sentence to "Sandbox parity of the other
runtimes" that the proxy also lets through the shift's exact test-service entries. Mention the shared-namespace edge
from finding 4.

### Data model and API

No server, web, wire or settings change. The only new public shapes are runner-internal: `TestServiceInput.egressProxy`,
`RuntimeAdapter.usesEgressProxy?`, `HarnessLaunch.testServices`, `EgressProxyOptions.testServices`,
`testServiceListed`, `harnessTestServices`.

## Risks

- **Security boundary.** The only new way through the proxy is an exact, canonicalised loopback `host:port` that the
  supervisor's decision allowed. Mitigations: canonicalise and filter the entries at proxy start; match on the
  canonical string; test that another port, `127.0.0.2`, `::ffff:127.0.0.1`, `0:0:0:0:0:0:0:1`, `localhost.` and a LAN
  address are refused; test that a test-service entry does not make a privateEndpoints-only target or an org route pass.
- **Concurrent commands in one box** (finding 4, option C1): a parallel second command can lose its listener when the
  first ends. Known limitation; a backlog suggestion covers C2.
- **`localhost` resolving to `::1` first** while the service listens on `127.0.0.1` only: same behaviour as the
  runner's own probe, which marks the service "not answering" in the note in that case. No new failure.
- **Codex `sandbox: native` on Linux**: covered by `usesEgressProxy()` returning false; add a test for it.
- **Test flag.** Put new tests in new files (below) so `out_of_scope_test_change` does not trip; only
  `apps/runner/test/test-services.test.ts` may be edited, and only for additions.

## Tests (for the builder)

New files (names are a suggestion):

- `apps/runner/test/egress-test-services.test.ts` (proxy, real Unix socket and a real loopback TCP server, as in
  `private-endpoints.test.ts`):
  - `testServiceListed`: exact match true; port mismatch false; host mismatch (`127.0.0.2`, `localhost` vs a declared
    `127.0.0.1`) false; `[::1]` and `::1` both match a declared `[::1]:p`; empty list false; a non-loopback or
    malformed entry never matches.
  - CONNECT to a declared `127.0.0.1:<port>` gets `200` and the server's bytes; the same host on another port gets 403
    and `denied()` lists it; another loopback address gets 403; an undeclared private address gets 403.
  - Plain HTTP `GET http://127.0.0.1:<port>/x` through the proxy reaches the server; another port gets 403.
  - No leak: with `testServices` only, a target listed in neither list and a route with `orgSourced: true` to a
    test-service address are refused; with `privateEndpoints` only, a test-service address is refused; with both, each
    list works only for its own entries.
  - Empty or absent `testServices`: the same answers as today for the same requests.
- `apps/runner/test/harness-test-services.test.ts`:
  - `launchInHarnessSandbox({... testServices: ['127.0.0.1:<port>'] })`: a CONNECT through `launched.proxy`'s socket to
    the declared entry gets `200`, another port 403 (proves the list reaches `startEgressProxy` without mocking), then
    `cleanup()`. No bubblewrap needed: only the proxy is started, the command is only built.
  - `harnessTestServices`: a list for builder/reviewer/tester card shifts, `undefined` for a chat, another role or an
    empty list.
  - Each adapter with a fake `host.launch` (as in `gemini-adapter.test.ts:466`): the captured `HarnessLaunch` has
    `testServices` equal to `input.testServiceDomains` and its `privateEndpoints` do not contain them; nothing for a
    chat. Codex `runHarness` gets it; `usesEgressProxy()` is true for Gemini and opencode, and for Codex only with
    `sandboxKind() === 'harness'`.
- Additions to `apps/runner/test/test-services.test.ts` (literally named in Affected areas, additions only):
  - The same input with `runtime: 'gemini' | 'opencode' | 'codex', egressProxy: true` gives the same decisions and the
    same `testServiceDomains` / `testServicesSpec` as `claude-code` with a valid version, for an allowed list and for a
    mixed list with refused ports (runner port, environment port, 3128, bad host).
  - The Claude version gate does not apply to the egress path (`claudeVersion: undefined` or `'0.30.0'` still allowed).
  - `runtime: 'codex'` without `egressProxy` keeps the "codex runtime" refusal (existing line 79 still passes).
  - `egressProxy: true` with `sandbox: 'unavailable'` or `platform: 'darwin'` gives the platform refusal.
  - `testServicesNote` for a harness decision lists the service as reachable and not "not reachable".
  - Empty list with `egressProxy: true`: `[]` and an empty note.

Run: `pnpm --filter @aom/runner test` (unit). Leave `gemini-real`, `opencode-real` and `codex-harness-real` to testers.

## Acceptance criteria mapped to the design

| AC | Covered by |
|---|---|
| Architect's note on what release/1.6.0 does | "Requirement 0" above (also posted on the card) |
| Harness shift gets the exact host:port in a separate field | Design 1 to 5: decision allows it, `testServiceDomains` reaches the adapter, `HarnessLaunch.testServices` to `EgressProxyOptions.testServices`; harness-test-services tests |
| Declared host:port through, other port / loopback / private refused and logged | Design 5, `testServiceListed` and `deny()`; egress-test-services tests |
| privateEndpoints and org checks unchanged, no entry in privateEndpoints | Design 5 "what does not change"; existing `private-endpoints.test.ts`, `egress-hardening.test.ts`, `harness-sandbox.test.ts` untouched and green; no-leak tests; adapter test that `privateEndpoints` lacks the entries |
| aom-env through 127.0.0.1:3128 end to end on all three runtimes | Design 6 (no shim change needed) plus design 5; verified by testers with the real-runtime suites or a manual run (test plan item 4) |
| Note and reachability/doctor lines correct for harness | Design 1 (decision) feeds the unchanged note, progress and doctor code; test-services additions |
| A refused service is refused for harness too, same note | Design 1: per-port checks shared, same reasons; test-services additions |
| No declared services: same allow list and note | `decideTestServices` returns `[]`, `harnessTestServices` returns `undefined`, proxy option absent; tests for the empty case |
| Unit tests for exact / port mismatch / host mismatch / empty list | egress-test-services tests |

## Follow-up (outside this card)

Backlog suggestion: start the test-service listeners once per harness box (option C2) so parallel commands in a Gemini
CLI, opencode or Codex session cannot lose each other's listener.
