# GWP-131: Jira credentials and git host tokens sealed at rest on the runner

## 1. Question

The runner keeps two credential files in plaintext JSON (mode 0600): `secrets/jira.json` (Jira base URL, e-mail,
API token) and `secrets/git-tokens.json` (GitLab, Bitbucket Cloud and Azure DevOps tokens). Owner decision 3 says
tokens are stored encrypted on the workstation. Move both files onto the existing sealed-file store
(`apps/runner/src/secrets/sealed-file.ts`, AES-256-GCM, key derived from `runner-key.pem`). Existing plaintext files
must migrate with no user action. A file that cannot be decrypted must give a clear "connect again" message, must not
crash the runner and must not wipe other credentials.

## 2. Step 0: what the current code already does

Checked by reading, at `b648d067` (the card branch base; per the planning note this is also `release/1.6.0`).

| File | Sealed? | Evidence |
|---|---|---|
| `apps/runner/src/external/jira-store.ts` (`JiraCredentialStore`, `resolveJira`) | **No** | Imports only `node:fs`/`node:path`/`config.ts`. `save()` writes `JSON.stringify(cfg)` through `${file}.${pid}.tmp`, then renames it. `load()` uses `JSON.parse` + `JiraConfigSchema`. |
| `apps/runner/src/forge/tokens.ts` (`FileTokenStore`) | **No** | `write()` writes `JSON.stringify(data)` through `${file}.tmp`, then renames it. `read()` uses `JSON.parse` + `migrate()` (the Azure DevOps key migration). |
| `apps/runner/src/secrets/sealed-file.ts` | Exists | Used by `storage/store.ts`, `outbound-delivery/send.ts` (WhatsApp, Google Sheets) and `outbound-delivery/journey-webhook.ts`. |

**Result: neither file is sealed. Both have to be built, so the card is not closed.** No other process reads either
file directly: there is no credential helper or script that opens them. A grep for `git-tokens` / `jira.json` over
`apps/`, `packages/` and `scripts` finds only the stores, the places that construct them, comments and user-facing
text. This means only the stores have to change format.

## 3. Findings

### 3.1 Where the stores are constructed (each one needs a key)

| Site | Constructs | Has a key today? |
|---|---|---|
| `runner.ts:431` (`forgeEnv.tokens`) | `FileTokenStore` | `this.keys` exists but is created **after** this line (`runner.ts:439`). It has to move up. |
| `runner.ts:972` (`jiraConfig()`) → `resolveJira` | `JiraCredentialStore` | Yes: `this.keys.deriveFileKey`. |
| `integrations/jira.ts:24,33` (`JiraIntegration.store()`, `status()`) | `JiraCredentialStore`, `resolveJira` | `AdapterEnv.sealKey` is set by the runner (`runner.ts:938`). It is optional, and `headlessEnv` and the test envs do not set it. |
| `integrations/headless.ts:54` | `FileTokenStore` | No. Used by the CLI commands `jira-connect`, `integrations` and `auth`. |
| `cli.ts:761` (`jiraConnect`) | `JiraCredentialStore` | No. `paths.secrets` is known, and `cli.ts:645` already builds `RunnerKeys` the same way. |
| `cli.ts:858` (`gitConnect`) | `FileTokenStore` | No, same as above. |

`runner-key.pem` is always `<paths.secrets>/runner-key.pem`. The CLI already opens it for WhatsApp, so the runner
process and the CLI derive the same file key.

### 3.2 Behaviour traps

1. **Silent wipe.** `FileTokenStore.read()` turns any error into `{}`. With a sealed file and the wrong key, `set()`
   would then save `{ newToken }` over the file and destroy every other token. `SealedFile.load()` has the same
   problem: it returns `undefined` for missing, plaintext, wrong key and damaged files alike, so the caller cannot
   tell them apart.
2. **Silent fallback.** `resolveJira()` falls back to the `jira` block in config.json whenever `load()` returns
   `undefined`. If decryption fails, the runner would quietly switch to older credentials.
3. **`migrate()` in tokens.ts is the Azure DevOps key migration** (`azure-devops@host` → `#org`). It runs in memory
   on every read and is saved on the next write. It must keep working on data that comes out of the sealed file and
   out of a legacy plaintext file.
4. **Redaction lifetime.** `JiraIntegration.connect()` and `forge-tokens.ts saveToken()` call
   `unregisterSecret(token)` in `finally`. That removes the registration made by `SealedFile.save()`. This is
   acceptable because neither store caches: every use reads the file again, and every sealed read registers the
   token again (`SealedFile.load` → `registerSecret`). Leave those `finally` blocks as they are.
5. **GitHub does not use `git-tokens.json`.** Only `forge/gitlab.ts`, `forge/bitbucket.ts` and `forge/azure.ts` call
   `tokens.get`. GitHub logins are held by `gh`. The AC example "GitHub PAT" therefore has to be tested with a GitLab,
   Bitbucket or Azure DevOps token.
6. **Existing tests read the raw file as plaintext.** These assertions change by nature:
   `forge.test.ts:579` (`toContain('abc')`), `azure-tokens.test.ts:46,80` (`JSON.parse(readFileSync)`),
   `jira-connect.test.ts:72`, `integrations-service.test.ts:227`, and the `resolveJira` signature in
   `attachments.test.ts:223-234`. `jira-connect.test.ts` and `attachments.test.ts` are **not** in the card's
   Affected areas, so the runner's out-of-scope-test flag would fire (see ledger GWP-1 / GWP-3). I posted a comment
   on the card asking for both paths to be added.

### 3.3 Downgrade

An older runner (for example after a version pin) that reads a sealed file sees no credentials: Jira shows "not
connected", and git host tokens are missing. If that older runner then saves a git token, it writes plaintext that
holds the envelope fields as junk entries. The new runner drops those entries when it migrates, so the sealed tokens
are lost and have to be connected again. This is acceptable and the same as for the other sealed files. Mention it
in the release notes.

## 4. Options

### 4.1 How the stores get the key

| Option | For | Against |
|---|---|---|
| **A. Explicit `keyOf` constructor argument** (as `StorageStore`, `OutboundDelivery` and `JourneyWebhookCaller` do) plus a small `fileKeyOf(secretsDir)` helper for the CLI and headless paths | Consistent with every other sealed store. The type checker finds every construction site. No hidden file reads or key generation inside a constructor. Tests pass a fixed 32-byte key (fast, no RSA). | Constructor and `resolveJira` signatures change (internal only; the `TokenStore` methods do not change). |
| B. Optional `keyOf` that defaults to `<dirname(file)>/runner-key.pem` | Call sites stay the same. | Implicit coupling. Each test that points at a temp dir generates a 2048-bit RSA key. A forgotten site still works but is hard to see. |

**Choice: A.** The card's "do not change the TokenStore / JiraCredentialStore interfaces seen by callers" is met:
`get/set/remove/list` and `load/save/remove` keep their signatures. Only construction changes.

### 4.2 Plaintext → sealed migration

| Option | For | Against |
|---|---|---|
| **A. Generic, in `SealedFile.open({ legacy })`**: a non-envelope file that the legacy parser accepts is sealed in place | One implementation, one test surface, reusable later (for example by the config.json Jira block). | Small extension of SealedFile (allowed by the card: "only extend it if a migration helper is missing", and it is missing). |
| B. Each store does its own detect / parse / save | No SealedFile change. | Duplicated logic around a security-sensitive ordering. |

**Choice: A.**

### 4.3 Removing the plaintext

`save()` writes `${file}.${pid}.tmp` (0600) and `rename`s it over the plaintext file. After the rename the
plaintext no longer exists under any name; no `.bak` is left next to it. I do **not** recommend zero-filling the old
file before the rename. On SSDs, journaling and copy-on-write filesystems it does not reliably scrub the blocks, and
it opens a window where a crash loses the only readable copy. Write this limitation in docs/RUNNER.md. Also delete
the leftover legacy tmp file `git-tokens.json.tmp` (the old `write()` name, which may hold plaintext after an earlier
crash) once the migration succeeds.

### 4.4 Unreadable file

| Option | Result |
|---|---|
| Throw from `get()`/`load()` | Crashes callers (poller, clone, status). Rejected because of R6. |
| Return empty and let `set()` overwrite | Silent wipe. Rejected. |
| **Return empty, report a problem, and move the unreadable file aside on the next write** | Callers see "not connected" with a "connect again" detail. Connecting again works. The unreadable file is kept, still encrypted, as `<name>.unreadable-<timestamp>`, so it can be recovered if the old key comes back. A warning is logged once. |

**Choice: the third.**

## 5. Recommendation and design

### 5.1 `apps/runner/src/secrets/sealed-file.ts` (extend; existing behaviour unchanged)

```ts
export type SealedRead<T> =
  | { state: 'missing' }
  | { state: 'ok'; value: T; migrated: boolean }
  | { state: 'unreadable'; reason: 'key' | 'damaged' };

const isEnvelope = (x: unknown): x is Envelope =>
  !!x && typeof x === 'object' && (x as Envelope).v === 1 && (x as Envelope).alg === 'A256GCM' &&
  typeof (x as Envelope).iv === 'string' && typeof (x as Envelope).ct === 'string' && typeof (x as Envelope).tag === 'string';

open(opts: { legacy?: (raw: unknown) => T | undefined } = {}): SealedRead<T> {
  if (!existsSync(this.file)) return { state: 'missing' };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { return { state: 'unreadable', reason: 'damaged' }; }
  if (!isEnvelope(raw)) {
    const value = opts.legacy?.(raw);
    if (value === undefined) return { state: 'unreadable', reason: 'damaged' };
    for (const s of this.secretsOf(value)) registerSecret(s);   // before anything can log
    try { this.save(value); } catch { return { state: 'ok', value, migrated: false }; } // retried next read; never writes plaintext
    return { state: 'ok', value, migrated: true };
  }
  let plain: string;
  try { /* existing decipher, AAD = basename */ } catch { return { state: 'unreadable', reason: 'key' }; }
  const parsed = /* JSON.parse + schema.safeParse, in try */;
  if (!parsed?.success) return { state: 'unreadable', reason: 'damaged' };
  for (const s of this.secretsOf(parsed.data)) registerSecret(s);
  return { state: 'ok', value: parsed.data, migrated: false };
}

load(): T | undefined { const r = this.open(); return r.state === 'ok' ? r.value : undefined; } // same as today: no legacy, plaintext → undefined

/** Moves an unreadable file aside (it stays encrypted) so a new save does not destroy it. Returns the new path. */
quarantine(): string | undefined {
  if (!existsSync(this.file)) return undefined;
  const to = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(this.file, to);
  return to;
}
```

Notes: `reason: 'key'` covers a GCM auth failure, which cannot tell a wrong key from a tampered file. The message
therefore says "the runner key changed or the file is damaged". `load()` keeps returning `undefined` for a plaintext
file (no legacy option), so the existing users (storage, WhatsApp, Sheets, webhooks) behave exactly as before.

A shared message helper, also in `sealed-file.ts` or next to the stores. It contains no file contents and no secret:

```ts
export const unreadableMessage = (what: string, how: string) =>
  `The saved ${what} on this workstation cannot be read (the runner key changed or the file is damaged). ${how}`;
```

### 5.2 `apps/runner/src/secrets/keys.ts`: helper for code without a Runner

```ts
/** keyOf for the sealed files in `secretsDir` (CLI, headless adapters). Opens runner-key.pem on first use only. */
export function fileKeyOf(secretsDir: string): (fileName: string) => Buffer {
  let keys: RunnerKeys | undefined;
  return (name) => (keys ??= new RunnerKeys(join(secretsDir, 'runner-key.pem'))).deriveFileKey(name);
}
```

### 5.3 `apps/runner/src/forge/tokens.ts`

```ts
const StoredTokenSchema = z.object({
  provider: z.string(), host: z.string(), token: z.string().min(1),
  user: z.string().optional(), organization: z.string().optional(), savedAt: z.string(),
}).passthrough();
const StoredTokensSchema = z.record(z.string(), StoredTokenSchema);

/** The old plaintext file: keep every entry that has the token shape, drop the rest (never fail on one bad entry). */
function legacyTokens(raw: unknown): Record<string, StoredToken> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, StoredToken> = {};
  for (const [k, v] of Object.entries(raw)) { const p = StoredTokenSchema.safeParse(v); if (p.success) out[k] = p.data as StoredToken; }
  return out;
}

export const TOKENS_UNREADABLE = unreadableMessage('git host tokens',
  'Connect GitLab, Bitbucket or Azure DevOps again (Integrations page or `guildwise-runner git-connect <provider>`).');

export class FileTokenStore implements TokenStore {
  private readonly sealed: SealedFile<Record<string, StoredToken>>;
  private unreadable = false;
  constructor(private readonly file: string, keyOf: (name: string) => Buffer, private readonly opts: { warn?: (m: string) => void } = {}) {
    this.sealed = new SealedFile(file, keyOf, StoredTokensSchema as ZodType<Record<string, StoredToken>>,
      (v) => Object.values(v).map((t) => t.token));
  }
  private read(): Record<string, StoredToken> {
    const r = this.sealed.open({ legacy: legacyTokens });
    if (r.state === 'unreadable') {
      if (!this.unreadable) this.opts.warn?.(TOKENS_UNREADABLE);   // once per transition, not per read
      this.unreadable = true;
      return {};
    }
    this.unreadable = false;
    if (r.state === 'missing') return {};
    if (r.migrated) rmSync(`${this.file}.tmp`, { force: true });  // legacy tmp name, may hold plaintext
    return migrate(r.value);                                       // Azure DevOps key migration, unchanged
  }
  private write(data: Record<string, StoredToken>): void {
    if (this.sealed.open().state === 'unreadable') {               // re-check right before writing: never overwrite it
      const moved = this.sealed.quarantine();
      this.opts.warn?.(`${TOKENS_UNREADABLE} The unreadable file was kept as ${moved ? basename(moved) : 'is'}.`);
    }
    this.sealed.save(data);                                       // 0600 tmp + rename; dir 0700; registers tokens
  }
  /** Why the saved tokens are not available, if they are unreadable (no secret in it). */
  problem(): string | undefined { this.read(); return this.unreadable ? TOKENS_UNREADABLE : undefined; }
  // get / set / remove / list: unchanged bodies
}
```

- `remove()` on an unreadable file finds no key and returns `false` without writing, so nothing is lost.
- `set()` on an unreadable file moves that file aside, then writes a fresh sealed file holding only the new token.
  This is the "connect again" path. `saveAndVerify` then calls `remove()` on a refused token, which leaves a sealed
  `{}`; the moved-aside file is untouched.
- Add `problem?(): string | undefined` to the `TokenStore` interface as an **optional** member. Callers and
  `MemoryTokenStore` do not change.
- `forge/gitlab.ts`, `forge/bitbucket.ts`, `forge/azure.ts`, in each `status()` `not_connected` branch:
  `detail: this.env.tokens.problem?.() ?? <existing detail>`. This shows the message on the Integrations page
  (`fromGitConnection`), on the Workstations page (`gitConnections`) and in `git-connect --status`
  (`describeConnection`).

### 5.4 `apps/runner/src/external/jira-store.ts`

```ts
export const JIRA_UNREADABLE = unreadableMessage('Jira credentials',
  'Connect Jira again (Integrations page or `guildwise-runner jira-connect`).');

export class JiraCredentialStore {
  private readonly sealed: SealedFile<JiraConfig>;
  constructor(file: string, keyOf: (name: string) => Buffer) {
    this.sealed = new SealedFile(file, keyOf, JiraConfigSchema, (c) => [c.apiToken]);
  }
  read(): SealedRead<JiraConfig> {
    return this.sealed.open({ legacy: (raw) => { const p = JiraConfigSchema.safeParse(raw); return p.success ? p.data : undefined; } });
  }
  load(): JiraConfig | undefined { const r = this.read(); return r.state === 'ok' ? r.value : undefined; }
  problem(): string | undefined { return this.read().state === 'unreadable' ? JIRA_UNREADABLE : undefined; }
  save(cfg: JiraConfig): void { if (this.sealed.open().state === 'unreadable') this.sealed.quarantine(); this.sealed.save(cfg); }
  remove(): boolean { return this.sealed.remove(); }
}

/** The secrets file first; config.json's `jira` block only when there is NO secrets file (never when it is unreadable). */
export function resolveJira(secretsDir: string, fromConfig: JiraConfig | undefined, keyOf: (name: string) => Buffer) {
  const r = new JiraCredentialStore(jiraFile(secretsDir), keyOf).read();
  if (r.state === 'ok') return r.value;
  if (r.state === 'unreadable') return undefined;
  return fromConfig;
}
```

Only `apiToken` is registered for redaction. The e-mail is sealed on disk (R1), but registering it would hide the
user's e-mail everywhere in logs and agent output (git authorship, for example). The card's R4 is about tokens.

### 5.5 Callers

| File | Change |
|---|---|
| `runner.ts` | Move `this.keys = new RunnerKeys(...)` (line 439) above `this.forgeEnv = {` (line 428). `tokens: new FileTokenStore(join(secrets,'git-tokens.json'), (n) => this.keys.deriveFileKey(n), { warn: (m) => this.log.warn(m) })`. `jiraConfig()`: `resolveJira(this.paths.secrets, this.freshConfig().jira, (n) => this.keys.deriveFileKey(n))`, plus a warn-once flag that logs `JIRA_UNREADABLE` when the store reports a problem. The poller calls this on every poll, so do not log on every call. |
| `integrations/jira.ts` | `private keyOf = () => this.env.sealKey ?? fileKeyOf(this.env.paths.secrets)` (hold one function). `store()` passes it. `status()`: first `const p = this.store().problem(); if (p) return baseStatus('jira','', 'workstation', now, 'not_connected', { detail: p });`, then `resolveJira(..., keyOf)` as now. `connect`/`remove` unchanged. |
| `integrations/headless.ts` | `const keyOf = overrides.sealKey ?? fileKeyOf(paths.secrets)`. `tokens: new FileTokenStore(join(paths.secrets,'git-tokens.json'), keyOf)`. Do **not** add `sealKey` to the returned env: that would quietly enable headless Sheets/WhatsApp connect, which is a behaviour change outside this card. |
| `cli.ts:761` | `new JiraCredentialStore(jiraFile(paths.secrets), fileKeyOf(paths.secrets))`. |
| `cli.ts:858` | `new FileTokenStore(\`${paths.secrets}/git-tokens.json\`, fileKeyOf(paths.secrets))`. |
| `cli.ts` texts at 751 and 824, `jira-store.ts` / `tokens.ts` doc comments | "stored ... (mode 0600)" → "stored encrypted with this runner's key (mode 0600)". |

No other caller changes. `JiraAdapter`, `IntegrationPoller.jira`, `forge/*` (except the one-line `detail` in the
three token forges), `repo/{access,clone,create}.ts`, `git/completion.ts`, `git/release-publish.ts` and `agent-git`
only use `TokenStore` methods or a `JiraConfig`, and those do not change.

### 5.6 Docs

`docs/RUNNER.md` (the "Jira on the runner" and git token sections) and `docs/ARCHITECTURE.md`, where they say "mode
0600 plaintext":
- Both files are now sealed with the runner key, like storage/WhatsApp/Sheets.
- Deleting or replacing `secrets/runner-key.pem` now means connecting Jira and GitLab/Bitbucket/Azure DevOps again.
- A backup of `secrets/` is useless without `runner-key.pem`.
- Migration is automatic. The plaintext file is replaced in place by rename. The old disk blocks are not scrubbed.
- A downgraded runner sees these integrations as not connected.

`packages/shared` texts ("secrets/git-tokens.json (mode 0600)") stay as they are: they are still true, and the card
is runner-only.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Wrong key wipes other tokens | Re-check in `write()` plus quarantine. Test 4. |
| Fallback to older config.json Jira credentials | `resolveJira` returns `undefined` when the file is unreadable. Test 4b. |
| Plaintext left on disk | Rename over the same path, and delete the legacy `.tmp`. Test 3 checks the dir listing and the bytes. |
| Migration loops or rewrites on each start | The envelope branch never writes. Test 3 compares the bytes (a random IV means any rewrite changes them). |
| CLI and runner migrate at the same time | Each process uses its own pid tmp file plus an atomic rename, and both seal the same value with the same key. |
| `runner-key.pem` generated by two processes at once (pre-existing, affects WhatsApp too) | Out of scope; suggested on the backlog. |
| Downgrade or version pin | Document it; reconnect. |
| Performance | One HKDF + AES-GCM per read, which is sub-millisecond. `gitConnections` does a few reads. Acceptable. |
| config.json `jira` block is still plaintext (written by the user, older form) | Out of scope; backlog suggestion to migrate it into the sealed file. |

## 7. Tests

New file **`apps/runner/test/sealed-credentials.test.ts`**. New files are not flagged. Use
`keyA = () => Buffer.alloc(32, 7)` and `keyB = () => Buffer.alloc(32, 8)`.

1. **Jira sealed round-trip:** save → raw file parses as `{v:1, alg:'A256GCM', iv, ct, tag}`, and the raw text
   contains neither the token nor the e-mail. `load()` returns the same values.
2. **Tokens sealed round-trip:** set/get/list/remove for GitLab, Bitbucket and two Azure DevOps orgs. The raw text
   contains no token. `list()` holds no token.
3. **Migration (both files):** write the old plaintext formats, including an old `azure-devops@dev.azure.com` entry
   with an organization, plus a stale `git-tokens.json.tmp`. The first read returns the right values (Azure DevOps
   resolves by org). Afterwards the file is an envelope, no token appears in any file in `secrets/`, and the `.tmp`
   is gone. Second read: the file bytes are unchanged (proves AC5).
4. **Wrong key:** seal with keyA and open with keyB. `get()` is `undefined` and `problem()` names "connect ... again".
   No throw. `set()` with keyB moves the old file to `git-tokens.json.unreadable-*` (still an envelope) and the new
   file holds only the new token. `remove()` with keyB returns `false` and changes nothing. Another store
   (`jira.json` sealed with keyA) still loads with keyA. Case 4b: `resolveJira(dir, cfgFromConfig, keyB)` is
   `undefined`, not `cfgFromConfig`. `JiraIntegration.status()` gives `not_connected` with the reconnect detail.
   No message contains the token.
5. **Permissions** (skip on win32): both files and the quarantined file are 0600, and `secrets/` is 0700.
6. **Redaction:** after `unregisterSecret(token)` and a fresh store `get()` / `load()`, `redact(\`x ${token} y\`)` has
   no token. This also holds after a legacy migration read.
7. `SealedFile.load()` on a plaintext file still returns `undefined` and does not rewrite it, so the existing users
   are unaffected.

Existing tests to update (the assertions read plaintext, so they change on purpose):
- `test/forge.test.ts:570-580`: constructor key; line 579 becomes `not.toContain('abc')` plus an envelope check.
- `test/azure-tokens.test.ts:25,42,50,75`: constructor key. Lines 46 and 80 check keys through
  `new SealedFile(file, key, z.record(z.string(), z.unknown())).load()` instead of `JSON.parse(readFileSync)`. The
  plaintext test at 59-86 keeps its intent and now also covers migration.
- `test/jira-connect.test.ts:71-81`: read through `new JiraCredentialStore(jiraFile(secrets), fileKeyOf(secrets)).load()`,
  and check that the raw file does not contain `right-token`.
- `test/integrations-service.test.ts:227`: same, using `t.keys.deriveFileKey`.
- `test/attachments.test.ts:223-234`: constructor key and the third `resolveJira` argument.

Run the whole `apps/runner` vitest suite. The suites named in the card are all unit suites; skip the `*.sshd.test.ts`
suites if they need a running sshd.

## 8. Acceptance criteria → design

| AC | Covered by |
|---|---|
| Card records release/1.6.0 state before build | §2, plus the card comment. Neither file is sealed, so build both. |
| Jira file is a sealed envelope; no token or e-mail in plaintext | §5.4, test 1, `jira-connect.test.ts` and `integrations-service.test.ts` updates |
| Forge token file is sealed; token not in plaintext | §5.3, test 2, `forge.test.ts` update. Use a GitLab/Bitbucket/Azure PAT (GitHub is held by `gh`, §3.2.5). |
| Upgrade migrates both with no reconnect and no plaintext left | §5.1 legacy branch, §4.3, test 3 |
| Restart does not migrate again or change the files | Envelope branch never writes; test 3 byte comparison |
| Mode 0600 | `SealedFile.save` (0600 tmp + chmod, dir 0700); test 5 |
| Key mismatch → redacted "connect again" error; runner keeps running; others unaffected | §4.4, §5.3 problem/quarantine, §5.4 resolveJira, forge `detail`; test 4 |
| Tokens redacted in logs and output (test) | `secretsOf` on open/save; test 6 |
| All existing runner tests pass | §7 list of intended assertion changes; full suite run |

## 9. Follow-ups (backlog suggestions, not this card)

- Move config.json's legacy `jira` block into the sealed `jira.json` and remove it from config.json.
- `RunnerKeys` creates `runner-key.pem` with a non-exclusive write. Two processes starting at once could each hold a
  different key. Use `flag: 'wx'` and re-read the file when it already exists.
