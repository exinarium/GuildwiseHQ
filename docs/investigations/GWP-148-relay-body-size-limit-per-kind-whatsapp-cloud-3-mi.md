# GWP-148: Relay body size limit per kind (whatsapp_cloud 3 MiB)

Status: design, ready to build. Checked on the card branch, whose HEAD (58a66b71) is `origin/release/1.6.0`.

## 1. Question

The inbound webhook relay (`/relay/in/<token>`) has one body limit for every kind (`AOM_RELAY_MAX_BODY_BYTES`, default 1 MiB). Meta documents WhatsApp webhook payloads of up to 3 MB. An event over the limit gets 413, and Meta retries it for 7 days and then drops it. The card asks for per-kind limits (`AOM_RELAY_MAX_BODY_BYTES_BY_KIND`, in the same format as `AOM_RELAY_TIMEOUTS`), a built-in 3 MiB default for `whatsapp_cloud`, a hard ceiling, a body read that stops at the limit, and a forward path from server to runner that carries the largest allowed body.

## 2. Check of release/1.6.0 (requirement 0, AC 1)

Not done. None of the requirements exist yet. What exists today:

| Item | Where | State |
| --- | --- | --- |
| Global limit `AOM_RELAY_MAX_BODY_BYTES` | `apps/server/src/config.ts:198`, `z.coerce.number().int().min(1).max(RELAY_BODY_HARD_MAX_BYTES).default(1_048_576)`, mapped to `config.relay.maxBodyBytes` (`:513`) | Exists. An out-of-range value fails startup (zod). |
| Hard maximum | `packages/shared/src/relay/index.ts:24`, `RELAY_BODY_HARD_MAX_BYTES = 4 * 1024 * 1024` | Exists (4 MiB). |
| Per-kind body override | none | Missing. |
| `whatsapp_cloud` default | none | Missing. `docs/RUNNER.md:714` tells operators to raise the global limit to 3145728 instead. |
| Limit on the public route | `apps/server/src/webhook-relay/route.ts:197`, `bodyLimit: ctx.config.relay.maxBodyBytes` | One fixed limit per route. Fastify's raw body reader checks `Content-Length` first and then counts streamed bytes, so it never buffers past the limit. The kind is known only after the `onRequest` lookup. |
| Per-kind timeouts (the pattern to copy) | `config.ts:395-407`, `clampMs` and `relayTimeouts` | Exists. |
| Server-to-runner frame cap | `packages/shared/src/protocol/runner.ts:2185`, `body: z.base64().max(Math.ceil(RELAY_BODY_HARD_MAX_BYTES / 3) * 4)` (5,592,408 characters) | The runner validates every incoming frame with `ServerToRunnerSchema.safeParse` (`apps/runner/src/connection/client.ts:218`). The server sends without validation (`runner-gateway/registry.ts:82`). Base64 of any body up to 4 MiB fits exactly. |
| Server ws `maxPayload` | `apps/server/src/app.ts:602`, 8 MiB | Applies only to frames the server receives (runner to server). A `relay.response` is at most 64 KiB, so it does not apply here. |
| Runner ws client | `apps/runner/src/connection/client.ts:162`, no `maxPayload` | The `ws` default is 100 MiB, so it does not apply here. |
| Runner dispatcher and WhatsApp handler | `apps/runner/src/relay/dispatch.ts:104` (`Buffer.from(msg.body, 'base64')`), `relay/whatsapp/handler.ts` | No size check on the request body. |
| Edge proxy | `deploy/Caddyfile:69-74`, `/relay/in/*` `max_size 4MiB` (GWP-128, done). `apps/server/test/deploy-proxy-config.test.ts:142` asserts it equals `RELAY_BODY_HARD_MAX_BYTES`. | A 3 MiB body passes the bundled proxy today. |

Conclusion: a 3 MiB body already fits through the proxy, the frame schema and the runner. Only the server's limit (config and route) and the docs have to change. Nothing on the forward path has to be raised as long as the ceiling stays at 4 MiB (section 3.1).

## 3. Options

### 3.1 Hard ceiling: 4 MiB (existing) or 16 MiB (proposed on the card)

| | A: ceiling = `RELAY_BODY_HARD_MAX_BYTES` (4 MiB) | B: ceiling 16 MiB |
| --- | --- | --- |
| Covers Meta's 3 MB | yes | yes |
| Protocol | no change | raise the constant, so the frame cap becomes about 22.4 MB of base64 |
| Runner version skew | none | runners built with the old schema drop frames over 4 MiB with "dropping invalid server frame", which looks like a 504 timeout to the provider. This needs a feature flag or a minimum runner version. |
| Bundled proxy | no change | raise Caddy `max_size` and the `deploy-proxy-config` test. Every self-hoster's edge then accepts 16 MiB on an unauthenticated route. |
| Memory | 200 in flight × (4 MiB + 5.6 MB base64 + JSON) ≈ 2 GB worst case, the same as today | about 4× that |

**Decision: A.** The ceiling is the existing `RELAY_BODY_HARD_MAX_BYTES` (4 MiB). It meets every AC, including "a value above the ceiling is capped". This follows the owner's ruling on public body limits in ledger f84a9061 (GWP-69): keep the limit the card needs, because "a higher limit only adds exposure on public endpoints", and it can be raised later. The card says "proposed 16 MiB", and the planner flagged it as an owner choice. The choice is recorded on the card. If the owner wants 16 MiB, the extra work is listed in section 7. It is a separate change because of the runner version gate.

### 3.2 Per-kind limit on one Fastify route

Fastify's `bodyLimit` is fixed per route (`reply[kRouteContext]._parserOptions.limit`, used in `content-type-parser.js:247` of fastify 5.12.7), and the kind is known only after `lookup`.

- **A, `preParsing` hook (chosen).** It runs after `onRequest` (so `req.relay.kind` is known) and before the body is read (`route.js:652`, `runPreParsing`). The hook rejects a declared `Content-Length` over the kind's limit with 413 before any byte is read. Otherwise it returns a counting stream that fails with 413 as soon as the count passes the limit. Fastify's own reader keeps doing what it does today: buffer the bytes, check `Content-Length` against the bytes received (400 on a mismatch), and hand the exact bytes to the existing `'*'` parser. The route's `bodyLimit` becomes the largest per-kind limit, as a backstop.
- B, a parser that reads the stream itself (no `parseAs`). It works, but it rewrites Fastify's buffering, length-mismatch and error handling for no gain.
- C, one route per kind, or a route-level limit equal to the ceiling with a check after buffering. C breaks requirement 6: the body would be buffered up to 4 MiB for a 1 MiB kind.

### 3.3 Parser reuse

`relayTimeouts` can be split into a shared entry reader and the clamp. Its behaviour does not change at all (same split, same trim, same `Number`, same `Math.trunc`, same accept rule). Both settings then follow one convention by construction (section 4.2).

### 3.4 Built-in whatsapp_cloud default against a larger global

If `AOM_RELAY_MAX_BODY_BYTES` is already set above 3 MiB (for example 4194304), a fixed 3 MiB default would *lower* WhatsApp's limit, which would be a regression for an operator who followed the old RUNNER.md advice and went further. **Decision:** the built-in default is a floor, `max(3145728, AOM_RELAY_MAX_BODY_BYTES)`. With no settings, or with the global at 512 KiB, `whatsapp_cloud` gets exactly 3 MiB, as the ACs require. An explicit per-kind entry always wins, including a lower one (2 MiB in the AC).

## 4. Design

### 4.1 Limits and order of precedence

For each kind `k`:

1. an entry for `k` in `AOM_RELAY_MAX_BODY_BYTES_BY_KIND`, clamped to `1..RELAY_BODY_HARD_MAX_BYTES`; otherwise
2. for `whatsapp_cloud` only: `max(3145728, AOM_RELAY_MAX_BODY_BYTES)`; otherwise
3. `AOM_RELAY_MAX_BODY_BYTES` (default 1048576, unchanged, still validated by zod at startup).

The ceiling is `RELAY_BODY_HARD_MAX_BYTES` (4 MiB) and the floor is 1 byte, the same range zod allows for `AOM_RELAY_MAX_BODY_BYTES`.

### 4.2 Config (`apps/server/src/config.ts`)

EnvSchema, next to `AOM_RELAY_TIMEOUTS`:

```ts
/** Per kind body limits, `kind=bytes,kind=bytes` (same rules as AOM_RELAY_TIMEOUTS); each clamped to 1..RELAY_BODY_HARD_MAX_BYTES. */
AOM_RELAY_MAX_BODY_BYTES_BY_KIND: z.string().default(''),
```

The shared reader and both users:

```ts
/** `kind=n,kind=n`: entries with a known kind and a finite number (truncated). Anything else is skipped. */
function relayKindEntries(overrides: string): [RelayKind, number][] {
  const out: [RelayKind, number][] = [];
  for (const part of overrides.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    const n = Number(v);
    if (k && (RELAY_KINDS as readonly string[]).includes(k) && Number.isFinite(n)) out.push([k as RelayKind, Math.trunc(n)]);
  }
  return out;
}

export function relayTimeouts(fallback: number, overrides: string): Record<RelayKind, number> {
  const out = Object.fromEntries(RELAY_KINDS.map((k) => [k, clampMs(fallback)])) as Record<RelayKind, number>;
  for (const [k, n] of relayKindEntries(overrides)) out[k] = clampMs(n);
  return out;
}

/** Built-in per-kind floors: Meta sends WhatsApp webhook payloads of up to 3 MB and drops a refused one after 7 days. */
export const RELAY_BODY_KIND_DEFAULTS: Partial<Record<RelayKind, number>> = { whatsapp_cloud: 3 * 1024 * 1024 };
const clampBytes = (n: number) => Math.min(RELAY_BODY_HARD_MAX_BYTES, Math.max(1, n));

/** The body limit of each relay kind: an override, else max(built-in default, global), else the global. */
export function relayBodyLimits(fallback: number, overrides: string): Record<RelayKind, number> {
  const out = Object.fromEntries(
    RELAY_KINDS.map((k) => [k, Math.max(RELAY_BODY_KIND_DEFAULTS[k] ?? 0, fallback)]),
  ) as Record<RelayKind, number>;
  for (const [k, n] of relayKindEntries(overrides)) out[k] = clampBytes(n);
  return out;
}
```

The result is the same as `AOM_RELAY_TIMEOUTS` for every kind of bad entry (AC 5). The table goes into the unit test, which runs each case through both functions:

| Entry | `AOM_RELAY_TIMEOUTS` | `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` |
| --- | --- | --- |
| unknown kind (`sms=5`) | skipped, the kind keeps its default | skipped |
| non-numeric (`whatsapp_cloud=abc`), no `=` | skipped | skipped |
| zero or negative | clamped to the floor (1000 ms) | clamped to the floor (1 byte) |
| above the maximum | clamped to 15000 ms | clamped to 4194304 |
| fraction (`=2097152.9`) | truncated | truncated |
| repeated kind | the last entry wins | the last entry wins |
| empty value (`whatsapp_cloud=`, `Number('')` is 0) | floor | floor |

The floor for zero or negative is deliberate: it is what "the same as AOM_RELAY_TIMEOUTS" means. It fails closed (the kind then refuses every non-empty POST) instead of quietly accepting more, and the docs state the 1..4194304 range. Do not add a different rule for bytes.

Config type and `loadConfig`:

```ts
relay: {
  /** `AOM_RELAY_MAX_BODY_BYTES`, the limit of every kind without its own (see maxBodyBytesByKind). */
  maxBodyBytes: number;
  /** Largest request body forwarded, per kind; bigger is a 413. */
  maxBodyBytesByKind: Record<RelayKind, number>;
  ...
}
// loadConfig
maxBodyBytes: e.AOM_RELAY_MAX_BODY_BYTES,
maxBodyBytesByKind: relayBodyLimits(e.AOM_RELAY_MAX_BODY_BYTES, e.AOM_RELAY_MAX_BODY_BYTES_BY_KIND),
```

`maxBodyBytes` keeps its name, type and meaning, so `relay-endpoint.test.ts:214` (a `generic` integration) stays valid unchanged. Its only other reader, `route.ts:197`, moves to the new field.

### 4.3 Public route (`apps/server/src/webhook-relay/route.ts`)

Add a `preParsing` hook to the `GET`/`POST` route and set the route `bodyLimit` to the largest per-kind limit:

```ts
import { Transform } from 'node:stream';

const tooLarge = () => Object.assign(new Error('relay body over the limit'), { statusCode: 413, name: 'RelayBodyTooLarge' });

/** Passes bytes through until `limit`, then fails with 413: never more than one chunk past the limit is held. */
function capped(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) return cb(tooLarge());
      cb(null, chunk);
    },
  });
}

/** The integration's own limit, checked before any body byte is read and while it streams. GET bodies are never read. */
const sizeCheck = async (req: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
  if (req.method !== 'POST') return payload;
  const limit = ctx.config.relay.maxBodyBytesByKind[(req.relay as RelayCall).kind];
  if (sizeOf(req) > limit) throw tooLarge();
  const out = capped(limit);
  out.on('error', () => payload.unpipe(out));
  return payload.pipe(out);
};

const routeLimit = Math.max(...Object.values(ctx.config.relay.maxBodyBytesByKind));
fastify.route({
  method: ['GET', 'POST'],
  url: '/relay/in/:token',
  logLevel: 'silent',
  bodyLimit: routeLimit,
  exposeHeadRoute: false,
  onRequest: lookup,
  preParsing: sizeCheck,
  preHandler: rateLimit,
  handler: forward,
});
```

Notes for the builder:
- `preParsing` runs for GET too (`runPreParsing` comes before `handleRequest`, and GET is bodyless). Skip GET so a GET with a stray `Content-Length` behaves as it does today.
- If `lookup` answered 404, the reply is already sent and `runPreParsing` returns early (`reply.sent`), so `req.relay` is always set when `sizeCheck` runs.
- Both rejections reach the existing error handler with `statusCode 413`. It records `rejected_size` with the integration id and the `Content-Length` (the same row shape the existing 413 test checks) and sends an empty 413. The error handler does not change.
- Do **not** use `stream.pipeline` or destroy `req.raw` on overflow. That destroys the socket before the 413 is written. Unpiping is enough: Node discards the rest of the request after the reply ends, without buffering it (Fastify's own limit error behaves the same way). Fastify's reader listens for `error` on the returned stream and keeps a `statusCode >= 400` as given.
- The order inside the route is unchanged: lookup → size → parse → rate limit → forward. Auth, token hashing, rate limit, timeouts and `forwardHeaders` are untouched.
- Memory: at most the limit plus one socket chunk (about 64 KiB) is held before the 413.

### 4.4 Forward path (requirement 5, AC 6)

No code change. The largest allowed body is 4 MiB, and its base64 is `ceil(4194304/3)*4 = 5,592,408` characters, which is exactly the `RelayRequestSchema` cap. The runner `ws` client has no frame cap below 100 MiB, and the server's 8 MiB `maxPayload` covers only runner-to-server frames. `RelayHub.forward` (`hub.ts`, `body: req.body.toString('base64')`) base64-encodes the whole buffer, and the dispatcher decodes it into the `RelayEvent.body` Buffer that the WhatsApp handler signs and stores. Add a guard test so that a future ceiling change cannot break the forward without failing a test (section 6).

Leave the `RELAY_BODY_HARD_MAX_BYTES` doc comment as it is, or extend it with "also the ceiling of AOM_RELAY_MAX_BODY_BYTES_BY_KIND".

### 4.5 Deployment and docs (requirement 7, AC 7)

- `docker-compose.prod.yml`, app environment next to line 33: `AOM_RELAY_MAX_BODY_BYTES_BY_KIND: ${AOM_RELAY_MAX_BODY_BYTES_BY_KIND:-}`. Compose has no `env_file`, so without this line the setting cannot reach the bundled app. An empty value equals unset. Caddy does not need it, because its 4 MiB route cap is already the ceiling. Optionally, assert the line in `deploy-proxy-config.test.ts` next to line 180.
- `.env.prod.example`, after line 33: `# AOM_RELAY_MAX_BODY_BYTES_BY_KIND=     # per relay kind, e.g. whatsapp_cloud=3145728 (built in); each at most 4194304`.
- `docs/SELF-HOSTING.md` env table, a new row after `AOM_RELAY_MAX_BODY_BYTES` (line 462): `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` | unset (whatsapp_cloud: 3145728 built in) | per kind body limits in the same format as `AOM_RELAY_TIMEOUTS`, for example `whatsapp_cloud=3145728,generic=262144`. Each value is clamped to 1..4194304; unknown kinds and non-numbers are ignored. Without an entry, whatsapp_cloud gets 3 MiB (or `AOM_RELAY_MAX_BODY_BYTES` if that is larger), because Meta sends webhook payloads of up to 3 MB and drops an event it cannot deliver after 7 days of retries; every other kind gets `AOM_RELAY_MAX_BODY_BYTES`. Also say on the `AOM_RELAY_MAX_BODY_BYTES` row that it applies to kinds without their own limit. On the `/relay/in/*` row of the proxy table (line 263), name the per-kind limits as well.
- `docs/RUNNER.md:714`, rewrite: Meta documents payloads of up to 3 MB; the server accepts 3 MiB for WhatsApp integrations by default, so nothing needs to be set; `AOM_RELAY_MAX_BODY_BYTES_BY_KIND=whatsapp_cloud=<bytes>` changes it (at most 4 MiB); an over-limit event gets 413 and Meta retries it for up to 7 days, then drops it.
- SELF-HOSTING "Running behind a reverse proxy": one sentence that a proxy of your own must let at least 3 MiB through on `/relay/in/*` for WhatsApp (nginx defaults to `client_max_body_size 1m`).
- `deploy/Caddyfile:67` comment: mention the per-kind limits (comment only; the test checks `max_size 4MiB`).
- `config.ts` doc comments as in 4.2.

## 5. Acceptance criteria mapping

| AC | Design |
| --- | --- |
| Check of release/1.6.0 recorded | Section 2, plus a comment on the card. |
| whatsapp_cloud, no settings: 3145728 accepted and forwarded, 3145729 gets 413 | 4.1 step 2 and 4.3; tested in the new endpoint test. |
| Other kinds unchanged (1 MiB or `AOM_RELAY_MAX_BODY_BYTES`) | 4.1 step 3. The existing 413 test (`generic`) passes unchanged, plus a new 512 KiB case. |
| Override 2097152 wins over the built-in default | 4.1 step 1. |
| Bad entries handled as in `AOM_RELAY_TIMEOUTS`, capped at the ceiling | 4.2, shared `relayKindEntries` and the table; ceiling 4 MiB (3.1). |
| 3 MiB reaches the runner's whatsapp_cloud handler byte for byte | 4.4, no limit on the path; endpoint test and runner test. |
| Documented with the whatsapp_cloud example | 4.5. |
| Unit and endpoint tests, existing relay tests pass | Section 6. |

## 6. Tests

New `apps/server/test/relay-config.test.ts` (pure, no database):
- `relayBodyLimits(1048576, '')`: `whatsapp_cloud` 3145728, every other kind 1048576.
- `relayBodyLimits(524288, '')`: `whatsapp_cloud` 3145728, others 524288. `relayBodyLimits(4194304, '')`: `whatsapp_cloud` 4194304 (the floor rule).
- Single entry, several entries, unknown kind, non-numeric, missing `=`, zero, negative, empty value, fraction, above the ceiling (capped to 4194304), repeated kind. For each bad case, assert in the same test that `relayTimeouts(5000, <same shape>)` treats it the same way (skipped vs clamped).
- `relayTimeouts` regression: a few existing behaviours (default 5000, `whatsapp_cloud=5000,calendar_push=8000`, clamping to 1000 and 15000) give the same values as before the refactor.
- `loadConfig({...minimal env, AOM_RELAY_MAX_BODY_BYTES_BY_KIND: 'whatsapp_cloud=2097152'}).relay.maxBodyBytesByKind.whatsapp_cloud === 2097152`, and `maxBodyBytes` stays 1048576.

Endpoint tests, a new `apps/server/test/relay-body-limits.test.ts` beside `relay-endpoint.test.ts`. These use `createWorld` and need Postgres like the other relay tests. Reuse `helpers/relay.ts` (`createIntegration(w, 'whatsapp_cloud')`, `serve`/`autoReply`, `relayRows`). Use a rate burst large enough, or a fresh integration per case: the existing world uses burst 3.
- World with default env: `whatsapp_cloud` integration, 3145728 bytes (a Meta-style JSON padded to size) gives 200, and `Buffer.from(seen[0].body, 'base64').equals(body)`. 3145729 bytes give 413 with an empty body, no forward, and a `rejected_size` row. `generic`: 1048576 gives 200, 1048577 gives 413.
- World with `AOM_RELAY_MAX_BODY_BYTES=524288`: `generic` 524288 gives 200 and 524289 gives 413; `whatsapp_cloud` 3145728 gives 200.
- World with `AOM_RELAY_MAX_BODY_BYTES_BY_KIND=whatsapp_cloud=2097152`: 2097152 gives 200 and 2097153 gives 413.
- Streamed over-limit body: inject a `Readable` without `Content-Length` (chunked) that counts what it produced. It gets 413, and the producer was not drained to the end (for example 8 MiB offered, at most limit + one chunk pulled). If `inject` makes this unreliable, assert at least the 413 and that nothing was forwarded.
- Declared `Content-Length` over the limit: 413 with no body read.

Forward and runner side:
- `packages/shared/test` (or the runner test): `RelayRequestSchema` accepts a `relay.request` whose body is the base64 of `RELAY_BODY_HARD_MAX_BYTES` bytes. This guards 4.4.
- `apps/runner/test/relay-dispatch.test.ts`: a 3 MiB `relay.request` envelope run through `ServerToRunnerSchema.parse` (the same check `client.onFrame` uses) and `RelayDispatcher` to a registered `whatsapp_cloud` handler stub. The handler's `event.body` equals the original bytes.
- Optionally, in `relay-whatsapp.test.ts`: a correctly signed 3 MiB payload gives 200 and the inbox file decodes to the same bytes.

Regression: `relay-endpoint.test.ts`, `relay-no-content.test.ts`, `relay-integrations.test.ts`, `relay-membership.test.ts`, `deploy-proxy-config.test.ts`, and the runner's `relay-dispatch.test.ts` and `relay-whatsapp.test.ts` pass unchanged. The DB-backed server suites need Postgres. If it is not available in the build sandbox, list them in the handoff for the testers.

## 7. Risks and follow-ups

- **Ceiling = 4 MiB (owner may override).** If the owner wants 16 MiB later, that is a separate change: raise `RELAY_BODY_HARD_MAX_BYTES` (the frame cap follows), Caddy `max_size` and its test, and gate bodies over 4 MiB on a runner feature (for example a new relay feature in `hello`), so older runners never get a frame they would drop silently. Size `AOM_RELAY_MAX_IN_FLIGHT` against memory too.
- **Memory for whatsapp_cloud.** The default for one kind grows from 1 to 3 MiB. In the worst case, 200 in flight × (3 MiB raw + 4 MiB base64 + the JSON string) is about 2 GB, which a global setting of 4 MiB already allows today. Rate limits per integration (60 a minute, burst 20) bound it in practice. No change.
- **Self-hosters behind their own proxy** (not the bundled Caddy) may have a lower edge limit. Covered by the sentence in 4.5.
- **Merge overlap.** GWP-137 (merged, in HEAD) touched `config.ts` and `app.ts`. GWP-129 touches `hub.ts`, which this design does not change.

## 8. Files to change

| File | Change |
| --- | --- |
| `apps/server/src/config.ts` | EnvSchema entry, `relayKindEntries`, `relayTimeouts` refactor (no behaviour change), `RELAY_BODY_KIND_DEFAULTS`, `clampBytes`, `relayBodyLimits`, `relay.maxBodyBytesByKind` |
| `apps/server/src/webhook-relay/route.ts` | `capped`, `sizeCheck` `preParsing` hook, route `bodyLimit` = largest per-kind limit |
| `docker-compose.prod.yml` | pass `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` to the app |
| `.env.prod.example`, `docs/SELF-HOSTING.md`, `docs/RUNNER.md`, `deploy/Caddyfile` (comment) | docs (4.5) |
| `apps/server/test/relay-config.test.ts` (new), `apps/server/test/relay-body-limits.test.ts` (new), `apps/runner/test/relay-dispatch.test.ts`, a shared schema test | tests (section 6) |

Not changed: `hub.ts`, `protocol/runner.ts`, `relay/index.ts` (apart from an optional comment), `app.ts`, the runner client, the dispatcher, the WhatsApp handler, auth, hashing, signatures and timeouts.
