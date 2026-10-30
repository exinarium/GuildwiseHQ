# GWP-41: local test services for build, review and test shifts

Status: design, ready to build. Security-sensitive: it widens the agent sandbox's network boundary, so the owner must
approve the change before it is merged.

## 1. Question

Build, review and test shifts must be able to reach the project's local test services from inside the shift sandbox. For
GWP that is Postgres at `127.0.0.1:5433` (`docker-compose.dev.yml` line 10; `apps/server/vitest.config.ts` defaults
`AOM_TEST_DB_URL` to `postgres://…@127.0.0.1:5433/aom_test`). With that access the shift can run the `apps/server` vitest
suite itself, without a DevOps request.

Constraints from the card:

- Only loopback hosts (`127.0.0.1`, `::1`, `localhost`).
- Only the exact declared ports.
- Only builder, reviewer and tester shifts.
- Nothing hard-coded in the runner.
- An empty list must give byte-identical settings.
- The runner's own endpoints and other agents' services are never opened.
- If a platform cannot enforce the per-port opening, open nothing and report the service as unreachable.

Two questions came over from planning:

1. How can a per-port loopback opening be expressed at all?
2. Where is it enforced: the Claude Code sandbox settings or `apps/runner/src/sandbox/egress-proxy.ts`?

## 2. Findings

### 2.1 What the sandbox does with loopback today (Linux and WSL2)

- Claude Code runs every Bash call in its own bubblewrap sandbox with a private network namespace. The namespace's
  loopback is empty. This shift showed it: `/proc/net/tcp` inside the sandbox lists no sockets at all. A direct
  `connect(127.0.0.1:5433)` lands on that empty loopback and is refused. The host's Postgres is not visible there.
- The only way out of the namespace is the sandbox's own proxy. Inside the sandbox, socat bridges `127.0.0.1:3128` (HTTP
  CONNECT) and `localhost:1080` (SOCKS) to Claude Code's proxy on the host. The sandbox gets `HTTP(S)_PROXY` and
  `ALL_PROXY` with a per-session credential, and `NO_PROXY` covers loopback and the private ranges.
- `allowLocalBinding` has no effect on Linux. A command can listen inside its own namespace, but that does not reach the
  host (Claude Code docs, "A command fails to reach a server on localhost").
- **Port-qualified allowlist entries exist.** Claude Code's proxy accepts `allowedDomains` entries such as
  `"127.0.0.1:3000"`, `"[::1]:443"` and `"myapp.test:3000"`, and such an entry matches only that port. An IP entry with no
  port opens every port on that address. Connections to an IP literal are decided by the allowlist. The local-address
  check that refuses names resolving to loopback does not apply to IP literals, and `localhost` itself is allowed to
  resolve to loopback. Bracketed IPv6 entries with a port need Claude Code 2.1.229 or later. This workstation runs
  2.1.314. (Source: code.claude.com/docs/en/sandboxing, sections "IPv6 addresses in domain lists" and "Hostnames that
  resolve to local addresses".)
- Database drivers, `pg` included, ignore proxy variables, so the allowlist entry alone does not help `vitest`. Claude
  Code's own git-over-SSH support solves the same problem by tunnelling a raw TCP stream through the proxy:
  `GIT_SSH_COMMAND` uses `socat - PROXY:127.0.0.1:%h:%p,proxyport=3128,proxyauth=…`. The same tunnel works for any TCP
  protocol.
- The seccomp filter blocks `socket(AF_UNIX)` for every role without `allowAllUnixSockets`
  (`claude-policy.ts` lines 130-135). Builders and reviewers do not have it; only browser roles (the tester) do.

### 2.2 What the runner already has

- **Tester environments (`runs/forward.ts`, `bin/aom-env`).** The runner listens on one Unix socket per environment port
  in the agent's private tmp dir. `aom-env` starts `socat TCP-LISTEN:<port> … UNIX-CONNECT:<socket>` inside the command's
  namespace and then runs the command. This works only because the tester has `allowAllUnixSockets`. `aom-env` already
  handles one detail this design needs: each Bash call is a new namespace, so the bridge must live in the same command
  as the test run. Ports 3128 and 1080 (`RESERVED_RUN_PORTS`) are never forwarded because the proxy bridges use them.
- **Deployed targets (`extraAllowedDomains`).** The supervisor adds `targetHosts(testEnv.target)` to the shift's
  `allowedDomains` for a remote tester. This is the precedent for a per-shift, server-delivered opening. Its comment
  "Hostnames, no ports (the sandbox cannot filter ports)" in `adapters/types.ts` and `docs/RUNNER.md` is out of date:
  ports can now be filtered.
- **The egress proxy (`sandbox/egress-proxy.ts`).** It serves only the harness runtimes (Gemini CLI, opencode, Codex in
  the harness box), through `harness-session.ts`. Claude Code shifts never pass through it. It already understands exact
  `host:port` entries (`privateEndpoints`, `endpointListed`).
- **The runner's own local endpoints.** The IPC HTTP server listens on `127.0.0.1:<random port>` (`ipc/server.ts:75`,
  exposed as `ipc.url`), and the IPC Unix socket sits in `/tmp/aom-ipc-*`. Run environments own ports that
  `runs/manager.ts` tracks (`testPorts(envId)`).
- **Role keys** (`packages/shared/src/roles/builtin.ts`): `builder`, `reviewer` (has the `shell` tool, read-only
  worktree, also does the pre-review when no pre-reviewer is hired) and `tester`. Mention work calls
  `buildShiftSettings(…, 'mention')`. The CEO, the DevOps engineer, chats and scans have their own builders
  (`buildCeoSettings`, `buildDevopsSettings`, `buildChatSettings`, `scanSandboxBlock`).
- **Project settings** are event-sourced. A `Project…Set` event in `packages/shared/src/events/project.ts` is projected
  into a `projects` column in `apps/server/src/projections/projects.ts`. A `PUT /api/projects/:id/<setting>` route
  returns `getProjectDetail`, `toProjectDto` maps the column, and a panel component sits in `ProjectSettings.tsx`.
  `buildShiftStart` (`runner-gateway/brief.ts:592`) adds optional top-level fields such as `mcpServers` to `shift.start`.
- **Doctor** (`cli.ts:367`) runs offline and knows no projects. It already reads `status.json`, which the running runner
  writes (`runner.ts:1108`).

## 3. Options for enforcement

| | Mechanism | Per-port exact | Opens anything else | Empty list byte-identical | Verdict |
|---|---|---|---|---|---|
| **A** | `allowedDomains += "127.0.0.1:5433"` (Claude Code's proxy enforces it), plus a TCP tunnel inside the namespace started by `aom-env`: `socat TCP-LISTEN:5433 → PROXY:<sandbox proxy>:127.0.0.1:5433` | yes, by Claude Code's proxy | no: TCP inside the namespace only, no AF_UNIX | yes (nothing added) | **recommended** |
| B | Runner Unix-socket forwarders (`startForwards`, generalised) + `aom-env` `UNIX-CONNECT` | yes, by the runner | builders and reviewers would need `allowAllUnixSockets`, which opens every reachable Unix socket | yes | rejected for builder and reviewer; two mechanisms if used for testers only |
| C | Point Claude Code at the runner's egress proxy (`httpProxyPort`/`socksProxyPort`) | yes, by the runner | Claude Code's whole domain filtering stops applying, and the runner proxy must re-implement all of it for every shift | no if switched on per project; a large blast radius either way | rejected |
| D | `excludedCommands` for the test command | n/a | the whole suite runs unsandboxed (filesystem and network) | yes | rejected: relaxes the filesystem rules |
| E | `allowedDomains += "127.0.0.1"` (no port) | **no** | every host loopback port, the runner's IPC port included | yes | rejected |

Why A:

- The opening is one exact `host:port` string in the settings Claude Code already enforces, next to the registry
  domains.
- Nothing else in the sandbox changes. There are no new socket families and no unsandboxed commands. Filesystem rules
  and secret denies are untouched.
- The tunnel is the pattern Claude Code itself uses for SSH. `aom-env` already exists, testers already use it, and it
  already knows the "one namespace per Bash call" rule.
- A declared port that is not in the list (5432, the IPC port) is refused by the proxy, and a direct connection has no
  route. This is the behaviour AC 4 asks for, with no extra code.

**The egress proxy is not the enforcement point.** Claude Code shifts do not use it. Harness runtimes (Gemini CLI,
opencode, Codex in the box) are out of scope for this card: the runner gives them no opening and the prompt and doctor
say "not reachable with this runtime". A follow-up could map the same list to the egress proxy's exact `host:port` check
(`privateEndpoints`-style, kept in a separate field). I file this as a backlog suggestion, not part of this card.

## 4. Design

### 4.1 Data model (packages/shared)

New file `packages/shared/src/projects/test-services.ts` (or next to `api/projects.ts`; export it from the index):

```ts
export const TEST_SERVICE_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export const MAX_TEST_SERVICES = 10;

export const LocalTestServiceSchema = z.object({
  name: z.string().trim().min(1).max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, dash and underscore only'),
  // trim + lower-case, "[::1]" accepted as "::1"; anything else is refused
  host: z.string().trim().transform(normaliseHost).refine(isTestServiceHost,
    'only 127.0.0.1, ::1 or localhost: a test service must run on this workstation'),
  port: z.number({ error: 'the port must be a whole number from 1 to 65535' })
    .int('the port must be a whole number from 1 to 65535').min(1, '…').max(65535, '…')
    .refine((p) => !RESERVED_RUN_PORTS.includes(p), 'ports 3128 and 1080 are used by the sandbox proxy'),
});
export const LocalTestServicesSchema = z.array(LocalTestServiceSchema).max(MAX_TEST_SERVICES)
  .superRefine(uniqueNamesAndPorts); // "names must be unique", "each port can be declared once"
export type LocalTestService = z.infer<typeof LocalTestServiceSchema>;

/** The exact sandbox allowlist entry: 127.0.0.1:5433, [::1]:5433, localhost:5433. Pure. */
export function testServiceDomain(s: LocalTestService): string;
```

Decisions behind the schema:

- **The host must be exactly one of the three strings.** Do not reuse `isLoopbackHost`: it also accepts `127.0.0.2` and
  `*.localhost`.
- **Ports are unique across the list, not just `host:port` pairs.** Inside the sandbox each declared port is bound on the
  namespace's loopback, so `localhost:5433` and `127.0.0.1:5433` would collide.
- **3128 and 1080 are refused in shared validation.** They are fixed on every workstation, so the form can say so at
  once. Workstation-specific ports (the runner's IPC port, run environments) can only be checked by the runner (§4.4).
- **No credentials anywhere.** The test configuration keeps the connection string (`AOM_TEST_DB_URL` default).

Additions:

- `ProjectDtoSchema.testServices: LocalTestServicesSchema.optional()`
- `SetTestServicesRequestSchema = z.object({ services: LocalTestServicesSchema })`
- Event `defineEvent('ProjectTestServicesSet', z.object({ projectId: Id, services: LocalTestServicesSchema, by: Id }))`
  in `events/project.ts`
- `ShiftStartSchema.testServices: z.array(LocalTestServiceSchema).optional()` in `protocol/runner.ts`. It is additive:
  an older runner strips it and opens nothing, which is the safe direction.

### 4.2 Server (apps/server)

- **Migration** `apps/server/migrations/2743_project_test_services.sql` (take the next free number at build time):
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_services jsonb NOT NULL DEFAULT '[]'::jsonb;`
- **Projection.** `ProjectTestServicesSet` → `UPDATE projects SET test_services=$2::jsonb WHERE id=$1` in
  `projections/projects.ts`.
- **Command.** `setTestServices(ctx, user, org, projectId, services)` in `commands/projects.ts`:
  - Permission: the same rule as `setManualQa`, so the project Owner or an organization Owner or Admin (else
    `forbidden`).
  - Parse again with `LocalTestServicesSchema`, and on failure throw `badRequest('invalid_test_service', <first message>,
    {issues})`.
  - If the list is unchanged, append nothing.
- **Route.** `PUT /api/projects/:id/test-services` with `{ params: IdParamsSchema, body: SetTestServicesRequestSchema }`
  in `routes/projects.ts`. It returns `getProjectDetail`.
- **DTO.** `toProjectDto`: `testServices: LocalTestServicesSchema.safeParse(p.test_services).data ?? []`.
- **Delivery.** In `buildShiftStart` (`runner-gateway/brief.ts`), add `testServices` only when all of these hold:
  - the list is non-empty
  - `agent.role_key` is in `{'builder', 'reviewer', 'tester'}`
  - `!agent.is_devops`

  Question, BA task, DevOps, CEO and chat paths never set the field. The value is read at claim time, which gives AC 7:
  the next shift sees the change and running shifts keep what they were started with.

### 4.3 Web (apps/web)

- New `components/TestServicesPanel.tsx`, mounted in `pages/ProjectSettings.tsx` next to the Environment and Reference
  repositories panels, titled **"Local test services"**.
  - A row per entry with name, host and port, plus Add, Edit (in place) and Remove buttons and one Save.
  - Explain in one line: build, review and test shifts of this project may connect to exactly these ports on the
    workstation; credentials stay in the test configuration.
  - Editable by the project Owner or an organization Owner or Admin; read-only for everyone else.
- Validate on the client with the shared schema and show the message under the field. The server validates again and
  its 400 message is shown the same way.
- Host is a text input with a `datalist` of the three hosts. This lets AC 1's cases (`10.0.0.5`, `db.example.com`,
  `0.0.0.0`) show the message rather than being impossible to type.
- Touch standing order:
  - port field: `inputMode="numeric"`, `pattern="[0-9]*"`
  - name and host fields: `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`
  - buttons sized for touch
  - the row stacks on narrow screens
  - the field being edited is scrolled into view when the soft keyboard opens
- `useSetTestServices(id)` in `api/queries/projects.ts`: `put('/projects/${id}/test-services', { services })`, then
  invalidate the project query.

### 4.4 Runner (apps/runner): the enforcement

**New module `apps/runner/src/sandbox/test-services.ts`**, pure and unit-tested:

```ts
export const TEST_SERVICE_ROLES = new Set(['builder', 'reviewer', 'tester']);
export type TestServiceDecision = LocalTestService & ({ state: 'allowed' } | { state: 'refused'; reason: string });

/** Which declared services this shift gets, and why not for the rest. */
export function decideTestServices(i: {
  services: LocalTestService[] | undefined;
  kind: string; roleKey: string; isDevops: boolean; runtime: string; hasShell: boolean;
  platform: NodeJS.Platform; sandboxMode: SandboxMode; claudeVersion?: string;
  runnerPorts: ReadonlySet<number>;   // IPC HTTP port + every port the run manager owns
  envForwardPorts: ReadonlySet<number>; // this shift's AOM_ENV_FORWARDS ports (tester)
}): TestServiceDecision[];
export function testServiceDomains(d: TestServiceDecision[]): string[];   // allowed only, via testServiceDomain()
export function testServicesSpec(d: TestServiceDecision[]): string;       // "127.0.0.1:5433,[::1]:6379" (allowed only)
export function testServicesNote(d: TestServiceDecision[]): string;       // the instructions section (§4.5)
```

**Refusal rules.** These are checked in this order, and a refused service is never added anywhere:

1. The shift is not a card shift, or the role is not in `TEST_SERVICE_ROLES`, or the agent is DevOps → return `[]` (no
   section at all, so the shift stays byte-identical).
2. The role has no `shell` tool → refused, "this role has no shell".
3. The runtime is not `claude-code` → refused, "not reachable with the <runtime> runtime (no per-port opening there)".
4. The platform is not `linux`, or the sandbox mode is `off` / unsandboxed → refused, "this platform's sandbox cannot
   open a single loopback port; nothing was opened". On macOS, Seatbelt has no network namespace and binding the same
   port inside would clash with the real service. Never fall back to a wider opening.
5. The Claude Code version is below 2.1.229 (the first version documented with port-qualified IP entries) or unknown →
   refused, "Claude Code <v> cannot limit the sandbox to one port".
6. The port is in `runnerPorts` → refused, "port <p> belongs to the runner (its local HTTP port or a run environment)".
7. The port is in `envForwardPorts` → refused, "port <p> is already forwarded to the test environment".
8. The port is in `RESERVED_RUN_PORTS` → refused (defence in depth; the server already refuses it).

**Settings (`adapters/claude-policy.ts`):**

- `ClaudePolicyContext` gains `testServiceDomains?: string[]`. These are the exact `host:port` strings of the allowed
  services, already decided.
- In `buildShiftSettings`, pass them on only when `roleKey` is in `TEST_SERVICE_ROLES` and `!isDevops`. This is a second,
  defensive role gate, so a mention, CEO, DevOps, chat or scan context can never carry them. Code sketch:
  `const ts = TEST_SERVICE_ROLES.has(roleKey ?? '') ? (ctx.testServiceDomains ?? []) : [];`
- In `sandboxBlock`, do not mutate shared state:
  `allowedDomains: shell ? [...REGISTRY_DOMAINS, ...(ctx.extraAllowedDomains ?? []), ...testDomains] : []`. Thread
  `testDomains` in as a new optional parameter, defaulting to `[]`.
  - `buildChatSettings`, `buildCeoSettings`, `scanSandboxBlock` and `buildDevopsSettings` do not pass it.
  - `buildMentionWorkSettings` goes through `buildShiftSettings(…, 'mention')` and so gets `[]`.
- With an empty list the generated object is identical to today's, so the JSON is byte-identical.
- No other field changes: no `allowLocalBinding`, `allowUnixSockets` or `allowAllUnixSockets` change, and no filesystem
  change.

**Adapter (`adapters/claude-code.ts`):**

- `ShiftStartInput` gains `testServiceDomains?: string[]` (doc comment: exact loopback `host:port`, decided by the
  supervisor).
- `policy()` copies it into the context only for `start()`. `startChat` never passes it.

**Supervisor (`shifts/supervisor.ts`)**, around the existing `extraAllowedDomains` / forwards code (≈ lines 1141-1290):

- Compute `decisions = decideTestServices({...})` from:
  - `msg.testServices`, `msg.kind`, `msg.agent.roleKey`, `msg.agent.isDevops`, `msg.agent.runtime`
  - `msg.agent.permissions.allowedTools.includes('shell')`, `process.platform`
  - the Claude Code sandbox mode and version (from the adapter's capabilities)
  - `runnerPorts` = the port of `this.deps.ipc.url` plus a new `runs.ownedPorts()` (every port of every environment the
    manager tracks)
  - `envForwardPorts` = `s.forwards?.sockets.map(x => x.port)`. Compute the forwards first.
- Then:
  - If any service is allowed, set `s.env.AOM_TEST_SERVICES = testServicesSpec(decisions)`.
  - Pass `testServiceDomains: testServiceDomains(decisions)` to `adapter.start`.
  - Append `testServicesNote(decisions)` to `texts.instructions` before `identityLast` and `writeInstructions`. The
    instructions are written before the env is built today, so compute the decisions earlier: everything they need is
    known at that point except the forward ports, which can be read from `runs.testPorts(envId)` for the tester.
  - Add a progress line for refused entries: "Local test service postgres-test (127.0.0.1:5433) not opened: <reason>."
  - Record the decisions for the doctor (below).
- With no decisions nothing is set: no env var, no note, no progress line.

**`bin/aom-env` (`shims.ts`, `AOM_ENV_SCRIPT`):**

- When `AOM_TEST_SERVICES` is set, parse the proxy from `$HTTPS_PROXY`: `http://[user:pass@]host:port`, credentials
  optional. That is the Claude Code sandbox's proxy with its per-session credential. Do not print it.
- For each `host:port`, start
  `socat TCP-LISTEN:<port>,bind=<127.0.0.1|[::1]>,fork,reuseaddr PROXY:<proxyhost>:<host>:<port>,proxyport=<pp>[,proxyauth=<user:pass>]`.
  - `localhost` binds `127.0.0.1`, and `::1` uses `TCP6-LISTEN` with `bind=[::1]`.
  - The `PROXY` target is the declared host string itself (`127.0.0.1`, `[::1]`, `localhost`), so it matches the
    allowlist entry exactly.
- Wait for each listener as the forwards do: `/proc/net/tcp` for 127.0.0.1, and `/proc/net/tcp6` for `::1` with
  `00000000000000000000000001000000:<hex>`.
- If `HTTPS_PROXY` is missing or not of that form, print "aom-env: no sandbox proxy, test services not reachable" and
  run the command anyway. The service stays closed, which is the safe direction.
- Keep the existing `AOM_ENV_FORWARDS` branch unchanged. A tester can have both; ports never overlap because of refusal
  rule 7.
- Update the usage text and the header comment. The agent's command is then, for example,
  `aom-env --timeout 20 -- pnpm --filter @aom/server test`. `pg` connects to `127.0.0.1:5433` directly (`NO_PROXY`
  covers loopback), reaches socat in its own namespace and is tunnelled to the host's port.
- The proxy credential already lives in the sandbox's environment, and `GIT_SSH_COMMAND` puts it on a socat command line
  the same way. Nothing new is exposed. Never log the spec together with the proxy URL.

**Doctor (AC 6):**

- The supervisor keeps `testServicesSeen: Map<projectKey, {at, decisions}>`, updated at every shift start that carried
  `testServices`, and replaced each time so a removed entry disappears.
- `runner.writeStatus` adds `testServices` to `status.json`, and the supervisor triggers a status write after updating
  the map. `status.json` is already in `RUNNER_PRIVATE`, so no settings change is needed. Do **not** add a new file to
  `RUNNER_PRIVATE`: that would change every shift's settings and break AC 6's snapshot.
- `sandboxDoctorLines` gains an optional third parameter `testServices?: Record<string, {at: string; decisions:
  TestServiceDecision[]}>`. For each project and service it prints one line:
  - allowed: `ok    test service: GWP postgres-test 127.0.0.1:5433 (build, review and test shifts; as of <at>)`
  - refused: `warn  test service: GWP redis 127.0.0.1:43548 not opened: <reason>`
  - nothing recorded: one line `ok  test services: none declared by the projects this runner has worked on`
- `cli.ts` doctor reads `status.json` (it already reads it at line 300) and passes the field.

### 4.5 Shift instructions (AC 5)

`testServicesNote` renders this only when there are decisions:

```
## Local test services
Your shell may connect to these services on this workstation (and to no other local port):
- postgres-test: 127.0.0.1:5433
Each Bash call has its own network, so run every command that needs them through aom-env, in the same call:
`aom-env --timeout <minutes> -- <command>` (for example `aom-env --timeout 20 -- pnpm --filter @aom/server test`).
Credentials are in the project's test configuration, not here.
Not reachable in this shift: redis (127.0.0.1:6379): <reason>.
```

If every declared service is refused, the first list is replaced by "No local test service is reachable in this shift."
followed by the reasons. That way the agent knows to ask DevOps rather than guess.

### 4.6 Docs

- `docs/RUNNER.md`: a short "Local test services" paragraph next to "Forwarders (D6)". It covers the mechanism, the
  refusal rules, the doctor line and the Linux-only scope.
- Correct the outdated "the sandbox cannot filter ports" statement in `adapters/types.ts` and in `docs/RUNNER.md`.

## 5. Acceptance criteria → design

| AC | Where it is met | Test (builder unit / tester live) |
|---|---|---|
| Settings section to add, edit and remove; non-loopback host or bad port refused and not saved | §4.1 schema, §4.2 command and route, §4.3 panel | shared: schema cases `10.0.0.5`, `db.example.com`, `0.0.0.0`, `127.0.0.2`, `x.localhost`, port 0, 65536, `"abc"`, 1.5, 3128, duplicate name, duplicate port, `[::1]` normalised. Server: PUT 400 leaves the column unchanged; round trip GET after PUT; migration default `[]`; non-owner 403. Web: component test for add, edit, remove and error display |
| Build shift reaches 127.0.0.1:5433 and the full `apps/server` suite passes | §4.4 allowlist entry + `aom-env` tunnel | runner unit: builder settings contain exactly `"127.0.0.1:5433"`; `aom-env` script test (spec parsing, socat arguments; a socat-less fake proving the listener and proxy arguments). **Live: tester** (docker-compose.dev.yml up) |
| Same for review and test shifts | role gate `{builder, reviewer, tester}` | runner unit for reviewer and tester settings. Live: tester |
| An undeclared loopback port (5432, the runner's port) is still refused; external hosts unchanged | the entry is port-exact; direct connections have no route; IPC and run ports refused (rule 6) | runner unit: `allowedDomains` equals the registry list + extras + exactly the declared entries, with no bare `127.0.0.1`/`localhost`; a declared IPC port is refused. Live: tester |
| BA, CEO, DevOps, chat and scan shifts cannot reach 5433 | server sends the field only for the three roles; runner rule 1; `buildShiftSettings` second gate; chat, CEO, scan and DevOps builders never take it | runner unit: same ctx with services for `ba`, `ceo`, `mention`, `isDevops`, `buildChatSettings`, `scanSandboxBlock` → no entry. Server unit: `buildShiftStart` omits the field for a BA agent. Live: tester (a BA shift) |
| Empty list → byte-identical settings | nothing is added when there are no decisions | runner unit: `JSON.stringify(buildShiftSettings(...))` with `testServiceDomains: []` / absent equals the output without the field (snapshot or deep-equal against the current builder, reviewer and tester settings) |
| Other projects do not get GWP's services | the list comes per shift from that card's project row; no runner-side cache feeds settings (the doctor map is display only) | server unit: `buildShiftStart` for a card of project B has no `testServices` |
| Doctor shows the allowed services | §4.4 doctor | runner unit: `sandboxDoctorLines` with allowed, refused and empty |
| Removing an entry means the next shift can no longer reach the port | read at claim time; settings rebuilt per shift | server unit: PUT without the entry, then `buildShiftStart` omits it. Live: tester |

Live checks for the tester or a workstation run (not in a builder shift, per the ledger rulings on GWP-11, 18, 19 and 20):

- With Postgres on 5433 and GWP declaring it, from a build, a review and a test shift, `aom-env -- node -e
  "net.connect(5433,'127.0.0.1')"` succeeds.
- 5432 and the IPC port fail.
- `curl https://example.com` is still blocked.
- `aom-env --timeout 20 -- pnpm --filter @aom/server test` passes.
- A BA shift fails on 5433.
- After the entry is removed, the next build shift fails on 5433.

## 6. Risks

1. **The proxy's port-exact behaviour is taken from the documentation, not tested live in this shift.** The sandbox
   blocked the probe. Mitigations: the version gate (rule 5), the unit test that the entry always carries a port, and
   the tester's live check of 5432 before merge. If an older or newer Claude Code treated `127.0.0.1:5433` as a bare
   host, it would over-open, and the live check catches that. The owner's approval should wait for that check.
2. **Proxy URL parsing in `aom-env`.** The credential is base64 and hex, so it has no commas. Refuse anything that does
   not match `^https?://([^:@/]+:[^@/]+@)?[^:/]+:[0-9]+/?$` and run with no tunnel.
3. **Port clash with the tester's environment forwards.** Refusal rule 7: the environment wins and the prompt says so.
4. **Claude Code's own host proxy ports are random and unknown before the session starts.** A declared port that
   happened to equal one would only tunnel back into the same filtering proxy, so there is no widening. Accepted.
5. **The service itself.** An agent with access to the test DB can do anything that DB user can do. That is the purpose
   of the card. Owners should declare only throwaway test services; the panel text says so.
6. **Out of scope, found while investigating.** On macOS, `allowLocalBinding: true` (every shell role) lets Seatbelt
   sandboxes connect to *any* localhost port, the runner's IPC HTTP port included (Claude Code docs, "A command fails to
   reach a server on localhost"). This exists today and is not changed by this card. It is filed as a backlog
   suggestion.

## 7. Files to change (summary)

- `packages/shared`: the new test-services schema and helpers; `api/projects.ts` (DTO + request); `events/project.ts`
  (event); `protocol/runner.ts` (`ShiftStartSchema.testServices`); index exports; tests.
- `apps/server`: `migrations/2743_project_test_services.sql`; `projections/projects.ts`; `commands/projects.ts`
  (`setTestServices`); `routes/projects.ts` (PUT); `queries/misc.ts` (`toProjectDto`); `runner-gateway/brief.ts`
  (`buildShiftStart`); tests.
- `apps/web`: `components/TestServicesPanel.tsx`; `pages/ProjectSettings.tsx`; `api/queries/projects.ts`; component
  test.
- `apps/runner`:
  - new `sandbox/test-services.ts`
  - `adapters/claude-policy.ts` (`ClaudePolicyContext.testServiceDomains`, `buildShiftSettings` gate, `sandboxBlock`
    parameter, `sandboxDoctorLines` third parameter)
  - `adapters/claude-code.ts` (`policy()` for `start()` only)
  - `adapters/types.ts` (`ShiftStartInput.testServiceDomains`, corrected comment)
  - `shifts/supervisor.ts` (decide, env, note, progress, doctor map)
  - `runs/manager.ts` (`ownedPorts()`)
  - `shims.ts` (`aom-env`)
  - `runner.ts` (`writeStatus`)
  - `cli.ts` (doctor)
  - tests
- `docs/RUNNER.md`.

Not touched: `apps/runner/src/sandbox/egress-proxy.ts`, filesystem rules, secret denies, the `agent-org-manager`
repository.
