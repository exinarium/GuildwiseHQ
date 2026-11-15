# GWP-227: agent shifts with `scrubSubprocessEnv` lose `AOM_SHIFT_TOKEN`

Follow-up to `docs/investigations/GWP-55-bug-in-ceo-owner-chat-turns-run-in-bypass-permissi.md` (root cause, Claude Code
scrub behaviour, option comparison). This document is the design for making that fix cover every session.

## 1. Question

Since Claude Code 2.1.251, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes credential-named and credential-shaped variables
(such as `AOM_SHIFT_TOKEN`) from the environment of every Bash child. GWP-55 fixed this only for CEO owner turns (a
`shift-env.json` in the turn dir, found through `AOM_CEO_TURN_DIR`). How do we give every session that receives an
`AOM_SHIFT_TOKEN` a way for `aom` to find it when the scrub is on, without widening any sandbox, without logging the
token and without changing behaviour when the scrub is off?

## 2. Findings

### 2.1 Where a shift token is issued today (all `IpcServer.registerShift` callers)

| Site | Session | Revoked at | Runtime |
| --- | --- | --- | --- |
| `shifts/supervisor.ts:1549-1556` (`s.env`) | every background shift (builder, BA, tester, reviewer, architect, DevOps, CEO wake ...) incl. `testerShiftEnv` merged at ~1606 | `supervisor.ts:716` (`finally` of `handleStart`) | any adapter |
| `chat/chat.ts:760` (`runOwnerTurn`, `ownerTurnShiftEnv`) | CEO owner / order turn | `chat.ts:339` (`finally` of the chat run) | `startOwnerTurn` (unsandboxed) |
| `chat/chat.ts:1011` | session turn (meeting/board) | `chat.ts:339` | `startChat` |
| `chat/chat.ts:1090` | direct-model chat | `chat.ts:339` | direct-model (no shell) |
| `chat/chat.ts:1261` | interactive chat, @mention work, intake, review chat | `chat.ts:339` | `startChat` |
| `delegate/delegate.ts:409` | delegated child run | `delegate.ts:519` | any adapter |
| `health/role-smoke.ts:197` | role smoke test | `role-smoke.ts:249` | any adapter |

Every site builds the same block by hand: `AOM_IPC_URL`, `AOM_IPC_SOCKET` (when there is a socket), `AOM_SHIFT_TOKEN`,
`AOM_SHIFT_ID`. Every revoke is in a `finally`, so it runs on normal end, failure and kill (a killed session ends its
`run`, which unwinds into the `finally`).

### 2.2 How the scrub reaches a session

- `adapters/claude-code.ts:159` `sessionEnv`: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` when `claude.scrubSubprocessEnv` is
  true (never for unsandboxed DevOps). `sessionEnv` is used by `buildClaudeCommand` (shifts, delegates, smoke) and
  `buildClaudeChatCommand` (chats).
- `buildClaudeOwnerTurnCommand` (`claude-code.ts:352`) always scrubs a bypass owner turn.
- Backend runs (Bedrock/Vertex/gateway) set the scrub too (docs/RUNNER.md line ~1202).
- `input.env` (the session variables above) flows unchanged into the agent env through `agentEnv` (`claude-policy.ts:1084`)
  for Claude Code, Codex (`codex.ts:368/495/1012`), Gemini (`gemini.ts:271`) and Opencode (`opencode.ts:209`). So a
  variable added to the session env reaches every runtime without adapter changes.

### 2.3 Where `aom` runs and what it can read

- `aom` is in the sandbox's `excludedCommands` (`aomExcluded`, `claude-policy.ts:589`): it runs **outside** bubblewrap /
  Seatbelt as the runner user (Linux seccomp blocks Unix sockets inside the sandbox). The scrub is applied to the Bash
  child's environment regardless, which is why the token disappears even though the process is unsandboxed.
- So in practice `aom` can read any runner-user file. The sandbox read rule for the env dir matters for a sandboxed
  shell (`cat`, a piped `aom` that falls back into the sandbox, macOS) and is what the card's isolation criterion tests.
- The sandbox `denyRead` holds the whole runner root (`claude-policy.ts:419-426`, or `denyAround(runnerRoot, cwd)` for a
  read-only worktree role); `allowRead` beats `denyRead`, and `allowRead` must never name a directory that holds a
  writable path (comment at `claude-policy.ts:480-482`).
- The config dir (and so `settings.json`) is per agent per account (`sandbox.ts:176`), rewritten at every session start.

### 2.4 The scrub's matching rules (from GWP-55 section 2)

The scrub matches a variable by **name** (TOKEN, SECRET, KEY, PASSWORD, ...) **or by the shape of its value** (long
random base64). `AOM_CEO_TURN_DIR`, a path containing a chat id, survives (verified in GWP-55). A pointer variable is
therefore safe only if both its name and its value look harmless: a plain path, with no long random segment.

### 2.5 The token in other places (AC: never in logs or argv)

The token is only in environment variables and 0600 files (the CEO relay's `aom-permission.json`); it is never in argv.
Nothing in the new path may log the file content; the path may be logged.

## 3. Options

| # | Option | Covers all sessions | Isolation | Verdict |
| --- | --- | --- | --- | --- |
| A | Turn the scrub off when a token is present | yes | no: defeats the scrub | Rejected (card constraint) |
| B | Rename `AOM_SHIFT_TOKEN` | no: the value shape still matches | n/a | Rejected (GWP-55 option B) |
| C | Env file in the agent's private tmp (`<sandbox.tmp>/session-env/...`) | yes | readable and **writable** by the agent; tmp is shared by the agent's concurrent sessions and swept by the tmp lifecycle | Rejected: the agent could replace the file, and the tmp sweep would race the session |
| D | Env file next to each caller's own folder (turn dir style) | needs a folder per session that does not exist for shifts | mixed | Rejected: no uniform place |
| **E** | **One runner-private root `<runnerRoot>/session-env/` (0700), one 0700 dir per issued token, `env.json` 0600 inside; pointer `AOM_SHIFT_ENV_FILE`; the session's own dir added to that session's `allowRead`** | yes, through one helper used by every `registerShift` caller | denied to every other agent by the runner-root deny; not writable by any agent (`RUNNER_PRIVATE`) | **Recommended** |

Lifecycle sub-options for E:

| | Where the file is written and removed | Verdict |
| --- | --- | --- |
| E1 | Inside each adapter's `start` | Rejected: four adapters plus the owner turn, and the adapters do not own the token's lifetime |
| E2 | Inside `IpcServer` (`registerShift` writes, `revoke` removes) | Rejected: mixes file I/O into the transport |
| **E3** | **A small helper `issueShiftCredential` that registers the token, builds the IPC env block, writes the file and returns a `revoke()` that revokes the token and removes the file; every caller uses it** | **Recommended**: the file's life equals the token's life by construction, and the five copy-pasted env blocks become one |

## 4. Recommendation and design

### 4.1 New module `apps/runner/src/session/shift-credential.ts`

Replaces `apps/runner/src/ceo/shift-env.ts` (that file is deleted; its tests move, see 4.9).

```ts
/** The variable that names the session's env file. No TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL/AUTH in it (the scrub keeps it). */
export const SHIFT_ENV_POINTER = 'AOM_SHIFT_ENV_FILE';
/** What the file holds and what `aom` may fill from it (same set as GWP-55's OWNER_SHIFT_KEYS). */
export const SHIFT_ENV_KEYS = ['AOM_IPC_URL', 'AOM_IPC_SOCKET', 'AOM_SHIFT_TOKEN', 'AOM_SHIFT_ID', 'AOM_CEO_TURN_DIR'] as const;
export const SESSION_ENV_DIR = 'session-env';          // <runnerRoot>/session-env (0700)
export const SESSION_ENV_FILE = 'env.json';            // <runnerRoot>/session-env/<id>/env.json (0600)
/** Legacy GWP-55 name, read only (fallback c). Remove one release after this change. */
export const LEGACY_SHIFT_ENV_FILE = 'shift-env.json';
const MAX_BYTES = 8 * 1024;

export const sessionEnvRoot = (runnerRoot: string) => join(runnerRoot, SESSION_ENV_DIR);

/** `<root>/session-env/<id>` when `file` is exactly `<root>/session-env/<one segment>/env.json`, else undefined. */
export function sessionEnvDirOf(file: string | undefined, runnerRoot: string): string | undefined;

export interface IssuedShiftCredential {
  token: string;
  /** AOM_IPC_URL, AOM_IPC_SOCKET (unless socket:false or none), AOM_SHIFT_TOKEN, AOM_SHIFT_ID, AOM_SHIFT_ENV_FILE, ...extra */
  env: Record<string, string>;
  /** Absolute path of env.json; undefined when writing failed (the session then runs exactly as before GWP-227). */
  file?: string;
  /** Revokes the token and removes the session dir. Idempotent, never throws. */
  revoke(): void;
}

export function issueShiftCredential(
  deps: {
    ipc: Pick<IpcServer, 'url' | 'socketPath' | 'registerShift' | 'revoke'>;
    runnerRoot: string;
    log?: { warn(msg: string): void };
  },
  i: {
    sessionId: string;              // shiftId / chatId / delegateId / smoke id
    handler: ShiftIpcHandler;
    /** Extra shift variables that belong in the file too (the owner turn's AOM_CEO_TURN_DIR). */
    extra?: Partial<Record<(typeof SHIFT_ENV_KEYS)[number], string>>;
    /** false: no AOM_IPC_SOCKET (the direct-model chat never had one; keeps its env unchanged). Default true. */
    socket?: boolean;
  },
): IssuedShiftCredential;

/** Writes env.json atomically: mkdir root 0700 + dir 0700, write `<dir>/.env.json.<pid>.tmp` (flag 'wx', mode 0600), chmod 0600, rename. */
export function writeSessionEnvFile(dir: string, env: Record<string, string>): string;

/** Removes every entry of `<root>/session-env` whose dir name is not live; (re)creates the root with 0700. Returns the count. */
export function sweepSessionEnvFiles(runnerRoot: string, isLive: (dirName: string) => boolean = () => false): number;

export interface ShiftEnvAttempt {
  source: 'pointer' | 'legacy';
  path: string;
  problem?: 'not_absolute' | 'missing' | 'unreadable' | 'too_large' | 'invalid' | 'no_token';
}

/**
 * The env `aom` works with, and what it tried:
 *  (a) AOM_SHIFT_TOKEN in env: env returned as is, nothing read (attempts: []).
 *  (b) else AOM_SHIFT_ENV_FILE (absolute): fill MISSING SHIFT_ENV_KEYS from it; env values always win.
 *  (c) else, or when (b) gave no token, AOM_CEO_TURN_DIR/shift-env.json (legacy, one release).
 * Never throws; never puts file content into an error or a log line.
 */
export function resolveShiftEnv(
  env: NodeJS.ProcessEnv,
  read?: (path: string) => string,
): { env: NodeJS.ProcessEnv; attempts: ShiftEnvAttempt[] };
```

Details for the builder:

- **Dir name**: `${safe(sessionId)}.${randomBytes(4).toString('hex')}` where `safe` keeps `[A-Za-z0-9_-]` and caps the
  length at 64. The random suffix keeps two registrations of one id (a chat's next turn racing the previous turn's
  cleanup) apart; 8 hex characters keep the path from looking like a credential value (2.4). Do **not** use a long random
  name.
- **File content**: a flat JSON object of the `SHIFT_ENV_KEYS` present (same shape as the legacy `shift-env.json`, so one
  parser serves both). The pointer itself is not in the file.
- **Atomic write**: the temp file lives in the same 0700 dir, so a partial file is never at the final name and never
  visible to another user. Use `writeFileSync(tmp, json, { mode: 0o600, flag: 'wx' })`, `chmodSync(tmp, 0o600)` (umask),
  `renameSync(tmp, file)`. `chmodSync` of the dirs after `mkdirSync` (umask again); both in try/catch for Windows.
- **Write failure** (disk full, permissions): `log.warn('could not write the session env file <path>: <err.code>')` and
  return `env` without `AOM_SHIFT_ENV_FILE` and `file` undefined. The session still starts; with the scrub off nothing
  changes, with it on `aom` fails with the clear message of 4.5. Never fail a shift because of this file.
- **revoke()**: `ipc.revoke(token)` then `rmSync(dir, { recursive: true, force: true })` in a try/catch; guard with a
  `done` flag so a second call does nothing.
- The token must never appear in a log line, an error message or a thrown error. Errors carry the path and `err.code` only.

### 4.2 Callers (replace `registerShift` + hand-built block + `revoke`)

Each caller keeps its own `token` field (other code reads it) but stores the credential and calls `revoke()` in the
existing `finally` instead of `ipc.revoke(token)`.

| File | Change |
| --- | --- |
| `shifts/supervisor.ts:1549-1556` | `const cred = issueShiftCredential({ ipc: this.deps.ipc, runnerRoot: this.deps.paths.root, log: this.log }, { sessionId: msg.shiftId, handler: this.handlerFor(s) })`; `s.token = cred.token; s.credential = cred;` and `s.env = { ...sandboxEnv(...), ...cred.env, ...(AOM_WORKDIR), ..., PATH }`. Line 716: `shift.credential?.revoke()` (fall back to `ipc.revoke(shift.token)` only if there is a token but no credential). Add `credential?: IssuedShiftCredential` to `ActiveShift`. The tester's `testerShiftEnv` is merged into `s.env` later (line ~1606) and needs nothing: the pointer is already in `s.env`. |
| `chat/chat.ts:760-787` (`runOwnerTurn`) | `issueShiftCredential(..., { sessionId: msg.chatId, handler, extra: { AOM_CEO_TURN_DIR: turnDir } })`; `shiftEnv = cred.env` replaces `ownerTurnShiftEnv(...)`. `writeTurnFiles` no longer writes a shift-env file (4.3). |
| `chat/chat.ts:1011`, `:1261` | same helper, `sessionId: msg.chatId`; env block replaced by `...cred.env`. |
| `chat/chat.ts:1090` (`runDirectChat`) | same helper with `socket: false` so its env is unchanged apart from the pointer (the direct-model adapter reads `AOM_SHIFT_TOKEN` from `input.env` itself and ignores the pointer). |
| `chat/chat.ts:339` | `chat.credential?.revoke()` (add `credential?` to `ActiveChat`). |
| `delegate/delegate.ts:409-416`, `:519` | helper with `sessionId: delegateId`; `revoke()` in the `finally`. |
| `health/role-smoke.ts:197-216`, `:249` | helper with the smoke's id; `revoke()` in the `finally`. `role-smoke.ts` gets `ipc` passed in already; it also needs the runner root (it has `paths`). |
| `runner.ts` `start()` (next to the temp sweep, before `supervisor.resumePersisted()` and before any chat can start) | `sweepSessionEnvFiles(this.paths.root)` in a try/catch, `log.info` with the count only. A fresh runner process has no live tokens (the IPC registry is in memory and persisted shifts restart with a new token), so every leftover dir is an orphan; the `isLive` parameter exists for tests and a later periodic sweep. This also creates the root, so `denyAround` lists it for read-only roles from the first shift on. |
| `runner.ts` `stop()` (after `chat.cancelAll` / `ipc.stop()`) | `sweepSessionEnvFiles(this.paths.root)`: the `settledAll` race may give up after `exitGraceMs` before a shift's `finally` ran; all tokens are dead once the IPC server stops. |
| `paths.ts` | optional: `sessionEnv: join(root, 'session-env')` for symmetry with `activeShifts`; the helper can also take `paths.root`. |

`writeTurnFiles`'s callers and the existing CEO logic otherwise stay as they are.

### 4.3 CEO owner turn on the general path (`ceo/turn-files.ts`)

- Remove the `writeShiftEnvFile(i.turnDir, i.shiftEnv)` call and its import. `TurnFilesInput.shiftEnv` stays (it is the
  relay MCP server's env, `{ ...i.shiftEnv, AOM_PERMISSION_MODE }`); its doc comment changes to "the shift variables,
  including `AOM_SHIFT_ENV_FILE`". The relay (`aom ceo-permission-mcp`) therefore also falls back through the pointer when
  its explicit env is scrubbed.
- Add `'session-env'` to `PRIVATE_ENTRIES` (`turn-files.ts:21`) so the owner's deny floor refuses `Bash(*<root>/session-env*)`
  (the owner turn is unsandboxed; `aom` reads the file itself and never needs a shell command naming the path).
- `adapters/claude-code.ts:348-351` comment: "`aom` refills them from the file named by `AOM_SHIFT_ENV_FILE`
  (session/shift-credential.ts)".
- After this change no code writes `shift-env.json`; only `resolveShiftEnv` still reads it (fallback c).

### 4.4 Sandbox read allow-list (`adapters/claude-policy.ts`, `adapters/claude-code.ts`)

- `ClaudePolicyContext` gains `sessionEnvDir?: string` ("the session's own env-file dir: readable to this session's
  shell, never to another's").
- `ClaudeCodeAdapter.policy()` (`claude-code.ts:520-560`) sets it from `sessionEnvDirOf(input.env.AOM_SHIFT_ENV_FILE, root)`.
  The validation (exactly one segment below `<root>/session-env`, file name `env.json`, absolute, no `..`) guarantees the
  allow-list can never be widened to anything else even if the env were wrong.
- `sandboxBlock` (`claude-policy.ts:483`): `allowRead: [..., ...(ctx.sessionEnvDir ? [ctx.sessionEnvDir] : [])]`.
  `scanSandboxBlock` (`:747`): the same. This is the **only** read widening, and it is the session's own dir, which holds
  no writable path (so the bubblewrap note at `:480` is respected).
- `RUNNER_PRIVATE` (`claude-policy.ts:271`) gains `'session-env'`: no agent may write there (denyWrite), and the Read tool
  is denied there (`commonDenies`, DevOps settings). `allowRead` beats `denyRead` in the OS sandbox, so the shell still
  reads its own dir. (The Read tool is not used by `aom`.)
- Other agents: their `denyRead` covers the runner root (or, for a read-only worktree role, `denyAround` lists the
  existing `session-env` entry of the root) and their `allowRead` never holds another session's dir, so the path is
  unreadable to them.
- Codex, Gemini, Opencode: **no change needed**. They do not set the Claude Code scrub, so `AOM_SHIFT_TOKEN` stays in the
  env and `aom` takes path (a). The pointer reaches them anyway through `input.env` (costs nothing, keeps one code path).
  Their own sandboxes are not touched.

### 4.5 `aom` CLI (`apps/runner/src/aom/aom-cli.ts`)

- Import from `../session/shift-credential.ts` (line 51).
- Entry (`:3062-3066`): `const { env: entryEnv, attempts } = resolveShiftEnv(process.env);` and pass
  `shiftEnvAttempts: attempts` into `runAom`'s context.
- `AomContext` (`:68`) gains `shiftEnvAttempts?: ShiftEnvAttempt[]`.
- `ipc()` (`:199-205`): when `AOM_SHIFT_TOKEN` is missing, throw a `UsageError` built by a pure helper
  `missingTokenMessage(env, attempts)` (exported, unit tested):
  - pointer set: ``AOM_SHIFT_TOKEN is not in the environment and AOM_SHIFT_ENV_FILE (<path>) gave no token: <reason>``
    with reasons `the path is not absolute`, `the file does not exist (the session may have ended)`,
    `the file cannot be read`, `the file is larger than 8 KiB`, `the file is not valid JSON`,
    `the file holds no AOM_SHIFT_TOKEN`; plus `; also tried <legacy path>` when (c) was attempted.
  - pointer not set: ``AOM_SHIFT_TOKEN and AOM_SHIFT_ENV_FILE are not set: `aom` only works inside an agent shift``
    (plus the legacy path when tried).
  - token present but `AOM_IPC_URL` missing: keep today's message.
  The message never contains a token value (there is none to show) or the file content.
- Order (a)/(b)/(c) exactly as in 4.1; (a) skips every read even when `AOM_IPC_URL` is missing (the URL is never scrubbed;
  GWP-55 read the file when either was missing, which this narrows to match the AC).
- Exit code: `UsageError` already makes `runAom` return non-zero; keep it.

### 4.6 `scrubSubprocessEnv=false`

Nothing branches on the scrub: the file is written and the pointer is set for every session, but with the token in the
env `aom` takes path (a) and never reads the file. `sessionEnv` and the command builders do not change; only the session
env gains one variable. Existing aom-cli, adapter and CEO tests stay green apart from the expected env-shape updates.

### 4.7 Docs (builder updates, all in this repository)

- `docs/RUNNER.md:286-287` (owner turn): now "the file named by `AOM_SHIFT_ENV_FILE`".
- `docs/RUNNER.md:1837-1841` (`scrubSubprocessEnv`): the token now survives through `AOM_SHIFT_ENV_FILE`
  (`<data dir>/session-env/<session>/env.json`, 0600, removed at session end and swept at runner start); the remaining
  advice is to try one shift.
- `docs/RUNNER.md` data-dir listing, if it lists the runner root's entries: add `session-env/`.
- `docs/ARCHITECTURE.md:1724` and `:1766`: add `AOM_SHIFT_ENV_FILE` to the listed session variables.
- `apps/runner/src/config.ts:60-66` comment and `adapters/types.ts:114/229/299` comments: mention the pointer.
- Add a "Follow-up: GWP-227" paragraph at the end of the GWP-55 investigation pointing at this document.

### 4.8 Risks

| Risk | Mitigation |
| --- | --- |
| A future scrub heuristic also matches the pointer | The name holds no credential word and the value is a plain path with an 8-hex suffix, the same shape as `AOM_CEO_TURN_DIR`, which survives. Test plan item 6 (manual, real Claude Code >= 2.1.251) confirms. |
| One agent's concurrent sessions share `settings.json` (per agent per account, rewritten at each start; pre-existing) | The later session's `allowRead` replaces the earlier one's. `aom` runs outside the OS sandbox (excluded command), so it still reads its file; only a sandboxed `cat` of the earlier session's own file would be refused. Not a widening. Note in the code comment; per-session config dirs are out of scope. |
| The file outlives the session after a hard crash | Startup sweep removes every leftover dir; the token in it is already dead (the IPC registry is in memory). |
| The shutdown grace expires before a `finally` runs | `stop()` sweeps after the IPC server stops. |
| A chat's next turn reuses the chat id while the previous turn's cleanup runs | Random suffix per registration (4.1). |
| Read-only roles use `denyAround`, which lists only entries existing at settings time | The startup sweep creates `session-env/` before any session; the session's own dir exists before its settings are built. |
| Token leakage through logs | Helper logs path and `err.code` only; aom errors name the path, never content; a unit test asserts the token is absent from every log line and error the helper produces. |
| Windows (no POSIX modes) | `chmod` in try/catch as elsewhere; the OS sandbox is off there anyway. |

### 4.9 Tests (apps/runner/test; unit only, run with the hang limit)

1. `shift-credential.test.ts` (new; absorbs `ceo-owner-shift-env.test.ts`, which is deleted or reduced to the owner-turn
   wiring):
   - `issueShiftCredential` with a fake ipc: the file is `<root>/session-env/<id>.<8 hex>/env.json`, mode `0o600`, dir and
     root `0o700`, `statSync(file).uid === process.getuid()` (skip on win32), content = the `SHIFT_ENV_KEYS` present
     (token, URL, socket, shift id, plus `AOM_CEO_TURN_DIR` when `extra` has it); `env.AOM_SHIFT_ENV_FILE` is that absolute
     path; `socket: false` omits `AOM_IPC_SOCKET`.
   - atomic write: no `*.tmp` left behind; writing twice to the same dir replaces the file whole.
   - `revoke()` revokes the token on the fake ipc and removes the dir; a second call is a no-op.
   - write failure (root is a file): `file` undefined, no pointer, warning names the path, the token string is absent from
     every captured log line.
   - `sweepSessionEnvFiles`: removes unknown dirs, keeps those `isLive` accepts, recreates a missing root with `0o700`.
   - `SHIFT_ENV_POINTER` does not match `/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i`.
   - `sessionEnvDirOf`: accepts exactly `<root>/session-env/<seg>/env.json`; rejects relative paths, `..`, deeper paths,
     another file name, another root.
2. `resolveShiftEnv` (same file), AC cases:
   (a) token in env plus a pointer: returns the same object, the injected reader is never called;
   (b) no token, pointer to a written file: token, URL and socket filled, values in env win, `attempts` has one `pointer`
   entry without a problem;
   (c) no token, no pointer (or pointer to a missing file), legacy `<AOM_CEO_TURN_DIR>/shift-env.json` present: filled from
   it, `attempts` lists `legacy` (and the failed `pointer`);
   (d) nothing: env unchanged, `attempts` carries the problems; oversize, invalid JSON, non-string token, relative pointer.
3. `aom-cli.test.ts`: `missingTokenMessage` and `runAom(['card'], { env: {AOM_IPC_URL}, shiftEnvAttempts: [...] })` exit
   non-zero and the error text names `AOM_SHIFT_ENV_FILE` and the tried path; with the pointer unset it names both
   variables. Existing aom-cli suites unchanged.
4. `claude-args.test.ts`: `buildClaudeCommand` and `buildClaudeChatCommand` with `input.env.AOM_SHIFT_ENV_FILE` set, each
   with `scrubSubprocessEnv` true and false: the env holds the pointer unchanged; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is
   present only when true (DevOps: never); the token is not in `args`. `owner-turn-command.test.ts`: the owner turn env
   carries the pointer.
5. Policy (`claude-args.test.ts` or a new `session-env-policy.test.ts` using `policy-fixtures.ts`):
   - `buildShiftSettings` / `buildChatSettings` / `buildCeoSettings` with `sessionEnvDir` A: `allowRead` contains A and
     nothing else under `<root>/session-env`; `denyWrite` contains `<root>/session-env`.
   - **second agent**: settings built for agent B with its own `sessionEnvDir` B; a small helper
     `shellCanRead(fs, path)` (allowed when an `allowRead` entry equals or contains the path; otherwise refused when a
     `denyRead` entry equals or contains it) says A's file is not readable under B's policy and is readable under A's.
     Run it for a normal role and a read-only worktree role (`denyAround`), the latter with `session-env` existing.
   - without `sessionEnvDir` the settings are byte-identical to today's (snapshot or deep-equal against a build without
     the field).
6. `chat.test.ts` / `supervisor.test.ts` / `delegate.test.ts`: with the mock runtime, the env handed to the adapter holds
   `AOM_SHIFT_ENV_FILE`, the file exists while the session runs and is gone after the session ends normally, after a
   failure (adapter throws) and after `stop`/kill. Owner turn: no `shift-env.json` is written into the turn dir any more.
7. `runner` start: a leftover `session-env/<x>` dir is removed by `start()` (or test `sweepSessionEnvFiles` wiring directly
   if starting a runner in a unit test is too heavy).
8. `ceo-full-power-diagnostics.test.ts`: still passes with `shiftEnv` holding the pointer.

Left for testers (manual, Claude Code >= 2.1.251, `claude.scrubSubprocessEnv=true`): card test plan items 6-10
(background BA/builder shift, tester shift, chat, CEO owner turn, kill mid-run, grep logs and transcripts for the token).
The optional `claude-sandbox-real.test.ts` (opt-in, real `claude`) may get a case that `cat`s the own env file and another
session's file; it is not required for the unit run.

## 5. Acceptance criteria mapping

| AC | Design |
| --- | --- |
| Background builder/BA/tester shift runs `aom card` and its report with the scrub on | Supervisor issues the credential (4.2); pointer survives the scrub (2.4); `aom` fills the token from the file (4.5). Unit: tests 1, 2, 6; manual: testers. |
| Chat/interactive session and CEO owner turn work; owner turn on the general path, no CEO-only write path | chat.ts sites and `runOwnerTurn` use the helper; `writeTurnFiles` no longer writes `shift-env.json`; only the legacy read remains (4.3). Tests 2c, 6, 8. |
| Session env contains `AOM_SHIFT_ENV_FILE` = absolute path, name free of TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL/AUTH | `issueShiftCredential` env; tests 1 and 4. |
| File 0600, runner-user owned, readable from its own sandbox, not from another agent's | 4.1 modes, 4.4 allow-list; tests 1 and 5 (second agent's policy). |
| Removed on normal end, failure, kill; crash leftovers removed on next start | `revoke()` in every existing `finally`; startup and shutdown sweeps (4.2); tests 1, 6, 7. |
| Env token present: used, file not read | Resolution (a); test 2a. |
| Neither gives a token: non-zero exit naming the variable and the path | `missingTokenMessage` (4.5); test 3. |
| Scrub off: unchanged | 4.6; existing suites plus test 4 (scrub false) and test 5 (settings identical without the field). |
| Token never in logs, transcripts, card text or argv; only the path is logged | 4.1 logging rules, 2.5; test 1 (log capture), test 4 (args). |

## 6. Open points decided here

- Legacy `shift-env.json` read: kept for one release as fallback (c), then removed. A backlog suggestion records the
  removal.
- Non-Claude adapters: get the pointer through the shared env at no cost; no adapter or sandbox change for them.
- Size: about 300-400 changed lines across `session/`, `shifts/`, `chat/`, `delegate/`, `health/`, `adapters/`, `aom/`,
  `ceo/`, `runner.ts` and tests; the card is already marked large.
