# GWP-127: Runner storage, removing a connection while its token refresh is in flight

## Question

`StorageService.remove()` takes no lock. `StorageService.tokenFn()` runs under the per-connection `KeyedMutex`, but
after `await refreshTokens(...)` it calls `store.put(id, ...)` without checking the entry again. If `remove(id)` (or
`storage.sync`, which calls `remove`) runs during that await, the refresh writes the sealed token entry back, so a
removed OneDrive or Google Drive connection comes back in `secrets/storage.json`. How do we close this race, and how much
of the fix is already on release/1.6.0?

## Step 0: what is already on release/1.6.0

- `origin/release/1.6.0` tip is `b648d067` ("Merge DCO check: exempt dependabot[bot] commits"). This card branch is at the
  same commit, and `apps/runner/src/storage/**` and `apps/runner/test/storage-service.test.ts` are the same as on
  `origin/main` too.
- `apps/runner/src/storage/service.ts` on release/1.6.0:
  - `tokenFn` (lines 169-194) runs under `this.mutex.run(id, ...)`, awaits `refreshTokens` (line 183), then calls
    `this.store.put(id, { ...conn, ... })` (line 184) or, on `auth_expired`, `this.store.put(id, { ...conn, needsReauth: true })`
    plus a `needs_reauth` report (lines 188-189). Neither path checks the entry again.
  - `remove` (lines 357-369) takes no lock.
  - `sync` (lines 372-381) calls `remove` for every id it does not keep.
- `apps/runner/test/storage-service.test.ts` has no test for the mutex, for `tokenFn` racing anything, or for a slow
  refresh.

**Nothing is done yet. This card builds all of it.** It cannot be closed as already fixed.

## Findings

1. **The store operations are synchronous.** `StorageStore.get/put/remove` load, change and save the sealed file with
   `readFileSync`/`writeFileSync`/`renameSync` (`store.ts`, `sealed-file.ts`). Within one `tokenFn` call nothing else can
   run between "read the entry" and "put the entry" unless there is an `await` between them. So the race window is
   exactly the `await refreshTokens(...)`. A re-read straight after that await, followed by a put with no await in
   between, closes it fully.
2. **Both put paths bring the entry back.** The success put (line 184) and the `auth_expired` put (line 188) both spread
   the `conn` snapshot taken *before* the await. The `auth_expired` path also sends a `needs_reauth` report for a
   connection the server just removed. Both must be checked.
3. **The snapshot also overwrites later changes (a smaller, related problem).** `{ ...conn, auth }` writes back the config as
   it was before the refresh. A Google Drive base-folder id saved meanwhile by the `GDriveConnector` callback
   (`service.ts:202-206`) is lost. Building the put from the re-read entry fixes this for free.
4. **Who can change the entry during the refresh?** `tokenFn` calls for the same id cannot, because the mutex runs them
   one at a time. The ones that can are `remove` (and `sync` through it), `finishSignIn` (a new sign-in or a reconnect on
   the same id puts new tokens), the Google Drive folder callback, and `connect` (local, S3 and vault only, never OAuth).
5. **Re-entrancy.** `remove` calls `abortTransfer` (`cleanup`: closes the spool handle, `rm`) and `revokeToken`
   (`postForm` to the revoke URL). Neither calls `tokenFn` or takes the mutex. The connectors call `tokenFn` once per HTTP
   request (`http.ts authed`), so the lock is held only for the token read, refresh and write, never across a transfer.
6. **How revoking works for each provider.** `oauthProvider()` sets `revokeUrl` only for Google
   (`https://oauth2.googleapis.com/revoke`), and `revokeToken` does nothing when there is no `revokeUrl`. `remove()`
   revokes only for `google_drive`. The Microsoft identity platform has no endpoint to revoke one refresh token for a
   client. The only option is Graph `revokeSignInSessions`, which signs the user out of every app and is far broader
   than one storage connection. Microsoft refresh tokens rotate on refresh. Google refresh tokens usually do not rotate:
   `toTokens` keeps the previous one when the response has no `refresh_token`.
7. **Redaction.** `SealedFile.save()` and `load()` add every token in the file to the redaction registry
   (`registerSecret`). `refreshTokens` itself registers and logs nothing. So a refresh whose result is never put
   never registers its tokens, and nothing has to be unregistered.
8. **`refreshTokens` has no timeout.** `postForm` passes no signal for a refresh, so a token endpoint that hangs is
   bounded only by undici's default header and body timeouts (minutes).

## Options

| | (a) `remove()` under `mutex.run(id, ...)` | (b) `tokenFn` re-reads the entry after the await and does not write a stale result | (a) + (b) |
|---|---|---|---|
| Closes the resurrection | Yes, for remove/sync | Yes, for remove/sync, and also for a reconnect (new sign-in) during a refresh | Yes |
| `remove()` latency during a refresh | Waits for the refresh, which has no timeout (finding 8) | None: returns at once | Waits |
| `storage.sync` | Removes one id at a time, so one slow refresh holds up the rest of the sync | Never waits | Holds up the sync |
| Covers the `auth_expired` put and its stray report | Yes | Yes, if both paths re-check | Yes |
| Deadlock risk | Low today, but every future call inside `remove` must avoid the key | None (no new lock taken) | Low |
| Change size | Small | Small (one function) | Larger |

## Recommendation

**Build (b) only: re-check in `tokenFn`. Do not add a lock to `remove()`.**

Why:
- Because the store is synchronous (finding 1), a re-read straight after the await with no later await before the put
  is a complete fix, not a mitigation. Lock (a) adds nothing to correctness once (b) is in place.
- (a) makes `remove()` and the whole of `sync` wait on a token endpoint that has no timeout. Removing a connection
  should never wait on the provider it is removing.
- (b) also fixes the reconnect case (a new sign-in during a refresh), which (a) does not cover. Without it, today's code
  can overwrite the new sign-in's tokens with the old grant's tokens, or mark a just-reconnected connection
  `needs_reauth`.
- No new locking means no new deadlock risk, and `remove()` stays exactly as it is (AC 4 and 6 hold by construction).

This differs from the planner's preferred "lock remove()". The card lets the Architect choose, and the reasons are
above. If review insists on (a) as well, it can be added on top without changing the tests below, except the assertion
that `remove()` returns while the refresh is still pending.

## Design

### Files

- `apps/runner/src/storage/service.ts`: `tokenFn` only. `remove`, `sync`, `connector`, `open`, `test` and `probeOf`
  stay unchanged.
- `apps/runner/test/storage-service.test.ts`: new `describe` block with the race tests.
- `store.ts`, `oauth.ts`, `redact.ts`, `sealed-file.ts`: no change.
- No change to the wire protocol, `packages/shared`, error codes, the sealed file format, the server or the web app.

### Behaviour of `tokenFn` after the refresh await

Let `a` be the OAuth auth read at the start (under the lock), and `cur = this.store.get(id)` read straight after the
await. The refresh is **still current** when `cur?.auth?.type === 'oauth' && cur.auth.refreshToken === a.refreshToken`.
No other `tokenFn` can change the refresh token for this id while we hold the lock, so a different value (or no entry)
means remove, sync or a new sign-in happened during the await.

| After the await | Refresh succeeded with tokens `t` | Refresh threw `err` |
|---|---|---|
| Still current | `store.put(id, { ...cur, auth: { type: 'oauth', ...t, account: t.account ?? a.account } })` and return `t.accessToken` (as today, but spreading `cur` instead of `conn`) | As today: on `auth_expired`, `store.put(id, { ...cur, needsReauth: true })` plus the `needs_reauth` report. Rethrow `err` |
| **Removed** (`!cur`) | No put. Best-effort revoke of `t.refreshToken` when it differs from `a.refreshToken` (`void revokeToken(p, t.refreshToken, this.fetchFn)`). Throw `StorageError('not_found', 'This storage is not set up on this workstation.')` | No put, no report. Throw the same `not_found` error, not `err` |
| **Replaced** (entry exists, but a new sign-in changed the refresh token) | No put, no revoke. If `cur` is OAuth and not `needsReauth`, return `cur.auth.accessToken` (the newer sign-in wins). Otherwise throw as at the top of `tokenFn` (`auth_expired` if `needsReauth`, else `not_found`) | Same as the succeeded case: no put, no report |

Sketch (for the builder; adapt freely):

```ts
const NOT_SET_UP = 'This storage is not set up on this workstation.';

private tokenFn(id: string) {
  return (force: boolean) =>
    this.mutex.run(id, async () => {
      const conn = this.store.get(id);
      // ... unchanged checks up to `const p = oauthProvider(...)` ...
      let t: Tokens;
      try {
        t = await refreshTokens(p, a.refreshToken, this.fetchFn, this.now());
      } catch (err) {
        const cur = this.store.get(id);
        if (!isCurrent(cur, a.refreshToken)) return this.superseded(cur); // removed or replaced: write nothing
        if (err instanceof StorageError && err.code === 'auth_expired') {
          this.store.put(id, { ...cur, needsReauth: true });
          this.report(id, 'needs_reauth', storageError('auth_expired', err.message));
        }
        throw err;
      }
      // No await between this read and the put: remove() cannot slip in between.
      const cur = this.store.get(id);
      if (!isCurrent(cur, a.refreshToken)) {
        // Removed: the provider may have rotated the refresh token; revoke the one nobody will ever hold. Best effort,
        // not awaited (revokeToken never rejects). OneDrive has no revoke endpoint, so this does nothing there.
        if (!cur && t.refreshToken !== a.refreshToken) void revokeToken(p, t.refreshToken, this.fetchFn);
        return this.superseded(cur);
      }
      this.store.put(id, { ...cur, auth: { type: 'oauth', ...t, account: t.account ?? a.account } });
      return t.accessToken;
    });
}

const isCurrent = (c: StoredConnection | undefined, rt: string): c is StoredConnection =>
  c?.auth?.type === 'oauth' && c.auth.refreshToken === rt;

/** The entry this refresh started from is gone or was replaced by a new sign-in: nothing is written back. */
private superseded(cur: StoredConnection | undefined): string {
  if (cur?.auth?.type === 'oauth' && !cur.needsReauth) return cur.auth.accessToken;
  if (cur?.needsReauth) throw new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
  throw new StorageError('not_found', NOT_SET_UP);
}
```

Notes:
- `Tokens` is already exported from `oauth.ts`. Import it as a type.
- Use the existing message text for `not_found`. A shared constant is optional. Do not add a new error code.
- In the removed case, revoke is fire-and-forget on purpose. `revokeToken` has no timeout, and awaiting it would keep
  the caller and this id's lock waiting on the provider. It swallows every error, so `void` cannot cause an unhandled
  rejection.
- Revoke only when the refresh token rotated: `remove()` has already revoked `a.refreshToken` (Google), and Google
  usually does not rotate. Never revoke in the replaced case: on Google, revoking ends the user's grant for the app,
  which could cut off the newer sign-in.
- OneDrive: nothing is revoked, the same as in `remove()` today, because Microsoft has no per-token revoke for a client
  (finding 6). The dropped tokens exist only in memory in this call, are never written or registered, and the access
  token expires within about an hour. That is the card's "or say why not".
- Redaction: in the removed and replaced cases nothing is put, so `SealedFile.save()` never registers the new tokens
  (finding 7). They are never registered, so nothing needs unregistering. Do not log `t` or `err` details.

### What each caller sees (no caller code changes)

- **Write** (`open`, line 539): `tokenFn` rejects with `not_found`. The existing `catch` calls
  `fail(this.typed(err))`, which sends `storage.write.result { ok: false, error: { code: 'not_found' } }` and logs
  `storage.write conn=… not_found`. No transfer is created.
- **Test / probe** (`test` → `probeOf` → connector `probe` → `authed` → `tokenFn`): `probeOf` returns the typed
  `not_found`, and `test` answers `{ health: { state: 'not_on_workstation' }, error: { code: 'not_found' } }`. That is the
  same answer as testing an unknown id today. It sends a `storage.report` for the removed id (in-memory `health` only,
  never the store), the same as today's unknown-id test.
- **Upload in progress** (connector `put` gets a 401 and calls `tokenFn(true)`): the transfer has already been aborted
  by `remove()`. The `not_found` lands in `end`'s `catch`, sees `t.finished` and only cleans up, as for any aborted
  transfer.
- **`remove()` / `sync()`**: unchanged. They do not wait on the refresh. `sync` removes the entry, and the refresh then
  finds it gone.

### Risks

- **Merge conflict with GWP-126**, which edits other methods of `service.ts` (`open`, `chunk`, `end`, `deleteWritten`,
  `fail`, `cleanup`). `tokenFn` is a separate block, so a textual conflict is unlikely, but the builder should run
  `aom git merge-main` before handing off if GWP-126 merges first.
- **The replaced case returning the newer sign-in's token**: that token belongs to the same connection id, which the
  caller asked for, so this is correct. If review prefers stricter behaviour, change `superseded` to always throw
  `not_found`. The tests below only assert the removed case strictly.
- **Not in this card, a similar race in sign-in**: `finishSignIn` calls `store.put` after `g.setup` or `setupOneDrive`
  without checking `ctl.signal.aborted`, so a remove that aborts the flow just after the last setup response arrives
  could still save the entry. That is a different code path (sign-in, not refresh) and is suggested as a separate
  backlog item.

## Test plan (builder): `apps/runner/test/storage-service.test.ts`

Add a `describe('token refresh racing remove', ...)` block. Reuse `setup()`, `write()`, `result()`, `keyOf`,
`StorageStore` and `SealedFile`. No real network.

**Doubles:**
- Seed the OAuth entry directly through `new StorageStore(t.secretsDir, keyOf).put(CONN, {...})`. The service reads the
  file on every call. Use an `expiresAt: 0` auth so the first `tokenFn(false)` refreshes:
  - Google Drive: `{ kind: 'google_drive', savedAt, config: { kind: 'google_drive', baseFolder: 'x', baseFolderId: 'f1' }, auth: { type: 'oauth', accessToken: 'g-old-access', refreshToken: 'g-old-refresh', expiresAt: 0, scope: '' } }`
    with `oauthEnv: { AOM_STORAGE_GOOGLE_CLIENT_ID: 'gid' }`.
  - OneDrive: `config: { kind: 'onedrive', driveId: 'drive1', baseFolder: 'x', baseItemId: 'base1' }` with
    `oauthEnv: { AOM_STORAGE_MS_CLIENT_ID: 'client-id' }`.
- `fetch` double: on the token URL with `grant_type=refresh_token`, check which refresh token is in the body. For the
  held connection, return a promise the test resolves later (store the resolver in a variable and record that it was
  called). For any other refresh token, answer at once. The answer is
  `json(200, { access_token: 'race-NEW-access', refresh_token: 'race-NEW-refresh', expires_in: 3600 })`. Record every
  call to `.../revoke` with its body. Answer `json(200, { id: 'x', files: [] })` (or similar) for everything else so
  probes pass.
- Use markers unique to this block, because the redaction registry is process-wide.
- Helper: `await until(() => resolver !== undefined)`, a polling loop like the existing ones (10 ms steps, bounded).

**Cases and the AC each covers:**

1. **Remove during refresh, test path (Google Drive)** (AC 2, 3, 6, 8): start
   `const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: CONN })` and wait until the refresh is held.
   `await t.svc.handle('storage.remove', { connectionId: CONN })` → `{ removed: true }`, resolved **while the refresh is
   still held** (no deadlock, no wait). Release the refresh and `await op`. Expect `op.error` to match
   `{ code: 'not_found' }`, `store.get(CONN)` undefined, and `storage.json` absent (it was the last entry) or, if another
   entry was seeded, the sealed file loaded with `SealedFile` has no `CONN`. Revoke was called for `g-old-refresh` (by
   remove) and for `race-NEW-refresh` (the dropped rotated token). `t.logs` and `JSON.stringify(t.frames)` contain
   neither `race-NEW-access` nor `race-NEW-refresh`. `redact('race-NEW-access')` (from `src/secrets/redact.ts`) returns
   the input unchanged, which shows it was never registered.
2. **Remove during refresh, write path (OneDrive)** (AC 2, 3): `write(t, Buffer.from('x'))` can't be awaited across the
   hold, so send `storage.write.open` with `onMessage` directly. Wait for the held refresh, remove, release, then wait
   for the result. `result(t)` matches `{ ok: false, error: { code: 'not_found' } }`, `t.svc.activeTransfers()` is 0,
   and there is no entry. No revoke call is made for OneDrive.
3. **`storage.sync` during refresh** (AC 5): same as case 1, but run `storage.sync { connectionIds: [OTHER] }` instead of
   remove. It returns `removed: [CONN]`, and after release the entry is still gone and `op` failed with `not_found`.
4. **Order: the refresh finishes first** (AC 4, 6): release before removing. `op` succeeds (no `error`), the store holds
   `race-NEW-refresh`, then `remove` returns `{ removed: true }`, the entry is gone, and revoke is called with
   `race-NEW-refresh` (Google).
5. **Isolation** (AC 7): seed X (held refresh) and Y (another OAuth entry with a different refresh token, answered at
   once, or a valid unexpired token). With X's refresh held: `storage.test` on Y resolves and Y's store entry holds new
   tokens, and `storage.remove` on Y resolves and Y is gone. Then release X and check X's own result (expired-token
   refresh saved).
6. **`auth_expired` after removal** (finding 2): the held refresh answers `json(400, { error: 'invalid_grant' })` after
   the remove. `op` fails with `not_found` (not `auth_expired`), there is no entry, and no `storage.report` with
   `needs_reauth` is sent for `CONN` after the remove.
7. **Regression** (AC 4): every existing test in the file passes unchanged. That includes "remove deletes the entry and
   the file", "sync deletes connections the server no longer lists" and the OneDrive test whose expired grant marks
   `needsReauth` and sends `needs_reauth` (the still-current path keeps that behaviour). Run the whole `apps/runner` unit
   suite (vitest) in the foreground. Other runner tests reach the service through `harness.ts` (reconnect, pairings,
   reference-repos, shift-limit, claude-usage-limit) and must stay green.

## Acceptance criteria → design

| AC | Covered by |
|---|---|
| Release/1.6.0 check recorded | "Step 0" above (nothing done; `b648d067` = card base), also posted on the card |
| Slow refresh + remove → no entry, sealed file has no X | Re-check after the await, no put when the entry is gone. Tests 1, 2 |
| Started op fails with the existing `not_found`, no crash or unhandled rejection, no recreation | `superseded()` throws `StorageError('not_found')`, which the existing callers already type. Tests 1, 2, 6 |
| `remove()` unchanged; existing tests pass | `remove` not edited. Test 7 |
| `storage.sync` gets the same guarantee | `sync` → `remove`, and the re-check covers any removal. Test 3 |
| No deadlock; remove as fast as before | No new lock: `remove` never waits on the mutex. Tests 1 (remove resolves while the refresh is held) and 4 |
| Y not blocked by X | Locking stays per id (`KeyedMutex` unchanged), and remove takes no lock. Test 5 |
| No token in logs; nothing registered for the dropped refresh | No put → `SealedFile.save` never registers. Nothing logged. Test 1 asserts on logs, frames and `redact()` |
