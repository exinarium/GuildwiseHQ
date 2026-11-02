# GWP-55: `aom` fails in bypass-mode CEO owner turns ("AOM_SHIFT_TOKEN is not set")

## Question

In a CEO owner-chat turn with `ceo.ownerPermissions = 'bypass'` (runner started with `full-power on --bypass`), every
`aom ...` command fails with `AOM_IPC_URL / AOM_SHIFT_TOKEN are not set: aom only works inside an agent shift`. The same
command works in an `auto` owner turn. Why, and what is the smallest fix that keeps bypass mode's credential protection?
The card also asks whether the repeated "Authorize this execution? Bash" desk prompt (x5) has the same cause.

## Findings

### 1. The runner gives both modes the same AOM_* variables

- `ChatManager.runOwnerTurn` (`apps/runner/src/chat/chat.ts:743-798`) builds the environment once for both modes:
  `ipcEnv` (`AOM_IPC_URL`, `AOM_IPC_SOCKET` when there is a socket, `AOM_SHIFT_TOKEN`) plus `AOM_SHIFT_ID`,
  `AOM_CEO_TURN_DIR` and `PATH`. It passes `permissionMode` to the adapter separately. Nothing here depends on the mode.
- `buildClaudeOwnerTurnCommand` (`apps/runner/src/adapters/claude-code.ts:299-346`) copies the parent env, then
  `HOME`, `input.env` and the provider credential into the `claude` process env, in that order, for both modes. The only
  difference between the modes is line 344:
  `if (ownerBypasses(input)) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';`
- The existing harness test `aom runner status|logs in a turn` (`ceo-full-power-diagnostics.test.ts:272+`) already runs
  with `ownerPermissions: 'bypass'` and reads `env.AOM_IPC_URL` / `env.AOM_SHIFT_TOKEN` successfully. But it reads the
  env the **runner hands to the adapter**, not the env a Bash command sees inside Claude Code. That is why it stays
  green while the real turn fails.

So the card's first suspicion (the bypass branch builds the child env from the owner's shell and drops the AOM_* vars)
is not what happens. The planner's hypothesis (b) is right.

### 2. Root cause: Claude Code's subprocess env scrub removes `AOM_SHIFT_TOKEN`

`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` makes Claude Code strip credentials from the environment of every subprocess it
starts: Bash commands, hooks and stdio MCP servers. Its official documentation
(https://code.claude.com/docs/en/env-vars, section "What the subprocess environment scrub removes") says:

- the scrub "recognizes a credential by its variable name or by the shape of its value";
- `NPM_TOKEN`, `DB_PASSWORD`: "Removes it, because the name looks like a credential";
- only `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, proxy and `GIT_CONFIG_*` vars are
  kept;
- "Before v2.1.251, the scrub removed `ANTHROPIC_API_KEY` and `AWS_SECRET_ACCESS_KEY` and left the table's other
  example variables unchanged";
- on Linux it also runs Bash in an isolated PID namespace (this does not affect `aom`, which talks over the IPC
  socket/loopback).

`AOM_SHIFT_TOKEN` has a credential-looking name, and its value is also credential-shaped: 32 random bytes in base64url
(`IpcServer.registerShift`, `apps/runner/src/ipc/server.ts:96-100`). Since Claude Code 2.1.251 the scrub therefore
removes it from every Bash command of a bypass turn. `aom`'s `ipc()` (`apps/runner/src/aom/aom-cli.ts:194-200`) then
refuses, correctly. `AOM_IPC_URL` (`http://127.0.0.1:<port>`), `AOM_IPC_SOCKET` (a path), `AOM_SHIFT_ID` (a uuid) and
`AOM_CEO_TURN_DIR` (a path) have neither a credential name nor a credential-shaped value, so they survive.

The same documentation also says: "A secret whose variable name and value don't look like a credential: Leaves it in
place" and "Leave the scrub unset if a subprocess needs one of the removed variables". So the path-valued
`AOM_CEO_TURN_DIR` is safe to depend on, and Claude Code offers no per-variable exemption.

Not affected: the deny-floor `PreToolUse` hook (`aom ceo guard`) is also a scrubbed subprocess, but it reads only
`AOM_CEO_TURN_DIR` (`GUARD_ENV`, `ceo/guard-hook.ts:30`) and never the token, so it keeps working in bypass. The relay MCP
server (`ceo-permission-mcp`) is a scrubbed stdio MCP server too. Its explicit `env` holds the token, which the scrub
probably removes as well. In bypass the relay is never called, so this does not show today. The design below covers it
anyway.

The runner already knows about this. The `scrubSubprocessEnv` option of the agent shifts (`apps/runner/src/config.ts:60-66`)
is off by default "because it also removes variables Claude Code considers credentials, which may include the shift
token the `aom` CLI needs". The bypass branch turns the scrub on unconditionally, so it hits exactly that case. A
runner restart cannot help, and auto mode works because it never sets the scrub. That matches the evidence on the card.

### 3. What the scrub protects must stay

The scrub is there so that, with no classifier or relay in front of the shell, a Bash command cannot read the runner's
provider credential (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`) or the owner's own cloud keys from its env
(comment at `claude-code.ts:342-343`; test "keeps the provider credential from its shell"). The card forbids weakening
this, so turning the scrub off, or narrowing it, is not an option.

Claude Code has no allow-list setting that exempts a variable from the scrub; the documentation gives none.

## Options

| # | Option | Fixes bypass | Keeps scrub | Touches `aom` CLI | Verdict |
|---|---|---|---|---|---|
| A | Drop `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` in bypass | yes | **no**: provider credential readable by `env` | no | Rejected: card constraint |
| B | Rename the variable (for example `AOM_SHIFT_KEY_REF`) | not reliably: the scrub also matches the **value** shape (43-char random base64url) | yes | yes, and every caller | Rejected: fragile against the next scrub heuristic |
| C | Put the AOM_* vars in the `env` block of `floor.json` (`--settings`) | unknown, probably not: the scrub applies to the subprocess env whatever its source | yes | no | Rejected: undocumented, likely does not work |
| D | `BASH_ENV` / `CLAUDE_CODE_SHELL_PREFIX` wrapper that re-exports the vars | partly: shell-specific (bash/zsh, login vs non-login), also wraps hooks and MCP servers, and the owner's own settings may already set it | yes | no | Rejected: fragile and it intrudes on the owner's own Claude Code |
| **E** | The runner writes the turn's shift variables to a 0600 file in the 0700 turn dir; `aom` fills any **missing** AOM_* variable from `<AOM_CEO_TURN_DIR>/shift-env.json` | **yes**: `AOM_CEO_TURN_DIR` survives the scrub | **yes** | yes: where the token is read from, not the check | **Recommended** |

Why E does not loosen anything:

- `aom` still refuses without a token. The token still has to be one the IPC server has registered for a live turn
  (`IpcServer.handle` returns 401 otherwise). Only where the CLI *reads* the value changes, and only when the env lacks
  it. The env always wins.
- The file holds nothing the auto-mode shell cannot already read from its own env. The token only authorizes this
  turn's own IPC handler (the CEO's `aom` verbs), which a bypass turn may run anyway. The provider credential is never
  written to it.
- It lives in `<runner root>/ceo-turns/<chatId>/` (0700, written 0600 like the other turn files), is removed with the
  turn dir, and the token is revoked when the turn ends.
- The file is read from one fixed name inside the directory that `AOM_CEO_TURN_DIR` names. The CLI's confined reader
  (for `--file` and the like) is not involved and not widened.

The card says the CLI's shift-token check "should not change". Option E keeps the check as it is (no token, no
`aom`) and only adds a second source for the token. No option that keeps the scrub can avoid touching the CLI's token
source. This is the one deliberate deviation from the card's affected areas.

## Design (option E)

### New module: `apps/runner/src/ceo/shift-env.ts` (the single shared step, requirement 3)

The one place that knows the owner-turn shift variables. Used by the runner when it starts a turn and by the `aom` CLI
(which bundles everything, `tsup.config.ts`), so the two cannot drift.

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_ENV } from './guard-hook.ts'; // 'AOM_CEO_TURN_DIR'

export const SHIFT_ENV_FILE = 'shift-env.json';
/** The variables of an owner/order turn that `aom` needs; the scrub of a bypass turn may remove any of them. */
export const OWNER_SHIFT_KEYS = ['AOM_IPC_URL', 'AOM_IPC_SOCKET', 'AOM_SHIFT_TOKEN', 'AOM_SHIFT_ID', GUARD_ENV] as const;

/** The shift variables of one CEO turn, for both permission modes (bypass and auto). Pure. */
export function ownerTurnShiftEnv(i: {
  ipcUrl: string; ipcSocket?: string; token: string; chatId: string; turnDir: string;
}): Record<string, string> {
  return {
    AOM_IPC_URL: i.ipcUrl,
    ...(i.ipcSocket ? { AOM_IPC_SOCKET: i.ipcSocket } : {}),
    AOM_SHIFT_TOKEN: i.token,
    AOM_SHIFT_ID: i.chatId,
    [GUARD_ENV]: i.turnDir,
  };
}

/** `<turnDir>/shift-env.json` (0600): how `aom` finds the variables Claude Code's subprocess scrub removed. */
export function writeShiftEnvFile(turnDir: string, env: Record<string, string>): void {
  writeFileSync(join(turnDir, SHIFT_ENV_FILE), JSON.stringify(env), { mode: 0o600 });
}

/**
 * The env `aom` works with: when AOM_SHIFT_TOKEN or AOM_IPC_URL is missing and AOM_CEO_TURN_DIR names a turn folder,
 * the missing AOM_* shift variables are filled from its shift-env.json. A variable already in the env always wins;
 * only OWNER_SHIFT_KEYS are taken, only string values; any read/parse error leaves the env as it is (the usual "not
 * set" error follows). Never logs the values.
 */
export function resolveShiftEnv(
  env: Record<string, string | undefined>,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string | undefined> { /* ... */ }
```

Traps for `resolveShiftEnv`:
- Do nothing when both `AOM_SHIFT_TOKEN` and `AOM_IPC_URL` are present (a normal agent shift never touches the disk).
- Do nothing when `AOM_CEO_TURN_DIR` is unset or not absolute.
- Cap the read (the file is around 300 bytes; refuse over about 8 KB) and accept only a plain object of strings.
- Return a new object; do not mutate `process.env`.

### `apps/runner/src/chat/chat.ts`, `runOwnerTurn`

Replace the inline `ipcEnv` and the `AOM_SHIFT_ID` / `AOM_CEO_TURN_DIR` literals with one call:

```ts
const shiftEnv = ownerTurnShiftEnv({
  ipcUrl: this.deps.ipc.url,
  ...(this.deps.ipc.socketPath ? { ipcSocket: this.deps.ipc.socketPath } : {}),
  token: chat.token,
  chatId: msg.chatId,
  turnDir,
});
writeTurnFiles({ turnDir, ..., shiftEnv });               // was ipcEnv
chat.session = await adapter.startOwnerTurn({
  ...,
  env: { ...shiftEnv, PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ''}` },
  permissionMode,
});
```

The env stays identical for both modes. `permissionMode` still only reaches the adapter's flag and scrub decision.

### `apps/runner/src/ceo/turn-files.ts`, `writeTurnFiles`

- `TurnFilesInput.ipcEnv` becomes `shiftEnv` (the full `ownerTurnShiftEnv` result). Update the one test call site in
  `ceo-full-power-diagnostics.test.ts:139` (`ipcEnv: {}` becomes `shiftEnv: {}`) and any other caller the type check
  finds.
- Write `shift-env.json` through `writeShiftEnvFile(turnDir, shiftEnv)` after the dir is created (0700).
- The relay MCP config env becomes `{ ...i.shiftEnv, AOM_PERMISSION_MODE: i.mode }`, so the relay also gets
  `AOM_CEO_TURN_DIR` and can fall back the same way if its explicit env is scrubbed. In bypass the relay is normally
  never called, but this keeps the relay from failing silently.

### `apps/runner/src/aom/aom-cli.ts`, entry block (around line 2992)

```ts
if (isEntry) {
  const env = resolveShiftEnv(process.env);
  const confined = confinedReader(env, process.cwd());
  ...
  return runAom(process.argv.slice(2), {
    env,
    ...
    fetch: env.AOM_IPC_SOCKET ? socketFetch(env.AOM_IPC_SOCKET, fetch) : fetch,
    ...
  });
}
```

`ipc()` (line 194) and its error message stay **unchanged**. The fallback sits only at the entry, so every verb
(`aom ceo intake|devops|notify`, `aom runner logs|status|restart`, `ceo-permission-mcp`, `ceo guard`) gets it.

### `apps/runner/src/adapters/claude-code.ts`

No behaviour change. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` stays for bypass. Update the comment at line 342-344 to say
that the scrub also removes `AOM_SHIFT_TOKEN`, and that `aom` recovers it from `<AOM_CEO_TURN_DIR>/shift-env.json`
(`ceo/shift-env.ts`). Also extend the `scrubSubprocessEnv` comment in `config.ts:60-66` to say the CEO turns are covered
by the file fallback and the agent shifts are not yet.

### Docs

- `docs/design/ceo-front-door.md` section 14.1 (permission modes): one paragraph saying that bypass turns run with
  Claude Code's subprocess env scrub, that this removes the shift token from Bash, and that `aom` reads the turn's
  `shift-env.json` instead (0600, removed with the turn dir).
- `docs/RUNNER.md`, at the `scrubSubprocessEnv` note: the same in one sentence.

### Data model and API

No server, schema, IPC protocol or `packages/shared` change. The AOM_* names are runner-local strings (no constants for
them exist in `packages/shared`). One new file in the turn dir: `shift-env.json` (`{AOM_IPC_URL, AOM_IPC_SOCKET?,
AOM_SHIFT_TOKEN, AOM_SHIFT_ID, AOM_CEO_TURN_DIR}`).

## Tests

All tests are unit tests in `apps/runner/test`. None needs the network or a real Claude.

1. **Builder, both modes** (extend `ceo-full-power-diagnostics.test.ts`, describe `permission mode of the CEO turns`):
   build `input({ env: ownerTurnShiftEnv(fake), permissionMode })` for `'bypass'` and `'auto'`. For each mode and each
   key in `OWNER_SHIFT_KEYS`, assert `c.env[key] === fake[key]`. Bypass still has `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
   and auto has none. Keep the existing "keeps the provider credential from its shell" test exactly as it is.
2. **Runner → adapter, both modes** (extend `aom runner status|logs in a turn`): for `ownerPermissions` `bypass` and
   `auto`, inside the wrapped `startOwnerTurn`, check:
   - every `OWNER_SHIFT_KEYS` entry is present;
   - `AOM_SHIFT_ID === m.chatId`;
   - `AOM_CEO_TURN_DIR === turnDirOf(h.runner.paths.root, m.chatId)`;
   - `<AOM_CEO_TURN_DIR>/shift-env.json` parses to exactly those values and has mode 0600 (skip the mode check on
     win32). Read it inside the callback, before the turn dir is removed.
3. **The scrub regression** (new file `apps/runner/test/ceo-owner-shift-env.test.ts`). In the harness, inside a bypass
   owner turn, take the env the adapter got and simulate the scrub: delete every key matching
   `/TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i` except the `GITHUB_*`/`GH_*` names. Then:
   - `runAom(['runner', 'status'], { env: resolveShiftEnv(scrubbed), fetch, io, readFile })` returns 0, and its output
     has `runnerVersion` and not `not set`. Use the real `fetch`: the harness IPC listens on loopback.
   - The same call with the **unresolved** scrubbed env fails with the existing `AOM_SHIFT_TOKEN are not set` message.
     This is the fail-before-fix proof and shows the check is unchanged.
4. **`resolveShiftEnv` unit cases** (same new file, using a fake `read`):
   - env values win over the file;
   - no `AOM_CEO_TURN_DIR`, a relative dir, a missing file, bad JSON, a non-object, non-string values and an oversized
     file all leave the env unchanged;
   - only `OWNER_SHIFT_KEYS` are copied (an extra `PATH` or `ANTHROPIC_API_KEY` key in the file is ignored);
   - when token and URL are both present, `read` is never called.
5. **No secret in snapshots or logs**: use no snapshot of the env. Assert values with `toBe` against the fake. The
   audit log test (`permission mode: bypass`) must not contain the token (`expect(audit).not.toContain(token)`).

Confirm before the fix: test 3 fails on the base commit. The first bullet fails because `shift-env.json` does not exist
and `resolveShiftEnv` does not exist yet.

Run: `pnpm --filter @aom/runner test` and `pnpm --filter @aom/shared test` (both unit only), plus
`pnpm --filter @aom/runner typecheck`.

## Acceptance criteria

| AC | Covered by |
|---|---|
| Bypass turn gets AOM_SHIFT_TOKEN, AOM_SHIFT_ID, AOM_IPC_URL, AOM_IPC_SOCKET, AOM_CEO_TURN_DIR with the turn's values | `ownerTurnShiftEnv` used once in `runOwnerTurn`; tests 1 and 2 (bypass). The Bash-level part, where the scrub removes the token: `shift-env.json` + `resolveShiftEnv`, test 3 |
| Auto turn still gets the same vars | Same helper, tests 1 and 2 (auto) |
| Bypass still keeps the provider credential from its shell; existing test passes | `claude-code.ts` unchanged; existing test kept; test 1 re-asserts the scrub flag |
| New/extended test covers both modes and fails if any var is missing | Tests 1 and 2 loop over `OWNER_SHIFT_KEYS` for both modes; test 3 fails before the fix |
| On a `--bypass` runner, `aom ceo notify` (or a read-only verb) succeeds in an owner turn | Test 3 at unit level; manual check left for the tester / owner on a DevBox runner (see below) |
| Runner and shared suites pass | Builder runs both suites |

Manual check (tester or owner, DevBox):
1. Build a runner from the fix and start it with `--bypass`.
2. In the CEO owner chat, ask for `aom runner status` and then `aom ceo notify ...`. Both must succeed.
3. Ask for `env | grep AOM_`. `AOM_SHIFT_TOKEN` will still be absent (that is the scrub working), and `aom` still works.
4. Ask for `env | grep -i -E 'anthropic|oauth'`. Nothing may show.
5. Repeat with `ownerPermissions = auto`.

## Risks

- **Claude Code changes the scrub again** (for example it starts scrubbing path-valued vars). Then `AOM_CEO_TURN_DIR`
  could go too. That is unlikely, because a path is neither credential-named nor credential-shaped. Test 3's simulated
  scrub documents the assumption, and the env-var docs link sits in the code comment.
- **Turn dir not removed** (runner crash): the file stays 0600 inside the 0700 runner-owned dir, and the token is dead
  once the runner restarts (tokens live in memory). This is the same exposure as the existing `aom-permission.json`,
  which already holds the token today (`turn-files.ts:132`).
- **Base branch**: the card says "fix on main", but `aom card facts` shows the card branch is based on `release/1.5.0`.
  The change is small and self-contained, so it merges either way. The runner and owner decide where it lands; the
  builder does not change branches.

## Related signal: "Authorize this execution? Bash" (x5): different cause

The desk question "Authorize this execution? Bash" is raised by the permission relay (`ceo/permission-relay.ts`,
`op: 'permission', sub: 'ask'`). Claude Code calls the relay (`--permission-prompt-tool`) only when a tool call needs a
permission it lacks. In `bypassPermissions` mode it never asks. So the repeated prompts came from **auto** turns (owner
auto or standing-order turns), where the scrub is never set. They are **not** caused by this bug, and this card does
not change them.

Likely causes, for a separate card (not verified against the desk data, which this workstation cannot read):
1. "Allow for the rest of the turn" is kept in the relay process (`turnAllowed`), which lives for one `claude -p`
   process. Every new owner message is a new process, so the same Bash approval is asked again on every message.
2. `--allowedTools 'Bash(aom:*)'` only matches a command that starts with `aom`. `cd x && aom ...`, `aom ... | head`,
   `env | grep AOM` and the like go to the classifier and then to the relay. While `aom` was broken, the CEO probably
   tried several such diagnostic variants in a row.
3. Each denied or timed-out ask is retried by the model with a slightly different command, which adds more prompts.

This is filed on the project backlog as a suggestion ("CEO desk: repeated 'Authorize this execution? Bash' approvals in
auto turns"). The manager decides whether it becomes a card.

## Related latent bug (follow-up, not in scope)

Agent shifts with `claude.scrubSubprocessEnv: true` hit the same scrub. Since Claude Code 2.1.251 they lose
`AOM_SHIFT_TOKEN` too, which the config comment already half-predicts. They have no `AOM_CEO_TURN_DIR`, so this card's
fallback does not help them. A follow-up could generalize `shift-env.json` to every shift, through a non-credential
pointer variable (for example `AOM_SHIFT_ENV_FILE`) in a place the sandboxed shell can read. This is filed on the
backlog as a suggestion ("Agent shifts with scrubSubprocessEnv lose AOM_SHIFT_TOKEN").
