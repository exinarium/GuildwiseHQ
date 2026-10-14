# Design: the workstation Integrations page

Status: design, not built. Backlog items: #34 (Integrations page), #60 (Claude sign-in from the web), #48 (MCP auth state), #50 (Claude login expiry), #20 and #21 (plugin MCP servers, Jira).
Builds on: the #48/#50 work already committed in worktree `.claude/worktrees/agent-a922f3b2e033c655d` (commits d771761, 7df27f9). That work adds `RuntimeInfo.auth`, `McpServerInfo.authState`, `claude-auth.ts` (detect, probe, copy and write-back) and `workstation-notices.ts` (desk notices `claude_auth_expired` and `mcp_needs_sign_in`).

Decisions are marked **D1, D2, …**. Questions for the owner are collected at the end (section 10).

---

## 0. What exists today

**Secrets the runner keeps:**
- Git tokens are in `secrets/git-tokens.json` (`forge/tokens.ts`).
- Jira credentials are in `secrets/jira.json` (`external/jira-store.ts`). The older `config.json` `jira` block is still read.
- Claude: `config.json` holds `runtimes.claude-code.{authMode, oauthToken, apiKey}`. Changing it needs a runner restart. In `default` mode the runner uses `~/.claude/.credentials.json`; after #50 agents get a private copy and write it back.
- SSH: the runner keeps paths and check results in `secrets/git-ssh.json`, and the key files themselves in `~/.ssh/aom_<provider>`.
- Logins held by other tools: `gh` and `glab` keep their own (machine-wide). Plugin MCP sign-ins live in `~/.claude/.credentials.json` under `mcpOAuth` (machine-wide).

**Status reports (facts only):**
- runner messages: `git.report`, `jira.report`, `mcp.servers` (with `authState` from #48), and `runtimes.report` / `hello` (with `auth` from #50)
- server columns: `workstations.git_connections`, `jira_status`, `mcp_servers`, `runtimes`

**An encrypted browser-to-runner channel already exists, for the sudo password:**
- The runner generates an RSA-OAEP-2048 key: `secrets/runner-key.pem`, class `RunnerKeys` in `apps/runner/src/secrets/keys.ts`.
- It announces the public key in `hello.sudoKey`. The server stores it in `workstation_keys`.
- The browser encrypts with WebCrypto (`encryptForRunner` in `apps/web/src/api/queries/devops.ts`).
- The server relays the ciphertext in the durable `runner_commands` queue and empties the payload once the result arrives (`applySudoSetResult`).
- `aom-runner doctor` prints the key id, so the user can compare it with the one the page shows.

**Interactive logins already driven by the runner:** `forge/agent-git.ts` (`spawnLogin`, `waitForPrompt`) runs `gh auth login --web`, `glab auth login --web` and `az login --use-device-code` with stdin ignored, and passes on the URL and code.

**The installed Claude CLI (2.1.299), checked with `--help` only; no login was run:**
- `claude setup-token`: no options. It is interactive: it prints a URL, waits for a pasted code, then prints a token that lasts a year.
- `claude auth login [--claudeai|--console] [--email] [--sso]`: no `--no-browser` flag.
- `claude auth status --json` returns these keys: `loggedIn`, `authMethod`, `apiProvider`, `email`, `orgId`, `orgName`, `subscriptionType`, …
- **`claude mcp login <name> [--no-browser]`**: "Print the authorization URL instead of opening a browser (for SSH/headless sessions — paste the redirect URL back when prompted)". There is also `claude mcp logout <name>`.

  This is the supported headless path for MCP OAuth, and it is exactly the paste-back relay #60 asks for.

**`gh` 2.102:** `gh auth login --web` uses the device flow. `--with-token` reads a classic PAT from stdin.

**Several pairings:** each pairing has its own data directory, including `secrets/` and `runner-key.pem`. But `~/.claude`, `gh` and `~/.ssh` belong to the whole machine.

---

## 1. Integration registry (shared)

**D1. One registry in `packages/shared/src/integrations/registry.ts`, plus one runner adapter per kind in `apps/runner/src/integrations/<kind>.ts`.** The web page, the server's validation, the CLI help text and the agents' "how to connect" text are all generated from the registry. Adding an integration means one registry entry, one runner adapter and one test file. No new screen, route, protocol message or CLI command is needed.

### 1.1 Shape

```ts
// packages/shared/src/integrations/schema.ts
export type IntegrationKindId =
  | 'claude-code' | 'github' | 'gitlab' | 'bitbucket-cloud' | 'azure-devops'
  | 'ssh' | 'jira' | 'mcp';                       // future: 'linear', 'sentry', 'slack', ...

export interface IntegrationKind {
  id: IntegrationKindId;
  label: string;                                   // "Bitbucket Cloud"
  group: 'ai' | 'git' | 'tracker' | 'mcp' | 'other';
  /** Several of it per workstation (github per host, mcp per server, ssh per provider@host)? */
  instances: 'single' | { by: 'host' | 'server' | 'provider-host'; defaultInstance?: string };
  /** Where the credential lives: 'workstation' = this pairing's data dir; 'machine' = shared by every pairing (gh, ~/.claude, ~/.ssh). */
  scope: 'workstation' | 'machine' | ((method: string) => 'workstation' | 'machine');
  methods: IntegrationMethod[];                    // first = recommended
  help: { summary: string; docsUrl?: string; notes?: string[] };
  test: { label: string; what: string };           // "Ask Jira who you are (GET /rest/api/2/myself)"
  storage: string;                                 // human text: "secrets/jira.json (0600), this workstation only"
  cli: (instance?: string) => string;              // headless equivalent: "aom-runner jira-connect"
  minRunner: string;                               // version that supports web connect for this kind
}

export interface IntegrationMethod {
  id: string;                                      // 'token' | 'device' | 'setup_token' | 'oauth_paste' | 'api_key' | 'ssh_key' ...
  label: string;
  flow: 'fields' | 'interactive' | 'local_only';   // local_only: only instructions (service principal env vars)
  fields?: IntegrationField[];                     // for 'fields' (and pre-fields of 'interactive', e.g. host)
  scopes?: Array<{ name: string; why: string; required: boolean }>;
  steps: Array<{ text: string; link?: { href: string; label: string } }>;
  expiry?: string;                                 // "Atlassian API tokens expire after at most one year"
  warning?: string;                                // "Subscription tokens are for individual use"
}

export interface IntegrationField {
  key: string; label: string;
  type: 'text' | 'secret' | 'url' | 'email' | 'host';
  required: boolean; placeholder?: string; pattern?: string; maxLength: number; help?: string;
}
```

### 1.2 Status shape (the one fact record the runner reports)

```ts
export const IntegrationStatusSchema = z.object({
  kind: IntegrationKindIdSchema,
  instance: z.string().max(200),                  // '' for single; 'github.com'; 'plugin_atlassian_atlassian'; 'github@github.com'
  state: z.enum(['connected','not_connected','refused','expired','needs_sign_in','unreachable','unavailable','not_needed']),
  method: z.string().max(40).optional(),          // 'token' | 'cli' | 'oauth_token' | 'api_key' | 'default_login' | 'ssh' | ...
  account: z.string().max(200).optional(),        // login / display name / e-mail as the provider reports it
  scopes: z.array(z.string().max(80)).max(50).optional(),
  missingScopes: z.array(z.string().max(80)).max(50).optional(),
  expiresAt: z.iso.datetime().optional(),         // where known (setup-token: savedAt + 1y; provider-reported PAT expiry)
  savedAt: z.iso.datetime().optional(),
  checkedAt: z.iso.datetime(),
  scope: z.enum(['workstation','machine']),
  detail: z.string().max(400).optional(),         // one sentence: why not connected / what next
  publicKey: z.string().max(1000).optional(),     // ssh only (public half)
  site: z.string().max(300).optional(),           // jira base URL, gitlab host, azure org
});
```

### 1.3 Entries (MVP content)

| kind | instances | scope | methods (first = recommended) | test | storage on the runner |
|---|---|---|---|---|---|
| `claude-code` | single | workstation (token, key) / machine (default login) | `setup_token` (interactive: URL, paste code, the runner keeps the 1-year token); `api_key` (fields: key); `oauth_token` (fields: token made elsewhere); `default_login` (interactive `claude auth login`, phase 2) | `claude auth status --json`, then `probeClaudeLogin` (#50) | `secrets/claude.json` (new, 0600; see D9); default login: `~/.claude/.credentials.json` |
| `github` | by host (`github.com` default) | machine | `device` (`gh auth login --web`: code and link shown on the page); `token` (classic PAT: `gh auth login --with-token`; scopes `repo`, `read:org`, `gist`) | `gh api user` plus the `X-OAuth-Scopes` header | gh's own store (keyring or `~/.config/gh`) |
| `gitlab` | by host | workstation (PAT) / machine (glab) | `token` (scopes `api`, `write_repository`); `cli_web` (glab, only when the browser is on the workstation) | `GET /api/v4/user` and `personal_access_tokens/self` (scopes, expiry) | `secrets/git-tokens.json` |
| `bitbucket-cloud` | single | workstation | `token` (fields: Atlassian e-mail, API token; scopes `read:user:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`) | `GET /2.0/user`, then one repository call (#5 states) | `secrets/git-tokens.json` |
| `azure-devops` | by organization | workstation (PAT) / machine (az) | `token` (fields: organization, PAT; "Code: Read & write", "Project and Team: Read"; organization-scoped); `device` (`az login --use-device-code`, phase 2); `service_principal` (local_only: env var steps) | `GET _apis/connectionData` | `secrets/git-tokens.json` |
| `ssh` | by provider@host | machine | `ssh_key` (runner generates `~/.ssh/aom_<provider>`, shows the public key and the upload link from `sshUploadHelp`); `key_file`; `agent` | `git ls-remote` or `ssh -T` (existing `git.ssh check`) | `~/.ssh/aom_*`, `secrets/git-ssh.json`, `secrets/known_hosts` |
| `jira` | single | workstation | `token` (fields: base URL, e-mail (empty = Data Center PAT), API token; classic "Create API token", see R5) | `GET /rest/api/2/myself` | `secrets/jira.json` |
| `mcp` | by server (`plugin_<plugin>_<server>`, instances come from discovery) | machine | `oauth_paste` (interactive `claude mcp login <key> --no-browser`); `not_needed` for stdio servers and servers with their own headers | auth state from `mcpOAuth` (#48); optional `claude mcp get <key>` health check (phase 2) | `~/.claude/.credentials.json` `mcpOAuth` (Claude Code's own) |

Help steps carry deep links: GitHub `https://github.com/settings/tokens/new?scopes=repo,read:org,gist`, Atlassian `https://id.atlassian.com/manage-profile/security/api-tokens`, GitLab `https://<host>/-/user_settings/personal_access_tokens?name=Guildwise&scopes=api,write_repository`, Azure `https://dev.azure.com/<org>/_usersSettings/tokens`, plus the SSH upload pages already in `sshUploadHelp`. Reuse `connectSteps()` (it moves into the registry; `connectSteps` stays as a thin wrapper so `agent-git.ts` and the CLI keep working).

### 1.4 Runner adapter contract

```ts
// apps/runner/src/integrations/types.ts
export interface IntegrationAdapter {
  kind: IntegrationKindId;
  /** Instances known on this workstation (configured hosts, discovered MCP servers, saved tokens). */
  instances(): Promise<string[]>;
  status(instance: string): Promise<IntegrationStatus>;          // never throws; never returns a secret
  /** 'fields' methods: save (only after the provider accepted it), then return the new status. */
  connect?(instance: string, method: string, fields: Record<string, string>): Promise<IntegrationStatus>;
  /** 'interactive' methods: start the login; the session reports prompts and accepts one input. */
  begin?(instance: string, method: string, pre: Record<string, string>): Promise<InteractiveLogin>;
  test(instance: string): Promise<IntegrationStatus>;
  remove(instance: string): Promise<IntegrationStatus>;
}
```

`IntegrationService` (`apps/runner/src/integrations/index.ts`) holds the adapters, runs the commands (section 5), sends `integrations.report`, writes the local audit log and enforces the local policy (D8). The existing `forge/*`, `external/jira*` and `mcp/plugins.ts` code is called by the adapters; it is not rewritten.

---

## 2. Getting a secret from the browser to the runner

### 2.1 Options evaluated

| | (a) end-to-end encrypted relay over the runner websocket | (b) plain relay, no persistence or logging | (c) a page the runner serves on localhost |
|---|---|---|---|
| Works for VPS and Codespace workstations | yes | yes | no (the browser is elsewhere; it would need port forwarding) |
| Server DB, backups or queue rows leak the secret | no (ciphertext only) | the queue row holds plaintext until it is wiped | n/a |
| Server logs, error messages, APM, a proxy that terminates TLS | no | depends on discipline (zod errors, pino, crash dumps) | n/a |
| A passive or curious server operator | protected | not protected | protected |
| An active, malicious server (serves altered JS or a swapped public key) | **not protected** (honest; see 2.3) | not protected | protected (the page and key come from the runner) |
| Browser extensions with page access | not protected (any web form) | same | same |
| Cost | small: a key and a sealing helper already exist | smallest | large: an HTTP server in the runner, DNS-rebinding and CSRF defences, a one-time URL token, works only locally |

**D2. Recommend (a)**, built on the existing runner key. Reject (b): it costs almost the same as (a) and leaves plaintext in Postgres and logs. Reject (c) as the main path: it does not work for the cloud workstations the product sells. It can come back later as an optional "open locally" hardening for owners who do not trust the server (section 9, phase 3).

### 2.2 Envelope

**D3. Hybrid RSA-OAEP-256 plus AES-256-GCM on the existing `RunnerKeys` key.** RSA-OAEP-2048 alone holds at most 190 bytes, and an Atlassian API token is about 192 characters, so the sudo scheme cannot carry it as is. Rejected: a second X25519 key. WebCrypto X25519 is now widely available, but a second key type and fingerprint would buy nothing against the threats that remain.

Browser (`apps/web/src/lib/runner-seal.ts`):
```
k   = AES-GCM-256 key (random), iv = 12 random bytes
ref = requestId (uuid v4, browser-generated) or the sessionId for a paste step
aad = "guildwise-integration-v1\n" + workstationId + "\n" + ref + "\n" + kind + "\n" + instance + "\n" + op
pt  = JSON { v:1, ref, workstationId, kind, instance, op, method, exp, fields }
envelope = { v:1, alg:"RSA-OAEP-256+A256GCM", keyId, wrappedKey: b64(RSA-OAEP(pub, raw k)), iv: b64, ct: b64(AES-GCM(k, iv, aad, pt)) }
```
`op` is `connect` or `input`. `exp` = serverTime + 10 minutes. The server returns `serverTime` with the key, so a skewed browser clock does not matter. Fields are limited to 8 KB in total.

Runner (`RunnerKeys.open(envelope, outer)` in `secrets/keys.ts`; the existing `decrypt` stays for sudo):
1. Check that `keyId` is this pairing's key.
2. Unwrap the key, then decrypt with the AAD rebuilt from the **command's outer fields**. A ciphertext moved to another workstation, kind, instance, session or op fails here.
3. Check that the inner fields equal the outer fields.
4. Check that `now < exp <= now + 15 min`.
5. Replay: refuse a `ref` already seen. Seen refs are kept until their `exp`, in memory and in `secrets/integration-seen.json`, so a restart does not reopen the window. For `input` there is a second guard: a live session in state `awaiting_code` with that `sessionId`, kind and instance must exist, and it accepts exactly one input.
6. Register the plaintext secret with `redact.ts` immediately and hold it only in memory. Write it only to its store file or to the stdin of the login process. It never goes into argv, env (except the git process env, as today), a log line, a report or an error text.

**Sudo:** keep it unchanged in the MVP. It may move to the same envelope later.

### 2.3 Threat model (honest version)

| Threat | Result |
|---|---|
| DB dump, backup, replica, `runner_commands` row | Ciphertext only. The payload is emptied on result or at expiry, by a sweep every minute (D6). |
| Server logs, error bodies, pino request logging, validation errors | The server only sees `envelope`. pino `redact` gets `req.body.envelope` and `*.envelope` as a second line of defence. Route schemas use `z.string()` on base64 with no echoing. |
| Honest-but-curious operator or an insider with DB access | Cannot read it. |
| Replay of a captured envelope (by the server or the network) | Refused: `ref` is in the seen set, `exp` has passed, or for input the session no longer waits. |
| A ciphertext reused for another workstation, kind or session | Refused by the AAD binding. |
| **Compromised server acting actively** (serves JS that keeps the plaintext, or announces its own public key) | **Not prevented.** The server already serves the app and already sends agents their instructions, so it is trusted with integrity. Mitigations: the page shows the key fingerprint, which `aom-runner doctor` also prints (a trust-on-first-use check the owner can do); every change is in the runner's local log (`logs/integrations.jsonl`); `aom-runner integrations allow-web off` (D8) turns web-submitted credentials off entirely. (c) is the real fix if ever wanted. |
| A compromised server replaces a credential, e.g. sets the Claude token to an attacker's account | Possible for an active server, as above. It can already steer agents directly, so this adds little power. It is logged on the runner and audited on the server (D11). Machine-scope changes are limited by D8. |
| One pairing's server changes a machine-wide login used by another pairing (a client's server rewriting the owner's `~/.claude` or `gh` login) | **D8:** machine-scope writes from the web are allowed only from the machine's primary pairing (the first one, or the one marked with `aom-runner integrations machine-admin <pairing>`). Others get "This sign-in is shared by every pairing on this machine; connect it from <primary> or the terminal". |
| Browser extensions, XSS | Inherent to any web form. Secret inputs are `type=password` with `autocomplete=off` and `spellcheck=false`, are cleared after sealing, and are never in the react-query cache, URL or localStorage. CSP stays strict. Help text says so. |
| Shoulder-surfing a device code | The code is single-use, short-lived and bound to the approving account. Acceptable. |

**Who may submit.**

**D4.**
- Only the workstation's own user may connect, replace, test, remove or sign in: `workstations.user_id = session user` and `status='active'`, as with sudo and git-ssh. Anyone else gets a 404.
- Org Owners and Admins see **state only** for workstations that serve their organization (phase 3, Q3), never account names or keys.
- Platform admins see what the admin workstation list shows today: nothing new.

---

## 3. Interactive sign-in flows

### 3.1 Session engine (runner)

**D5.** `apps/runner/src/integrations/session.ts` generalizes `agent-git.ts`'s `LoginProcess`/`spawnLogin` into `InteractiveLogin`:
- **Spawn:** the child runs with cwd = `<data dir>/tmp/integrations` (never a repository, so nothing is written into user repos). For `claude` it runs with the owner's own `HOME` and `CLAUDE_CONFIG_DIR` unset. `NO_COLOR=1`, `COLUMNS=1000`, `BROWSER=true` (a no-op, so nothing tries to open a desktop browser on a headless box). Hard limit: 10 minutes.
- **Pseudo-terminal:** used when the adapter asks for one (the `claude` TUIs need a TTY). It is made with `script(1)`, so no native module is needed (the runner ships as a tgz without native modules):
  - Linux: `script -qfec "<cmd quoted>" /dev/null`
  - macOS: `script -q /dev/null <cmd> <args…>`
  - native Windows: not supported; the tile shows the CLI instructions. WSL2 is Linux.

  Wide `COLUMNS` and `stty cols 1000` stop the terminal from wrapping a long token or URL.
- **Output parsing:** each adapter supplies matchers: `url` (the host must be on the adapter's allow-list or, for MCP, the server's authorization host), `userCode`, `awaitingInput` (a prompt regex), `success` (exit 0 and/or a token regex) and `failure`. **Raw output never leaves the runner.** Only extracted fields go out: URL, user code and a one-line state. All output passes through `redact()`.
- **State machine:** `starting → awaiting_user (URL/code shown) → awaiting_code (paste expected) → completing → connected | failed | cancelled | expired`.
- **Limits:** one session per (kind, instance), at most 2 per workstation.
- **On success:** the adapter stores the result, calls `status()`, sends `integrations.report` and the matching legacy report (`git.report`, `jira.report`, `mcp.servers`, `runtimes.report`), and touches the recheck marker.

### 3.2 Claude Code

- **`setup_token` (recommended for a subscription; Q1).**
  1. The runner runs `claude setup-token` in a pty.
  2. It sends the sign-in URL to the page.
  3. The user opens the URL, signs in to claude.ai and copies the code the Anthropic callback page shows. They paste it on the page. The code is sealed with `op=input` and the runner writes it to stdin.
  4. The CLI prints the token. The runner captures it with `/sk-ant-oat01-[A-Za-z0-9_-]{20,}/`, registers it for redaction, stores `secrets/claude.json` `{authMode:'oauth', oauthToken, savedAt, via:'web'}` (D9) and switches the adapter to the new credential **without a restart**.
  5. It runs `probeClaudeLogin`. The #50 monitor marks the login ok, the runtime becomes available, `runtimes.report` goes out, `syncClaudeAuthNotice` closes the desk notice and dispatch resumes.

  The token never leaves the workstation. The PKCE verifier stays inside `claude` on the runner, so a code that leaks on the way is useless anyway; it is still sealed.

  Side effects to show on the tile: this moves the workstation from `default` to `oauth` mode. Agents then get `CLAUDE_CODE_OAUTH_TOKEN` and no longer depend on the refresh-token rotation of `~/.claude` (which fixes the root of #50 for this workstation). Plugin MCP sign-ins are passed to agents as private copies (#20). The "individual use" warning stays. Expiry is shown as `savedAt + 365 days`. A desk notice 14 days before expiry is phase 2.

  **To verify in the spike (S1):** the exact prompt and token lines under `script`; whether `setup-token` accepts the pasted code from a pty stdin; that it does not also write `~/.claude/.credentials.json`.
- **`api_key` and `oauth_token` (fields).** The key or token is sealed. The runner checks it with a probe under a temporary env before saving (nothing is saved if the probe says expired). Stored in `secrets/claude.json`.
- **`default_login` (phase 2).** `claude auth login --claudeai` in a pty. It has no `--no-browser` flag, so the spike must confirm that it prints a URL and asks for the code when no browser opens. It rewrites the machine's `~/.claude/.credentials.json`, which is also the owner's own interactive Claude login. That makes it machine scope under D8, and it is not the recommended web path.

### 3.3 MCP servers (#48)

`claude mcp login <server key> --no-browser` runs in a pty with the owner's `~/.claude`:
1. It prints the provider's authorization URL. The page shows it with the host prominent ("You are signing in to **auth.atlassian.com**").
2. The user signs in. The provider redirects to `http://localhost:<port>/callback?code=…&state=…`.
   - **If the browser is on another machine** (VPS, Codespace, or a laptop driving a desktop), that page fails to load ("This site can't be reached"). That is expected. The user copies the whole address from the address bar and pastes it into the tile. It is sealed, and the runner writes it to stdin.
   - **If the browser is on the workstation itself,** the localhost redirect may complete on its own (only if the CLI also listens with `--no-browser`; to verify in S2). If not, pasting works the same way.
3. Claude Code stores the `mcpOAuth` entry. The runner re-scans: `authState` becomes `signed_in`, `mcp.servers` is reported and `syncMcpSignInNotices` closes the notice.

Agents then pick the entry up through the #50 copy-and-write-back path in default mode, or the private `mcpOAuth` copy in oauth mode.

Honest limits, shown in the help:
- The CLI's name for a plugin server (`plugin:atlassian:atlassian` or something else) must be confirmed in S2.
- Claude.ai connectors and hand-added servers are out of scope, as in #20.
- A provider that needs the redirect itself to be delivered (`response_mode=form_post`) cannot use paste-back. Then the only way is "On <workstation> run `claude`, `/mcp`, Authenticate" (the existing `mcpSignInInstruction`).

**Sign out:** `claude mcp logout <key>`, machine scope.

### 3.4 Forge CLIs

- **GitHub `device`.** Reuses the `agent-git` login: `gh auth login --web --hostname <h> --git-protocol https` with stdin ignored. The page shows the user code with a Copy button, plus "Open github.com/login/device". The process exits 0, then `gh auth setup-git` runs. No secret crosses the wire.
- **GitHub `token`.** The PAT is sealed and goes to `gh auth login --with-token --hostname <h>` on stdin, then `gh auth setup-git`. For a fine-grained PAT the help warns as `gh` does.
- **Azure `device`** (phase 2): `az login --use-device-code`, same tile UI.
- **GitLab `cli_web`.** glab's web login uses a localhost callback with no paste-back. It is offered only with the note "only when this browser runs on the workstation"; the PAT is recommended.

### 3.5 SSH keys

No new runner work: the tile re-hosts the existing `SshPanel` logic through the `git.ssh` command (`prepare`, `check`, `save`) inside the registry tile.
1. "Create a key": the public key is shown with Copy and a link to the provider's SSH key page (`sshUploadHelp`).
2. "I added it, test": runs `check`.
3. "Use for new clones": runs `save`.

The public key and check result come back in `integrations.report` (`publicKey`). Old runners use `git.report`.

---

## 4. Page and UX

**Routes.**
- `/workstations/:id/integrations`.
- `/integrations` redirects to it when the user has one active workstation. With several, it shows a chooser: name, online dot, count of "needs attention", last used. The last choice is remembered per user in localStorage.
- "Integrations" is a nav entry under Workstations, and each workstation card on the Workstations page gets an Integrations button.

**Layout.** Groups in this order: AI runtime (Claude Code), Git hosts (GitHub, GitLab, Bitbucket Cloud, Azure DevOps, SSH), Trackers (Jira), MCP servers (one row per discovered plugin server), then future groups.

At the top:
- workstation name, online state and runner version
- the runner key fingerprint ("Secrets are encrypted in this browser for this workstation, key `3f9a…c21e`. `aom-runner doctor` shows the same id.")
- a banner when the runner is too old for web connect ("Update to runner ≥ X to connect from here; until then run …", with the CLI line from the registry)

**Each tile shows:**
- **Status badge:** Connected / Not connected / Refused / Expired / Needs sign-in / Unreachable / Tool missing / Not needed.
- **Facts:** as whom; method; site or host; scopes, with missing ones in amber; expiry ("in 41 days", red when under 14); last checked; scope note ("Shared by every pairing on this machine" for machine scope).
- **Actions:**
  - Connect, when not connected
  - Replace, when connected: the same dialog
  - Test: the runner re-checks and returns a fresh status
  - Remove: a confirm dialog that names what is deleted on the workstation
  - Sign in / Sign out for MCP

  Actions are disabled with a reason when the workstation is offline, when another user is viewing, or when D8 forbids a machine-scope change from this pairing.
- **Disclosures:** "How to set it up" (registry steps with links and scopes) and "From a terminal" (the CLI line, for headless machines).

**Connect dialog.**
1. Choose the method (radio, recommended first, with its warning).
2. Fill in the fields (secrets masked).
3. Submit. The button reads "Encrypting for <workstation>…", then "Checking with <provider>…".
4. Result: the new status, or the provider's reason ("Bitbucket refused the token: missing scope write:pullrequest:bitbucket").

**Interactive dialog.** A three-step stepper with a 10-minute countdown and Cancel:
1. "Open this link" (opens a new tab; the code is shown large with Copy)
2. "Paste the code / the address you landed on" (masked input; MCP shows a screenshot hint of the failed localhost page)
3. "Finishing…"

**Deep links** (all go to `/workstations/:id/integrations?focus=<kind>[:<instance>]`, which scrolls to and highlights the tile and opens Connect when `&connect=1`):

| Where | Change |
|---|---|
| Project settings, repository provider control (`RepoProviderControl` / `ConnectHelper`) | "Connect on the Integrations page" replaces the CLI-only helper. The CLI line stays under "From a terminal". |
| Card detail | Where a finalize notice says "no login for the host" or the BA reports Jira not connected, a link to the tile. |
| Desk notices `claude_auth_expired` and `mcp_needs_sign_in` (from #50/#48) | `Desk.tsx` adds a subkind action "Sign in from the web" using `item.data.workstationId`. The notice text gets "or open Integrations". |
| `McpServersPanel` and `WorkstationSignIns` (#48/#50) | The "needs sign-in" or "login expired" badge becomes a link. |
| `JiraStatusLine`, `GitConnectionsPanel` on Workstations | Replaced by a one-line summary ("3 of 5 connected · Open Integrations") in phase 2. In the MVP they stay and gain a link. |

**Workstations owned by someone else.** When the project's workstation belongs to another member, the link is replaced by "Ask <name> to connect <kind> on <workstation>".

---

## 5. Protocol, server routes, data, permissions

### 5.1 Protocol additions (all additive; old runners ignore them, old servers never send them)

**Runner to server:**
- `integrations.report { integrations: IntegrationStatus[] (max 100), registryVersion: number }`
  - Sent after `welcome`, after any connect, remove or test, after a recheck marker, and on the 10-minute rescan when something changed.
  - The legacy `git.report`, `jira.report`, `mcp.servers` and `runtimes.report` continue unchanged. Dispatch, project settings and #48/#50 still read them.
- `integration.session { sessionId, kind, instance, state, prompt?: { url?, urlHost?, userCode?, inputLabel?, inputKind?: 'code'|'redirect_url'|'none' }, status?: IntegrationStatus, error?: string(300) }`
  - Added to `RUNNER_ACKED_TYPES` (low volume; a terminal state must not be lost).
- `hello.integrationsVersion?: number`: the runner announces that it supports web connect.

**Server to runner:** new `RunnerCommandName` values with payload schemas in `CommandPayloadSchemas`:

| command | payload | result (`command.result`) |
|---|---|---|
| `integration.connect` | `{ requestId, kind, instance, method, envelope }` | `{ status }` or `{ error }` |
| `integration.begin` | `{ sessionId, kind, instance, method, pre? }` (non-secret pre-fields: host, organization) | `{ accepted: true }` (progress via `integration.session`) |
| `integration.input` | `{ sessionId, kind, instance, envelope }` | `{ accepted }` |
| `integration.cancel` | `{ sessionId }` | `{}` |
| `integration.test` | `{ requestId, kind, instance }` | `{ status }` |
| `integration.remove` | `{ requestId, kind, instance }` | `{ status }` |

`git.ssh` stays as it is, for SSH.

### 5.2 Delivery and expiry

**D6.**
- All `integration.*` commands use the existing durable `runner_commands` queue, so result correlation and redelivery on reconnect work as today.
- Routes refuse with `409 workstation_offline` when the runner is not connected.
- Commands carrying an envelope also get `expires_at = now + 10 min`.
- On `command.result`, the payload is set to `'{}'` (as `applySudoSetResult` does). A one-minute sweep (in the existing job loop) marks `pending`/`sent` integration commands past `expires_at` as `failed` with `payload='{}'`.
- All `integration.*` results are **terminal** (no blind retry; the user clicks again), handled as `repo.create` is.
- Only one pending `integration.connect` per (workstation, kind, instance); an earlier undelivered one is dropped.

### 5.3 Server data

**Migration `1870_workstation_integrations.sql`:**
```sql
CREATE TABLE workstation_integrations (          -- operational: latest facts per (workstation, kind, instance)
  workstation_id uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  kind text NOT NULL, instance text NOT NULL DEFAULT '',
  status jsonb NOT NULL, checked_at timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, kind, instance));
CREATE TABLE integration_requests (              -- operational, short-lived (deleted after 24 h, like forge_repo_lists)
  id uuid PRIMARY KEY,                           -- browser requestId or server sessionId
  workstation_id uuid NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, kind text NOT NULL, instance text NOT NULL DEFAULT '',
  op text NOT NULL CHECK (op IN ('connect','session','test','remove')),
  method text, state text NOT NULL,              -- pending|awaiting_user|awaiting_code|completing|done|failed|cancelled|expired
  prompt jsonb,                                  -- url, urlHost, userCode, inputLabel: never a secret
  status jsonb, error text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX ON integration_requests (workstation_id, state);
ALTER TABLE runner_commands ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS integrations_version int;
ALTER TABLE workstations ADD COLUMN IF NOT EXISTS primary_pairing boolean;   -- reported by the runner, for D8 display only
```
`workstation_integrations` is added to the keep-over-rebuild list in `apps/server/src/projections/rebuild.ts`. `integration_requests` is not added: it is short-lived. Migration 1880 is reserved for phase 2 (expiry notices).

**Events versus operational tables.**

**D7.**
- Status facts are **operational**. They churn, are re-reported, are not history and are not rebuilt from events.
- Who-did-what is **events** (audit), in the event log under the workstation stream, `userScope(owner)`, actor = user:
  - `WorkstationIntegrationConnected { workstationId, kind, instance, method, account?, by }`
  - `WorkstationIntegrationRemoved { workstationId, kind, instance, by }`
  - `WorkstationIntegrationSignInStarted { workstationId, kind, instance, method, by }`
  - Optionally `WorkstationIntegrationChanged { workstationId, kind, instance, from, to, via: 'workstation' }`, emitted by the server when a report shows a state change it did not initiate (CLI or expiry). It is debounced and only for state transitions.

  None of these carries a token, field value, URL or code.
- The runner keeps its own JSONL `logs/integrations.jsonl`: time, kind, instance, op, method, via (`web:<userId>` or `cli`), result. No secrets.

### 5.4 Routes (`apps/server/src/routes/integrations.ts`; all `requireUser` plus the D4 ownership check)

| Method and path | Purpose | Rate limit |
|---|---|---|
| `GET /api/integrations/registry` | registry metadata (static, cacheable) | none |
| `GET /api/workstations/:id/integrations` | `{ key:{keyId, publicKey}, serverTime, runner:{connected, version, integrationsVersion, primaryPairing}, integrations: IntegrationStatus[], activeSessions }`. For old runners the statuses come from the legacy columns (`legacyIntegrations()` maps git, jira, mcp_servers and runtimes.auth), read-only. | 60/min |
| `POST /api/workstations/:id/integrations/connect` | `{ requestId, kind, instance, method, envelope }` → 202 | 10/min/user |
| `GET /api/workstations/:id/integrations/requests/:rid` | poll a request or session (state, prompt, status, error) | 120/min |
| `POST /api/workstations/:id/integrations/sessions` | `{ kind, instance, method, pre? }` → 202 `{ sessionId }`. Refused if one is live for the same kind and instance. | 6/10 min/workstation |
| `POST /api/workstations/:id/integrations/sessions/:sid/input` | `{ envelope }`. Only in `awaiting_code`; at most 3 inputs per session (a wrong code ends the CLI anyway). | 10/min/user |
| `POST /api/workstations/:id/integrations/sessions/:sid/cancel` | | 30/min |
| `POST /api/workstations/:id/integrations/test` | `{ requestId, kind, instance }` | 30/min |
| `POST /api/workstations/:id/integrations/remove` | `{ requestId, kind, instance }` | 10/min |
| `GET /api/orgs/:id/workstation-integrations` (phase 3) | Owner/Admin: per member workstation serving the org, `{ workstation, owner, kind, instance, state }` only | 30/min |

**Server checks before relaying:**
- `kind`, `method` and `instance` are valid against the registry.
- The method's flow matches the route.
- `envelope.keyId` equals the stored key (else `409 runner_key_changed`: reload).
- The size limit holds.
- The workstation is online.
- The runner's `integrationsVersion` is high enough for the kind (`minRunner`).

**Validation:** enums are checked against the registry, and the `envelope` is treated as opaque base64 that is never logged, echoed or stored beyond the command row.

**Updating the page.** The MVP polls the request every second while a dialog is open; this is the existing `forge_repo_lists` pattern. Phase 2 may push `integration.session` over the browser websocket to the owner's sockets.

---

## 6. Runner-side changes

**Local policy.**

**D8.** New config block `integrations: { allowWeb: boolean (default true), machineScopeFromWeb: 'primary' | 'never' (default 'primary') }`. CLI:
- `aom-runner integrations` lists the status table
- `aom-runner integrations allow-web on|off`
- `aom-runner integrations machine-admin <pairing>`

When the web is refused, the command result says so and the tile shows "Turned off on this workstation (`aom-runner integrations allow-web on`)".

**Claude credentials.**

**D9.** A new `secrets/claude.json` (0600), resolved like `resolveJira`: secrets file first, then the `config.json` fields. `ClaudeCodeAdapter` reads auth through a provider function at each session start, so changing it needs no restart. Both `aom-runner auth api-key` and `aom-runner auth oauth-token` write the secrets file too; the "then restart the service" step disappears from the docs. Removing the credential falls back to `config.json`, otherwise to `default`.

**Files to create (runner):** `apps/runner/src/integrations/`
- `index.ts` (`IntegrationService`)
- `types.ts`
- `session.ts`
- `pty.ts`
- `seen.ts` (replay cache)
- `audit-log.ts`
- `claude-store.ts`
- adapters: `claude-code.ts`, `github.ts`, `gitlab.ts`, `bitbucket.ts`, `azure-devops.ts`, `ssh.ts`, `jira.ts`, `mcp.ts`

**Files to modify (runner):**
- `secrets/keys.ts`: add `open()`
- `runner.ts`: command routing, `integrations.report`, `hello.integrationsVersion`
- `adapters/claude-code.ts`: the auth provider getter
- `config.ts`: the `integrations` block
- `cli.ts`: the `integrations` command; `jira-connect`, `git-connect` and `auth` call the same adapter `connect()`, so CLI and web share one path
- `forge/agent-git.ts`: reuse `session.ts`
- `mcp/plugins.ts`: expose the server key for `claude mcp login`

**Shared:**
- create `packages/shared/src/integrations/{registry.ts,schema.ts,envelope.ts,index.ts}`
- modify `protocol/runner.ts`, `api/workstations.ts` (`integrations?` on the DTO), `events/workstation.ts`, `forge/index.ts` (`connectSteps` reads the registry)

**Server:**
- create `migrations/1870_workstation_integrations.sql`, `commands/integrations.ts`, `routes/integrations.ts`
- modify:
  - `runner-gateway/handlers.ts` (the two new messages, `command.result` branches, wiping payloads)
  - `runner-gateway/commands-queue.ts` (`expires_at`)
  - `projections/rebuild.ts`
  - `queries/misc.ts` (DTO)
  - the app's pino `redact` paths
  - the job loop (the expiry sweep)

**Web:**
- create:
  - `pages/Integrations.tsx`
  - `components/integrations/{IntegrationTile,ConnectDialog,SignInSession,WorkstationChooser,McpSignInList}.tsx`
  - `lib/runner-seal.ts` (`encryptForRunner` moves here, sudo keeps using it)
  - `api/queries/integrations.ts`
  - `help/articles/integrations.md`
  - a What's new entry
- modify `router.tsx`, nav, `Workstations.tsx`, `GitConnections.tsx`, `RepoProviderControl.tsx`, `JiraStatusLine.tsx`, `McpServersPanel.tsx`, `WorkstationSignIns.tsx`, `Desk.tsx`, `CardDetail.tsx` (notice links)

---

## 7. CLI migration and docs

- **D10.** Every existing CLI command stays, for headless machines and for owners who turn the web off:
  - `git-connect` (all flags)
  - `jira-connect`
  - `auth api-key|oauth-token`
  - `rotate-token`
  - `org-folder`

  Internally they call the adapters' `connect()`, `remove()` and `status()`, so behaviour, checks and storage are identical, and the change shows on the page within the 10-second recheck. New: `aom-runner integrations [list|allow-web|machine-admin]`.
- **`docs/RUNNER.md`:**
  - new section "Integrations (connect from the web)": the registry, the envelope, D8, the local log, `script(1)` and the pty requirement, what is machine-wide and what is per workstation
  - update "Setting credentials" (no hand edit of `config.json`; `secrets/claude.json`)
  - update "Claude credentials on a cloud workstation" (setup-token from the web)
  - update "Plugin MCP servers" (sign in from the web, paste-back, limits)
  - update "Credentials and secrets"
  - update "Jira on the runner" (API token kind, R5)
- **`docs/USER-GUIDE.md`:** a new subsection after 3.4, "Connect your integrations": step by step per kind, with the honest MCP paste-back explanation. Update 4.19 (cloud workstations).
- **`docs/ARCHITECTURE.md`:** protocol table rows and the threat model paragraph.
- **Help article and What's new:** as above.
- **Runner release:** the runner version bump is needed. It is a separate go-ahead and is not part of this design's approval.

### 7.1 Tests

**Shared:**
- Registry validity: every kind has methods; `fields` methods have fields; secret fields are `type: 'secret'`; links are https; ids are unique; `minRunner` is semver.
- Status schema bounds.
- `connectSteps` still produces today's text.

**Crypto (shared and runner):**
- The browser seals with WebCrypto (Node webcrypto in vitest) and `RunnerKeys.open` reads it back.
- Refusals for:
  - tampered AAD (different workstation, kind or session)
  - inner and outer fields that do not match
  - `exp` in the past, or more than 15 minutes ahead
  - a replayed `ref`, also after a restart (the seen file)
  - a different `keyId`
  - an oversize payload
- The plaintext never appears in any message the runner sends or in its log, checked by scanning everything a fake client captured.

**Runner adapters** use fakes (fetch, exec and scripted spawn transcripts recorded from real CLIs in S1/S2):
- `claude setup-token` happy path, wrong code and timeout
- `claude mcp login` paste-back
- gh device flow and gh `--with-token`
- Bitbucket missing scope (#5 states)
- Jira refused
- GitLab expiry and scopes from `personal_access_tokens/self`
- D8 policy refusals
- hot switching of the Claude credential
- `integrations.report` after a CLI change

**Server:**
- ownership: another user gets 404; an org Owner gets 404 on write
- offline gives 409
- `runner_key_changed` gives 409
- payload wiped after the result and after expiry
- the envelope never appears in pino output (capture the logger)
- rate limits
- the old-runner legacy mapping
- events carry no secret fields
- `workstation_integrations` survives a rebuild
- terminal command results are never retried

**Web:**
- a tile per state
- the connect dialog sends only `envelope` (assert on the request body that no field value appears)
- the session stepper (poll states, countdown, cancel)
- the chooser
- deep links from Desk, McpServersPanel, RepoProviderControl and JiraStatusLine
- the old-runner banner

**E2E:** a fake runner in `apps/server/test/helpers/fake-runner.ts` answering `integration.*`, plus one Playwright flow for a Jira connect and for a device-code session.

---

## 8. Risks

- **R1. The TTY behaviour of `claude setup-token`, `claude auth login` and `claude mcp login` is not verified** (help was read; no login was run). The spike S1/S2 decides the matchers. If `setup-token` cannot run under `script(1)`, the fallback is that the tile shows the steps to run `claude setup-token` anywhere (even on the user's laptop) and paste the resulting token (`oauth_token` method), still sealed.
- **R2. The CLI's plugin server name for `claude mcp login`** may differ from `plugin:<plugin>:<server>`. S2 finds out; the adapter maps it.
- **R3. Claude CLI output can change between versions.** The matchers are kept in one file with recorded transcripts as tests. An unknown output ends in `failed` with "use the terminal: <cmd>", never a hang.
- **R4. Switching to `authMode: oauth` changes the MCP credential path** (private `mcpOAuth` copy). Refreshed MCP tokens are written back only if #50's write-back also covers oauth mode; the builder should confirm this with the #50 code.
- **R5. Atlassian scoped API tokens** must be called through `https://api.atlassian.com/ex/jira/<cloudId>`, not the site URL, which the current adapter uses. The MVP help asks for the classic "Create API token". Phase 2 lets the adapter resolve the `cloudId` (via `https://<site>/_edge/tenant_info`) when a scoped token is refused at the site URL.
- **R6. D8 depends on the runner knowing its primary pairing.** It defaults to the first entry in `pairings.json`.
- **R7. Native Windows has no `script(1)`.** Interactive Claude flows show CLI instructions there. Fields flows work everywhere.

---

## 9. Phasing

**Spike (start of the MVP run, about an hour, on a real workstation with a throwaway account if possible):**
- S1: `claude setup-token` under `script -qfec` (URL line, prompt, token line, exit code, files touched).
- S2: `claude mcp login <name> --no-browser` (server naming, whether it also listens on localhost, the paste prompt).
- S3: `gh auth login --web` output with stdin ignored. `agent-git` already relies on this, so it is a confirmation only.

Record the transcripts (redacted) as test fixtures.

**MVP (one builder run):**
1. Shared: the registry with all kinds listed (`azure-devops` `device` and `claude-code` `default_login` marked phase 2), the status schema, the envelope helpers.
2. Runner:
   - `IntegrationService`
   - envelope open, replay cache, D8 and D9
   - the session engine with `script(1)`
   - adapters: `claude-code` (`setup_token`, `api_key`, `oauth_token`), `mcp` (`oauth_paste`), `github` (`device`, `token`), `bitbucket-cloud`, `gitlab` (`token`), `azure-devops` (`token`), `jira`; `ssh` as a status wrapper around the existing `git.ssh`
   - the `integrations.report` message
   - the CLI's `integrations` command; `jira-connect`, `git-connect` and `auth` routed through the adapters
3. Server: migration 1870, routes, `command.result` handling, the expiry sweep, pino redaction, the three audit events, the legacy mapping for old runners.
4. Web: the page, chooser, tiles, the connect and session dialogs, deep links from Desk (both notice subkinds), McpServersPanel, WorkstationSignIns, RepoProviderControl and JiraStatusLine.
5. Docs: RUNNER.md, USER-GUIDE, help, What's new. Tests as in 7.1.
6. Runner release: a separate go-ahead.

If the run is tight, cut from the end of this list: `azure-devops` `token`, then `gitlab` `token`, then the SSH re-host. Claude, MCP, Jira, Bitbucket and GitHub are the owner's actual pain points and stay.

**Phase 2:**
- `claude auth login` (`default_login`) from the web
- `az login --use-device-code`
- Jira scoped tokens (`cloudId`)
- expiry notices 14 days ahead (setup-token, GitLab/Azure PAT expiry; migration 1880)
- the MCP Test via `claude mcp get`
- push session updates over the browser websocket instead of polling
- collapse the Workstations page's Git, Jira and MCP panels into a summary line
- move sudo to the hybrid envelope

**Phase 3:**
- the org Owner status overview (Q3)
- an optional runner-served localhost page for owners who do not trust the server (option c)
- organisation-wide shared keys, stored encrypted (#34 "optional later"; only if the owner wants it)
- provider OAuth apps (Atlassian, GitHub App) instead of pasted tokens

---

## 10. Questions for the owner

1. **Claude sign-in from the web: which flow should be recommended?**
   - **Recommendation:** `claude setup-token` driven by the runner (a 1-year token kept on the workstation; the workstation moves to `oauth` mode). It removes the refresh-token race behind #50 for that workstation.
   - **Alternative:** web-driven `/login` (`default` mode, which also changes the owner's own interactive Claude login on that machine). That comes later as phase 2.
   - The API key stays available, and stays the recommendation for cloud workstations.
2. **Web-submitted credentials on by default?**
   - **Recommendation:** yes, on by default.
   - A local `aom-runner integrations allow-web off` turns it off.
   - Machine-wide logins (`~/.claude`, `gh`, MCP sign-ins) can only be changed from the machine's primary pairing.
3. **Org Owner and Admin view.**
   - **Recommendation:** in phase 3, show Owners and Admins the integration **state only** (connected / needs attention, no account names) for members' workstations that serve the organization, so they can see why work is stuck.
4. **Approve the server additions.**
   - Migration 1870 (two operational tables, plus `expires_at` on `runner_commands`).
   - The new `/api/workstations/:id/integrations/*` routes.
   - Three audit events (`WorkstationIntegrationConnected`, `…Removed`, `…SignInStarted`).
   - Two runner messages and six runner commands, all additive.
   - **Recommendation:** approve. The server stores facts and ciphertext in transit only, never a token.
5. **Organisation-wide keys** (one Jira service account for all workstations).
   - **Recommendation:** not now. It would be the first secret the server holds, which breaks the "secrets stay on the workstation" rule; revisit only if several members need the same tracker account.


## 11. Owner decisions (2026-10-14)

Taken on the recommendations above (the owner asked to proceed on recommendations unless a question truly needs him):
Q1 `claude setup-token` from the web first; Q2 web-submitted credentials on by default (local switch to turn off);
Q3 Owners/Admins see state only, phase 3; Q4 server additions approved for local/UAT (production deploys wait for the
owner); Q5 no organisation-wide keys now.
