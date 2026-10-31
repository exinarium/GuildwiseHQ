# GWP-37: WhatsApp Cloud API handler on the runner (relay)

Design for the runner side of the inbound relay for WhatsApp Cloud API: the secrets are stored encrypted on the workstation, the runner checks the `X-Hub-Signature-256` signature, answers the `hub.challenge` handshake and delivers events to a local inbox. The design sits on the relay dispatcher of GWP-36 (`apps/runner/src/relay/dispatch.ts`), which has landed on `main`.

**Revision 2026-10-31.** The first version was written before GWP-36 landed. Section 7 checks each assumption against the landed code. Changed in this revision: the handler signature and event fields (4.5), how served ids reach the dispatcher and how the runner re-announces (4.7), reuse of the landed `FileRelaySink` instead of a new `relay/inbox.ts` (4.6), and the body size limit, which is one server setting rather than per kind (5.2, 4.9). Sections 2, 3, 4.2, 4.3, 4.4 and 4.8 are unchanged apart from paths.

## 1. Question

How does the runner serve a WhatsApp Cloud API webhook that reaches it through the relay, so that:

- the Meta app secret and the verify token exist only encrypted on the workstation (never in a frame, the server DB or logs, or unredacted runner logs),
- the GET verification handshake and the POST signature check run on the workstation in constant time over the exact raw bytes,
- a valid event is answered 200 promptly and handed to a local intake,
- the integration is announced to the server only while its secrets are present,
- and Meta's retry window, which the "runner offline" notice relies on, is written down from Meta's own documentation?

Open points from planning: what the intake contract is, and whether GET and POST use the GWP-36 path or a WhatsApp-specific route.

## 2. Findings

### 2.1 What exists in the repository (working branch `main`)

| Area | File | What it gives us |
|---|---|---|
| Runner key pair | `apps/runner/src/secrets/keys.ts` (`RunnerKeys`) | RSA-OAEP key in `secrets/runner-key.pem` (0600, folder 0700). Only **decrypts**: `decryptAny(value, aad, { requireBound: true })` opens `h2.` blobs bound by associated data. |
| Sealing | `packages/shared/src/delivery/connect.ts` `sealLarge(publicKeyB64, text, aad?)` | AES-256-GCM under an RSA-OAEP-wrapped key; with `aad` it yields `h2.<wrapped>.<iv>.<ct+tag>`. Works in Node (WebCrypto). `ProviderStore.promote` already seals on the runner with the runner's own public key, so local sealing is an established pattern. |
| Encrypted store pattern | `apps/runner/src/direct/store.ts` (`ProviderStore`) | Keeps only ciphertext in a 0600 JSON file (atomic tmp+rename write). On construction it decrypts and calls `registerSecret` so redaction knows the secrets before the first log line, calls `unregisterSecret` on replace or clear, and fires `onChange` listeners. **This is the store to mirror.** |
| Credential folder pattern | `apps/runner/src/capabilities/pack-credentials.ts` (`PackCredentialStore`) | Stores the **plaintext** secret in a 0600 file: it is not encrypted, so it does not meet this card's "encrypted" requirement. Reuse only its `load()` re-registration and its `prepare()` 0700 folder handling. |
| Redaction | `apps/runner/src/secrets/redact.ts` | A registry for the whole process; `registerSecret` ignores values under 3 characters. `log.ts` passes every line through `redact`. |
| CLI | `apps/runner/src/cli.ts` | `promptSecret` (raw-mode TTY, or one line from a pipe), `promptLine`, `selectPairings` / `pairingPaths`, `git-connect` / `jira-connect` with `--status` / `--disconnect`, `touchRecheck(paths.secrets)` to tell a running runner, and (GWP-36) `relay add|remove|list`, which edit `config.relay.integrations` and need a runner restart. |
| CLI → running runner | `forge/connect.ts` `touchRecheck` / `recheckFile`; `runner.ts` ~l.1097 | A 10 s interval in the running runner watches the `secrets/git-recheck` mtime and then re-reports. The new store hooks into this same tick. |
| Relay dispatcher (GWP-36) | `apps/runner/src/relay/dispatch.ts` | `RelayDispatcher({ integrations, log })`, `register(kind, handler)`, `served()`, `dispatch(msg)`. Turns `relay.request` into a `RelayEvent` (`body` is a `Buffer` of the exact bytes, `headers` is `[name, value][]` lower-case with duplicates kept, `query` raw without `?`, `deadline`). Answers 503 for an integration not in `integrations()` or of another kind, 501 without a handler, 500 when the handler throws (logs `err.name` only), `null` (dropped) after the deadline. Only `content-type`, `retry-after`, `cache-control` response headers pass; response body at most 64 KiB. |
| Generic sink (GWP-36) | `apps/runner/src/relay/generic.ts` | `RelaySink { put(e) }` and `FileRelaySink(dir)`: one file per event, `<dir>/<integrationId>/<receivedAt>-<requestId>.json`, 0600 in a 0700 folder, tmp+rename, record `{requestId, integrationId, kind, method, query, headers, bodyBase64, receivedAt}`. `runner.ts` builds it on `config.relay.sinkDir ?? <data dir>/relay/inbox`. |
| Announcement (GWP-36) | `packages/shared/src/protocol/runner.ts` `relay.serve` / `relay.serve.result`; `runner.ts` `welcome` handler | `relay.serve { integrations: [{integrationId, kind}] }` **replaces** the runner's previous set on the server (`hub.ts serve`), so it can be re-sent at any time. Today it is sent once per `welcome` (when the server has `relay:1`) from `this.relay.served()`, which reads `opts.config.relay.integrations` (static until restart). The server refuses `unknown`, `revoked`, `kind_mismatch`, `not_business`, `not_allowed`. |
| Replay/dedupe helper | `integrations/seen.ts` `ReplayCache` | Not a good fit for webhook dedupe: it rewrites the whole map on every claim. |
| Business intake | none | The GWP-26 business intake does not exist in this repository. |

### 2.2 Meta's documentation (checked 2026-10-30)

| Topic | What Meta says | Source |
|---|---|---|
| **Retry window (WhatsApp)** | "If a webhook request to your endpoint receives an HTTP status code other than 200, or if the webhook cannot be delivered for another reason, Meta retries delivery with decreasing frequency until the request succeeds, for up to 7 days." "These retries can result in duplicate webhook notifications." | WhatsApp webhooks, section "Webhook delivery failure": https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks |
| Retry window (WhatsApp endpoint guide) | "delivery is retried immediately, then a few more times with decreasing frequency over the next 7 days." "Unacknowledged responses will be dropped after 7 days." "Your server should handle deduplication." | https://developers.facebook.com/docs/whatsapp/webhooks/create-webhook-endpoint |
| Retry window (generic Graph API webhooks, for contrast) | "retry immediately, then try a few more times with decreasing frequency over the next 36 hours." This applies to other Meta products. **WhatsApp's own page (7 days) governs this integration.** | https://developers.facebook.com/docs/graph-api/webhooks/getting-started |
| Verification | GET with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. "If the request is valid, respond with HTTP status 200 and the hub.challenge value." Otherwise answer 400-level or any non-200. | create-webhook-endpoint (above) |
| Signature | `X-Hub-Signature-256: sha256=<HMAC-SHA256(payload, app secret)>`. | create-webhook-endpoint; Graph getting-started |
| Payload size | "Webhook payloads can be up to 3 MB." | set-up-webhooks |
| Batching | Up to 1000 updates per request, but batching is not guaranteed. | Graph getting-started |
| TLS | A valid certificate is needed; self-signed is not supported. | create-webhook-endpoint |
| Response timeout | **Not documented** on any of these pages. The design makes no claim about it; it only answers within milliseconds. | - |

Meta keeps retrying a non-2xx answer for up to 7 days, then drops the event. So the "runner offline, messages waiting at the provider" notice (GWP-38) can say: messages wait at Meta for up to 7 days. `docs/SELF-HOSTING.md` (GWP-36) already says "Meta retries for up to 7 days"; this card adds the citation in `docs/RUNNER.md`.

## 3. Options compared

### 3.1 Where GET/POST are served

| Option | Pros | Cons |
|---|---|---|
| **A. The GWP-36 generic path `/relay/in/<token>`, dispatched by `kind = whatsapp_cloud` (recommended)** | No new server route. The server stays provider-agnostic. Meta is given exactly one callback URL. | None of note. |
| B. A WhatsApp-specific server route | Could add WhatsApp-specific limits. | Puts provider knowledge on the server, which works against decision 5 and duplicates GWP-36. |

**Recommendation: A.** The Meta callback URL is the relay URL from GWP-36, and the runner handles both GET and POST.

### 3.2 How the secrets are encrypted at rest

| Option | Pros | Cons |
|---|---|---|
| **A. `sealLarge` with the runner's own public key and a bound AAD, opened with `RunnerKeys.decryptAny(..., { requireBound: true })` (recommended)** | Reuses the existing format and code. A blob moved to another integration id or another runner key does not open. This is the same at-rest level as `ProviderStore`. | The private key sits on the same disk. Like every runner secret, this protects against the file being copied on its own (backups, sync folders), not against the user's own account. |
| B. Plaintext in a 0600 file (`PackCredentialStore` style) | Simple. | Breaks AC 1 and the test "the stored file does not contain the plaintext". |
| C. OS keychain | Strong. | New dependency, and headless runners and WSL have no keychain. Out of step with the rest of the runner. |

### 3.3 Answering 200 versus durability

| Option | Pros | Cons |
|---|---|---|
| Answer 200, then write the event asynchronously | Fastest. | If the process dies between the 200 and the write, the event is lost and Meta does not retry. |
| **Write the raw event to the inbox file (the landed `FileRelaySink.put`, synchronous fs calls, atomic), answer 200, then notify the intake consumer asynchronously (recommended)** | The 200 is durable: whatever Meta was told was accepted is on disk. Processing (the business workflow) never holds up the answer. A write failure throws, the dispatcher answers 500, so Meta retries. | A few milliseconds of disk I/O before the answer, well inside the 5 s forward timeout. |

The card says "processing happens after the answer". Persisting the event is acceptance, not processing, so this option meets the AC "the 200 is sent before intake processing finishes".

### 3.4 Status codes for a failed signature

Missing header: **401**. Malformed header or wrong signature: **403**. Both are non-2xx, so Meta treats them as failures. The card allows 401 or 403.

## 4. Design

### 4.1 Files and modules

| File | New/changed | Contents |
|---|---|---|
| `apps/runner/src/relay/whatsapp/store.ts` | new | `WhatsAppSecretStore`: the encrypted local store (4.2). |
| `apps/runner/src/relay/whatsapp/verify.ts` | new | Pure functions: `verifyHandshake(query, verifyToken)` and `verifySignature(rawBody, header, appSecret)` (4.3, 4.4). No I/O, so they are easy to unit test. |
| `apps/runner/src/relay/whatsapp/handler.ts` | new | `whatsAppHandler({ store, sink, sinkDir, intake })`: a `RelayHandler` (`(e, ctx) => Promise<RelayReply>`) registered for kind `whatsapp_cloud` (4.5). Also exports `RelayIntake`, `InboundEvent`, `noopIntake` (4.6). |
| `apps/runner/src/relay/generic.ts` | changed (small) | Export `relayEventFile(dir, e)`, the path `FileRelaySink.put` writes to, and use it inside `put` (no behaviour change), so the handler can tell the intake where the event is (4.6). |
| `apps/runner/src/relay/config.ts` | changed (small) | `addRelayIntegration` refuses kind `whatsapp_cloud` with "use `guildwise-runner whatsapp-connect <id>`" (4.7). |
| `apps/runner/src/runner.ts` | changed | Build the store, share one `FileRelaySink`, compose the dispatcher's `integrations` callback, register the handler, extract `announceRelay()`, reload on the recheck tick (4.7). |
| `apps/runner/src/cli.ts` | changed | New command `whatsapp-connect` (4.8); `--kind` help of `relay add` no longer lists `whatsapp_cloud`. |
| `docs/RUNNER.md` | changed | New section "WhatsApp Cloud API through the relay" (4.9), plus lines in "Data directory structure". |
| `apps/runner/test/relay-whatsapp-*.test.ts` | new | Unit tests (section 6). |

No change in `packages/shared` or the server. The AAD helper is runner-local because only this runner seals and opens these blobs. No new `relay/inbox.ts`: the landed `FileRelaySink` is the inbox.

### 4.2 Data model: the secret store

File `<pairing data dir>/secrets/relay-whatsapp.json`: mode 0600, folder 0700, atomic tmp+rename write, the same `write()` as `ProviderStore`.

```jsonc
{
  "<integrationId>": {
    "sealed": "h2.<wrapped>.<iv>.<ct+tag>",   // sealLarge(JSON.stringify({ appSecret, verifyToken }), aad)
    "keyId": "<runner keyId at sealing>",
    "phoneNumberId": "1234567890",            // optional, NOT secret (it is in every payload), stored plain
    "setAt": "2026-10-30T12:00:00.000Z"
  }
}
```

- AAD: `relay.whatsapp.v1|<integrationId>|<keyId>`. A blob copied under another id, or a blob sealed for another runner key, does not open.
- Integration id: a UUID (GWP-36 issues `z.uuid()` ids; `relay/config.ts` uses `UUID_RE` and stores them lower-case). Validate with the same regex and store the id lower-case, so it matches what the server sends in `relay.request.integrationId`. Read the file with `plainMap` (no prototype), as in `ProviderStore`.

```ts
export class WhatsAppSecretStore {
  constructor(deps: { file: string; keys: Pick<RunnerKeys, 'decryptAny'> & { publicKey: { keyId: string; publicKey: string } } });
  /** CLI: seals and writes; replaces an existing binding (unregisters the old values first). */
  async set(id: string, s: { appSecret: string; verifyToken: string; phoneNumberId?: string }): Promise<void>;
  /** CLI: removes the binding and unregisters its values. Returns false if there was none. */
  remove(id: string): boolean;
  /** Integration ids whose blob opens with this runner's key: the ones to announce. */
  ids(): string[];
  /** Opened secrets (memory only), or undefined. Never log the return value. */
  get(id: string): { appSecret: string; verifyToken: string; phoneNumberId?: string } | undefined;
  /** Re-reads the file: registers new values, unregisters values that were removed or replaced. Returns true when ids() changed. */
  reload(): boolean;
  /** For --status: id, phoneNumberId, setAt, readable (true/false). No secrets. */
  list(): Array<{ id: string; phoneNumberId?: string; setAt: string; readable: boolean }>;
}
```

(Check the exact shape of `RunnerKeys`' public key accessor when building; `ProviderStore.promote` shows how the runner seals to its own key.)

- The constructor calls `reload()`: decrypt every entry, keep the plaintext in an in-memory `Map`, and `registerSecret(appSecret)` and `registerSecret(verifyToken)` for each. A blob that will not open (runner key changed) is `readable: false`, is not announced, and `--status` tells the user to bind it again.
- `reload()` keeps the previous set of plaintexts and calls `unregisterSecret` on each value that is gone or replaced. This is how removing a binding through the CLI also clears redaction in the running runner on the next recheck tick.
- Input checks in `set` (no logging of values):
  - app secret: 16–256 characters, no whitespace. If it is not exactly 32 hex characters (Meta's usual format), warn but still store.
  - verify token: 8–256 printable ASCII characters, no whitespace.
  - phone number id: digits, 5–30.

### 4.3 Handshake (GET)

```ts
export function verifyHandshake(query: string, verifyToken: string):
  { status: 200; body: string } | { status: 400 | 403 } {
  const q = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const one = (k: string) => (q.getAll(k).length === 1 ? q.get(k) : null); // duplicates are refused
  if (one('hub.mode') !== 'subscribe') return { status: 403 };
  const given = one('hub.verify_token');
  if (given === null || !tokenEquals(given, verifyToken)) return { status: 403 };
  const challenge = one('hub.challenge');
  if (challenge === null || challenge.length === 0 || challenge.length > 512 || !/^[\x21-\x7e]+$/.test(challenge))
    return { status: 400 };
  return { status: 200, body: challenge }; // exactly the value, Content-Type: text/plain; charset=utf-8
}
// constant time regardless of length: compare fixed-size digests
const tokenEquals = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest());
```

- `RelayEvent.query` is the raw query without `?` (GWP-36); the `startsWith('?')` guard stays harmless.
- Right token: 200 with exactly `hub.challenge` as `text/plain` (`content-type` is on the dispatcher's allowed list). Wrong or missing token, or missing or other `hub.mode`: 403. Right token without a usable challenge: 400.
- The challenge is restricted to printable ASCII and at most 512 characters. Meta sends an integer, and the restriction keeps the echoed body harmless. The relay caps response bodies at 64 KiB.

### 4.4 Signature (POST)

```ts
const SIG_RE = /^sha256=([0-9a-fA-F]{64})$/;
export function verifySignature(raw: Buffer, header: string | undefined, appSecret: string): 'ok' | 'missing' | 'malformed' | 'mismatch' {
  if (header === undefined || header === '') return 'missing';
  const m = SIG_RE.exec(header.trim());
  if (!m) return 'malformed';
  const expected = createHmac('sha256', appSecret).update(raw).digest();     // over the exact bytes
  const given = Buffer.from(m[1] as string, 'hex');                          // 32 bytes, length guaranteed by the regex
  return timingSafeEqual(expected, given) ? 'ok' : 'mismatch';
}
```

- `raw` is `RelayEvent.body`, already a `Buffer` of the exact bytes (the dispatcher decodes the frame's base64). Never decode it to a string and re-encode it, and never `JSON.parse` it before this check. A body that is semantically equal but has different bytes (whitespace, key order, `é` precomposed vs decomposed) therefore fails.
- Header lookup over `RelayEvent.headers` (`[name, value][]`, names lower-case, duplicates kept): collect every entry named `x-hub-signature-256`. None → `missing`; more than one → `malformed`; exactly one → check it.
- `missing` → 401. `malformed` or `mismatch` → 403. In all three cases the event is not delivered.

### 4.5 Handler (the GWP-36 `RelayHandler` for kind `whatsapp_cloud`)

Landed signature (`relay/dispatch.ts`):

```ts
export type RelayHandler = (e: RelayEvent, ctx: RelayHandlerContext) => Promise<RelayReply>;
// RelayEvent { requestId, integrationId, kind, method: 'GET'|'POST', query, headers: [string,string][], body: Buffer, receivedAt: Date, deadline: number }
// RelayReply { status, headers?: Record<string,string>, body?: Buffer | string }
// RelayHandlerContext { integration: LocalRelayIntegration, log: Logger }
```

```ts
export function whatsAppHandler(deps: {
  store: Pick<WhatsAppSecretStore, 'get'>;
  sink: RelaySink;          // the runner's one FileRelaySink
  sinkDir: string;          // the same dir, for relayEventFile()
  intake: RelayIntake;
}): RelayHandler
```

Flow:

0. The dispatcher has already answered **503** if the id is not in its `integrations()` list (4.7) or the kind differs, and **501** if no handler is registered. A thrown error becomes **500**; a reply after `e.deadline` is dropped (the server already answered 504).
1. `s = store.get(e.integrationId)`. If there is none (a race with a removal before the next re-announce), answer **503** (non-2xx, so Meta retries) and log metadata.
2. `GET` → `verifyHandshake(e.query, s.verifyToken)`; on 200 reply `{ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: challenge }`.
3. `POST`:
   1. `verifySignature(e.body, header(e.headers, 'x-hub-signature-256'), s.appSecret)`. On failure, return 401 or 403.
   2. **After** verification, parse a copy for the summary only (`JSON.parse(e.body.toString('utf8'))` in a try): `object`, `entry[].changes[].field`, `value.metadata.phone_number_id`, and the counts of `messages` and `statuses`.
   3. If the binding has a `phoneNumberId` and the payload names only other numbers, answer **200** without delivering and log `ignored:other_number`. One Meta app can subscribe several numbers to one callback URL; a 200 stops Meta retrying an event that belongs to another runner.
   4. `await sink.put(e)`: the landed `FileRelaySink` writes the raw event atomically. If it throws, let it throw: the dispatcher answers **500** and Meta retries (the same contract as `genericHandler`).
   5. Return **200** with no body.
   6. Schedule the intake notification **after** the return: `setImmediate(() => void intake.accept(event).catch(() => ctx.log.warn(...metadata...)))`. It is never awaited by the handler.
4. Any other method: **405** (the schema only lets GET and POST through today; keep the branch for safety).

Logging is metadata only, through `ctx.log` (which is redacted anyway). For example:

`relay whatsapp_cloud <integrationId> POST 200 delivered bytes=1234 ms=3 messages=1 statuses=0`

Never log `e.query` (it holds `hub.verify_token`), headers, the body, or the parsed payload. Outcome labels: `handshake_ok`, `handshake_refused`, `sig_missing`, `sig_invalid`, `delivered`, `ignored:other_number`, `no_binding`.

### 4.6 The intake contract and the inbox (the landed `FileRelaySink`)

GWP-36 landed a local sink, so this card **reuses it** and adds no `relay/inbox.ts`:

- Folder: `config.relay.sinkDir ?? <pairing data dir>/relay/inbox`, one subfolder per integration id (0700), as for `generic`.
- One file per event: `<receivedAt>-<requestId>.json` (0600, tmp then rename) holding `{ requestId, integrationId, kind, method, query, headers, bodyBase64, receivedAt }`. The raw bytes are kept exactly. For a WhatsApp POST the query is empty and the headers hold the signature (an HMAC, not a secret); nothing of this leaves the workstation.
- Change in `generic.ts`: export `relayEventFile(dir: string, e: RelayEvent): string` (folder + stamp + requestId, the expression `put` already uses) and call it from `put`. No behaviour change; it lets the handler give the intake the file path without changing the `RelaySink` interface.

**Duplicates.** The first design named files by body hash to collapse Meta's retries. The landed sink names them by request id, so a Meta retry of the same event becomes a second file. Do not change the sink for this: Meta tells the receiver to deduplicate, retries only follow a non-2xx or a lost answer (rare), and message-level dedupe on `messages[].id` / `statuses[].id` is the consumer's job anyway (GWP-26). The `InboundEvent` carries `bodySha256` so a consumer can drop byte-identical retries cheaply.

The GWP-26 business intake is not in this repository, so the handler notifies an `intake` that is a no-op today. When the business intake lands, it implements the same interface and is wired in `runner.ts` without changing the handler.

```ts
export interface InboundEvent {
  requestId: string;
  integrationId: string;
  kind: 'whatsapp_cloud';
  receivedAt: string;
  file: string;               // relayEventFile(sinkDir, e): absolute path of the stored raw event
  bodySha256: string;
  summary: { phoneNumberIds: string[]; fields: string[]; messages: number; statuses: number };
}
export interface RelayIntake { accept(e: InboundEvent): Promise<void>; }
export const noopIntake: RelayIntake = { accept: async () => {} };
```

Message content is stored only on the workstation. That is the point of the relay, and it never goes to the server. Retention is out of scope: the consumer (GWP-26) moves or deletes files it has processed; a cap or retention for the inbox is a backlog suggestion (it applies to `generic` too).

### 4.7 Announce and unannounce (runner.ts wiring)

Landed today (GWP-36): `this.relay = new RelayDispatcher({ integrations: () => opts.config.relay.integrations, log })`; the `welcome` handler sends `relay.serve { integrations: this.relay.served() }` when the server has `relay:1`; `relay add|remove` edits the config file and asks for a restart. `relay.serve` replaces the runner's whole set on the server (`hub.ts serve` drops what is no longer announced and marks it offline), so re-sending it on the open connection is enough to announce or unannounce. There is no callback registry, so this card composes the list itself:

- **Source of truth for `whatsapp_cloud`: the secret store, not the config.** A runner serves a WhatsApp integration exactly when it holds readable secrets for it.
  ```ts
  this.whatsapp = new WhatsAppSecretStore({ file: join(this.paths.secrets, 'relay-whatsapp.json'), keys: this.keys });
  // before the dispatcher is built (it registers the redaction values before anything logs)
  this.relay = new RelayDispatcher({
    integrations: () => [
      ...opts.config.relay.integrations.filter((i) => i.kind !== 'whatsapp_cloud'),
      ...this.whatsapp.ids().map((id) => ({ id, kind: 'whatsapp_cloud' as const })),
    ],
    log: this.log,
  });
  ```
  Construction order: in the constructor the dispatcher is built (~l.384) before `this.keys` (~l.407). The `integrations` callback is a closure, so it may name `this.whatsapp` before it exists; build the store directly after `this.keys`, and register the `whatsapp_cloud` handler there. Nothing in between logs a secret, but if the builder moves the store, it must still be built before the first `relay.request` and before anything logs.
- A config entry of kind `whatsapp_cloud` (possible if someone ran `relay add --kind whatsapp_cloud` before this card) is ignored, with one startup warning naming `whatsapp-connect`. `addRelayIntegration` refuses that kind from now on; update the `relay add --kind` help text.
- One sink for both handlers: `const sinkDir = opts.config.relay.sinkDir ?? join(this.paths.relay, 'inbox'); const sink = new FileRelaySink(sinkDir);` then `register('generic', genericHandler(sink))` and `register('whatsapp_cloud', whatsAppHandler({ store: this.whatsapp, sink, sinkDir, intake: noopIntake }))`.
- Extract the welcome code into `private announceRelay(): void { if (this.serverFeatures.has(RELAY_FEATURE)) this.client.send('relay.serve', { integrations: this.relay.served() }); }` and call it from `welcome` (unchanged behaviour). `client.send` only writes when the socket is open, which is fine: the next `welcome` announces again.
- On the existing recheck tick (`runner.ts` ~l.1097, the `recheckFile` mtime check), add `if (this.whatsapp.reload()) this.announceRelay();`. After a removal the id is gone from `served()`, the server drops it and answers 503 (runner offline) to Meta. Until the tick, the dispatcher still lists the id but the handler's `no_binding` answers 503 too (the store reloads only on the tick, so in practice the window is the tick itself).
- Only **ids and kind** go in the announcement (the schema allows nothing else). No secret, no phone number id, no label.
- `relay.serve.result` already logs refusals; a `kind_mismatch` there means the integration in the web app is not a WhatsApp one; mention it in the docs.
- Latency: the tick is 10 s, so bind and remove take effect within about 10 s, with no restart (unlike `relay add`). Say so in the CLI output, as `git-connect` does.

### 4.8 CLI: `guildwise-runner whatsapp-connect [integrationId]`

Options: `--phone-number-id <id>`, `--status`, `--disconnect`, `--pairing <p>`, `--data-dir <dir>`.

- **Pairing:** an integration belongs to one organization, so this command works on exactly one pairing. If the machine has more than one pairing and `--pairing` is absent, stop with an error that lists the pairings (`selectPairings` returns them all otherwise).
- **`--status`** (id optional): prints the `list()` rows, never secrets. Exit code 1 when the binding is missing or unreadable.
- **`--disconnect <id>`:** `store.remove(id)`, `touchRecheck`, then prints "Removed. A running runner stops serving this integration within about 10 seconds; Meta will get 503 and keep the messages for up to 7 days."
- **Bind or replace** (default):
  1. Print one line: "Nothing you type here leaves this machine."
  2. `promptSecret('Meta app secret (hidden): ')`.
  3. `promptSecret('Verify token (hidden, empty = generate one): ')`. When empty, generate `randomBytes(24).toString('base64url')` and print it **once** so the user can paste it into Meta's dashboard.
  4. Optional phone number id, from the flag or `promptLine`.
  5. `registerSecret` both values in the CLI process too.
  6. `await store.set(...)`, then `touchRecheck(paths.secrets)`.
  7. Print the Meta setup steps (callback URL = the relay URL from the web app, the verify token, and to subscribe the `messages` field).
- **Piping:** values can be piped on stdin, as `promptSecret` already supports (the app secret on line 1, the verify token on line 2). Keep them off argv: no `--app-secret` flag, because argv shows up in `ps` and in shell history.
- No `relay add` is needed: binding the secrets is what makes the runner serve the integration.
- The CLI never contacts the server.

### 4.9 Docs (`docs/RUNNER.md`)

`docs/RUNNER.md` has no relay section yet (GWP-36 documented the server side in `docs/SELF-HOSTING.md` and `docs/ARCHITECTURE.md`). New section **"WhatsApp Cloud API through the relay"**:

1. Create the integration (kind WhatsApp) in the web app and copy its relay URL. It is shown once.
2. On the workstation, run `guildwise-runner whatsapp-connect <integrationId> [--pairing …]` and enter the app secret (Meta App Dashboard → App settings → Basic) and a verify token (or let the command generate one). No `relay add` and no restart are needed.
3. In the Meta App Dashboard → WhatsApp → Configuration, set Callback URL = the relay URL and Verify token = the same token, click Verify and save, then subscribe the `messages` field.
4. Send a message from Meta's test number.
5. The **retry window**, quoting and linking the two WhatsApp pages from 2.2 (up to 7 days with decreasing frequency, duplicates possible, dropped after 7 days), with a note that the generic Graph API page says 36 hours, which does not apply to WhatsApp.
6. Where events land (`relay/inbox/<integrationId>/`, or `relay.sinkDir`), and that duplicates are possible.
7. How to replace or remove the binding; a `kind_mismatch` refusal in the runner log means the web app integration is not of kind WhatsApp.
8. The 3 MB payload note: the server's `AOM_RELAY_MAX_BODY_BYTES` defaults to 1 MiB; set it to `3145728` to accept Meta's documented maximum (link to `docs/SELF-HOSTING.md`).

Add `secrets/relay-whatsapp.json` and `relay/inbox/` to "Data directory structure".

## 5. Risks and notes

1. **The verify token does pass through the server once, in Meta's GET query.** Meta itself puts it in the handshake URL, so it reaches `/relay/in/<token>?hub.verify_token=…` and the `relay.request` query. The runner never sends it; the app secret never transits at all (only its HMAC does). GWP-36 already keeps it out of server logs (`redactUrl` replaces everything after `/relay/in/`, and `relay-no-content.test.ts` puts a sentinel in `hub.verify_token`). The CLI offers a generated random token: it only gates the subscribe handshake and can be rotated freely. Read AC 1's "no protocol frame carries them" as: no frame the runner or server originates carries them.
2. **Size limit.** Meta documents payloads of up to 3 MB. GWP-36 landed one server-wide limit, `AOM_RELAY_MAX_BODY_BYTES` (default 1 MiB, at most 4 MiB), not a per-kind one. Text and status events are a few KB (media arrives as ids), so 1 MiB is ample in practice; an over-limit event gets 413, Meta retries it for 7 days, and then it is lost. This card changes no server code: the docs tell operators to set `AOM_RELAY_MAX_BODY_BYTES=3145728` when they use WhatsApp, and a per-kind limit (like `AOM_RELAY_TIMEOUTS`) is a backlog suggestion.
3. **Runner key change.** If `runner-key.pem` is regenerated, the blobs stop opening. The store marks them unreadable and stops announcing them (the server answers 503), and `--status` says to bind again. No silent failure.
4. **Two workstations bound to the same integration.** Both announce and GWP-36 routes to one of them. Each one's inbox only holds what it received. Document this; it is acceptable for 1.4.0.
5. **Duplicates.** Meta documents them. With the landed sink each retry is its own file; the consumer dedupes on message ids (and can use `bodySha256`). Not handled in this card beyond that.
6. **Unbounded inbox** on a workstation without a consumer: backlog follow-up for retention or a cap (shared with `generic`).
7. **Response timeout.** Meta does not document one. The handler answers in milliseconds (an HMAC plus one small file write), far inside GWP-36's 5 s forward timeout (`AOM_RELAY_TIMEOUTS` can set `whatsapp_cloud` separately).
8. **Existing `relay add --kind whatsapp_cloud` entries** are ignored with a warning (4.7). There are none in the field yet (GWP-36 has only just landed), so this is a guard, not a migration.

## 6. Acceptance criteria → design → tests

All tests are unit tests (vitest, `apps/runner/test/`). Inject a fake `RunnerKeys` built from a temporary key file (`new RunnerKeys(tmp/runner-key.pem)` generates one) and a temporary data dir. Handler tests call the handler directly with a `RelayEvent`, and at least one goes through `RelayDispatcher.dispatch` with a `relay.request` frame (as `relay-dispatch.test.ts` does) to prove the wiring.

| AC | Design | Test(s) |
|---|---|---|
| 1. Secrets only encrypted on the workstation, never sent, logs redacted | 4.2 store (sealLarge + AAD, 0600), 4.7 announce sends ids only, 4.8 CLI never contacts the server | `relay-whatsapp-store.test.ts`: after `set`, the file content contains neither plaintext and has an `h2.` blob; mode 0600 (skip on win32); a blob moved to another id does not open. A `createLogger(file)` line that includes the app secret or verify token prints `***`. After `remove`/`reload`, the old value is no longer redacted (unregistered). Dispatcher built with the composed `integrations` callback: `served()` entries are exactly `{integrationId, kind}`, and the serialised `relay.serve` payload never contains either secret. |
| 2. Announces with secrets; stops after removal, server answers 503 | 4.7 (`ids()` in `integrations()`, `reload()` → `announceRelay()`), handler `no_binding` 503, dispatcher 503 | Store: `ids()` after set; empty after remove; `reload()` returns true on change. Dispatcher with the composed callback: the id is served after set and not after remove (then `dispatch` answers 503). A config entry of kind `whatsapp_cloud` without secrets is not served; `addRelayIntegration(..., 'whatsapp_cloud')` is refused. The server-side 503 is GWP-36's (`relay-endpoint.test.ts`, for testers). |
| 3. Handshake 200 with exactly the challenge / 403 | 4.3 | `relay-whatsapp-verify.test.ts`: right token → 200, body === challenge, content-type text/plain. Wrong token, missing token, missing `hub.mode`, `hub.mode=unsubscribe`, duplicated `hub.verify_token` → 403. Right token without a challenge → 400. Through `dispatch`: the `relay.response` body decodes to exactly the challenge. |
| 4. Correct POST → 200 and delivered; missing/malformed/wrong → 401/403, not delivered | 4.4, 4.5, 4.6 | Signature: valid; missing → 401; malformed (`sha1=…`, short hex, no prefix, header twice) → 403; wrong secret → 403. In each failure the inbox folder stays empty and `intake.accept` is not called. Valid → 200, one file at `relayEventFile(...)` whose `bodyBase64` decodes to the exact bytes, `intake.accept` called once with that `file`. A sink that throws → the dispatcher answers 500. |
| 5. Raw bytes; semantically equal but different bytes fail | 4.4 | Sign body A; send `JSON.stringify(JSON.parse(A))` (re-serialised) and A with one byte changed or extra whitespace → 403. A body with a multibyte character (`é` as raw UTF-8) signed over its bytes → ok; the same text with `é` decomposed → 403. |
| 200 before intake (test plan) | 4.5 steps 5–6 | An intake whose `accept` returns a promise that never resolves: the handler still resolves 200, and `accept` is called only after the handler returned (assert the order with a flag set in `setImmediate`). |
| 6. Real WhatsApp test message through the relay, Meta shows it delivered | Whole design + 4.9 docs | **Manual/staging E2E for testers** (needs GWP-36 deployed, a public TLS URL and a Meta developer app). Not run by the builder. |
| 7. Retry window written down with a link | 2.2, 4.9 | Docs review: `docs/RUNNER.md` quotes "up to 7 days" with both WhatsApp links. The builder also posts it on the card (`aom comment`). |

Regression: `relay-dispatch.test.ts` (generic handler, `relayEventFile` refactor, `addRelayIntegration` for the other kinds) must still pass.

Suites left for testers: the integration test with GWP-36's server (a signed fixture in Meta's format through `/relay/in/<token>` reaches the inbox; an unsigned one gets 401/403 at the caller); the Meta E2E; and the no-content sentinel search (app secret and verify token as sentinels over the server DB dump, the server logs, and the runner logs, where they appear only redacted).

## 7. Assumptions checked against the landed GWP-36 code (2026-10-31)

| # | Assumption | Result | What the landed code does, and what changed here |
|---|---|---|---|
| 1 | `relay.request` carries requestId, integrationId, kind, method, query, headers and the exact raw body; a per-kind handler returns `{status, headers?, body?}` sent as `relay.response`. | **Revised (shape only)** | The frame field is `body` (base64, exact bytes) plus `deadlineMs`. The dispatcher hands handlers a `RelayEvent` with `body: Buffer` (already decoded), `headers: [name, value][]` (lower-case, duplicates kept) and `query` without `?`. A handler is a function `(e, ctx) => Promise<RelayReply>`. The body is raw bytes, so nothing needs fixing in GWP-36. 4.4 and 4.5 now use these names; verify.ts and store.ts logic is unchanged. |
| 2 | Served ids come from a runner-side registry fed by callbacks and can be re-sent after hello without a reconnect. | **Revised** | `relay.serve` exists and replaces the set on the server, so re-sending works without a reconnect. But `served()` reads one `integrations` callback that today returns the static `config.relay.integrations` (changes need a restart). 4.7: this card composes that callback (config minus `whatsapp_cloud`, plus the store's ids), extracts `announceRelay()` from the `welcome` handler and calls it from the recheck tick. No new frame. |
| 3 | Integration ids are UUIDs and the server checks the announced kind. | **Holds** | `z.uuid()` in the schemas, `UUID_RE` and lower-casing in `relay/config.ts`; `hub.ts serve` refuses `kind_mismatch`. |
| 4 | GWP-36's generic handler has a local sink to reuse. | **Holds** | `FileRelaySink` in `relay/generic.ts`. 4.6 now reuses it (no `relay/inbox.ts`); file names are by request id, so the body-hash dedupe of the first design is dropped and left to the consumer; a small `relayEventFile` export gives the intake the path. |
| 5 | Dispatcher 500 on handler error, 501 without handler; no query/headers/body in logs. | **Holds** | As assumed (plus 503 for an unserved id or other kind). Server: `redactUrl` hides everything after `/relay/in/`, route and hub log ids and numbers only, `relay-no-content.test.ts` covers a `hub.verify_token` sentinel. |
| 6 | The size limit can be set per kind (3 MiB for `whatsapp_cloud`). | **Revised** | One server-wide `AOM_RELAY_MAX_BODY_BYTES` (default 1 MiB, max 4 MiB); only the timeout is per kind. No server change in this card: docs tell operators to set 3 MiB; per-kind limit goes to the backlog (5.2). |

## 8. Recommendation

Build it as designed:

- an encrypted `WhatsAppSecretStore` (sealLarge with the runner's own key and a bound AAD, redaction on load, replace and remove),
- pure constant-time `verifyHandshake` / `verifySignature` over the raw bytes,
- a `whatsapp_cloud` handler on the landed `RelayDispatcher` that writes through the landed `FileRelaySink`, answers 200, then notifies a pluggable `RelayIntake`,
- served ids composed from the config (other kinds) and the secret store (WhatsApp), re-announced with `relay.serve` on the existing recheck tick,
- a `whatsapp-connect` CLI command next to `git-connect`,
- and the Meta setup steps, the cited 7-day retry window and the 3 MiB body-limit advice in `docs/RUNNER.md`.
