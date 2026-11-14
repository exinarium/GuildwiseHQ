# GWP-224: do not migrate a non-token JSON object in git-tokens.json to an empty sealed map

## Question

`FileTokenStore` (apps/runner/src/forge/tokens.ts) passes any `git-tokens.json` that is not a readable v1 envelope to
the legacy plaintext migration. Today `legacyTokens` accepts any JSON object and drops every entry that is not
token-shaped. A damaged envelope or a future (v2) envelope therefore comes back as `{}`. `SealedFile.open` then seals
that empty map over the original file, and every saved forge token is lost without a warning. How do we stop that
using the existing unreadable/quarantine path, and fix the "(mode 0600)" storage wording?

## Findings

### How a read works today

`SealedFile.open({ legacy })` (apps/runner/src/secrets/sealed-file.ts:61):

1. Missing file → `missing`.
2. Not JSON → `unreadable/damaged`.
3. `isEnvelope(raw)` is **strict**: `v === 1 && alg === 'A256GCM'` and `iv`/`ct`/`tag` are all strings.
   - Envelope → decrypt. A wrong key, or a `ct`/`tag`/`iv` string that was changed → `unreadable/key`. A bad
     plaintext → `unreadable/damaged`. **This case is already safe.**
   - Not an envelope → `legacy(raw)`. `undefined` → `unreadable/damaged` (safe). Any other value → it is **saved
     (sealed over the file)** and returned as `ok, migrated: true`.

`legacyTokens(raw)` (tokens.ts:76) returns `undefined` only for a non-object or an array. For any other object it
returns the token-shaped entries, which can be `{}`. So the files that are lost are exactly the ones that fail the
strict `isEnvelope` but are still objects:

| File content | isEnvelope | legacyTokens today | Result today |
| --- | --- | --- | --- |
| `{v:1, alg, iv, ct:"<changed>", tag}` (all strings) | true | not called | unreadable (key): safe |
| `{v:1, alg, iv, ct: 123, tag}` / `alg` changed / one field missing | false | `{}` | **sealed empty map, tokens lost** |
| `{v:2, alg, iv, ct, tag}` (newer runner, then a downgrade) | false | `{}` | **sealed empty map, tokens lost** |
| `{v:1, ct:"..."}` (only some envelope keys) | false | `{}` | **sealed empty map, tokens lost** |
| `{"foo":1,"bar":{"x":true}}` | false | `{}` | **sealed empty map, file lost** |
| legacy file with valid entries and junk | false | valid entries | migrated: correct |
| `{}` | false | `{}` | migrated to sealed `{}`: correct (AC: keep) |

### The unreadable path already does what the card asks

- `FileTokenStore.read()` maps `unreadable` to `{}`, sets `this.unreadable`, warns once (`TOKENS_UNREADABLE`) and
  **does not touch the file**.
- `problem()` returns `TOKENS_UNREADABLE` (no path contents, no secret).
- `write()` (used by `set`/`remove`) re-opens the file. When it is `unreadable` it calls `SealedFile.quarantine()`,
  which renames it to `git-tokens.json.unreadable-<timestamp>` (0600), and only then saves the new file.
- `list()` returns `[]` for a missing file and otherwise goes through `read()`. `get()` goes through `read()`. Neither
  throws.

So once `legacyTokens` returns `undefined` for the problem inputs, they all go through the existing
unreadable/quarantine path. **No change to sealed-file.ts is needed.**

### Other SealedFile users

Only `JiraCredentialStore` also passes `legacy` (`legacyJira`, jira-store.ts:19). It is a strict
`JiraConfigSchema.safeParse`, so an envelope-shaped object already fails it and is reported unreadable. The other users
(webhook, sheets, whatsapp, reviewer tokens, storage) call `open()`/`load()` with no `legacy`, so a non-envelope is
already unreadable for them. The bug exists only in `legacyTokens`.

### The "forge/index.ts" string

`apps/runner/src/forge/index.ts` holds only re-exports and has no storage string, which is what the planner saw. The
string the card means is in **`packages/shared/src/forge/index.ts:405`** (the GitLab `git-connect` steps):
`'2. Paste the token when asked. It is kept on this workstation only (secrets/git-tokens.json, mode 0600).'`.
The card named the wrong package. The builder edits the shared file and leaves the runner file unchanged.

### Wording sites

User-facing strings that present mode 0600 as the protection of a sealed file:

- packages/shared/src/integrations/registry.ts:342, 392, 447: `storage: 'secrets/git-tokens.json (mode 0600), this workstation only.'`
- packages/shared/src/integrations/registry.ts:528: `storage: 'secrets/jira.json (mode 0600), this workstation only.'`
- packages/shared/src/forge/index.ts:405 (above).
- apps/runner/src/cli.ts:874 (jira-connect success line): `Saved on this machine only (mode 0600).` This one is not
  named on the card, but it is the same claim about a sealed file (jira.json). It is recommended as a one-line
  consistency fix.

These stay as they are:

- registry.ts:175 `secrets/claude.json (mode 0600)`: claude.json is **not** a SealedFile, so 0600 is the real
  protection there and the wording is true.
- Code comments and docs that already say "encrypted with this runner's key (mode 0600 …)": tokens.ts:20,
  jira-store.ts:7, cli.ts:801/925/947, docs/RUNNER.md:565, 2053, 3139, 3140. They are true: `SealedFile.save` writes
  0600 in a 0700 directory, and the encryption is named first. Leave them, or only touch them if the builder edits that
  line anyway.

The `storage` string is shown in apps/web `IntegrationTile.tsx:298` (`Stored: {kind.storage}`) and in the delete
dialog (line 342, `…on <ws>: ${kind.storage}`), so it must stay a short sentence that ends with a full stop. No test
or snapshot asserts these strings. I checked packages/shared/test, apps/web/src and e2e.

## Options

**A. Fix in `legacyTokens` only (tokens.ts).** Return `undefined` when the object has any envelope key, or when a
non-empty object yields zero valid entries. `SealedFile.open` already turns `undefined` into `unreadable/damaged`, and
FileTokenStore's existing read/problem/write/quarantine logic handles the rest. About 10 lines of source. It does not
touch shared code.

**B. Make `SealedFile.open` refuse envelope-shaped objects before it calls `legacy` (sealed-file.ts).** This protects
every legacy user at once. But it changes shared behaviour, which the card says must be additive only. `legacyJira` is
already safe, so B adds risk and protects nothing more.

**C. Add an option to SealedFile (for example `open({ legacy, refuseEnvelopeLike: true })`).** This is additive, but
it adds API surface for one caller, and the empty-result check would still have to live in tokens.ts.

**Recommendation: A.** It is the smallest change, it reuses the existing quarantine/problem path, and it leaves
sealed-file.ts and every other store byte-for-byte unchanged.

## Design

### 1. apps/runner/src/forge/tokens.ts

Replace `legacyTokens` with:

```ts
/** The keys of a sealed envelope (secrets/sealed-file.ts). A plaintext token file is keyed `provider@host`, never these. */
const ENVELOPE_KEYS = ['v', 'alg', 'iv', 'ct', 'tag'] as const;

/**
 * The old plaintext file: keep every entry that has the token shape, drop the rest (one bad entry never fails it).
 * Undefined (the file is unreadable, kept and reported, never resealed) for an envelope this runner cannot open (a
 * damaged field, or a newer version after a downgrade) and for a non-empty object with no token in it: sealing an
 * empty map over either would lose every saved token.
 */
function legacyTokens(raw: unknown): Record<string, StoredToken> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (ENVELOPE_KEYS.some((k) => Object.hasOwn(raw, k))) return undefined;
  const entries = Object.entries(raw);
  const out: Record<string, StoredToken> = {};
  for (const [k, v] of entries) {
    const p = StoredTokenSchema.safeParse(v);
    if (p.success) out[k] = p.data as StoredToken;
  }
  if (entries.length > 0 && Object.keys(out).length === 0) return undefined;
  return out;
}
```

Notes:

- `Object.hasOwn` is fine: the target is ES2023 and the runner already uses it (runner.ts:1522).
- "Any envelope key" is meant to be strict (requirement 1). A real legacy file is keyed `provider@host[#org]`, so a
  top-level key `v`/`alg`/`iv`/`ct`/`tag` never belongs to a real token file. A hand-edited legacy file that also has
  such a key is refused and kept, which is the safe failure.
- `{}` → `entries.length === 0` → returns `{}` → migrated to sealed `{}` as today (AC5).
- Nothing else in `FileTokenStore` changes. `read`, `write`, `problem`, `get`, `list`, `set` and `remove` stay as they
  are: the existing unreadable branch gives "no tokens, problem set, file untouched on read, quarantined on the next
  write".
- The `rmSync(${file}.tmp)` cleanup runs only when `r.migrated`, so a refused file never deletes the old plaintext
  `.tmp` copy. That is correct, because it may be the only readable copy.
- Messages: `TOKENS_UNREADABLE` and the existing quarantine warning name only the file's basename. Do not add a reason
  that echoes content.
- Optional, but nice for the comment on the TokenStore interface (tokens.ts:20): leave it as it is (it is true).

### 2. Wording (strings only; ids, keys and schema unchanged)

- registry.ts:342, 392, 447 →
  `storage: "secrets/git-tokens.json, sealed (encrypted) with this runner's key, this workstation only.",`
- registry.ts:528 →
  `storage: "secrets/jira.json, sealed (encrypted) with this runner's key, this workstation only.",`
- packages/shared/src/forge/index.ts:405 →
  `'2. Paste the token when asked. It is sealed (encrypted) with this runner\'s key in secrets/git-tokens.json, on this workstation only.',`
- apps/runner/src/cli.ts:874 (recommended) → `… Saved on this machine only, sealed with this runner's key.`

Use the quote style that the repo's biome config wants (it may keep single quotes with `\'`). Run
`pnpm biome check` (or the repo's lint script) on the changed files.

### 3. Tests: new file apps/runner/test/token-store-unreadable.test.ts

Use the same helpers as sealed-credentials.test.ts: `cleanupTmp`/`tmp` from `./helpers.ts`, `keyA = () =>
Buffer.alloc(32, 7)`, and a `secretsDir()` from `mkdtempSync`. Made-up tokens only (`GL-TEST-TOKEN-1`, …), each
`unregisterSecret`-ed in `afterEach`. Helper: `const raw = readFileSync(file)` before, and assert
`readFileSync(file).equals(raw)` after a read. After a write, assert that the
`git-tokens.json.unreadable-*` file holds the original bytes.

For an envelope-shaped fixture, seal a real token with `new FileTokenStore(f, keyA).set(...)`, parse the file, mutate
one field and write it back. That gives realistic bytes and no hand-made secret.

| # | Case | Arrange | Assert |
| --- | --- | --- | --- |
| 1a | damaged v1, ct/tag changed (strings) | flip a base64 char in `ct` (and separately `tag`) | `get` undefined, `list()` `[]`, `problem()` === `TOKENS_UNREADABLE`, bytes unchanged, file is not a sealed `{}` (open it with keyA via `SealedFile`/a fresh store and confirm it is still unreadable) |
| 1b | damaged v1, wrong type | `ct: 123` or `alg: 'X'` or `tag` deleted | same as 1a. **This is the case that fails today**: the test must fail on the base commit |
| 2 | future envelope | `{...env, v: 2}` | same as 1a; fails today |
| 3 | partial envelope keys | `{ v: 1, ct: 'abc' }` | same; fails today |
| 4 | non-empty junk | `{"foo":1,"bar":{"x":true}}` | same; fails today |
| 5 | legacy migration | two valid entries (gitlab, azure-devops with org on the old key) + `junk: {not:'a token'}` | file becomes a v1 envelope, both `get`s return the tokens (azure via the org key), `list()` length 2, `problem()` undefined |
| 6 | `{}` and missing file | write `{}`; separate dir with no file | `list()` `[]`, `problem()` undefined; `{}` file is now a sealed envelope (as today) |
| 7 | v1 round-trip | set gitlab + bitbucket, get, list, remove | unchanged behaviour (same as the existing sealed-credentials test; a short regression is enough) |
| 8 | set after quarantine | case 1b/2 file, then `set({provider:'gitlab', host:'gitlab.com', token:'GL-TEST-TOKEN-NEW'})` | `git-tokens.json` is a new envelope that reads back the new token, `problem()` undefined, exactly one `git-tokens.json.unreadable-*` file whose bytes equal the original, and a `warn` callback received the quarantine message (no token text in it) |

Also add one test for `remove()` on an unreadable file. It returns `false`, does not write, and leaves the bytes
unchanged (read() gives `{}`, so `write` is never reached). This pins down the "never overwrite" constraint for the
second mutating method.

Run: `pnpm --filter <runner package> exec vitest run test/token-store-unreadable.test.ts test/sealed-credentials.test.ts test/forge.test.ts test/azure-tokens.test.ts test/storage-service.test.ts`,
then the whole runner and shared unit suites (`vitest run`, foreground, with `timeout`). The worktree's `pnpm install`
timed out when it was prepared. If `node_modules` is missing, ask DevOps to install it (`aom devops`). Do not install it
yourself.

## Acceptance criteria mapping

| AC | Covered by |
| --- | --- |
| Damaged envelope preserved, problem() unreadable, get/list empty, no throw | envelope-key check in `legacyTokens` (wrong-type fields), plus the existing `unreadable/key` path (changed strings); tests 1a, 1b |
| Unknown version (v: 2) treated the same | envelope-key check; test 2 |
| Non-empty object with no valid token preserved and reported | zero-yield check; tests 3, 4 |
| Legacy file with ≥1 valid entry still migrates; every valid entry readable | `legacyTokens` returns the non-empty map as before; test 5 (and the existing sealed-credentials migration test) |
| `{}` and missing file behave as today | `entries.length === 0` returns `{}`; missing is handled by SealedFile; test 6 |
| Valid v1 file: no regression | no change on the envelope path; test 7 + existing forge/azure/sealed-credentials tests |
| set() after quarantine writes a fresh file, original kept | the existing `write()` → `quarantine()` → `save()`; test 8 |
| Storage descriptions no longer claim (mode 0600) as the protection | registry.ts 342/392/447/528 and shared forge/index.ts:405 (+ cli.ts:874); diff review (no snapshot exists) |
| Unit tests added and green, existing suites green | new test file + the runs above |

## Risks and traps

- **A test that cannot fail.** Changing a character inside `ct`/`tag` keeps `isEnvelope` true, so that case already
  passes today (it goes down the decrypt path). The tests that prove the fix are the wrong-type, v2, partial-key and junk
  cases (1b, 2, 3, 4). Make sure at least those fail on the base commit before the fix.
- **Read must not rewrite.** Do not add a quarantine call to `read()`/`problem()`. The current behaviour is that a read
  leaves the file in place and only the next write moves it aside. The card allows "quarantined or untouched", and
  quarantining on read would change the timing for the existing key-change tests in sealed-credentials.test.ts.
- **Do not touch sealed-file.ts.** Every protection lives in `legacyTokens`.
- **Users who see a new warning.** A workstation whose plaintext file held only invalid entries (for example a token
  saved with an empty string) used to get a silent empty store. It now gets the "cannot be read" problem until it
  connects again, and the next `set` keeps the old file as `.unreadable-*`. That is the intended safe behaviour.
- **Merge overlap.** GWP-214 (in build, base `development`) adds entries to registry.ts (commit 46a05df3), but not on
  these lines. Expect at most a trivial merge, and if GWP-214 adds a new `storage:` string with "(mode 0600)" for a
  sealed file, the same wording applies. It does not touch tokens.ts or sealed-file.ts. No dependency or group is
  needed.
- Security: no token values or file contents in messages or test names. Fixtures use made-up strings that are
  registered with and removed from the redaction registry the way sealed-credentials.test.ts does.

## Size

About 15 lines of source in tokens.ts, 5 to 6 string lines, and one new test file of about 150 to 200 lines. That is
under the large threshold, so no risk flag is recorded.
