# Design: per-project Claude accounts on a workstation (final)

Repo: `/path/to/guildwise` (branch `feat/claude-accounts`). Status: final, owner decisions applied.
Implementers work from this file plus the code. Every path is relative to the repo root unless it starts with `~`.

---

## 0. Decisions (made by the owner)

| # | Decision |
|---|---|
| D1 | A project names its account by a **key** (e.g. `work`). If the account does not exist on a workstation, that workstation's runner **provisions** its own dedicated config dir for it (section 2.3). |
| D2 | **Every shift that works on one ticket of the project** uses the project's account: `card` shifts, `question` shifts whose desk item has a `card_id` in the project, and `ba_task` shifts whose task has a `card_id` (`spec_card`). If the project has no account, the shift uses the main account. Out of scope, always main: CEO shifts, DevOps shifts (even when the request names a card), BA tasks without a card, and all chats (including the CEO full-power owner turn). |
| D3 | The fallback checkbox ("use the main account when this one is out") is **off by default**. Off means pause. |
| D4 | An **expired login, or a login that was never completed, counts exactly like a hit usage limit** (fallback or pause), and raises a desk notification. |
| D5 | **Shifts already running finish on the account they started with.** Every new shift (next stage, another agent, a retry) picks its account again. |
| D6 | **The primary source of an account is a Claude Code config dir, and the runner only ever uses a dir it created itself.** The default is `~/.claude-gw-<key>` (alias `claude-gw-<key>`), created when missing and marked with a file `.aom-runner-owned`. The runner never adopts the user's own dirs or aliases: the owner uses `~/.claude-work` and the `claude-work` alias interactively, so provisioning for the key `work` makes `~/.claude-gw-work`, not `~/.claude-work`. A `configDir` the owner writes into `config.json` is honoured (they chose it). A default dir that exists without the marker is left alone and reported as an error. Token or API-key accounts are a secondary option. |

Rejected alternatives (one line each):
- Naming accounts by Anthropic `accountUuid`: token accounts have no readable profile, and a key is what people type.
- Letting the runner choose the account: the dispatcher must know which accounts are usable to decide pause versus fallback, so the server chooses.
- Sharing one agent config dir across accounts: concurrent shifts of the same agent (capacity up to 8) would overwrite each other's `.credentials.json`, and `harvestAgentCredentials` could write one account's token into another account's file.
- A server-side account registry (events): credentials and directories are machine facts that never leave the workstation; the server only needs metadata.

---

## 1. How it works today (verified in code)

### 1.1 Spawning and credentials (runner)
- `apps/runner/src/adapters/claude-code.ts`:
  - `ClaudeCodeAdapter.start` and `startChat` spawn `claude` through `spawnSession` (`adapters/process-session.ts`) with `inheritEnv: false`.
  - `sessionEnv()` sets `CLAUDE_CONFIG_DIR = input.sandbox.configDir` (= `<runnerHome>/agents/<agentId>/claude`), `HOME` (the agent's own, or the real home for DevOps), and the provider credential from `this.live`.
  - `buildClaudeCommand` and `buildClaudeChatCommand` add `--resume <id>` when asked.
- **How the credential is resolved:** `resolveClaudeCredential` (`apps/runner/src/integrations/claude-store.ts`) picks, in order:
  1. `secrets/claude.json`, giving `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`;
  2. the `config.json` `runtimes['claude-code']` block;
  3. `authMode: 'default'`, the machine login.
- **Machine login (`authMode: 'default'`):**
  - `linkCredentials` gives each agent config dir a **private copy** of `<realHome>/.claude/.credentials.json` through `prepareAgentCredentials` (`adapters/claude-auth.ts`), taken under the runner-wide lock `claude-credentials.lock`.
  - `sessionHooks.onExit` then calls `harvestAgentCredentials`, which writes a newer `claudeAiOauth` and newer `mcpOAuth` entries back to the canonical file. It compares by `expiresAt` only.
  - `credentialPaths()` hardcodes `~/.claude/.credentials.json`, while `mcp/plugins.ts` honours `CLAUDE_CONFIG_DIR`.
  - `docs/ARCHITECTURE.md` §12.2 still says "symlink"; the code copies.
- **The CEO full-power turn** (`buildClaudeOwnerTurnCommand`): real `HOME`, no `CLAUDE_CONFIG_DIR` override, and `--resume` inside the real `~/.claude`.
- **This machine** (`~/.aom-runner-guildwise`):
  - `config.json` says `authMode: "default"`, but `secrets/claude.json` holds a web-entered setup token, which wins.
  - `~/.claude-work` is a second Claude Code config dir with its own `.credentials.json` and `.claude.json` (`oauthAccount`: `emailAddress`, `organizationType: claude_team`, `accountUuid`, ...).
  - `~/.bashrc` lines 10 and 11 contain `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'` and `alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude claude'`.
  - `claude` is version 2.1.304; `claude auth login [--claudeai|--console] [--email] [--sso]` and `claude auth status --json` exist.

### 1.2 Usage limit, login expiry, pause and recovery
- **Detection:** `apps/runner/src/adapters/claude-usage-limit.ts`, with `isUsageLimitText`, `parseResetTime`, `detectUsageLimit` (an hour from now when no time can be read) and `formatLimitTime`.
- **State:**
  - `ClaudeUsageMonitor` (`markLimited` / `markOk`): one per `Runner` (`runner.ts`, `claudeUsage`), **kept in memory only**.
  - `ClaudeAuthMonitor` (`claude-auth.ts`, `markExpired` / `markOk`): likewise one per runner (`claudeAuth`).
- **Hooks:** `sessionHooks()` and `ownerHooks()` in `claude-code.ts` mark limited or expired on exit, and mark ok after a clean run with output.
- **Effect:** `capabilities()` reports `available:false` plus `usage:'limited', limitedUntil, limitedLabel` or `auth:'expired'`.
- **A shift that hits the limit:** `ShiftSupervisor` (`shifts/supervisor.ts`, around line 1263) rejects it with `usage_limited` (`auth_expired` for logins). The server (`apps/server/src/commands/shifts.ts`, around line 1242) puts the card back in the queue without penalty.
- **Recovery:**
  - `Runner.probeUsage()` runs after `limitedUntil`, at most every 3 minutes, through `ClaudeCodeAdapter.probeUsage()`, which calls `probeClaudeUsage` (one `claude -p "Reply with: ok" --model haiku --max-turns 1`).
  - `Runner.probeAuth()` runs every 3 minutes, through `probeLogin()`, which calls `probeClaudeLogin`.
  - Any change goes out as `reportRuntimes()`, which sends `runtimes.report`.
- **`server-limits.json` is unrelated:** it caches the plan's shift cap (`shiftLimit`, `maxConcurrentShifts`).

### 1.3 Runner to server reporting
- `hello.runtimes` and `runtimes.report` carry `RuntimeInfoSchema` (`packages/shared/src/protocol/runner.ts`).
- `RunnerGateway.runtimesReport` (`apps/server/src/runner-gateway/handlers.ts`) writes `workstations.runtimes` (jsonb, operational) directly, runs `syncClaudeAuthNotice` / `syncClaudeUsageNotice` (`apps/server/src/commands/workstation-notices.ts`, desk subkind `claude_usage_limit`), and appends `WorkstationRuntimesChanged` (no projection).
- **Gating in the dispatcher:**
  - `apps/server/src/dispatcher/dispatcher.ts` `freeAgents()` skips an agent when `!rt.available`, `rt.auth==='expired'` or `activeUsageLimit()` (`apps/server/src/queries/usage-limit.ts`).
  - `devops.ts:55`, `questions.ts:59` and `ba-tasks.ts:126` check `rt.available`.
  - `usageLimitsFor()` drives the project banner (`apps/web/src/components/UsageLimitBanner.tsx`).

### 1.4 Projects
- Events: `packages/shared/src/events/project.ts`. Projection: `apps/server/src/projections/projects.ts`. DTO: `apps/server/src/queries/misc.ts`. API schemas: `packages/shared/src/api/projects.ts`.
- The pattern to copy is the per-setting event `ProjectFullSuiteSet`:
  - migration `apps/server/migrations/1530_project_full_suite.sql`;
  - command `setFullSuite` (`apps/server/src/commands/projects.ts`);
  - route `PUT /api/projects/:id/full-suite` (`apps/server/src/routes/projects.ts`);
  - web `apps/web/src/components/FullSuitePanel.tsx`, mounted in `apps/web/src/pages/ProjectSettings.tsx`.
- The latest migration is `2241_ceo_topic_candidates.sql`.

### 1.5 Shift kinds and what ties them to a ticket
Agents belong to the organization (`agents.allowed_project_ids`), so **the account is chosen per shift**.

| Kind | Dispatched by | Ticket link | Shift row created by | Account (D2) |
|---|---|---|---|---|
| `card` | `Dispatcher.pass` (+ preferred loop, `overflowPass`) → `claim()` (`dispatcher/claim.ts`) → `buildShiftStart` (`runner-gateway/brief.ts`) | `cards.project_id` | `CardClaimed` (`projections/shifts.ts`) | project |
| `question` | `questionPass` (`dispatcher/questions.ts`) → `runner-gateway/question-brief.ts` | `desk_items.card_id` (when set) → `cards.project_id` | `QuestionShiftDispatched` (`projections/intake.ts`) | project if `card_id` is set, else main |
| `ba_task` | `baTaskPass` (`dispatcher/ba-tasks.ts`) → `runner-gateway/ba-task-brief.ts` | `ba_tasks.card_id` (`spec_card`, migration 2221) | `BaTaskDispatched` (`projections/phases.ts`) | project if `card_id` is set, else main |
| `devops` | `devopsPass` (`dispatcher/devops.ts`) | optional `DevopsShift.card` | `projections/devops.ts` | main (D2) |
| `ceo` | `ceoPass` | none | `projections/ceo.ts` | main |
| chats | `chat/relay.ts` → `chat.start` | possibly a card | `ShiftStarted` (relay) | main |

### 1.6 Session resume
- The server proposes `resumeSessionId` in `cardAffinityResume` / `affinityResume` (`runner-gateway/brief.ts`).
- The runner decides in `SessionRegistry.decide()` (`apps/runner/src/sessions/registry.ts`, file `<dataDir>/sessions.json`). It refuses for another agent, more than 120K tokens, more than 4 hours, an unknown session, or a missing transcript.
- Transcripts live in the **agent's** config dir (`transcriptFile(configDir, cwd, id)`).
- The resume state values are `RESUME_STATES` in `packages/shared/src/protocol/runner.ts`.
- **Conclusion: agents are stateless enough to move between accounts.** Each shift re-renders `CLAUDE.md`, `settings.json` and `mcp.json`, and handoffs and threads live on the server.
- **Do not resume across accounts:**
  - prompt caches belong to one organization, so up to 120K tokens would be re-read uncached and billed to the new account;
  - whether thinking-block signatures work across organizations is unverified.

  So a different account means a fresh start (`fresh_other_account`).

### 1.7 Existing web login machinery (reused for provisioning)
- **Integration kinds:** `packages/shared/src/integrations/registry.ts` `INTEGRATION_KINDS`. `claude-code` currently has `instances: 'single'` and the methods `setup_token` (interactive), `api_key`, `oauth_token`, and `default_login` (phase 2, not built).
- **Runner adapter:** `apps/runner/src/integrations/claude-code.ts` `ClaudeCodeIntegration` (`instances()`, `status()`, `test()`, `connect()`, `begin()`, `remove()`).
  - `begin('setup_token')` returns a `LoginSpec` (`integrations/session.ts`: `{cmd, args, pty, env?, cwd?, parse, stdin?, finish, terminalHint}`).
  - `LoginSession` runs it in a pseudo-terminal, `parse` extracts the sign-in URL (host allow-list `CLAUDE_SIGN_IN_HOSTS`) and the "Paste code here" prompt, the web shows the link and accepts up to `MAX_INPUTS = 3` pasted codes, and the session ends after `SESSION_LIMIT_MS` (10 minutes).
- **Commands:** `integration.begin` / `.input` / `.cancel` / `.test` / `.remove` / `.connect` (`RunnerCommandNameSchema`; payloads in `packages/shared/src/integrations/schema.ts`, e.g. `IntegrationBeginPayloadSchema {sessionId, kind, instance, method, pre?}`).
- **Routes** (`apps/server/src/routes/integrations.ts`): `POST /api/workstations/:id/integrations/sessions`, `.../sessions/:sid/input`, `.../sessions/:sid/cancel`, `.../connect`, `.../test`, `.../remove`.
- **Web:** `apps/web/src/pages/Integrations.tsx` already renders several instances per kind ("Connect another …"). The deep link is `?focus=<kind>:<instance>` (`apps/web/src/lib/integrations.ts` `parseFocus`).
- **Conclusion:** a web login for account `work` is `integration.begin {kind:'claude-code', instance:'work', method:'claude_login'}`. The runner runs `claude auth login --claudeai` in a pseudo-terminal with `CLAUDE_CONFIG_DIR=<dir>`, the web shows the link, and the user pastes the code back. No terminal is needed.

---

## 2. Design

### 2.1 Account registry (runner-local, reported to the server)

**Main account.** Key `main`, always present. It is today's credential, resolved by `resolveClaudeCredential` (secrets token, config token or key, or the default `~/.claude` login). Nothing changes for existing installs.

**Additional accounts** go in `config.json` → `runtimes['claude-code'].accounts`:
```ts
// apps/runner/src/config.ts, inside ClaudeRuntimeConfigSchema
accounts: z.array(z.object({
  key: ClaudeAccountKeySchema,                 // from @aom/shared, never 'main'
  /** Claude Code config dir; '~' allowed. Default '~/.claude-gw-<key>' (created when missing). */
  configDir: z.string().optional(),
  /** 'config_dir' (default, D6) or 'token' (secrets/claude-accounts/<key>.json holds an oauth token or API key). */
  source: z.enum(['config_dir', 'token']).default('config_dir'),
})).default([]),
```
- **Token accounts:** `secrets/claude-accounts/<key>.json`, the same format as `ClaudeCredentialSchema`, through a `ClaudeCredentialStore` per key. Add `claudeAccountFile(secretsDir, key)` to `integrations/claude-store.ts`.
- **Which credential each account uses:**
  - A `config_dir` account uses `<dir>/.credentials.json` as its canonical file and `<runnerHome>/claude-credentials-<key>.lock` as its lock. It probes with `CLAUDE_CONFIG_DIR=<dir>`. Profile details for display come from `<dir>/.claude.json` `oauthAccount.emailAddress` and `organizationType`; if that file is missing, from `claude auth status --json` (`email`).
  - A `token` account passes `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- **New module `apps/runner/src/adapters/claude-accounts.ts`**, holding `ClaudeAccountRegistry`:
  - `list(): ClaudeAccount[]` (main first); `get(key)`.
  - Each `ClaudeAccount` carries `{ key, main, source, configDir?, auth: ClaudeAuthMonitor, usage: ClaudeUsageMonitor, credential(): {authMode, oauthToken?, apiKey?}, credentialPaths(agentConfigDir): CredentialPaths | undefined, probeEnv(): NodeJS.ProcessEnv }`. For `main`, `credentialPaths` and `probeEnv` are what `ClaudeCodeAdapter.credentialPaths()` / `probeEnv()` do today.
  - Login state is `ok | expired | none`:
    - `none` means a `config_dir` account whose `.credentials.json` is missing or has no `claudeAiOauth`, or a token account with no token.
    - Extend `ClaudeAuthMonitor` with a `none` state, or keep a separate flag.
    - `none` and `expired` both make the account unusable.
  - State is persisted to `<dataDir>/claude-accounts-state.json`: `{ [key]: { limitedUntil?: string, login?: 'expired' } }`. It is written on every change and loaded at start, so a restart no longer forgets a limit. Main is included, which replaces the in-memory-only `Runner.claudeUsage` / `claudeAuth`.
  - It watches the mtime of `<dir>/.credentials.json` for `config_dir` accounts (checked in the existing runner tick). A change while `none` or `expired` triggers an immediate `probeLogin` for that account, so a login made in a terminal (`claude-gw-work`, then `/login`) is picked up within seconds.
- **`Runner`** (`apps/runner/src/runner.ts`):
  - It owns the registry.
  - `probeUsage()` and `probeAuth()` loop over the accounts, with the same timing rules per account and the account's own `probeEnv()`.
  - `onChange` of any account monitor calls `reportRuntimes()` and logs `account <key>: ...`.
- **Reporting:**
  - `runtimeInfos()` adds `accounts: ClaudeAccountInfo[]` (schema in section 3).
  - The top-level `auth` / `usage` / `limitedUntil` / `limitedLabel` keep describing **main**, so older servers keep working.
  - `available` is `false` only when **no** account is usable; the server uses `accounts`.
  - `hello.capabilities` gains `CLAUDE_ACCOUNTS_CAPABILITY`.
- **CLI** (`apps/runner/src/cli.ts`):
  - `aom-runner accounts list`;
  - `aom-runner accounts add <key> [--config-dir <dir>] [--oauth-token|--api-key]` (provisions as in section 2.3);
  - `aom-runner accounts login <key>` (runs `claude auth login` with `CLAUDE_CONFIG_DIR` in the foreground terminal);
  - `aom-runner accounts remove <key>` (unregisters the account; never deletes the dir or the alias).
- **Several pairings** (`pairings.json`): each pairing has its own `config.json` and therefore its own `accounts` list. The config dir and alias are machine-wide and shared; that is safe because write-back is locked per account.
  - The per-account lock file lives in the runner home of the pairing that wrote it. Two pairings using the same `config_dir` therefore use two lock files.
  - To prevent that, place the lock next to the account instead, as `<configDir>/.aom-credentials.lock`.

### 2.2 Spawning on an account (runner)

- **Inputs:** `ShiftStartInput` and `ChatStartInput` (`apps/runner/src/adapters/types.ts`) get `account?: string` (absent = `main`). `ShiftSupervisor` passes `msg.account?.key ?? 'main'`. A persisted active shift (`<dataDir>/active-shifts/<shiftId>.json`) keeps its `shift.start`, so a resumed shift after a restart stays on its account (D5).
- **A config dir per account per agent:**
  - `main` keeps `agents/<id>/claude`, so nothing on disk moves.
  - Account `k` uses `agents/<id>/claude-acct-<k>`.
  - The change goes where the sandbox paths are built (`apps/runner/src/sandbox/sandbox.ts`, `configDir`), parameterised by account.
  - Check `adapters/claude-policy.ts`: every rule derived from the config dir must use `input.sandbox.configDir`. The agent dir (`dirname(sandbox.home)`) is unchanged.
  - `agent.wipe` already removes all of `agents/<id>`.
- **Environment:** `sessionEnv` / `buildClaudeCommand` / `buildClaudeChatCommand` take the account's `credential()` instead of `this.live`. A `config_dir` account sets no token variable; its login arrives as the copied `.credentials.json`.
- **Credentials:**
  - `ClaudeCodeAdapter.linkCredentials(configDir, servers, account)` and `sessionHooks(configDir, parser, account)` bind the account's `CredentialPaths` **at session start**. The closure never re-resolves them, so write-back can only reach that account's canonical file.
  - For a non-main `config_dir` account, the copy holds that account's `claudeAiOauth` plus the `mcpOAuth` of `<dir>/.credentials.json`. `harvestAgentCredentials` is unchanged; only the paths differ.
  - Plugin MCP sign-ins come from the account dir. If granted MCP servers are not signed in there, `mcpSignInNote` already tells the agent.
- **Detection:** `sessionHooks.onExit` marks `account.usage.markLimited(until)` or `account.auth.markExpired()`, and on a clean run with output, `markOk()` on that account only.
- **Guard before spawning** (`ShiftSupervisor`, before `adapter.start`):
  - Unknown key: reject `runtime_unavailable`, `detail: 'account_missing:<key>'`. This should not happen, because the server only sends known keys; it is a race guard.
  - Limited: reject `usage_limited` with `limitedUntil` and `accountKey`.
  - `expired` or `none`: reject `auth_expired` with `accountKey`.
  - All three put the card back without penalty, as today.
- **Resume:**
  - `SessionRecord` gets `accountKey?: string` (absent = `main`), recorded in `ShiftSupervisor` where it calls `sessions.record(...)`.
  - `SessionRegistry.decide(sessionId, agentId, configDir, accountKey)` returns `{state:'fresh_other_account', detail:'the session ran on account <a>; this shift runs on <b>'}` when they differ. This check comes before the transcript check.
- **Unchanged:** the CEO owner turn, chats, role smoke (`health/role-smoke.ts`), and DevOps, CEO and non-ticket BA shifts all use `main`, because the server sends no `account` for them.

### 2.3 Provisioning an account on a workstation (D1, D4, D6)

**Trigger (server):**
- A new runner command `claude.account.ensure` (section 3) is queued with `enqueueRunnerCommand` (`apps/server/src/runner-gateway/commands-queue.ts`):
  - when `ProjectClaudeAccountSet` sets a key: to every active workstation that serves the project's org (`wsServesOrgSql`) and hosts at least one active agent allowed on the project, whose runner has `CLAUDE_ACCOUNTS_CAPABILITY`;
  - in `RunnerGateway.hello` (after `welcome`): for every key referenced by projects of the orgs this workstation serves that is missing from `hello.runtimes[claude-code].accounts`. At most once per workstation and key per 24 hours, using `runner_commands` history.
- A runner without the capability never gets the command. Its accounts count as missing, and a desk notice says "update the runner" (section 2.5).

**Handler (runner)**, new file `apps/runner/src/adapters/claude-account-provision.ts`, wired as a command handler in `runner.ts`. It is idempotent. For `{ key, configDir? }`:
1. **Pick the dir, never adopting the user's own.** The runner uses, in order: the `configDir` of an existing `config.json` entry for the key (the owner chose it, so it is honoured), the payload's `configDir`, else the runner-owned default `~/.claude-gw-<key>` (on Windows `%USERPROFILE%\.claude-gw-<key>`). It does **not** scan the shell files for `claude-<key>` aliases and never reuses `~/.claude-work` or the `claude-work` alias.
   - A dir that is not from the `config.json` entry must either not exist yet or carry the ownership marker `.aom-runner-owned`. A default dir that exists **without** the marker is not touched and not adopted: result `failed`, with a detail that says so and names `aom-runner accounts add <key> --config-dir <dir>` as the deliberate way to register it.
   - Refuse paths inside the runner data dir, `~/.claude` (that is main), or outside the home directory: result `failed`.
2. **Create the dir** with `mkdir -p` and mode `0700`, and write the marker file `.aom-runner-owned` (not for a dir named in `config.json`).
3. **Register** `{key, configDir, source:'config_dir'}` in this pairing's `config.json`, using `saveConfig` (atomic, `0600`).
4. **Add the alias `claude-gw-<key>`** (POSIX only). The target file is `~/.zshrc` when `$SHELL` ends in `zsh`, else `~/.bashrc` (created if missing). Edit only inside a marked block, rewriting the whole block atomically:
   ```
   # >>> guildwise claude accounts >>>
   alias claude-gw-work2='CLAUDE_CONFIG_DIR=~/.claude-gw-work2 claude'
   # <<< guildwise claude accounts <<<
   ```
   The block is created once; later keys are added inside it, sorted, never duplicated. Lines outside the block are never edited. An alias of that name that sits outside the block is not ours: it is left alone and reported as `aliasConflict: true`. Report `aliasAdded: true` or `false`.
5. **Login state:** if `<dir>/.credentials.json` has `claudeAiOauth`, run `probeLogin` for the account and answer `ready` (or `awaiting_login` if the probe says expired). Otherwise answer `awaiting_login`. The account is reported with `login: 'none'`, which makes it unusable (fallback or pause).
6. **Machine-scope gate:** steps 2 to 4 touch the user's home directory, so they run only when `config.integrations.machineScopeFromWeb === 'primary'` and this is the primary pairing (the same rule as the machine login on the Integrations page). Otherwise answer `needs_owner` with the exact commands in `detail`: `aom-runner accounts add <key>`, then `aom-runner accounts login <key>`.

**Login without a terminal (preferred):**

> **Owner addendum: the browser already handles account linking, so reuse it; build no new mechanism.** The login for a newly provisioned account is the **existing** web linking flow of the `claude-code` integration, run for that account's *instance*. It uses:
> - the same Integrations page tile and `ConnectDialog` (interactive flow: link shown, code pasted back), deep-linked with `?focus=claude-code:<key>`;
> - the same routes (`POST /api/workstations/:id/integrations/sessions`, `.../sessions/:sid/input`, `.../cancel`) and the same runner commands (`integration.begin` / `integration.input` / `integration.cancel`);
> - the same `LoginSession` on the runner (`apps/runner/src/integrations/session.ts`) and the same `integration.session` messages back to the browser.
>
> The only new parts are runner-side: `ClaudeCodeIntegration` accepts a non-empty `instance` (the account key), and its `begin()` returns a `LoginSpec` for that account. No new web component, route, command or desk flow exists for the login. The desk notice in 2.5 only links into this flow, with the terminal command as a fallback.
>
> Method choice inside that flow:
> - **Default:** for an instance whose source is `config_dir`, the existing interactive method is offered under the id `claude_login`. It runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR=<dir>`, so the login lands in the account's own folder (D6).
> - If the implementer finds `ConnectDialog` keys any behaviour on the method id `setup_token`, reuse that id's UI path and only branch on the runner.
> - The existing `setup_token` method stays available per instance as the secondary (token) source.

- **New method `claude_login`** on the `claude-code` kind, for non-main instances (`flow: 'interactive'`, `paste: 'code'`). The label is "Sign in with your Claude subscription", with this step text: "Open the link, sign in to the account for this key, paste the code."
- **`ClaudeCodeIntegration.begin(instance, 'claude_login')`** returns this `LoginSpec`:
  ```ts
  {
    cmd: claudeBin,
    args: ['auth', 'login', '--claudeai'],
    pty: true,
    env: { CLAUDE_CONFIG_DIR: account.configDir },
    cwd: sessionCwd,
    parse: parseClaudeAuthLogin,
    terminalHint: `CLAUDE_CONFIG_DIR=${display(account.configDir)} claude auth login`,
    finish,
  }
  ```
  - `env` may also carry whatever the `setup_token` flow uses to avoid opening a local browser.
  - `parseClaudeAuthLogin` reuses `findUrl(...)` + `hostAllowed(..., CLAUDE_SIGN_IN_HOSTS)`, the "Paste code here" prompt and "OAuth error" handling, like `parseSetupToken`, and finishes on a "Login successful" style line or on process exit 0.
  - **Unverified:** the exact screen text of `claude auth login`. Record a fixture first, with a throwaway `CLAUDE_CONFIG_DIR`, as `apps/runner/test/fixtures/integrations/claude-auth-login.txt`, and match against it.
- **`finish`:** run `claude auth status --json` with that `CLAUDE_CONFIG_DIR`. If `loggedIn` is true, call `registry.get(key).auth.markOk()` and `reportRuntimes()`, and return the status with `account: email`. Otherwise return `{ error: 'Sign-in did not finish. Run <terminalHint> on the workstation.' }`.
- **Rest of the integration for non-main instances:**
  - `instances()` returns `['', ...accounts.map(a => a.key)]`, where `''` is main.
  - `status(instance)` reports the account's login state, `account: email` and `method: 'claude_login' | 'setup_token' | 'oauth_token' | 'api_key'`.
  - `test(instance)` probes that account.
  - `remove(instance)`: for a token account, delete the token file; for `config_dir`, unregister the account (the dir is kept).
  - `connect(instance, 'oauth_token'|'api_key')` saves to `secrets/claude-accounts/<key>.json` and sets `source:'token'` (secondary, D6).
  - `begin(instance, 'setup_token')` stays available as secondary and saves the token likewise.
- **Fallback when the web flow is impossible** (old runner, `needs_owner`, or the parse failed): the desk notice in section 2.5 gives the terminal command.

**Until the login completes, the account is unusable**, so the dispatcher falls back or pauses as the project setting says.

### 2.4 Server: storage, account selection, dispatch

**Data:**
- Migration `apps/server/migrations/2250_claude_accounts.sql`:
  ```sql
  ALTER TABLE projects ADD COLUMN claude_account_key text;                 -- NULL = main
  ALTER TABLE projects ADD COLUMN claude_account_fallback boolean NOT NULL DEFAULT false;
  ALTER TABLE shifts   ADD COLUMN account_key text;                        -- NULL = main
  ```
- Projections:
  - `apps/server/src/projections/projects.ts`: `ProjectClaudeAccountSet` sets both project columns.
  - `apps/server/src/projections/shifts.ts`: `CardClaimed` writes `account_key = p.accountKey ?? NULL`.
  - `apps/server/src/projections/intake.ts`: `QuestionShiftDispatched` writes `account_key`.
  - `apps/server/src/projections/phases.ts`: `BaTaskDispatched` writes `account_key`.
  - All of these are replay-safe: old events carry no key, which means main.
- Command `setClaudeAccount(ctx, user, projectId, {accountKey, fallbackToMain})` in `apps/server/src/commands/projects.ts`. Authorisation is the same as `setFullSuite`. It appends nothing when the value is unchanged. In the same transaction it queues `claude.account.ensure` (section 2.3).
- Route `PUT /api/projects/:id/claude-account` (`apps/server/src/routes/projects.ts`), body `SetClaudeAccountRequestSchema`.
- DTO: `ProjectDto.claudeAccount` (`queries/misc.ts`).
- New query `GET /api/projects/:id/claude-accounts` (or folded into the project settings payload) returning `ProjectClaudeAccountsView` (section 3). It lists, per eligible workstation, the reported account infos for the project key and for `main`. The UI uses it for the dropdown and the "missing on" warnings.

**Selection:** `resolveShiftAccount` (shared, section 3), applied per shift:
```
key = project?.claudeAccountKey ?? 'main'   (project = the ticket's project; non-ticket shifts: project = null)
if usable(ws, key) -> key
else if key !== 'main' && project.fallbackToMain && usable(ws, 'main') -> 'main'
else -> null  (pause: this ticket is not dispatched to this workstation now)

usable(ws, k): the runtime reports accounts[] and has an entry k with login === 'ok' && usage === 'ok'.
               Legacy runtime (no accounts[]): only k === 'main' exists, usable when
               rt.available && rt.auth !== 'expired' && !activeUsageLimit(...).
```
The runner is authoritative on `usage`, so `limitedUntil` is not compared to the clock for accounts: the runner flips the state after a successful probe.

**Dispatcher** (`apps/server/src/dispatcher/dispatcher.ts`):
- `freeAgents()`: replace the `activeUsageLimit` skip with `if (!anyUsableAccount(a.runtimes, a.runtime)) continue;` (shared helper). Keep the `available` and `auth` checks for legacy runtimes inside the helper.
- Load `projects.claude_account_key` and `claude_account_fallback` for the candidates' projects once per pass (a small map).
- In the card loop, the `preferred` loop and `overflowPass`: `const acct = resolveShiftAccount(projectOf(c), runtimeOf(agent))`. If it is `null`, skip the card for this agent. Otherwise call `claim(ctx, {..., accountKey: acct})`.
- `claim.ts`: `ClaimArgs.accountKey?: string` and `ClaimResult.accountKey?: string`. The `CardClaimed` payload carries `accountKey` (omitted when `main`, to keep events small).
- `buildShiftStart` (`runner-gateway/brief.ts`): `account: { key }` when `claim.accountKey` is set and not `main`, and only for runners with the capability. For `main`, omit it.
- `questionPass` (`dispatcher/questions.ts`): select `d.card_id` and the card's project setting. Resolve the account (ticket-bound only when `card_id` is set). Replace the `rt.available` gate with `acct !== null`. Put `accountKey` on `QuestionShiftDispatched` and `account` on `shift.start` (`runner-gateway/question-brief.ts`).
- `baTaskPass` (`dispatcher/ba-tasks.ts`): the same, using `ba_tasks.card_id`. `BaTaskDispatched.accountKey`; `account` in `runner-gateway/ba-task-brief.ts`.
- `devopsPass` (`dispatcher/devops.ts`), `ceoPass` and `chat/relay.ts` (chat start gating, if any): gate on `usable(ws, 'main')` instead of `rt.available`. This is required: `available` now stays true while only main is out.
- Cloud wake (`apps/server/src/cloud/tick.ts`): apply the same resolver before waking a machine for a candidate.

**Rejections** (`apps/server/src/commands/shifts.ts`, the runner-rejected handler):
- For `usage_limited` and `auth_expired` with `accountKey`, patch `workstations.runtimes` directly (operational, in the same handler): set that account's `usage:'limited', limitedUntil` or `login:'expired'`. This closes the race before `runtimes.report` arrives (the runner's `reportRuntimes` is async because it runs `claude --version`).
- Text: "Paused: account `<key>` reached its usage limit (resets …)." or "… login on account `<key>` does not work." The card goes back without penalty, as today.
- Make sure these two reasons never count toward `REJECTION_DESK_AT`.

**In-flight shifts (D5):** nothing is stopped. The next claim, question or BA task resolves again, so when the project account comes back, new shifts go to it automatically.

### 2.5 Notices and banners (server)
- **`syncClaudeUsageNotice` becomes per account** (`apps/server/src/commands/workstation-notices.ts`), coalesced by `(workstationId, accountKey)`, subkind `claude_usage_limit`. Text: "Account `work` on Desktop reached its usage limit until 18:00 (Africa/Johannesburg). Projects WEB, API fall back to main / are paused." The notice closes on recovery. `apps/server/src/ceo/wakes.ts` keeps treating the subkind as info.
- **New subkind `claude_account_login`** (D4), raised when an account referenced by a project the workstation serves reports `login: 'none'` or `'expired'`, or when a provisioning result is `awaiting_login`, `needs_owner` or `failed`.
  - Addressed to the workstation owner (as `claude_auth_expired` is).
  - The body contains:
    - a button or link to the Integrations page, with `?focus=claude-code:<key>` and the workstation selected ("Sign in from the browser");
    - the exact terminal fallback: `claude-gw-<key>` then `/login`, or `CLAUDE_CONFIG_DIR=<dir> claude auth login`;
    - for `needs_owner`: `aom-runner accounts add <key>` and `aom-runner accounts login <key>`;
    - for an old runner: "update the runner to 0.1.33 or later".
  - It closes when the account reports `login: 'ok'`.
  - Register the subkind in `push/notifier.ts` `RUNNER_SUBKINDS`.
- **`usageLimitsFor()`** (`apps/server/src/queries/usage-limit.ts`) becomes project-aware:
  - the project is **paused** when `resolveShiftAccount` returns `null` for every eligible agent workstation;
  - it is **on fallback** when it resolves to `main` only because of fallback.
  - `ProjectDto.usageLimit` gains optional `accountKey` and `mode: 'paused' | 'fallback'` (section 3).

### 2.6 Observability
- `shifts.account_key` (`NULL` = main), exposed on the shift rows the card page and Agents page already show (the shift DTO adds `accountKey?`).
- The Costs page gets an account filter or column, reading `shifts.account_key`.
- `WorkstationRuntimesChanged.runtimes[].accounts` (brief: key, login, usage, limitedUntil) gives a live refresh of the Workstations page.
- Runner: the supervisor progress line "starting on account `<key>`" and `logs/runner.log` lines tagged `account=<key>`.

### 2.7 Web
- **`apps/web/src/components/ClaudeAccountPanel.tsx`** (new), mounted in `apps/web/src/pages/ProjectSettings.tsx` with id `claude-account`:
  - Account: a select of "Main account (each workstation's own)" plus known keys (from `ProjectClaudeAccountsView`), plus "New key…" (free text validated with `ClaudeAccountKeySchema`).
  - The checkbox "If this account is out (usage limit or login), use the workstation's main account. Otherwise this project's tickets pause." It is unchecked by default (D3).
  - Per eligible workstation, a status line: ready / limited until … / sign-in needed (link to the Integrations page) / provisioning / runner too old.
  - Query and mutation in `apps/web/src/api/queries/projects.ts` (`useClaudeAccount`, `useSetClaudeAccount`).
- **`apps/web/src/pages/Workstations.tsx`:** an accounts table per workstation (key, dir, email/plan, login, usage, limited until).
- **`apps/web/src/pages/Integrations.tsx`:** the `claude-code` kind shows one tile per instance (`''` = "Main account"; others by key) and "Connect another account". The `claude_login` method is offered first for non-main instances.
- **`apps/web/src/components/UsageLimitBanner.tsx`:** handles `mode: 'paused'` ("paused: account `work` …") and `mode: 'fallback'` ("running on the main account while `work` is out until …").

---

## 3. Pinned shared contract (Slice S0; both tracks code against exactly this)

### 3.1 New file `packages/shared/src/claude/accounts.ts` (export from `packages/shared/src/index.ts`)
```ts
import { z } from 'zod';

export const MAIN_ACCOUNT = 'main' as const;
export const ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Any account key including 'main'. */
export const AccountKeySchema = z.string().regex(ACCOUNT_KEY_RE);
/** A project / additional account key: never 'main'. */
export const ClaudeAccountKeySchema = AccountKeySchema.refine((k) => k !== MAIN_ACCOUNT, { message: 'reserved' });

/** Announced in hello.capabilities by runners that understand accounts (shift.start.account, claude.account.ensure). */
export const CLAUDE_ACCOUNTS_CAPABILITY = 'claude-accounts:1';

export const ClaudeAccountLoginSchema = z.enum(['ok', 'expired', 'none']);
export const ClaudeAccountInfoSchema = z.object({
  key: AccountKeySchema,
  main: z.boolean(),
  source: z.enum(['config_dir', 'token', 'api_key', 'default']),
  /** Display only, home-relative ('~/.claude-gw-work'). Never a token. */
  configDir: z.string().max(400).optional(),
  email: z.string().max(200).optional(),
  /** oauthAccount.organizationType, e.g. 'claude_max', 'claude_team'. */
  plan: z.string().max(60).optional(),
  login: ClaudeAccountLoginSchema,
  usage: z.enum(['ok', 'limited']),
  limitedUntil: z.iso.datetime().optional(),
  limitedLabel: z.string().max(100).optional(),
  detail: z.string().max(300).optional(),
});
export type ClaudeAccountInfo = z.infer<typeof ClaudeAccountInfoSchema>;

/** The project's account setting as the dispatcher reads it. */
export interface ProjectAccountSetting { accountKey: string | null; fallbackToMain: boolean }
/** The slice of a workstation runtime the resolver reads (RuntimeInfo-compatible). */
export interface AccountRuntimeView {
  available: boolean;
  auth?: 'ok' | 'expired';
  usage?: 'ok' | 'limited';
  limitedUntil?: string;
  accounts?: ClaudeAccountInfo[];
}

/** Is account `key` usable on this runtime now? Legacy runtimes (no accounts[]) only know 'main'. */
export function accountUsable(rt: AccountRuntimeView | undefined, key: string, now: Date): boolean;
/** Any account usable (freeAgents gate). */
export function anyAccountUsable(rt: AccountRuntimeView | undefined, now: Date): boolean;
/**
 * The account a shift runs on: the project's key, else (fallback on) 'main', else null = pause.
 * `project` null/undefined = not ticket-bound, or a project without an account: 'main' if usable, else null.
 */
export function resolveShiftAccount(
  project: ProjectAccountSetting | null | undefined,
  rt: AccountRuntimeView | undefined,
  now: Date,
): { key: string; viaFallback: boolean } | null;
```
Legacy rule inside `accountUsable(rt, 'main')` when `rt.accounts` is absent: `rt.available && rt.auth !== 'expired' && !(rt.usage === 'limited' && rt.limitedUntil && Date.parse(rt.limitedUntil) > now)`. This is today's `activeUsageLimit` semantics; move that helper's logic here and keep `queries/usage-limit.ts activeUsageLimit` as a thin wrapper.

### 3.2 `packages/shared/src/protocol/runner.ts`
```ts
// RuntimeInfoSchema: add
accounts: z.array(ClaudeAccountInfoSchema).max(20).optional(),

// ShiftStartSchema: add
/** The Claude account this shift runs on; absent = 'main'. Only sent to runners with CLAUDE_ACCOUNTS_CAPABILITY. */
account: z.object({ key: AccountKeySchema }).optional(),

// shift.rejected payload schema: add
/** With reason usage_limited | auth_expired | runtime_unavailable(account_missing): the account concerned. */
accountKey: AccountKeySchema.optional(),

// RESUME_STATES: append
'fresh_other_account',

// RunnerCommandNameSchema: append
'claude.account.ensure',
// CommandPayloadSchemas: add
'claude.account.ensure': ClaudeAccountEnsurePayloadSchema,
```
And in `packages/shared/src/claude/accounts.ts`:
```ts
export const ClaudeAccountEnsurePayloadSchema = z.object({
  key: ClaudeAccountKeySchema,
  /** Optional preferred dir ('~' allowed); default: the runner-owned '~/.claude-gw-<key>'. The runner never adopts a dir or alias it did not create. */
  configDir: z.string().max(400).optional(),
});
export const ClaudeAccountEnsureResultSchema = z.object({
  key: ClaudeAccountKeySchema,
  state: z.enum(['ready', 'awaiting_login', 'needs_owner', 'failed']),
  configDir: z.string().max(400).optional(),   // display, home-relative
  aliasAdded: z.boolean(),
  /** Unused by this runner: provisioning never reuses an alias it did not create. */
  aliasExisting: z.string().max(300).optional(),
  aliasConflict: z.boolean().optional(),
  /** Exact commands for the owner when state is needs_owner | failed | awaiting_login. */
  detail: z.string().max(600).optional(),
});
```
The runner answers with `command.result {ok: true, result: ClaudeAccountEnsureResult}`. `ok: false` is used only for unexpected errors.

### 3.3 Events (`packages/shared/src/events/*`)
```ts
// events/project.ts (audience project)
defineEvent('ProjectClaudeAccountSet', z.object({
  projectId: Id,
  accountKey: ClaudeAccountKeySchema.nullable(),   // null = main
  fallbackToMain: z.boolean(),
  changedBy: Id,
})),
// events/card.ts CardClaimed payload: add
accountKey: AccountKeySchema.optional(),           // absent = main
// events/intake.ts QuestionShiftDispatched payload: add
accountKey: AccountKeySchema.optional(),
// events/phase.ts BaTaskDispatched: add
accountKey: AccountKeySchema.optional(),
// events/workstation.ts WorkstationRuntimesChanged.runtimes[] item: add
accounts: z.array(z.object({
  key: z.string(), login: z.string(), usage: z.string(), limitedUntil: z.string().optional(),
})).optional(),
```

### 3.4 API (`packages/shared/src/api/projects.ts`)
```ts
// ProjectDto: add
claudeAccount: z.object({ key: ClaudeAccountKeySchema.nullable(), fallbackToMain: z.boolean() }).optional(),
// ProjectDto.usageLimit object: add
accountKey: AccountKeySchema.optional(),
mode: z.enum(['paused', 'fallback']).optional(),     // absent = 'paused' (legacy meaning)

export const SetClaudeAccountRequestSchema = z.object({
  accountKey: ClaudeAccountKeySchema.nullable(),
  fallbackToMain: z.boolean().default(false),
});
export const ProjectClaudeAccountsViewSchema = z.object({
  setting: z.object({ key: ClaudeAccountKeySchema.nullable(), fallbackToMain: z.boolean() }),
  /** Keys reported by any workstation serving the org (for the picker). */
  knownKeys: z.array(ClaudeAccountKeySchema),
  workstations: z.array(z.object({
    workstationId: z.uuid(),
    name: z.string(),
    connected: z.boolean(),
    supportsAccounts: z.boolean(),                  // CLAUDE_ACCOUNTS_CAPABILITY
    main: ClaudeAccountInfoSchema.optional(),
    account: ClaudeAccountInfoSchema.optional(),    // the project's key on this workstation; absent = missing
    provisioning: ClaudeAccountEnsureResultSchema.shape.state.optional(),  // last ensure result
  })),
});
// Shift DTOs that list shifts: add accountKey?: string
```

### 3.5 Integrations registry (`packages/shared/src/integrations/registry.ts`)
- `claude-code`: `instances: { by: 'account', label: 'Account', placeholder: 'work', defaultInstance: '' }`. Extend the `by` union with `'account'`.
- New method, listed first:
  ```ts
  { id: 'claude_login', label: 'Sign in with your Claude subscription', flow: 'interactive', paste: 'code',
    steps: [{ text: 'Open the sign-in link and sign in to the Claude account for this key.' },
            { text: 'Copy the code the page shows and paste it here.' },
            { text: "The login is stored in this account's own Claude folder on the workstation (e.g. ~/.claude-gw-work)." }] }
  ```
  - Only for a non-empty instance. The web hides it for `''` and the runner refuses it there.
  - Its scope is `machine` (add it to `machineMethods`).
- Add optional `minRunnerForInstance?: string` to `IntegrationKind`; claude-code sets `'0.1.33'` (it applies to every non-empty instance, `minRunner` stays `0.1.11` for the default instance). Reason: the old-runner banner reads `INTEGRATION_KINDS[0].minRunner` (claude-code) for every kind, so bumping `minRunner` itself would change the banner text for all kinds. Server/web use `minRunnerForInstance` when `instance !== ''`.
- `validIntegrationInstance` for `by: 'account'` accepts `''` or `ACCOUNT_KEY_RE`; `checkIntegrationRequest` returns `'sign in needs an account key'` for `claude_login` with instance `''`.
- Also added: `ShiftDto.accountKey?: string` (api/shifts.ts); `ClaudeAccountEnsurePayload`, `ClaudeAccountEnsureResult`, `SetClaudeAccountRequest` and `ProjectClaudeAccountsView` types.
- Resolver semantics as built: `accountUsable` with `accounts[]` present uses the matching entry (`login === 'ok'` and no active limit; a limit with no `limitedUntil` is not active, as today); with no matching entry, `main` falls back to the legacy top-level rule and any other key is unusable. Always false when `!rt.available`. `anyAccountUsable` = main usable or any listed account usable.

---

## 4. Edge cases

- **Old runner (no capability):** it gets no `account` and no ensure command. Its `main` follows the legacy rule; a project key counts as missing (fallback or pause) and gets the "update runner" notice.
- **Old server with a new runner:** the top-level fields still describe main, so behaviour is as today. Deploy the server first anyway: the new enum values (`fresh_other_account`, the command name) and new fields must parse there.
- **Same key, different people on two machines:** both report `email`. `ProjectClaudeAccountsView` lets the panel warn "`work` is a@x on Desktop but b@y on Laptop". No blocking.
- **Several shifts of one agent on different accounts at once:** safe, because each account has its own config dir per agent.
- **The main account itself is out:** every ticket of projects without an account pauses, as do projects with fallback whose own account is also out. DevOps, CEO and question shifts on main pause too, as today.
- **A limit hit mid-shift:** the existing `usage_limited` put-back (no penalty), now carrying `accountKey`. The next pass falls back or pauses.
- **Restart during a limit:** state comes from `claude-accounts-state.json`, so there is no wasted spawn.
- **Login completed in a terminal** (`claude-gw-work`, then `/login`): the `.credentials.json` mtime watch triggers a probe, the account turns `ok` and dispatch resumes.
- **Removing a project's account** (set to `null`): new shifts use main. Nothing is deleted on the workstations.
- **Windows:** no alias step. The dir defaults to `%USERPROFILE%\.claude-gw-<key>`, and the login flow is the same (pseudo-terminal through the existing `integrations/pty.ts`).

---

## 5. Implementation plan: S0, then two parallel tracks, then S9

### S0: Shared contract (one PR, merged first)
- **Files:**
  - new `packages/shared/src/claude/accounts.ts` (schemas, `CLAUDE_ACCOUNTS_CAPABILITY`, `accountUsable`, `anyAccountUsable`, `resolveShiftAccount`, ensure payload and result);
  - `packages/shared/src/index.ts`;
  - `packages/shared/src/protocol/runner.ts` (3.2);
  - `packages/shared/src/events/project.ts`, `card.ts`, `intake.ts`, `phase.ts`, `workstation.ts` (3.3);
  - `packages/shared/src/api/projects.ts` (3.4);
  - `packages/shared/src/integrations/registry.ts`, `integrations/schema.ts` (`by: 'account'`) (3.5).
- **Tests:** `packages/shared/test/claude-accounts.test.ts`:
  - resolver truth table: project key, null, or main × ok / limited / expired / none / missing × fallback on or off × legacy runtime;
  - key regex and the reserved `main`;
  - old payloads (no new fields) still parse;
  - `RESUME_STATES` includes the new value.

### Track A: server and web (after S0; A1 → A2 → A3; A4 can start after A1)
- **A1. Project setting**
  - Files: `apps/server/migrations/2250_claude_accounts.sql`; `apps/server/src/projections/projects.ts`; `apps/server/src/commands/projects.ts` (`setClaudeAccount`); `apps/server/src/routes/projects.ts` (`PUT /api/projects/:id/claude-account`, `GET /api/projects/:id/claude-accounts`); `apps/server/src/queries/misc.ts` (DTO); new `apps/server/src/queries/claude-accounts.ts` (view).
  - Tests: `apps/server/test/claude-account-setting.test.ts` (authorisation, no-op on an unchanged value, rebuild from events, view lists missing and ready workstations).
- **A2. Dispatch**
  - Files: `apps/server/src/dispatcher/dispatcher.ts` (`freeAgents`, card loop, preferred, overflow); `dispatcher/claim.ts`; `dispatcher/questions.ts`; `dispatcher/ba-tasks.ts`; `dispatcher/devops.ts`; the CEO pass; `chat/relay.ts` gating; `apps/server/src/projections/shifts.ts`, `intake.ts`, `phases.ts` (`account_key`); `runner-gateway/brief.ts`, `question-brief.ts`, `ba-task-brief.ts` (`account`, capability-gated); `apps/server/src/cloud/tick.ts`; `queries/usage-limit.ts` (`activeUsageLimit` delegates to shared).
  - Tests: new `apps/server/test/claude-accounts-dispatch.test.ts`, using the fake runner from `apps/server/test/helpers`, reporting `accounts`:
    - a card claims on the project key and `shift.start.account` is set;
    - project account limited with fallback off: no claim; with fallback on: claim on main;
    - main also out: no claim;
    - recovery (`runtimes.report` ok): the next claim returns to the project key;
    - a question with a `card_id` uses the project key, one without uses main;
    - a `spec_card` BA task uses the project key;
    - DevOps and CEO stay on main and pause when main is out but the project key is ok;
    - a legacy runtime only offers main;
    - `shifts.account_key` is recorded.
  - Extend `apps/server/test/usage-limit.test.ts` and `dispatch-rejections.test.ts`.
- **A3. Rejections, provisioning and notices**
  - Files: `apps/server/src/commands/shifts.ts` (account patch on rejection, excluded from the rejection-storm count); `apps/server/src/commands/projects.ts` and `runner-gateway/handlers.ts` (queue `claude.account.ensure` on set and on `hello`, 24-hour throttle; handle its `command.result`, storing the last result in `workstations.runtimes`' account entry or a small operational column); `apps/server/src/commands/workstation-notices.ts` (per-account usage notice, new `claude_account_login`); `apps/server/src/push/notifier.ts`; `apps/server/src/queries/usage-limit.ts` (`usageLimitsFor` project-aware, `mode`); `runner-gateway/handlers.ts` `runtimesReport` (brief includes accounts).
  - Tests: `apps/server/test/claude-account-provision.test.ts` (ensure queued on set and on hello for missing keys, only to capable runners, throttled; each result state opens or closes the right desk item); the notice texts; `usageLimitsFor` paused versus fallback.
- **A4. Web**
  - Files: new `apps/web/src/components/ClaudeAccountPanel.tsx`; `apps/web/src/pages/ProjectSettings.tsx`; `apps/web/src/api/queries/projects.ts`; `apps/web/src/pages/Workstations.tsx`; `apps/web/src/pages/Integrations.tsx` (+ `apps/web/src/lib/integrations.ts` if `by: 'account'` needs labels); `apps/web/src/components/UsageLimitBanner.tsx`.
  - Tests: new `apps/web/src/test/claude-account-panel.test.tsx` (default unchecked, key validation, per-workstation status lines, sign-in link to `?focus=claude-code:<key>`); extend `workstations-page.test.tsx`, `integrations.test.tsx` (several Claude instances, `claude_login` hidden for main), `usage-limit-banner.test.tsx` (fallback mode).

### Track B: runner (after S0; B1 → B2 and B3 in parallel → release)
- **B1. Registry, state and reporting**
  - Files: `apps/runner/src/config.ts` (`accounts`); new `apps/runner/src/adapters/claude-accounts.ts` (`ClaudeAccountRegistry`, persisted state, mtime watch); `apps/runner/src/adapters/claude-auth.ts` (`none` state); `apps/runner/src/integrations/claude-store.ts` (`claudeAccountFile`); `apps/runner/src/runner.ts` (registry replaces `claudeUsage` / `claudeAuth`, per-account probe loops, `runtimeInfos().accounts`, capability in `hello`); `apps/runner/src/adapters/claude-code.ts` (`capabilities()` computes `available` as "any account usable", top-level fields = main); `apps/runner/src/cli.ts` (`accounts list|add|login|remove`).
  - Tests: new `apps/runner/test/claude-accounts.test.ts` (load and save state, login `none` detection, `probeEnv` per source sets `CLAUDE_CONFIG_DIR` or the token, mtime change triggers a probe); extend `claude-usage-limit.test.ts`, `claude-auth.test.ts`, `config.test.ts`, `cli.test.ts`.
- **B2. Provisioning and web login**
  - Files: new `apps/runner/src/adapters/claude-account-provision.ts` (ownership marker, marked-block alias writer, dir rules, machine-scope gate, result); command handler wiring in `runner.ts`; `apps/runner/src/integrations/claude-code.ts` (`instances()`, per-instance `status/test/connect/remove`, `begin(instance,'claude_login')` with `parseClaudeAuthLogin`, `begin(instance,'setup_token')` saving per key).
  - Fixture: record `apps/runner/test/fixtures/integrations/claude-auth-login.txt` first.
  - Tests: new `apps/runner/test/claude-account-provision.test.ts`, run against a temp HOME:
    - the owner's own `~/.claude-work` and `alias claude-work=...` are never adopted or touched: ensure for `work` creates `~/.claude-gw-work` and `claude-gw-work`;
    - a default dir that exists without the marker gives `failed` and is not touched; a dir the runner marked is reused; a `config.json` `configDir` is honoured;
    - a new key creates `~/.claude-gw-<key>` and the block once;
    - a second ensure is a no-op;
    - a second key is added inside the block, sorted;
    - an alias of our name outside the block gives `aliasConflict`;
    - paths in the data dir or in `~/.claude` are refused;
    - a non-primary pairing gives `needs_owner`;
    - an existing `.credentials.json` gives `ready`.
  - Extend `integrations-service.test.ts` / `integrations-runner.test.ts` (the `claude_login` session parses the fixture, `finish` marks the account ok).
- **B3. Spawning per account**
  - Files: `apps/runner/src/adapters/types.ts` (`account?`); `apps/runner/src/sandbox/sandbox.ts` (`claude-acct-<key>` config dir); `apps/runner/src/adapters/claude-code.ts` (`sessionEnv` / `buildClaudeCommand` / `buildClaudeChatCommand` take the account credential; `linkCredentials` and `sessionHooks` bound to the account; `probeUsage` / `probeLogin` per account); `apps/runner/src/adapters/claude-policy.ts` (check only); `apps/runner/src/shifts/supervisor.ts` (pass the account, guard and rejections with `accountKey`, record `accountKey`); `apps/runner/src/sessions/registry.ts` (`accountKey`, `fresh_other_account`).
  - Tests: extend `apps/runner/test/claude-args.test.ts` (environment per account: `config_dir` gives no token variable and the agent dir `claude-acct-<key>`; token gives `CLAUDE_CODE_OAUTH_TOKEN`); `claude-auth.test.ts` (write-back only reaches the session's account file even if the config changed mid-session); `supervisor.test.ts` (unknown, limited and expired accounts give the right rejection plus `accountKey`; a persisted shift restarts on its account); `runner-v3-units.test.ts` (`decide` gives `fresh_other_account`).
- **Release:** bump `RUNNER_VERSION` in `apps/runner/src/version.ts` from `0.1.32` to **`0.1.33`** when B1 to B3 ship together. If B1 ships alone, bump it then and again for B2 and B3 (0.1.34).

### S9: Docs and end-to-end check (after both tracks)
- `docs/ARCHITECTURE.md`: §5 (new event and optional fields); §11.1 (data dir: `claude-accounts-state.json`, `secrets/claude-accounts/`, `agents/<id>/claude-acct-<key>`); §11.2 (`shift.start.account`, `shift.rejected.accountKey`, `claude.account.ensure`, `RuntimeInfo.accounts`, capability); §12.2 (accounts; correct "symlink" to "copy"); §9 (account selection rule). Also `docs/RUNNER.md` (accounts, alias block, login flow).
- Manual check on this machine:
  - set project X to `work`; confirm `~/.claude-gw-work` and `claude-gw-work` are created, `~/.claude-work` and the `claude-work` alias are untouched, and `~/.bashrc` changed only inside the marked block;
  - confirm a card shift runs with `CLAUDE_CONFIG_DIR=agents/<id>/claude-acct-work`;
  - simulate a limit (stub the probe) and check fallback and pause;
  - complete the web login for a new key `test1`.

### Deploy order
Deploy the server first: S0 plus A1 to A3 do nothing until a runner reports accounts and a project sets a key. Then web (A4), then runner 0.1.33.
