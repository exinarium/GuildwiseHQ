# GWP-129: Relay: drop a runner from the serving map when its user leaves the org or loses owner/admin

## 1. Question

`RelayHub.serve` checks that the announcing user is an owner or admin of the integration's organization only when
the runner sends `relay.serve`. After that the runner stays in the serving map and `RelayHub.forward` keeps sending it
the org's provider requests until the socket closes. A removed, departed, demoted or deactivated user therefore keeps
receiving the org's relayed traffic until their runner reconnects. How do we end that straight away, on the server,
without touching the runner's other work or the relay wire protocol?

## 2. Release check (owner instruction, step 0)

- `origin/release/1.6.0` and the card branch base are the same commit (`b648d067`, `git merge-base --is-ancestor`
  and an empty `git diff` on every relevant path). Checking HEAD is therefore checking release/1.6.0.
- **Already done: nothing of R1-R6.**
  - `apps/server/src/webhook-relay/hub.ts`: the role check exists only in `serve()` (inline
    `m?.role === 'owner' || m?.role === 'admin'`, a second copy of the rule). `liveServers()` checks only that the
    registry still holds the same connection and that it is online. `forward()` has no role check and no cache.
    `RelayHub` subscribes to no events.
  - No membership command (`changeMemberRole`, `removeOrgMember`, `leaveOrg`, `transferOwnership`,
    `platformTransferOwnership`, `patchPlatformUser`) calls the hub.
- **Partly covered by accident:** `patchPlatformUser` (deactivate) unlinks every active workstation of the user;
  `RunnerGateway.onEvent('WorkstationUnlinked')` closes the runner socket, and the close handler calls
  `webhookRelay.disconnected()`. So deactivation already ends serving, but only as a side effect of closing the whole
  connection, with no reason logged, and only once the unlink event is dispatched. The design below makes it explicit
  (R1, R6) and does not rely on that side effect.
- **Not affected:** `removeMemberIn` (`apps/server/src/commands/sharing.ts`) is project-level. It emits
  `ProjectMemberRemoved` and never ends org membership (only `removeOrgMemberIn` emits `OrgMemberRemoved`). No change.
- **Not applicable:** there is no "delete user" path. `patchPlatformUser` only deactivates or reactivates.
- **Ownership transfer:** the projector (`projections/orgs.ts`, `OrgOwnershipTransferred`) always sets the old owner to
  `admin`. Today the old owner therefore always keeps serving. The design still re-checks on that event, so a future
  change to the transfer rule is covered without more work.

The card therefore adds all of R1-R6.

## 3. Findings that shape the design

1. **Projections run inside the append transaction** (`PgEventStore.append` runs the projectors in `tx`). When a
   subscriber receives `OrgMemberRoleChanged` / `OrgMemberRemoved` / `OrgOwnershipTransferred`, `org_members` already
   shows the new state, so a re-query from the subscriber is always current.
2. **Event delivery** goes through the `Notifier` (`LISTEN aom_events` plus a 5 s safety poll) to every subscriber in
   seq order, in every server process. Tests wait for it with `ctx.notifier.flush()`.
3. **The reference pattern** is `BrowserGateway`: `ctx.store.subscribe(e => this.onEvent(e))`, an `ACCESS_EVENTS`
   set, and `refreshAccess()` re-reads `orgRoleOf` for a live connection. `RunnerGateway` uses the same subscription.
4. **`orgRoleOf(pool, userId, orgId)`** (`apps/server/src/auth/org-context.ts`) plus **`isOrgManager({ orgRole })`**
   (`@aom/shared` authz) is the single owner/admin rule. `ownerOrAdmin` in `delivery/admin.ts` is just a thrower around
   `orgRoleOf`, and the inline check in `serve()` is a second copy that this card removes.
5. **`ctx.clock`** (`apps/server/src/clock.ts`) has `advance(ms)`; integration tests can move it forward without fake
   timers (vitest fake timers also work, since `now()` is `Date.now() + offset`).
6. `forward()` gets only `integrationId`. The integration's `org_id` is known in `serve()` at accept time, and an
   integration never changes org.
7. `RunnerConn` carries `workstationId` and `userId`. "Runner id" in the logs is the `workstationId`.

## 4. Options

| | A. Direct hub calls from each command | B. Hub subscribes to membership events (chosen) | C. Forward-time check only |
|---|---|---|---|
| Covers every path | Only paths someone remembers to wire (6 call sites, 2 files); a new path is missed silently | Every path that emits the events, including paths added later | Yes, but late (cache window) |
| Multi-process server | Only the process that ran the command | Every process (the notifier fans out from the database) | Yes |
| Timing | After commit, if called after the tx | Straight after commit (LISTEN, ms; 5 s poll fallback) | Up to the cache TTL |
| Coupling | Commands import the hub | None: commands are untouched | None |
| Matches existing code | No | Yes (BrowserGateway, RunnerGateway) | n/a |

**Choice: B for R1/R2, plus C as the R3 guard (defence in depth).** The guard is kept, not argued away, because the
event path alone does not cover:
- a role changed directly in the database (support fix, migration, test);
- a subscriber failure (`dispatch` isolates and logs handler errors, so a failed handler simply misses the event);
- the serve/event race: `serve()` reads the role, the demotion commits and its event is handled (nothing to drop yet),
  then `serve()` adds the runner to the map with the stale role.

## 5. Design

All production changes are in `apps/server/src/webhook-relay/hub.ts` plus two lines of wiring in
`apps/server/src/app.ts`. No command, route, shared schema, migration or runner change.

### 5.1 New hub state

```ts
/** integration id -> its organization (set when a server is accepted; integrations never change org). */
private orgOf = new Map<string, string>();
/** `${orgId}:${userId}` -> whether the user may serve relay there, and when that was looked up. */
private roleCache = new Map<string, { at: number; ok: Promise<boolean> }>();
private unsubscribe: (() => void) | null = null;

/** How long a forward-time role answer is reused (card limit: 60 s). */
export const RELAY_ROLE_TTL_MS = 30_000;

type DropReason = 'member_removed' | 'member_left' | 'role_changed' | 'user_disabled' | 'forward_check_failed';
```

- `serve()` sets `this.orgOf.set(id, r.org_id)` for each accepted integration.
- `forget()` also deletes `orgOf` and every pending request on that integration is left as it is today (unchanged).
- `markOffline()` deletes `orgOf.get(id)` together with the empty `serving` entry.
- The cache stores the **promise**, so a webhook burst on a cache miss makes one query per (org, user), not one per request.
- `serve()` must **not** seed the cache (see the race in section 4: the first forward must look up fresh).

### 5.2 One rule: `mayServe`

```ts
import { isOrgManager } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';

private async mayServe(orgId: string, userId: string): Promise<boolean> {
  return isOrgManager({ orgRole: await orgRoleOf(this.ctx.pool, userId, orgId) });
}
```

`serve()` replaces its inline `SELECT role ...` and `owner || admin` test with `await this.mayServe(r.org_id, conn.userId)`.
Behaviour and refusal reason (`not_allowed`) stay the same.

### 5.3 Shared offline path (R4)

Extract the pending-settling loop from `disconnected()` into a helper both paths use:

```ts
/** Requests waiting on `conn` (optionally for one integration) end as offline now, as on a disconnect. */
private settlePending(conn: RunnerConn, integrationId?: string): void {
  for (const [requestId, p] of this.pending) {
    if (p.conn !== conn || (integrationId && p.integrationId !== integrationId)) continue;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve({ kind: 'offline' });
  }
}
```

`disconnected()` calls `this.settlePending(conn)` and then behaves exactly as today.

### 5.4 The drop operation (R1, R2, R4, R5, R6)

```ts
/**
 * Ends `userId`'s relay serving for `orgId` (every org when null): their entries leave the serving map, requests in
 * flight to them end as offline, and integrations nobody else serves are marked offline. The runner stays connected.
 */
async dropServers(orgId: string | null, userId: string, reason: DropReason): Promise<void> {
  const ids: string[] = [];
  const perRunner = new Map<string, { orgId: string; workstationId: string; integrationIds: string[] }>();
  for (const [id, m] of this.serving) {
    const org = this.orgOf.get(id);
    if (!org || (orgId && org !== orgId)) continue;
    for (const [ws, conn] of m) {
      if (conn.userId !== userId) continue;
      m.delete(ws);
      this.settlePending(conn, id);
      ids.push(id);
      const key = `${org}:${ws}`;
      const e = perRunner.get(key) ?? { orgId: org, workstationId: ws, integrationIds: [] };
      e.integrationIds.push(id);
      perRunner.set(key, e);
    }
  }
  for (const e of perRunner.values())
    this.ctx.log.info({ relayDrop: { ...e, userId, reason } }, 'relay server dropped');
  await this.markOffline(ids);
}
```

- Never calls `runners.close()`: the main connection and all non-relay work continue (R5).
- `markOffline` already handles "no qualifying server left": it deletes the empty map entry and sets
  `relay_presence.offline_since`, so `isServed()` returns 0 and the status API shows offline, exactly as on the last
  disconnect (R4).
- The log line carries org, user, workstation (runner), integration ids and reason only. No request data (R6). The
  triggering membership event is already stored in the event store, so no new audit event type is needed.
- Re-enrolment: none. A re-promoted user's runner sends `relay.serve` again and the normal check applies (R5). The
  runner is not told it was dropped (see 5.8).

### 5.5 Event subscription (R1, R2)

```ts
start(): void {
  this.unsubscribe = this.ctx.store.subscribe((e) => this.onEvent(e));
}
stop(): void {
  this.unsubscribe?.();
  this.unsubscribe = null;
}

private async onEvent(e: StoredEvent): Promise<void> {
  const p = e.event.payload as Record<string, any>;
  switch (e.event.type) {
    case 'OrgMemberRoleChanged':
      return this.revalidate(p.orgId, p.userId, 'role_changed');
    case 'OrgOwnershipTransferred':
      return this.revalidate(p.orgId, p.fromUserId, 'role_changed');
    case 'OrgMemberRemoved':
      return this.revalidate(p.orgId, p.userId,
        p.reason === 'left' ? 'member_left' : p.reason === 'deactivated' ? 'user_disabled' : 'member_removed');
    case 'UserDeactivated':
      this.clearUserCache(p.userId);
      return this.dropServers(null, p.userId, 'user_disabled');
  }
}

/** After a membership event: forget the cached answer, re-read the role, drop the user's servers if it no longer qualifies. */
private async revalidate(orgId: string, userId: string, reason: DropReason): Promise<void> {
  this.roleCache.delete(`${orgId}:${userId}`);
  if (!this.servesFor(orgId, userId)) return;          // nothing in memory: no query at all
  const ok = await this.mayServe(orgId, userId).catch((err) => {
    this.ctx.log.warn({ err: err?.name, orgId, userId }, 'relay role re-check failed');
    return false;                                      // fail closed: the runner can announce again
  });
  if (!ok) await this.dropServers(orgId, userId, reason);
}
```

- `servesFor(orgId, userId)` is a cheap in-memory scan of `serving` + `orgOf`. Control events for users who serve
  nothing cost no query.
- Re-reading the role (rather than trusting the payload) keeps an old event from dropping a runner whose user was
  promoted again before the event arrived. It also keeps the old owner serving after a transfer (they become admin).
- `UserDeactivated` drops unconditionally across every org: a deactivated user may not serve anywhere, and
  `orgRoleOf` does not look at `users.status` (the owner of a suspended org keeps the `owner` row).
- Wiring in `apps/server/src/app.ts`: `ctx.services.webhookRelay.start()` right after
  `ctx.services.webhookRelay = new RelayHub(ctx)`; `ctx.services.webhookRelay.stop()` in the shutdown block next to
  `gateway.stop()` / `browser.stop()` (before `notifier.stop()`).

### 5.6 Forward-time guard (R3)

`forward()` becomes `async` (the route already awaits it):

```ts
async forward(req: ForwardRequest, timeoutMs: number): Promise<HubResult> {
  const { ctx } = this;
  if (this.pending.size >= ctx.config.relay.maxInFlight) return { kind: 'offline' };
  const candidates = this.liveServers(req.integrationId);
  if (candidates.length === 0) return { kind: 'offline' };
  const servers = await this.qualifying(req.integrationId, candidates);
  // re-check after the await: limits and the map may have changed meanwhile
  if (servers.length === 0 || this.pending.size >= ctx.config.relay.maxInFlight) return { kind: 'offline' };
  ... existing round-robin send loop over `servers`, unchanged ...
}

private async qualifying(integrationId: string, candidates: RunnerConn[]): Promise<RunnerConn[]> {
  const orgId = this.orgOf.get(integrationId);
  if (!orgId) return [];                                // fail closed: should not happen
  const now = this.ctx.clock.now().getTime();
  const verdicts = new Map<string, Promise<boolean | 'error'>>();
  for (const c of candidates) {
    if (verdicts.has(c.userId)) continue;
    const key = `${orgId}:${c.userId}`;
    let hit = this.roleCache.get(key);
    if (!hit || now - hit.at >= RELAY_ROLE_TTL_MS) {
      hit = { at: now, ok: this.mayServe(orgId, c.userId) };
      this.roleCache.set(key, hit);
      hit.ok.catch(() => { if (this.roleCache.get(key) === hit) this.roleCache.delete(key); });
    }
    verdicts.set(c.userId, hit.ok.catch(() => 'error' as const));
  }
  const out: RunnerConn[] = [];
  for (const c of candidates) {
    const v = await verdicts.get(c.userId);
    if (v === false) { await this.dropServers(orgId, c.userId, 'forward_check_failed'); continue; }
    if (v === 'error') continue;                         // not verified: skip for this request, do not drop
    if (this.serving.get(integrationId)?.get(c.workstationId) === c) out.push(c); // still serving after the await
  }
  return out;
}
```

- TTL 30 s (card limit 60 s), measured on `ctx.clock`. Cleared by every handled event (`revalidate` deletes the key,
  `UserDeactivated` clears all keys of the user).
- At most one `org_members` query per serving (org, user) per 30 s per process, whatever the burst size.
- A database error while checking never drops a server (it is transient) but also never sends to an unverified one.
- A rejected promise is removed from the cache so the next request retries.
- The "still serving after the await" check matters: an event may drop the server while the lookup is pending.

### 5.7 Data model, API, protocol

- No migration, no new table, no new event type, no API change.
- No wire change. Runners already deployed are unaffected.

### 5.8 Optional runner notice: not done

The server is the only enforcement point (constraint). The runner does not need to know: it keeps its local
"serving" state, receives nothing for that org, and on its next `relay.serve` (reconnect, or the user re-announces
after a re-promotion) it gets `not_allowed` or is accepted. Adding a `relay.dropped` message would need a shared
schema entry and runner handling for no security gain. If wanted later, a re-sent `relay.serve.result` with the
integration under `refused: not_allowed` is already understood by current runners. That is left out of scope.

## 6. Risks and traps

1. **`forward()` turns async.** On a cache miss there is one DB round trip before the send. Existing tests that read
   `hub().inFlight` right after starting a request may need to wait (`until(...)`). The route's `await` is unchanged.
2. **maxInFlight check races the await.** It is re-checked after `qualifying()` (snippet above).
3. **Never seed the role cache from `serve()`.** That would reopen the serve/event race for a whole TTL.
4. **Stale lookup promise.** An event deletes the key while a lookup is pending. The resolution must not re-insert it,
   and the forward must re-check map membership before sending (both in the snippet).
5. **Deactivation runs twice.** `OrgMemberRemoved{reason:'deactivated'}` per non-owner org, then `UserDeactivated`,
   then `WorkstationUnlinked` closes the socket. `dropServers` and `disconnected` are idempotent (map entries already
   gone → no log line, `markOffline` no-ops), so this is safe. Expect one `relay server dropped` line per org/runner from
   the first event that finds the entry.
6. **Multi-process.** Each process holds only its own runners. The event path reaches every process, so no extra work.
7. **Org suspension (`OrgStatusChanged`) is not re-checked mid-connection.** It is outside R1-R6. The public route
   already refuses non-operational orgs before `forward()`, so no traffic leaks. Logged as a backlog suggestion.

## 7. Acceptance criteria → design

| AC | Covered by |
|---|---|
| Release check recorded | Section 2 (nothing of R1-R6 existed; release/1.6.0 == base) |
| Owner removes A → next request not forwarded to A, no reconnect | `OrgMemberRemoved{removed}` → `revalidate` → `dropServers(..., 'member_removed')` (5.4, 5.5) |
| A leaves O → dropped straight away | `OrgMemberRemoved{left}` → `member_left` |
| Role admin → member → dropped | `OrgMemberRoleChanged` → re-read role → `role_changed` |
| Transfer: old owner below admin dropped; stays admin keeps serving | `OrgOwnershipTransferred` → `revalidate(fromUserId)`; today the projector makes them admin → kept |
| Platform admin disables A → dropped in every org | `UserDeactivated` → `dropServers(null, ...)` (plus the per-org `OrgMemberRemoved{deactivated}`) |
| Forward-time guard after ≤60 s without an event | 5.6, TTL 30 s on `ctx.clock`, drop with `forward_check_failed` |
| Only server dropped → `isServed` false; in-flight settle like disconnect | `markOffline` (unchanged) + `settlePending` shared with `disconnected` (5.3) |
| Other admins' runners keep serving | `dropServers` matches on `userId` (+ org) only |
| Runner stays connected; re-promoted → new `relay.serve` accepted | No `runners.close`; `serve` unchanged except using `mayServe` |
| Log line per drop: org, user, runner, reason, no payload | `relay server dropped` with `relayDrop: { orgId, userId, workstationId, integrationIds, reason }` |
| Existing behaviour unchanged; existing tests pass | Same paths for users who keep their role; `serve` reason codes unchanged |

## 8. Tests (builder)

Extend or add next to `apps/server/test/relay-endpoint.test.ts` / `relay-integrations.test.ts`, using the existing
helpers (`createWorld`, `makeBusiness`, `createIntegration`, `serve`, `autoReply`, `w.t.addOrgMember`,
`pairWorkstation`, `FakeRunner`, `ctx.notifier.flush()`, `ctx.clock.advance`). A new file
`apps/server/test/relay-membership.test.ts` keeps it readable. These suites need the test Postgres like the other
relay suites.

1. Two admins (A, B) serve O. `hub().dropServers(O, A, 'role_changed')`: A's runner is gone, `isServed` is still 1,
   the next request reaches B only.
2. Only A serves. A request is in flight (runner holds its answer). Drop A: the HTTP call ends with the route's
   offline answer straight away (not after the timeout), `hub().inFlight === 0`, `isServed === 0`, status API offline.
3. Guard: A serves; set A's role to `member` with a direct `UPDATE org_members` (no event). A request within the window
   still reaches A; `ctx.clock.advance(RELAY_ROLE_TTL_MS)`; the next request does not reach A, and A is dropped
   (`isServed === 0`, log reason `forward_check_failed`). Second case: within the window, fire the event path (API role
   change) and the very next request is refused without advancing the clock.
4. Re-promotion: after a drop, set A back to admin; A's runner sends `relay.serve` again and it is accepted.
5. API remove (`DELETE /api/org/members/:userId`), then `notifier.flush()`: no request reaches A's runner, and A's
   runner still answers a ping / receives a non-relay message (socket open).
6. API role change (`PATCH /api/org/members/:userId` to `member`): same.
7. `DELETE /api/org/members/me` as A: same.
8. Transfer (`POST /api/org/transfer-ownership`): the old owner (now admin) keeps serving. Unit-level: `revalidate` with the role
   stubbed below admin drops them (covers the "ends below admin" branch).
9. `PATCH /api/platform/users/:id {status:'deactivated'}`: A's runner served two orgs; both stop being served.
10. Control: change another member's role / remove another member: A keeps serving and keeps receiving.
11. Spy on `ctx.log.info`: one `relay server dropped` entry per drop with `orgId`, `userId`, `workstationId`,
    `reason`; serialize it and assert no body, header or query value of a sent request appears in it.
12. Burst: 20 concurrent requests on a cold cache make one `org_members` lookup (spy on `ctx.pool.query`, or count via
    a wrapped `mayServe`).

Regression: existing `relay-endpoint`, `relay-integrations`, `relay-status-last-event`, `relay-no-content`,
`org-authz` and the orgs / sharing suites.

## 9. Recommendation

Build option B + C as specified: the hub subscribes to the four membership events and re-checks with `orgRoleOf` +
`isOrgManager`, drops through a shared offline path, and guards `forward()` with a 30 s promise cache. Production
changes stay in `hub.ts` and two lines in `app.ts`. No command, protocol or runner change.
