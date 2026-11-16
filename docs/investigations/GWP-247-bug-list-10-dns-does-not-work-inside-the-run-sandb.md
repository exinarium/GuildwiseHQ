# GWP-247: DNS does not work inside the run sandbox

## Question

Commands run in the runner's service/run sandbox (`apps/runner/src/runs/sandbox.ts`, launched by
`RunManager.launch` and `RunManager.checkLaunch`) cannot resolve host names on systemd-resolved hosts
("Temporary failure in name resolution" for `registry.npmjs.org`), so package installs fail or retry for minutes.
Which mechanism causes it: the masked `/run/systemd`, an unreachable stub resolver `127.0.0.53`, or both? How do we
restore name resolution without exposing the rest of `/run/systemd` or widening the network policy? Do other sandboxes
share the problem?

## Findings

### 1. The masked path is the cause (confirmed)

- `maskedPaths()` (`runs/sandbox.ts:51`) includes every entry of `BROWSER_MASKED`
  (`adapters/claude-policy.ts:250`), which lists `/run/systemd`. `bwrapArgs()` (`runs/sandbox.ts:93-100`) turns every
  masked directory into an empty `--tmpfs`.
- On this workstation (Ubuntu, systemd-resolved, bubblewrap 0.11.1):
  - `/etc/resolv.conf -> ../run/systemd/resolve/stub-resolv.conf` (`nameserver 127.0.0.53`);
  - `/run/systemd/resolve/` holds `stub-resolv.conf`, `resolv.conf` (the upstream servers) **and two Unix sockets**,
    `io.systemd.Resolve` and `io.systemd.Resolve.Monitor` (resolved's varlink API);
  - `/etc/nsswitch.conf` has `hosts: files dns`: glibc reads `/etc/resolv.conf`.
- In the sandbox the symlink dangles (its target is under the empty tmpfs). glibc's resolver then falls back to its
  built-in default, `nameserver 127.0.0.1`. Nothing listens on `127.0.0.1:53`, so every lookup fails with
  `EAI_AGAIN` ("Temporary failure in name resolution"). pnpm/npm/NuGet treat that as a transient network error and retry
  with backoff, which is why installs look hung.

### 2. The stub `127.0.0.53` is reachable where it matters (second mechanism does not apply)

- `RunManager.launch` (steps, services, `stopCmd`) builds the spec without `network`, so the sandbox keeps the **host
  network**: bwrap gets no `--unshare-net`. `--unshare-pid` and `--unshare-ipc` do not touch networking. The process is
  in the host's network namespace and sees the host loopback, where resolved's stub listens on `127.0.0.53:53`. The runner's
  unit has no `PrivateNetwork=`, `RestrictAddressFamilies=` or `IPAddressDeny=` (grep of `apps/runner/src` finds none).
  So once the resolver file is visible, the stub answers. No upstream-nameserver rewrite is needed.
- `checkLaunch` with `network: 'none'` (handoff checks, worktree preparation) runs in its own network namespace with
  only a loopback. There neither the stub nor any upstream server is reachable, **by design**: these commands must
  never download (GWP-66 fix, `checks/offline-env.ts`). A lookup there fails at once: a UDP query to a closed port on the
  namespace's own `lo` gets ICMP port-unreachable, so it returns `ECONNREFUSED` with no wait. Nothing to fix; the design
  leaves this path as it is.
- `checkLaunch` falls back to the host network when `--unshare-net` is not available, and also runs with `network: 'host'`
  for a suite card's unit suites. Both behave like `launch` and get the fix. The offline package-manager environment
  still prevents downloads there, as today.
- If the owner disabled resolved's stub listener (`DNSStubListener=no`) while `/etc/resolv.conf` still points at
  `stub-resolv.conf`, the host's own DNS is broken too. The sandbox only mirrors the host, so this is out of scope.

### 3. Other sandboxes do not share the problem

| Sandbox | Masks `/run/systemd`? | Network | Affected? |
|---|---|---|---|
| Run/service sandbox (`runs/sandbox.ts`) | yes (tmpfs) | host (`launch`), none/host (`checkLaunch`) | **yes**: the only one |
| Agent shell, Claude Code (`adapters/claude-policy.ts` `sandboxBlock`, `browserMask` for browser roles) | only browser roles, through `denyRead` | own namespace; HTTP(S) through the filtering egress proxy, which resolves names on the host | no: tools reach hosts through the proxy and never resolve DNS directly. Showing resolv.conf would not help, because no nameserver is reachable from that namespace |
| Harness sandbox (`sandbox/harness-sandbox.ts`, Gemini CLI/opencode) | `/run` not mounted at all | own namespace, loopback bridge to the egress proxy | no, same reason |
| Reviewer sandbox (`review/reviewer-sandbox.ts`) | via claude-policy | `offline: true`, no network | no |
| `apps/runner/src/sandbox/sandbox.ts` (`sandboxFor`/`ensureSandbox`) | no bwrap or mask code | — | no |

So, for requirement 4, the PR states that only the run sandbox is affected.

## Options

| Option | What is exposed | Works for stub hosts | Works for `resolv.conf` (upstream) hosts | Risk |
|---|---|---|---|---|
| A. Unmask `/run/systemd` | the systemd private socket, journal and notify sockets, resolved's varlink sockets | yes | yes | **rejected**: the constraints forbid it (host sockets) |
| B. Bind `/run/systemd/resolve/` read-only | the two resolver files **plus** `io.systemd.Resolve` and `io.systemd.Resolve.Monitor` sockets (read-only binds do not stop `connect()` on a Unix socket) | yes | yes | rejected: adds a host socket |
| C. **Bind only the file `/etc/resolv.conf` really points at, read-only, at its own path, after the tmpfs** | one regular file | yes | yes | minimal; recommended |
| D. Write a generated resolv.conf with the upstream servers from `/run/systemd/resolve/resolv.conf` into the run tmp and bind it over `/etc/resolv.conf` | one generated file | yes, but bypasses the stub's cache and split DNS (VPN domains) | yes | needs parsing and a file per run; `/etc/resolv.conf` is a symlink, so binding over it is ambiguous. Only needed if the stub were unreachable, and it is not |
| E. Fix it on the host (static resolv.conf) | — | — | — | forbidden by the constraints |

## Recommendation

**Option C.** When the sandbox keeps the host network (`network !== 'none'`), resolve `/etc/resolv.conf` with
`realpathSync`. If the real target lies under one of the masked **system runtime** paths (`BROWSER_MASKED`, i.e.
`/run/systemd`, `/run/dbus`, …) and is a regular file, add `--ro-bind <target> <target>` **after** the mask loop. bwrap
looks up the source in the host filesystem (unaffected by the tmpfs) and creates the destination's parent folders
inside the tmpfs. Inside the sandbox `ls /run/systemd` shows only `resolve`, and `ls /run/systemd/resolve` only
`stub-resolv.conf` (or `resolv.conf`). `private`, `journal`, `notify` and resolved's own sockets stay hidden. The relative
symlink `/etc/resolv.conf` (from the read-only root bind) then resolves inside the sandbox.

This mirrors exactly what the host uses: the stub on stub hosts, the upstream list on hosts linked to
`/run/systemd/resolve/resolv.conf`, and nothing extra on hosts with a plain file or a target outside the masks
(`/run/NetworkManager/resolv.conf`, `/run/resolvconf/resolv.conf`, WSL's `/mnt/wsl/resolv.conf`).

On hosts with `hosts: ... resolve [!UNAVAIL=return] dns` (Fedora, Arch), nss-resolve wants the varlink socket. That
socket stays masked, so nss-resolve returns UNAVAIL and glibc falls through to `dns`, which reads the bound file. It
works without exposing the socket.

## Design

### Files

1. `apps/runner/src/runs/sandbox.ts` (main change, about 60 lines)
2. `apps/runner/src/runs/manager.ts` (log the warning once; about 15 lines)
3. `apps/runner/test/run-sandbox-dns.test.ts` (new)
4. `docs/RUNNER.md` (Service sandbox paragraph, around line 2726; the 1.8.0 note around line 1796)
5. `CHANGELOG.md` / runner version bump as the repository's release routine requires (see the existing pattern).

### `SandboxSpec`: two injectable fields (tests only; production uses the defaults)

```ts
export interface SandboxSpec {
  // ...existing fields...
  /** The host's resolver config (default `/etc/resolv.conf`; injectable for tests). */
  resolvConf?: string;
  /** System runtime paths masked for their sockets (default `BROWSER_MASKED`; injectable for tests). */
  systemMasks?: string[];
}
```

`maskedPaths()` uses `spec.systemMasks ?? BROWSER_MASKED` instead of the constant. Widen its `Pick<>` to include
`systemMasks`. Its output for the default is unchanged.

### New pure helper

```ts
export interface ResolverMount {
  /** Host file to bind read-only at the same path (inside a masked system folder). */
  bind?: string;
  /** One line for the runner log when name resolution cannot work in the sandbox. */
  warning?: string;
}

const under = (p: string, roots: string[]) => roots.find((r) => p === r || p.startsWith(`${r}/`));

/** Where a (possibly dangling) symlink chain ends, with existing parents canonicalised (`/var/run` -> `/run`). */
function literalTarget(p: string): string {
  let cur = p;
  for (let i = 0; i < 40; i++) {
    try {
      if (!lstatSync(cur).isSymbolicLink()) break;
      cur = resolve(dirname(cur), readlinkSync(cur));
    } catch { break; }
  }
  // canonicalise the deepest existing ancestor
  let head = cur; const tail: string[] = [];
  while (head !== dirname(head)) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch { tail.push(basename(head)); head = dirname(head); }
  }
  return cur;
}

/**
 * The resolver file the sandbox needs: `/etc/resolv.conf` on systemd-resolved hosts points into `/run/systemd/resolve`,
 * which the mask hides. Only that one regular file is re-opened, read-only; the folder's sockets and the rest of
 * `/run/systemd` stay masked. `systemMasked`: the real paths of the masked system folders; `otherMasked`: the rest
 * (runner data, home secrets, /run/user) — never re-opened.
 */
export function resolverMount(resolvConf: string, systemMasked: string[], otherMasked: string[]): ResolverMount {
  try { lstatSync(resolvConf); } catch {
    return { warning: `run sandbox: DNS unavailable, ${resolvConf} is missing on this host` };
  }
  let target: string;
  try { target = realpathSync(resolvConf); } catch {
    const lit = literalTarget(resolvConf);
    const root = under(lit, [...systemMasked, ...otherMasked]);
    return { warning: root
      ? `run sandbox: DNS unavailable, ${resolvConf} points into masked ${root} and ${lit} does not exist`
      : `run sandbox: DNS unavailable, ${resolvConf} is a broken link to ${lit}` };
  }
  const sys = under(target, systemMasked);
  if (!sys) {
    const other = under(target, otherMasked);
    return other ? { warning: `run sandbox: DNS unavailable, ${resolvConf} points into masked ${other}` } : {};
  }
  try { if (!statSync(target).isFile()) throw new Error(); } catch {
    return { warning: `run sandbox: DNS unavailable, ${resolvConf} points into masked ${sys} and ${target} is not a file` };
  }
  return { bind: target };
}
```

Message wording: the card's example is
`run sandbox: DNS unavailable, /etc/resolv.conf points into masked /run/systemd`. Keep that prefix and add the detail.

### `bwrapArgs` / `sandboxCommand`

```ts
function resolverFor(spec: SandboxSpec): ResolverMount {
  if (spec.network === 'none') return {}; // own namespace: offline by design, no resolver needed, no warning
  const real = (ps: string[]) => ps.flatMap((p) => { try { return [realpathSync(p)]; } catch { return []; } });
  const masked = maskedPaths(spec);
  const system = real(spec.systemMasks ?? BROWSER_MASKED).filter((p) => masked.includes(p));
  return resolverMount(spec.resolvConf ?? '/etc/resolv.conf', system, masked.filter((p) => !system.includes(p)));
}

export function bwrapArgs(spec: SandboxSpec): string[] {
  // ...unchanged up to and including the mask loop...
  const dns = resolverFor(spec);
  if (dns.bind) args.push('--ro-bind', dns.bind, dns.bind); // after the tmpfs that hides its folder
  // ...gitDirs, /tmp, worktrees, user secrets unchanged...
}

/** `bwrap <args> -- cmd...`; `warning`: name resolution will not work in this sandbox (log it once). */
export function sandboxCommand(spec: SandboxSpec, argv: string[]): { cmd: string; args: string[]; warning?: string } {
  return { cmd: 'bwrap', args: [...bwrapArgs(spec), '--', ...argv], warning: resolverFor(spec).warning };
}
```

(`resolverFor` running twice is cheap; or have an internal `buildArgs()` that returns both. Builder's choice.)

The bind goes **after** the mask loop and before the `--bind` entries. The existing `runs-p2` assertion on the exact
`--bind` list stays valid, because the new entry is a `--ro-bind`.

### `manager.ts`

Next to `netnsWarned` (`manager.ts:211`), add `private dnsWarned = new Set<string>()`. In both `launch` (~1300) and
`checkLaunch` (~1270), after `sandboxCommand(...)`:

```ts
if (c.warning && !this.dnsWarned.has(c.warning)) {
  this.dnsWarned.add(c.warning);
  this.deps.log.warn(c.warning);
}
```

This gives one line per distinct reason per runner process. It does not change control flow: the run goes on and
lookups fail at once (glibc's default `127.0.0.1` is refused at once on the host loopback). That meets "fails fast or
proceeds offline with a logged warning".

### Network policy

Unchanged. No `--share-net`/`--unshare-net` change, no new hosts or ports, no sockets. The fix only makes a config
file visible. A command that could already open a UDP socket to `127.0.0.53` on the host network now gets a correct
answer.

### Docs (`docs/RUNNER.md`)

- Service sandbox paragraph (~2726): after "...`/run/systemd`, `/run/user/<uid>` ... are masked too", add a **DNS**
  sentence. When `/etc/resolv.conf` resolves into a masked system folder (systemd-resolved: `/run/systemd/resolve/stub-resolv.conf`
  or `resolv.conf`), that one file is bound back read-only at its own path. Nothing else under `/run/systemd` (the
  private, journal and notify sockets, resolved's varlink sockets) becomes visible. With the host network the stub
  `127.0.0.53` is reachable, so lookups use the host's normal DNS, including its cache and VPN split DNS. A plain
  `/etc/resolv.conf`, or one pointing outside the masks, needs nothing. When no usable resolver exists (missing file,
  dangling link), the runner logs one `run sandbox: DNS unavailable, ...` line and lookups fail at once. Checks with
  `network: 'none'` get no resolver: they are offline by design.
- 1.8.0 note (~1796): keep the history and add "(the run sandbox's resolver is restored in the next release; the checks
  stay offline)".

## Risks

- **Bind pins the inode.** resolved rewrites its files by rename, so a long-running service keeps the old content. For
  `stub-resolv.conf` only the `search` line can change (the nameserver is always `127.0.0.53`). For hosts linked to the
  upstream `resolv.conf`, a laptop that roams keeps stale upstream servers in services started earlier. New steps get
  the current file. This is acceptable; document it in one clause.
- **Existing tests on a resolved host** now see an extra `--ro-bind /run/systemd/resolve/stub-resolv.conf ...` in
  `bwrapArgs(spec)` with real defaults. No current assertion forbids extra `--ro-bind` entries (`runs-p2` checks
  `--bind` only, `runs-guides` looks for the usersecrets bind by source). The builder re-runs them.
- **bwrap creating the mount point inside the tmpfs**: standard bwrap behaviour (parents are created with `mkdir -p` in
  the new root). A real-bwrap test (below) proves it where user namespaces are allowed.
- **Never bind a nonexistent source**: guaranteed because `bind` is only set after `realpathSync` and `statSync().isFile()`
  succeed. There is a small race if the file vanishes between the check and the bwrap start. Then bwrap fails to start
  that one command, as for any vanished bind. That is acceptable and the same exposure as the existing mask loop.
- `GWP-246` may touch `RunManager` call sites. The change here is a small additive block after `sandboxCommand`, so
  merge conflicts should be trivial.

## Tests

New `apps/runner/test/run-sandbox-dns.test.ts`, with a fake host tree in a tmp dir:
`<t>/run/systemd/{private,journal/,notify,resolve/stub-resolv.conf,resolve/resolv.conf,resolve/io.systemd.Resolve}`
(the socket can be a plain file for the arg test) and `<t>/etc/resolv.conf`. Pass `systemMasks: [<t>/run/systemd]`
and `resolvConf: <t>/etc/resolv.conf`, `runnerRoot`/`realHome` = fresh tmp dirs.

1. **Stub symlink** (`etc/resolv.conf -> ../run/systemd/resolve/stub-resolv.conf`): args contain `--tmpfs <t>/run/systemd`,
   then later `--ro-bind <t>/run/systemd/resolve/stub-resolv.conf <same>`. The ro-bind index is greater than the tmpfs
   index. **No** argument names `private`, `journal`, `notify`, `io.systemd.Resolve` or the folder
   `<t>/run/systemd/resolve` as a bind source/dest. Every bind destination under `<t>/run/systemd` equals the stub file.
   No warning.
2. **Upstream symlink** (`-> ../run/systemd/resolve/resolv.conf`): binds `resolve/resolv.conf` only.
3. **Plain file**: no argument under `<t>/run/systemd` other than the `--tmpfs`; no warning.
4. **Dangling into the mask** (target missing): no bind (no nonexistent source), and `sandboxCommand(...).warning`
   matches `/^run sandbox: DNS unavailable, .* points into masked .*run\/systemd/`.
5. **Missing resolv.conf**: warning `... is missing on this host`; args valid.
6. **`network: 'none'`**: no resolver bind and no warning, even for case 1. `--unshare-net` present
   (handoff-checks-offline stays green).
7. **Target inside a non-system mask** (for example a resolv.conf symlinked into the fake `runnerRoot`): never bound; warning.
8. Manager: with a `checkLaunch`/`launch` fake whose spec yields a warning, `deps.log.warn` is called once for two
   launches. Follow the `netnsWarned` test pattern in `handoff-checks-offline.test.ts`.
9. Optional real test, `describe.skipIf(!bwrapWorks || !isSymlinkIntoRunSystemd)`: run
   `bwrap <bwrapArgs(spec defaults)> -- sh -c 'ls -A /run/systemd; ls -A /run/systemd/resolve; cat /etc/resolv.conf'`
   and expect `resolve`, the single file name, and a `nameserver` line.

Then run the existing suites named on the card (runs, runs-p2, runs-tester, runs-guides, runs-rebase-error,
post-as-git-steps, sandbox-caches, check-run, handoff-checks-offline).

Manual/integration (tester or DevOps, on this systemd-resolved workstation, outside the agent shell sandbox, which cannot
nest user namespaces): `getent hosts registry.npmjs.org` and `ls /run/systemd /run/systemd/resolve` as a run step;
`pnpm install` with an uncached dependency and a clean run HOME; a shift handoff whose checks run offline.

## Acceptance criteria mapping

| AC | Covered by |
|---|---|
| Stub-symlink host: `getent hosts` returns an address | resolver file bound (C); stub reachable on host network (Finding 2); test 1, real test 9, manual step |
| `pnpm install` with an uncached dependency completes | same; manual step (DevOps/tester) |
| Plain resolv.conf: no regression | `resolverMount` returns `{}`; test 3 |
| Rest of `/run/systemd` hidden; unit test on bwrap args | only the file is bound after the tmpfs; tests 1, 2 assert private/journal/notify/sockets absent |
| No usable resolver: fail fast + logged warning | `warning` + `log.warn` once; glibc falls back to the refused `127.0.0.1` at once; tests 4, 5, 7, 8 |
| Handoff checks still pass offline | `network: 'none'` path untouched; test 6 + `handoff-checks-offline.test.ts` |
| Existing run-sandbox tests pass | builder runs the listed suites |
| `docs/RUNNER.md` describes DNS | Docs section above |
