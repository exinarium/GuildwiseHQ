# GWP-36 Inbound webhook relay core: design

Release 1.4.0 (business mode). Server + shared protocol + runner dispatch. Web UI is GWP-38. The WhatsApp handler is
GWP-37. Outbound replies are GWP-32.

## 1. Question

How do we make the server a pure messenger between an outside provider (WhatsApp Cloud API first; also form webhooks,
`webhook_in` and calendar pushes) and the org's runner? The design has to meet four limits:

- The server stores and logs nothing of the content.
- The server never queues anything.
- The body reaches the runner as the exact raw bytes, so the runner can check signatures.
- The provider gets the runner's answer within its own timeout.

## 2. Findings in the code

| Area | What is there | Consequence for the relay |
|---|---|---|
| `apps/server/src/routes/hooks.ts`, `commands/hooks.ts` | Public `POST /api/hooks/:id/:secret`. It sits outside the session guards because it calls no `requireUser`. It is exempt from `checkOrigin` through `EXEMPT_PREFIXES`. `sameHash` uses `timingSafeEqual`. The body is **parsed JSON** through the app-wide `application/json` parser. | Copy the token and constant-time pattern. Do **not** copy the body handling, because the relay needs raw bytes. |
| `commands/schedules.ts:530-531` | `newHookSecret()` = `hook_` + 24 random bytes as base64url. `hashHookSecret` = sha256 hex. Rotate and revoke replace or strip the hash in an event. | Same shape: `rly_` + 24 random bytes (192 bits). Only the sha256 is stored. |
| `app.ts` `checkContentType` (`auth/origin-check.ts`) | A global `onRequest` hook. It answers **415 to any non-JSON POST**, on every path and not only `/api/`. | `/relay/in/` must be exempt. Otherwise a form post to an unknown token gets 415 instead of 404, and a form webhook never works. |
| `app.ts` `checkOrigin` | Only applies to `/api/` paths. | `/relay/in/` is not affected. |
| `app.ts` `setNotFoundHandler` | For a GET on a non-`/api/` path it serves the SPA `index.html`. | Register `/relay/in/*` explicitly so that a malformed relay path answers 404 with an empty body, not the web app. |
| `app.ts` logger | pino `serializers.req` = `requestLogSerializer`, which runs `redactUrl()` (invite, desk and `token=` query patterns). Fastify logs "incoming request" and "request completed" for every route. The global error handler logs `err` and calls `reportServerError` (route pattern plus masked message). | Relay routes use `logLevel: 'silent'` and a scoped error handler. `redactUrl` also gets a `/relay/in/` rule as a second line of defence. |
| `deploy/Caddyfile` | No `log` directive, so Caddy writes no access log. | Fine as it is. Document that enabling a Caddy access log must exclude `/relay/in/*`. |
| `runner-gateway/gateway.ts` | Every runner frame is processed **strictly in order** on one promise chain per socket. | A `relay.response` behind a slow `repos.report` would be late. Handle `relay.response` on a fast path outside the chain. |
| `runner-gateway/registry.ts` | `RunnerRegistry` is keyed by workstation. `send()` is fire-and-forget and returns `false` when no socket is open. A workstation belongs to a **user**, not an org. | Routing needs its own integration → workstation map. Announcements have to be checked against org membership. |
| `@fastify/websocket` `maxPayload: 8 MiB` (`app.ts:508`) | Caps one frame. | A 1 MiB body is about 1.4 MB as base64. Cap the configurable body limit at 4 MiB. |
| `protocol/runner.ts` | `msg()` builds zod envelopes. `RUNNER_ACKED_TYPES` are the frames that go through the outbox. `welcome.features` advertises server features. | The new frames are **not** acked: a late answer is worthless, and the runner client already drops non-acked frames while offline. Gate the runner's announcement on a `relay:1` feature in `welcome`. |
| `apps/runner/src/runner.ts` `onMessage` (around line 1690) | The real dispatch switch. `client.ts onFrame` only parses and emits. | Add the `relay.request` case in `runner.ts` and put the logic in a new `apps/runner/src/relay/` module. |
| Naming | `integration` is already taken: `INTEGRATION_KINDS` and `routes/integrations.ts` for workstation sign-ins, `IntegrationMode` in `runs/integration.ts` for test environments, and `chat/relay.ts` (`ChatRelay`). | Use a separate `relay` namespace everywhere: `RelayIntegration`, `RELAY_KINDS`, `/api/relay/...`, tables `relay_*`, server service `webhookRelay`. The kinds do **not** belong in `runs/integration.ts`, which is about test runs. |
| Rate limits | `@fastify/rate-limit` is registered with an in-memory store (`global: false`). `receiveHook` counts `schedule_runs` rows per hour. | Use an in-memory token bucket keyed by integration id. A DB count per request would add a write and a read on the hot path, and the server is single-instance (the in-memory `RunnerRegistry` already assumes that). |
| Metadata-like tables | `inbound_counters` and `runner_inbox` are plain tables outside the event store. `pruneRunnerInbox` runs from `dispatcher/reaper.ts`. | `relay_requests` is a plain telemetry table that the reaper prunes. Integrations themselves are event-sourced. |

**Meta retry window (verified).** Meta's Cloud API webhook guide says the platform keeps retrying any non-200 answer "with
decreasing frequency … for up to 7 days". The no-storage page repeats the 7-day window for incoming-message webhooks.
Retries go to every app subscribed to the WABA, so duplicates are possible; the runner handler deduplicates (GWP-37).
Only HTTP 200 counts as success. An offline runner therefore loses nothing for up to 7 days, as long as we answer non-2xx.
I found no documented Meta response timeout in these sources. A 5 s forward timeout is far below anything Meta tolerates.
It stays configurable per kind.

## 3. Options compared

**Routing: how does the server know which runner serves an integration?**

| Option | For | Against |
|---|---|---|
| A. The runner announces the integration ids it serves (`relay.serve`). The server checks each one against the org and the role. **(chosen)** | Matches the card. The provider secret lives on the runner, so only a runner that holds it should serve. Several workstations can serve the same integration. No server-side config. | The server must check that the announcing user may receive that org's traffic. |
| B. The server binds an integration to one workstation at creation. | Simple routing. | The server cannot know the secret is on that workstation. No failover. It contradicts the card. |

**Raw body: how do we get the exact bytes?**

| Option | For | Against |
|---|---|---|
| A. An encapsulated Fastify plugin. It calls `removeAllContentTypeParsers()` and adds a `'*'` parser with `parseAs: 'buffer'`, using a route `bodyLimit`. **(chosen)** | Standard Fastify. Fastify checks `content-length` against `bodyLimit` before it reads (413 "without reading the rest") and aborts chunked bodies at the limit. A body without `content-type` also goes to `'*'`. | The plugin must be registered without `fastify-plugin` so the parsers stay scoped. |
| B. Read `req.raw` in the handler. | Full control. | The parsers already consume the stream, so we would have to bypass them. Size checks would have to be hand-rolled. |
| C. The extension `rawBodyPaths` hook. | Exists. | JSON only, keeps a **string** (breaks non-UTF-8), and still parses. |

**Rate limit**

| Option | For | Against |
|---|---|---|
| A. An in-memory token bucket per integration id. **(chosen)** | No DB on the hot path. The limit is exact per integration. | Resets on restart. That is fine, because the provider retries. |
| B. `@fastify/rate-limit` with a keyGenerator. | Library. | It runs in its own hook. Its key is only known after the token lookup. It writes its own `x-ratelimit-*` headers and logs. |
| C. A DB count of `relay_requests` (like `receiveHook`). | Survives restarts. | A read per request. A burst cannot be expressed. |

## 4. Design

### 4.1 Shared (`packages/shared`)

New module `packages/shared/src/relay/index.ts`, exported from the package index:

```ts
export const RELAY_KINDS = ['whatsapp_cloud', 'form_webhook', 'webhook_in', 'calendar_push', 'generic'] as const;
export const RelayKindSchema = z.enum(RELAY_KINDS);
export type RelayKind = z.infer<typeof RelayKindSchema>;
export const RELAY_PATH_PREFIX = '/relay/in/';
export const RELAY_TOKEN_PREFIX = 'rly_';
export const RELAY_FEATURE = 'relay:1';                 // in welcome.features
export const RELAY_RESPONSE_MAX_BYTES = 64 * 1024;
export const RELAY_BODY_HARD_MAX_BYTES = 4 * 1024 * 1024; // config cap (ws maxPayload is 8 MiB)
export const RELAY_OUTCOMES = ['forwarded', 'runner_offline', 'timeout', 'rejected_size', 'rejected_rate', 'unknown_path'] as const;
/** Response headers the runner may set; anything else is dropped. */
export const RELAY_RESPONSE_HEADERS = ['content-type', 'retry-after', 'cache-control'] as const;
/** Request headers never forwarded: hop-by-hop, proxy internals and GuildWise's own. */
export const RELAY_STRIPPED_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip'] as const; // plus any 'x-aom-*' and names listed in `Connection`

export const RelayIntegrationCreateSchema = z.object({
  kind: RelayKindSchema, label: z.string().trim().min(1).max(80),
}).strict();                         // .strict(): an app secret / verify token / access token in the body is a 400
export const RelayIntegrationDtoSchema = z.object({
  id: z.uuid(), orgId: z.uuid(), kind: RelayKindSchema, label: z.string(),
  status: z.enum(['active', 'revoked']),
  createdAt: z.iso.datetime(), rotatedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
});
export const RelayIntegrationStatusSchema = z.object({
  integrationId: z.uuid(),
  connected: z.boolean(),               // a serving runner is connected now
  servingWorkstations: z.number().int(), // how many (no names needed for the notice)
  everServed: z.boolean(),
  offlineSince: z.iso.datetime().nullable(),  // null while connected, or never served
  refusedSinceOffline: z.object({ count: z.number().int(), lastAt: z.iso.datetime().nullable() }),
});
```

Authorization: the `Authorization` header is **forwarded**. GuildWise does not use it on this route, and a generic or
form webhook may carry its own bearer secret that the runner has to check. "GuildWise's own auth" means the session
cookie (`cookie` is stripped entirely) and the `x-aom-*` headers.

Events (`packages/shared/src/events/relay.ts`, registered in the events index; `streamId.relayIntegration = id => relay-${id}`;
org scope `orgScope(orgId)`):

```ts
defineEvent('RelayIntegrationCreated', z.object({ integrationId: Id, orgId: Id, kind: RelayKindSchema,
  label: z.string().max(80), tokenHash: z.string().length(64), by: Id })),
defineEvent('RelayIntegrationRotated', z.object({ integrationId: Id, tokenHash: z.string().length(64), by: Id })),
defineEvent('RelayIntegrationRevoked', z.object({ integrationId: Id, by: Id })),
```

Protocol frames in `packages/shared/src/protocol/runner.ts`. None of them go into `RUNNER_ACKED_TYPES` or
`SERVER_ACKED_TYPES`:

```ts
// runner -> server: full replacement of what this runner serves; sent after a welcome that lists RELAY_FEATURE, and on change
export const RelayServeSchema = msg('relay.serve', {
  integrations: z.array(z.object({ integrationId: z.uuid(), kind: RelayKindSchema })).max(100),
});
// runner -> server
export const RelayResponseSchema = msg('relay.response', {
  requestId: z.uuid(),
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string().max(40), z.string().max(1000)).optional(),
  body: z.base64().max(Math.ceil(RELAY_RESPONSE_MAX_BYTES / 3) * 4).optional(),
});
// server -> runner
export const RelayRequestSchema = msg('relay.request', {
  requestId: z.uuid(),
  integrationId: z.uuid(),
  kind: RelayKindSchema,
  method: z.enum(['GET', 'POST']),
  query: z.string().max(8192),                                     // raw, without '?', never parsed
  headers: z.array(z.tuple([z.string().max(200), z.string().max(8192)])).max(200), // lower-case names, duplicates kept, order kept
  body: z.base64().max(Math.ceil(RELAY_BODY_HARD_MAX_BYTES / 3) * 4), // '' for GET
  deadlineMs: z.number().int().positive(),                         // time the runner has left
});
// server -> runner: what was accepted from relay.serve (the runner logs refusals locally)
export const RelayServeResultSchema = msg('relay.serve.result', {
  accepted: z.array(z.uuid()),
  refused: z.array(z.object({ integrationId: z.uuid(), reason: z.enum(['unknown', 'revoked', 'kind_mismatch', 'not_allowed', 'not_business']) })),
});
```

Add them to `RunnerToServerSchema` and `ServerToRunnerSchema`.

### 4.2 Server: data model (`apps/server/migrations/<next>_relay.sql`)

```sql
CREATE TABLE relay_integrations (            -- projection of the Relay* events
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL, label text NOT NULL, status text NOT NULL DEFAULT 'active',
  token_hash text UNIQUE,                    -- sha256 hex; NULL once revoked
  created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  rotated_at timestamptz, revoked_at timestamptz);
CREATE INDEX relay_integrations_org ON relay_integrations(org_id);

CREATE TABLE relay_presence (                -- operational state, not event-sourced (like workstations.last_seen_at)
  integration_id uuid PRIMARY KEY REFERENCES relay_integrations(id),
  last_served_at timestamptz NOT NULL, offline_since timestamptz);

CREATE TABLE relay_requests (                -- metadata only; pruned after AOM_RELAY_RETENTION_DAYS (default 30)
  id bigserial PRIMARY KEY, at timestamptz NOT NULL,
  org_id uuid, integration_id uuid, kind text,  -- NULL for unknown_path
  method text NOT NULL, size_bytes integer NOT NULL, status smallint NOT NULL,
  latency_ms integer NOT NULL, outcome text NOT NULL);
CREATE INDEX relay_requests_integration_at ON relay_requests(integration_id, at);
CREATE INDEX relay_requests_at ON relay_requests(at);
```

Projector `apps/server/src/projections/relay.ts` (registered in `projections/index.ts`): Created → insert;
Rotated → `token_hash`, `rotated_at`; Revoked → `status='revoked'`, `token_hash=NULL`, `revoked_at`. Replay-safe.
Check whether `rebuild.ts` / `store.extraSaved` need `relay_presence` and `relay_requests` listed as preserved
non-projection tables, the same way `inbound_counters` / `runner_inbox` are handled.

There are no columns for body, headers, query, token, IP or user agent. `relay_requests` is not an event: it is
high-volume telemetry written by unauthenticated callers.

### 4.3 Server: management API (`commands/relay-integrations.ts`, `routes/relay-integrations.ts`)

| Route | Guard | Result |
|---|---|---|
| `POST /api/relay/integrations` `{kind,label}` | `requireOrg(ctx, req, { min: 'admin' })` + business gate | 201 `{ integration, url }` |
| `GET /api/relay/integrations` | `requireOrg` (any member) + business gate | `{ integrations: Dto[] }` (never a URL) |
| `POST /api/relay/integrations/:id/rotate` | admin + business | `{ integration, url }`. The old URL is a 404 at once. |
| `POST /api/relay/integrations/:id/revoke` | admin + business | `{ integration }`. The URL is a 404. Drops the integration from the hub's serving map. |
| `GET /api/relay/integrations/status` | any member + business | `{ statuses: RelayIntegrationStatus[] }` |

- `url = ${ctx.config.publicOrigin}/relay/in/${token}`. It is returned once and never stored or logged.
- Token: `rly_` + `randomBytes(24).toString('base64url')`, hashed with `hashHookSecret` (or a local copy of it).
- Business gate: `assertBusinessOrg(org)` uses GWP-27's `isBusinessOrg`. A dev org gets 403
  `business_mode_required` with a plain message. Another org's id, or an unknown id, gets 404.
- Commands use `withAppendTx` + `SELECT … FOR UPDATE` on `relay_integrations`, as `rotateWebhookSecret` does.
  Rotating or revoking a revoked integration is a 409 `revoked`.
- The rotate/create response must not be logged. Fastify does not log reply bodies, so this holds as long as no one adds such logging.

### 4.4 Server: public endpoint (`apps/server/src/webhook-relay/route.ts`)

Register it in `createApp` next to `hookRoutes` as its own encapsulated plugin:

```ts
await app.register(relayPublicRoutes(ctx));   // NOT wrapped in fastify-plugin
// inside:
fastify.removeAllContentTypeParsers();
fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
fastify.setErrorHandler((err, req, reply) => { /* status from err.statusCode (413 for FST_ERR_CTP_BODY_TOO_LARGE), else 500;
   record metadata, log {integrationId, outcome, errName} only; reply.code(s).send() empty; never log err/req, never reportServerError with err.message */ });
const opts = { logLevel: 'silent', bodyLimit: cfg.maxBodyBytes, exposeHeadRoutes: false,
               onRequest: lookupToken, preHandler: rateLimit };
fastify.route({ method: ['GET', 'POST'], url: '/relay/in/:token', ...opts, handler: forward });
fastify.route({ method: ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'], url: '/relay/in/*', logLevel: 'silent', handler: empty404 });
// plus PUT/PATCH/DELETE/OPTIONS/HEAD on /relay/in/:token -> empty 404 (outcome unknown_path, no lookup)
```

Order per request (the clock starts in `onRequest`):

1. **Global hooks**: `checkContentType` gains an exemption for paths that start with `/relay/in/`. `checkOrigin`
   already skips non-`/api/` paths.
2. **`onRequest` lookup → 404.** If the token does not match `^rly_[A-Za-z0-9_-]{32}$`, the request is unknown.
   Otherwise `SELECT ri.*, o.mode, o.status FROM relay_integrations ri JOIN organizations o … WHERE token_hash=$1`,
   then a `timingSafeEqual` compare of the hashes. Not found, revoked, org not business, or org not operational
   (`isOrgOperational`) → empty 404, outcome `unknown_path`. Return from the hook so the body is never read. On a hit,
   set `req.relay = { integration, startedAt }` and keep nothing else.
3. **Body parse → 413.** Fastify's `bodyLimit`: if `content-length` exceeds it, Fastify rejects before reading. A
   chunked body is cut off at the limit. The scoped error handler answers an empty 413, outcome `rejected_size`.
   GET bodies are not parsed (size 0).
4. **`preHandler` rate limit → 429.** A token bucket per integration id (`capacity = burst` default 20, refill
   `perMinute/60` per second, default 60/min). Empty 429 with `Retry-After: <seconds until a token>`, outcome
   `rejected_rate`.
5. **Forward** through `ctx.services.webhookRelay.forward(...)`:
   - No online serving runner → empty **503** with `Retry-After: cfg.retryAfterSec` (default 60), outcome `runner_offline`.
   - Runner answered → the runner's status, the allowlisted headers and the decoded body, outcome `forwarded`.
   - No answer within `timeoutMs[kind]` → empty **504**, outcome `timeout`.
   - The runner disconnects while the request is in flight → empty 503, outcome `runner_offline` (no wait for the timeout).
6. **Metadata**: one `INSERT INTO relay_requests` per request, before the reply is sent, so tests can check it
   deterministically. One log line at info on `ctx.log` (not `req.log`, which is silent):
   `{ relay: { integrationId, kind, method, sizeBytes, status, latencyMs, outcome } }, 'relay request'`.
   For `unknown_path` both the integration id and the org are null.

Building the forward payload: `query = req.raw.url.slice(indexOf('?')+1)` or `''`, never parsed.
Headers come from `req.raw.rawHeaders` as pairs: lower-case the names, keep duplicates and order, drop
`RELAY_STRIPPED_HEADERS`, every `x-aom-*` header and every name listed in the `Connection` header.
`body = (req.body as Buffer | undefined ?? Buffer.alloc(0)).toString('base64')`.

**Second line of defence**: extend `redactUrl` with
`.replace(/(\/relay\/in\/)[^\s]*/gi, '$1[redacted]')`. That removes the token and the whole query, so `hub.verify_token`
cannot leak through the URL. Add a unit test next to the existing `redactUrl` tests. Do not add
`/relay/in/` to `EXEMPT_PREFIXES`, which is `/api/`-only and therefore not needed.

### 4.5 Server: hub, routing and correlation (`apps/server/src/webhook-relay/hub.ts`)

```ts
export class RelayHub {
  private serving = new Map<string /*integrationId*/, Set<string /*workstationId*/>>();
  private pending = new Map<string /*requestId*/, { workstationId: string; resolve: (r: HubResult) => void; timer: NodeJS.Timeout }>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private ctx: Ctx) {}
  async serve(conn: RunnerConn, items: { integrationId: string; kind: RelayKind }[]): Promise<RelayServeResult>;
  disconnected(conn: RunnerConn): Promise<void>;     // remove the ws from every set; settle its pending as offline; presence update
  forget(integrationId: string): void;               // revoke
  isServed(integrationId: string): number;            // count of online serving workstations
  forward(integration, req): Promise<HubResult>;      // { kind: 'answer', status, headers, body } | { kind: 'offline' } | { kind: 'timeout' }
  onResponse(conn: RunnerConn, msg: RunnerToServerOf<'relay.response'>): void;
  takeToken(integrationId: string, now: number): { ok: true } | { ok: false; retryAfterSec: number };
}
```

- **`serve`**: for each item, load the integration and its org. Accept it only if all of these hold:
  - the integration is active;
  - its `kind` equals the announced kind;
  - the org is in business mode and operational;
  - the workstation's user (`conn.userId`) is an active member of that org with role `owner` or `admin`.

  The id alone is not a secret, so this check stops someone else's runner from taking over traffic. Replace this
  workstation's entries with the accepted set. Upsert `relay_presence` (`last_served_at=now, offline_since=NULL`). For
  ids this runner no longer serves, and that no other runner serves, set `offline_since=now`. Answer with
  `relay.serve.result`.
- **`forward`**: pick an online serving workstation (`ctx.services.runners.isOnline`), round-robin. Then:
  - Make a `requestId` (uuid v7) and register it in `pending` with `setTimeout(timeoutMs)`.
  - Send with `runners.send(ws, 'relay.request', { …, deadlineMs: timeoutMs - 250 })`.
  - If `send` returns false, try the next workstation; when none are left the result is `offline`.
  - Safety cap: at most `maxInFlight` (default 200) pending requests overall. Above it the result is `offline` (503),
    so a flood cannot hold sockets open.
- **`onResponse`**: look up `pending.get(requestId)`. It must exist and its `workstationId` must equal
  `conn.workstationId`; otherwise the answer is late or foreign and is ignored (debug log with `requestId` only). Clear
  the timer, delete the entry, keep only the allowlisted headers, decode the body (it must be ≤ 64 KiB, already enforced
  by the schema), and resolve. A timeout deletes the entry first, so a late answer always finds nothing.
- **Gateway changes** (`gateway.ts`):
  1. In `socket.on('message')`, before chaining, peek at the type. If `conn` is set and the frame parses as
     `relay.response`, call `hub.onResponse` at once (fast path).
  2. In the `close` handler, call `hub.disconnected(c)` (only when `runners.remove(c)` returned true; a superseded
     connection hands over to the new one, which announces again).
  3. Add `RELAY_FEATURE` to `welcome.features` in `handlers.ts`.
  4. `handlers.handle` gets `case 'relay.serve': return this.ctx.services.webhookRelay.serve(conn, msg.integrations)` and
     `case 'relay.response'` (in case the fast path is bypassed).
- **On boot** (in `createApp` after the pool is up): `UPDATE relay_presence SET offline_since=$now WHERE offline_since IS NULL`.
  After a restart nothing is served until runners announce again, which they do right after `welcome`.
- **Status API**: for each org integration:
  - `connected = isServed(id) > 0`;
  - `offlineSince` comes from `relay_presence` (null if connected; if there is no row, `everServed:false`);
  - `refusedSinceOffline` = `SELECT count(*), max(at) FROM relay_requests WHERE integration_id=$1 AND outcome='runner_offline' AND at >= coalesce(offline_since, created_at)`.

  This feeds GWP-38's "runner offline, messages waiting at the provider" notice. The web part, including touch and
  small-screen layout, belongs to GWP-38.
- **Pruning**: `pruneRelayRequests(ctx)` deletes rows older than the retention period and is called from
  `dispatcher/reaper.ts` next to `pruneRunnerInbox`.

### 4.6 Server config (`config.ts`)

```ts
relay: {
  maxBodyBytes: number;       // AOM_RELAY_MAX_BODY_BYTES, default 1_048_576, max RELAY_BODY_HARD_MAX_BYTES
  perMinute: number;          // AOM_RELAY_RATE_PER_MINUTE, default 60
  burst: number;              // AOM_RELAY_RATE_BURST, default 20
  timeoutMs: Record<RelayKind, number>; // AOM_RELAY_TIMEOUT_MS default 5000; AOM_RELAY_TIMEOUTS="whatsapp_cloud=5000,calendar_push=8000"; each clamped 1000..15000
  retryAfterSec: number;      // AOM_RELAY_RETRY_AFTER_SEC, default 60
  maxInFlight: number;        // AOM_RELAY_MAX_IN_FLIGHT, default 200
  retentionDays: number;      // AOM_RELAY_RETENTION_DAYS, default 30
}
```

Document these in `docs/SELF-HOSTING.md` with one line saying a reverse-proxy access log must exclude `/relay/in/*`.
Add the relay to `docs/ARCHITECTURE.md` as a new short section.

### 4.7 Runner (`apps/runner`)

- **Config** (`config.ts`): `relay: { integrations: [{ id: uuid, kind: RelayKind, label?: string }], sinkDir?: string }`,
  default `{ integrations: [] }`. It is per pairing, like the rest of `config.json`.
- **CLI** (`cli.ts`): `guildwise-runner relay list | add <integration-id> --kind <kind> [--label] | remove <integration-id>`,
  with `--pairing` and `--data-dir` like `repos add`. If a running runner cannot pick up config changes live the way
  `repos add` does, print "restart the runner to apply". GWP-37/38 can later add a web-driven binding through the
  `command` channel.
- **Announcement** (`runner.ts`): on `welcome`, if `welcome.features` includes `RELAY_FEATURE`, send
  `relay.serve { integrations }` (also when the list is empty, to clear a stale set). Log every refused id from
  `relay.serve.result` with its reason, as a plain line with the id only.
- **Dispatch** (`apps/runner/src/relay/dispatch.ts`):

```ts
export interface RelayEvent {
  requestId: string; integrationId: string; kind: RelayKind; method: 'GET' | 'POST';
  query: string; headers: [string, string][]; body: Buffer; receivedAt: Date; deadline: number;
}
export interface RelayReply { status: number; headers?: Record<string, string>; body?: Buffer | string }
export type RelayHandler = (e: RelayEvent, ctx: { integration: LocalRelayIntegration; log: Logger }) => Promise<RelayReply>;

export class RelayDispatcher {
  register(kind: RelayKind, handler: RelayHandler): void;
  /** Never throws; always returns the relay.response payload. */
  async dispatch(msg: ServerToRunnerOf<'relay.request'>): Promise<RelayResponsePayload>;
}
```

  `dispatch` rules:
  - Integration not in the local config → 503.
  - No handler for the kind → **501**.
  - Handler throws → **500**, logged locally as `relay handler failed <integrationId> <requestId>: <err.name>`, never the body.
  - Reply body > 64 KiB, or a status outside 200..599 → 500.
  - Strip headers that are not in `RELAY_RESPONSE_HEADERS`.
  - If the handler is not done by `deadline`, send nothing. The server has already answered 504; `Promise.race` against
    the deadline and drop the result.

  `runner.ts onMessage`: `case 'relay.request': void this.relay.dispatch(msg).then(p => this.client.send('relay.response', p))`.
  The client drops a non-acked frame while offline, which is correct.
- **Generic handler** (`apps/runner/src/relay/generic.ts`): registered for `'generic'` only. It hands the event to a
  `RelaySink` and answers `200` with an empty body.
  - `FileRelaySink` writes `<dataDir>/relay/inbox/<integrationId>/<receivedAt>-<requestId>.json` with
    `{ requestId, integrationId, kind, method, query, headers, bodyBase64, receivedAt }`. Mode 0600, dir 0700,
    atomic write (tmp + rename).
  - If the sink fails, the handler throws, so the answer is 500 and the provider retries.
  - The data dir is already denied to agent sandboxes. Add `relay: join(root, 'relay')` to `RunnerPaths`.
- `whatsapp_cloud`, `form_webhook`, `webhook_in` and `calendar_push` have no handler in this card, so they answer 501
  until GWP-37 and later cards register theirs.
- Bump `RUNNER_VERSION`.

## 5. Risks and traps

- **Any content in logs fails the card.** The traps are:
  - Fastify's automatic request log (silenced per route; `redactUrl` covers it as a second line);
  - the global error handler (replaced in the scope);
  - `ctx.log.warn({ issues })` in the gateway for an invalid `relay.response`, which can echo values: log only `type`
    and the issue paths for `relay.*`;
  - zod error messages that quote input;
  - any `log.debug({ msg })` added while debugging.
- **The global `checkContentType` 415** would otherwise break the 404 order and form webhooks.
- **The SPA fallback** would serve `index.html` on `GET /relay/in/` without the explicit wildcard route.
- **The serial message chain** would let `relay.response` sit behind slow frames, hence the fast path.
- **Hijacking an integration**: integration ids show in the web UI. Without the membership and role check in `serve`,
  any paired runner could pull another org's messages.
- **Frame size**: base64 grows the body by 33%. The `maxBodyBytes` cap of 4 MiB keeps frames under the 8 MiB ws `maxPayload`.
- **Duplicates**: Meta retries go to every subscribed app, and a 504 can still be processed by the runner after the
  server has answered. Handlers must be idempotent (GWP-37 dedupes on the message id). The server never retries.
- **Restart**: presence and rate buckets are in memory. After a restart, requests in the few seconds before runners
  reconnect get a 503, and the provider retries. That is acceptable.
- **Replay**: `relay_presence` and `relay_requests` are not projections. Make sure a projection rebuild does not truncate them.

## 6. Acceptance criteria → design → tests

| AC | Design | Test (unit; file) |
|---|---|---|
| Manager of a business org creates and gets the URL once; rotate gives a new URL and the old one is 404; revoke → 404; non-business and non-manager refused | 4.3, 4.4 step 2 | `apps/server/test/relay-integrations.test.ts`: create/rotate/revoke, `member` → 403 `org_role_required`, dev org → 403 `business_mode_required`, other org's id → 404, old and revoked URL → 404, `.strict()` rejects `appSecret` |
| Only the hash in the DB; the plain token in no table or log | 4.2, 4.4, `redactUrl` | sentinel test (below) + `redactUrl` unit test |
| POST is byte-for-byte, with headers and query; the provider gets exactly the runner's status and body | 4.4 step 5, 4.5 | `apps/server/test/relay-endpoint.test.ts` with a fake runner over a real ws (as other gateway tests do): non-UTF-8 body (`0xff 0xfe 0x00`), JSON with odd key order and whitespace, compare `Buffer.equals`. Hop-by-hop and `cookie` stripped, `x-hub-signature-256` and `authorization` kept, raw query kept. Runner answers 202 + body → the caller gets 202 + the same body + content-type |
| GET with a `hub.*` query forwarded, body unchanged | same | same file: GET `?hub.mode=subscribe&hub.verify_token=X&hub.challenge=123`, runner echoes `123` → the caller gets `123` |
| 404 / 413 / 429 never reach the runner | 4.4 steps 2-4 | same file: unknown, malformed (`/relay/in/`, `/relay/in/a/b`) and revoked → 404 with empty body; 1 MiB + 1 → 413; burst + 1 → 429; the fake runner received 0 frames; a form post to an unknown token → 404 (not 415) |
| No runner → 503 + Retry-After, metadata only, no queue | 4.5 | same file: no runner / runner without `serve` / runner of a non-manager → 503, `Retry-After` set; after a runner connects, nothing is delivered for earlier calls |
| Timeout → 504, late answer ignored | 4.5 `pending` | same file with `timeoutMs` 200: 504; then a late `relay.response` → no throw, no second record, `pending` empty |
| One metadata record per request, nothing else | 4.2, 4.4 step 6 | each test above checks `relay_requests` has exactly one row with the right outcome, status, method, size and a null/set integration |
| Status API | 4.5 status | `relay-integrations.test.ts`: connected → `connected:true`; disconnect → `offlineSince` set; two 503s → count 2 and `lastAt`; reconnect clears it |
| No handler → 501, throws → 500 | 4.7 | `apps/runner/test/relay-dispatch.test.ts`: registered handler gets the exact bytes; 501; 500; unknown integration 503; oversize reply → 500; generic → 200 and a file in the sink with mode 0600 |
| Protocol round-trip | 4.1 | `packages/shared/test/relay-protocol.test.ts`: `makeEnvelope` → JSON → `RunnerToServerSchema` / `ServerToRunnerSchema` for all four frames; oversize body and response rejected; not in the acked sets |
| No-content check | 4.4, 5 | `apps/server/test/relay-no-content.test.ts`: distinct sentinels in path token, query, a header value and the body. Run them through forwarded, offline, timeout, 413, 429 and 404. Capture logs through a new `BuildOptions.logStream` (a pino destination for tests) and search the text of every row of every public table (`information_schema.tables` → `SELECT t::text FROM <tbl> t`, the event store included). Assert zero hits |

E2E (`e2e/**`) is left to the testers: a runner connected to a local server receives a relayed POST and its status
reaches the caller; with the runner stopped the caller gets 503.

## 7. Assumptions about unlanded dependencies (GWP-27)

1. `isBusinessOrg(org)` is exported from `packages/shared/src/orgs/mode.ts` (via `@aom/shared`) and takes an object
   with `mode`. **If wrong**: change the one import in `assertBusinessOrg` in `commands/relay-integrations.ts` and
   the join in the endpoint lookup.
2. `organizations.mode` exists (`'dev' | 'business'`) and the `OrgRow` returned by `requireOrg` carries `mode`. **If
   wrong**: read `SELECT mode FROM organizations` in `assertBusinessOrg`.
3. "Org manager" means org role `owner` or `admin` (`requireOrg(..., { min: 'admin' })`), the same check GWP-27 uses
   for `PATCH /api/org` mode changes. **If wrong**: swap the guard in four routes and the role check in `RelayHub.serve`.
4. Switching an org back to dev does not delete relay integrations. The relay endpoint then answers 404 because the
   lookup requires business mode, and the management routes answer 403. **If GWP-27 wants dev orgs to keep using
   integrations**: drop the mode condition in the lookup and in `serve`.

## 8. Recommendation

Build it as above, in this order:

1. Shared types, frames and events, with the protocol test.
2. Migration and projector.
3. Management commands and routes.
4. `RelayHub` and the gateway changes.
5. The public route, the scoped parser and error handler, and `redactUrl`.
6. Config, docs and the reaper prune.
7. Runner dispatch, generic handler, config, CLI and announcement.
8. The no-content test last, over all outcomes.

Sources: [Meta, Cloud API set up webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks),
[Meta, no-storage](https://developers.facebook.com/documentation/business-messaging/whatsapp/no-storage/),
[Hookdeck guide to WhatsApp webhooks](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices).
