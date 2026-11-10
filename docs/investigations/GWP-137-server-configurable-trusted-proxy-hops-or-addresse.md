# GWP-137: configurable trusted proxy instead of `trustProxy: true`

## 1. Question

The server creates its Fastify app with `trustProxy: true`, so it believes every `X-Forwarded-For` hop. On a server that a
client can reach without going through the reverse proxy, the client picks its own address and gets around every
per-address limit. What must change so that the operator configures which proxies are trusted, with a safe default, and
what is already in place on release/1.6.0?

## 2. Check of release/1.6.0 (step 0)

The card branch is identical to `origin/release/1.6.0` (commit `104c3122`: no commits on either side), so every finding
below holds for release/1.6.0.

| Item | State on release/1.6.0 |
| --- | --- |
| `trustProxy: true` hard-coded in `createApp` | **Still there**: `apps/server/src/app.ts:321`. |
| Second Fastify server | **Also hard-coded**: `apps/server/src/video/push.ts:106` (`startPushServer`, the publish worker's push endpoint). |
| Config key for proxy trust | **None**. `apps/server/src/config.ts` has no trust or proxy setting. |
| `docs/SELF-HOSTING.md` | **Partly**: line 400 says "put the server behind a reverse proxy that sets `X-Forwarded-For`"; no variable, no default, no warning. |
| `docs/security/public-forms.md` | T19 (line 63) is "documented", with the hop count listed as a follow-up (line 75). |
| `CHANGELOG.md` | No entry. |
| Deploy files | `docker-compose.prod.yml` + `deploy/Caddyfile`: Caddy runs in its own container and proxies to `app:4600`; nothing sets a trust value. |
| Code reading `X-Forwarded-For` directly | **None** in `apps/server/src` (only tests, and the relay's header denylist in `packages/shared/src/relay/index.ts:56`, which strips the header before forwarding and is not a client-address read). |

Nothing of the card is done; all of it is to be built.

## 3. Findings

### 3.1 Fastify's `trustProxy` in the locked version (important)

The lock file pins `fastify@5.12.7` (`apps/server/package.json` asks `^5.12.6`). Its `lib/request.js`:

```js
if (typeof tp === 'number') {
  // Hop-count-only trust cannot validate the immediate peer. Fail closed so
  // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
  return function () { return false }
}
```

and `docs/Reference/Server.md` now says "`number`: Hop-count-only trust is disabled". So **passing a number to Fastify
quietly means "trust nobody"**: `request.ip` becomes the proxy's address, and every visitor behind the proxy shares one
bucket. A builder who writes `trustProxy: n` gets no error and broken limits. The hop count must be passed as a trust
function, which Fastify still supports:

```js
if (typeof tp === 'function') return tp
```

`@fastify/proxy-addr` walks the addresses `[socket, XFF last, ..., XFF first]` and stops at the first one for which
`trust(addr, i)` is false; `request.ip` is the last address kept. With `(addr, i) => i < N`:

- N = 1: trusts the socket only, `request.ip` = the rightmost `X-Forwarded-For` entry (the one the proxy wrote).
- N = 2: `request.ip` = the second entry from the right. Entries further left (spoofed) are never reached.
- Fewer entries than N: `request.ip` = the leftmost entry.

This is the Express `trust proxy = N` meaning, which the card asks for. The Fastify maintainers removed it because a
hop count cannot check who the peer is: a client that reaches the server directly can write the address it wants into
the rightmost entry. That risk is real only when the server can be reached without the proxy, so the documentation
must say: prefer addresses; use a hop count only when the server cannot be reached except through the proxy.

A string or array is compiled by `proxy-addr.compile`: IPv4 and IPv6 addresses and CIDR ranges, IPv4-mapped IPv6 socket
addresses (`::ffff:203.0.113.7`) are matched against IPv4 ranges, and the names `loopback` (127.0.0.1/8, ::1/128),
`linklocal` (169.254.0.0/16, fe80::/10) and `uniquelocal` (10/8, 172.16/12, 192.168/16, fc00::/7) are expanded.
`false` gives the plain request (`request.ip` = socket address). `true` trusts every hop. No new dependency is
needed.

### 3.2 Who uses the resolved client address

Every per-address limit already reads `req.ip`; none reads the header. So once the Fastify option changes, they all
follow it with no code change:

| Consumer | Where | Keys on |
| --- | --- | --- |
| Public forms, every request and submission starts | `public-forms/routes.ts:302,314` via `clientKey` (`public-forms/limits.ts:59`) | `req.ip` |
| Offline form link | `public-forms/offline.ts:57` | `req.ip` |
| Journey webhook hooks | `journeys/hooks/route.ts:130` | `req.ip` |
| Landing-page assistant | `routes/assistant.ts:56` → `admit` → `ipHash` (`assistant/limits.ts:17`) | `req.ip` |
| Help-video proxy | `media-proxy.ts:129` `limiter.take(req.ip)` | `req.ip` |
| Login and password reset limits | `routes/auth.ts:115-184` | `req.ip` |
| `@fastify/rate-limit` (default key generator) | `app.ts:416`, `routes/integrations.ts:48` | `req.ip` |
| Blog API key IP allow list | `commands/blog-keys.ts:180` | `req.ip` |
| Session metadata, audit, log serializer | `routes/invitations.ts:35`, `routes/platform.ts:47`, `app.ts:245` | `req.ip` |

**Webhook relay**: its limit is a token bucket per integration (`webhook-relay/route.ts:154`,
`hub().takeToken(call.integrationId, ...)`), not per address. It does not read `req.ip` at all, so the setting does not
affect it and nothing changes there. The card's AC names the relay; the report records that it has no per-address key.

`request.protocol` and `request.host` also follow the trust setting (Fastify honours `X-Forwarded-Proto/Host` only
from a trusted peer). The server reads neither (only `req.hostname` in the log serializer); secure cookies come from
`AOM_PUBLIC_ORIGIN`. So the change does not affect cookies or redirects.

### 3.3 Tests are mostly unaffected by the new default

`light-my-request` (Fastify `inject`) uses `remoteAddress: '127.0.0.1'` unless a test sets another, and
`helpers/public-forms.ts` calls a real listener on `127.0.0.1`. Under the new default (trust loopback) both still
honour the `X-Forwarded-For` the tests send, so `assistant.test.ts` (separate buckets per `x-forwarded-for`),
`public-forms-ratelimit.test.ts` and the forms helpers keep passing unchanged. `relay-endpoint.test.ts` sends the header
only to check it is stripped. `media-proxy.test.ts` already sets `remoteAddress` without a header. (The planning note
expected these tests to break; they do not.)

The e2e TLS proxy (`e2e/support/tls-proxy.ts`) connects to the build on 127.0.0.1, so it is a same-host proxy and keeps
working under the default.

### 3.4 Deploy files

`docker-compose.prod.yml`: the `app` service only `expose`s 4600 (no published port); Caddy (`caddy` service) is the
only thing that reaches it, from its container address on the compose network (Docker picks the subnet from its
address pools: 172.16/12 or 192.168/16 by default, 10/8 when configured). With the new default the app would see
Caddy's address as every visitor's address. Caddy 2 (the image is `caddy:2`) replaces an `X-Forwarded-For` from a
client it does not trust (no `trusted_proxies` in `deploy/Caddyfile`), so the header that reaches the app holds exactly
the real client address.

`docker-compose.dev.yml` runs no proxy in front of the app. `docs/DEPLOY.md` only points to SELF-HOSTING.md, and
`docs/BYO-VPS.md` is about runners on a VPS; neither describes the server's proxy, so neither changes.

### 3.5 The hosted service (for GWP-138)

guildwise-cloud also runs Caddy in a separate container in front of `app:4600` (`guildwise-cloud/deploy/Caddyfile`),
and `server/src/billing/payfast.ts:228` checks that a PayFast ITN comes from a PayFast address using `req.ip`. When
the hosted build picks up this core change without setting the variable, `req.ip` becomes Caddy's address: per-address
limits collapse into one bucket and **the PayFast source check sees Caddy instead of PayFast**. GWP-138 must set the
variable in the same release in which the core submodule moves to this change. This card does not edit guildwise-cloud.

## 4. Options

### 4.1 How to apply the setting

| Option | For | Against |
| --- | --- | --- |
| A. Parse the variable in `config.ts` into a typed value; map it to Fastify's option in one small helper (boolean, address array, or `(addr, hop) => hop < n` for a hop count) | Uses Fastify's built-in trust; no new dependency; works the same on every Fastify 5.x (does not rely on the number form, which changed); testable without a database | The hop count is a custom function (one line) |
| B. Pass the number straight to Fastify | Shortest | **Broken** on 5.12.7: a number means "trust nobody" (3.1) |
| C. Our own `X-Forwarded-For` parser and a `clientIp(req)` helper used by every limit | Full control | Duplicates proxy-addr; every consumer must change; easy to miss one (and `@fastify/rate-limit`) |

**A**.

### 4.2 Value for the bundled Compose stack

| Option | For | Against |
| --- | --- | --- |
| `1` (hop count) | Works on any subnet | Does not check the peer; anyone who can reach port 4600 (another container, or an operator who publishes the port) chooses an address |
| A fixed subnet for the compose network, trusted by CIDR | Exact | Changes the network of existing installs; can clash with networks already on the host |
| `loopback,uniquelocal` (loopback plus the private ranges) | Checks the peer is private, whatever subnet Docker picked; no network change; Caddy overwrites the header, so a LAN visitor cannot add entries | Trusts any private peer (only containers on the network can reach 4600 anyway) |

**`loopback,uniquelocal`**, overridable from `.env`: `AOM_TRUST_PROXY: ${AOM_TRUST_PROXY:-loopback,uniquelocal}`. To
allow it, the variable accepts the three proxy-addr names next to addresses and CIDR ranges (a small addition to form
(c) of the card; they are only shorthands for fixed CIDR lists).

## 5. Recommendation and design

### 5.1 Variable name

**`AOM_TRUST_PROXY`**. Every server setting uses the `AOM_` prefix (`AOM_HOST`, `AOM_EXTRA_ORIGINS`, `AOM_RATE_LIMIT`);
`GUILDWISE_TRUST_PROXY` would be the only one without it. Record this name on the card and pass it to GWP-138.

### 5.2 Accepted values

Trimmed; words are case-insensitive.

| Value | Meaning | Config value |
| --- | --- | --- |
| unset or empty | Default: trust loopback only | `{ kind: 'addresses', addresses: ['127.0.0.0/8', '::1/128'], isDefault: true }` |
| `false`, `0`, `none` | Never trust `X-Forwarded-For`; client = socket address | `{ kind: 'off' }` |
| whole number 1..32 | Trust exactly N hops | `{ kind: 'hops', hops: N }` |
| comma-separated list of IPv4/IPv6 addresses, CIDR ranges, and the names `loopback`, `linklocal`, `uniquelocal` | Trust the header only from those peers (and skip trusted hops in the chain) | `{ kind: 'addresses', addresses: [...] }` (names expanded to their CIDRs, duplicates removed) |
| `true` | Trust every hop (old behaviour), warning at startup | `{ kind: 'all' }` |

Invalid, which stops the boot: anything else, including a negative or signed number (`-1`, `+2`), a number above 32, a
decimal, an entry that is not an IP address or a known name, a prefix that is not a whole number or is above 32 (IPv4)
or 128 (IPv6), a netmask form (`/255.0.0.0`), a zone id (`fe80::1%eth0`), `*`, or a list with no entries (`,`). The
list must not mix in `true`/`false`/a number.

Upper bound 32: no real chain has more hops; a bound catches typos like `1000`.

### 5.3 Files and modules

**New `apps/server/src/trust-proxy.ts`** (pure, no Fastify import needed beyond types):

```ts
import { isIP } from 'node:net';

export type TrustProxy =
  | { kind: 'off' }
  | { kind: 'all' }
  | { kind: 'hops'; hops: number }
  | { kind: 'addresses'; addresses: string[]; isDefault?: boolean };

export const TRUST_PROXY_DEFAULT: TrustProxy = {
  kind: 'addresses', addresses: ['127.0.0.0/8', '::1/128'], isDefault: true,
};

const NAMED: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const FORMS =
  'Use false (or 0, none) to never trust X-Forwarded-For, a hop count from 1 to 32, a comma-separated list of ' +
  'IP addresses or CIDR ranges (IPv4 or IPv6; the names loopback, linklocal and uniquelocal are accepted), ' +
  'or true to trust every hop (not recommended). Unset trusts loopback only.';

/** Parses AOM_TRUST_PROXY; throws an Error naming the variable and the accepted forms. Never falls back to trusting all. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? '').trim();
  if (!v) return TRUST_PROXY_DEFAULT;
  const bad = (why: string): never => {
    throw new Error(`AOM_TRUST_PROXY: "${v}" ${why}. ${FORMS}`);
  };
  const lower = v.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'none') return { kind: 'off' };
  if (lower === 'true') return { kind: 'all' };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n < 1 || n > 32) bad('is out of range for a hop count');
    return { kind: 'hops', hops: n };
  }
  const out: string[] = [];
  for (const part of v.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const named = NAMED[p.toLowerCase()];
    if (named) { for (const c of named) if (!out.includes(c)) out.push(c); continue; }
    const [addr, prefix, extra] = p.split('/');
    const family = addr && !addr.includes('%') ? isIP(addr) : 0;
    if (!family || extra !== undefined) bad(`has an entry that is not an IP address or CIDR range: "${p}"`);
    if (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
      bad(`has an invalid CIDR prefix: "${p}"`);
    const norm = prefix === undefined ? addr : `${addr}/${Number(prefix)}`;
    if (!out.includes(norm)) out.push(norm);
  }
  if (!out.length) bad('has no address in it');
  return { kind: 'addresses', addresses: out };
}

/** What to pass as Fastify's `trustProxy`. A hop count is a function: Fastify 5.12+ treats a number as "trust nobody". */
export function fastifyTrustProxy(t: TrustProxy): boolean | string[] | ((addr: string, hop: number) => boolean) {
  switch (t.kind) {
    case 'off': return false;
    case 'all': return true;
    case 'hops': { const n = t.hops; return (_addr, hop) => hop < n; }
    case 'addresses': return [...t.addresses];
  }
}

/** One line for the startup log: what is trusted. */
export function describeTrustProxy(t: TrustProxy): string { /* "loopback only (default)", "2 hops", ... */ }
```

The snippet shows intent; the builder owns the final code. Note: a value such as `1.2.3.4` must not hit the `^\d+$`
branch (it does not, it contains dots), and `0` is "off", not a hop count.

**`apps/server/src/config.ts`**

- `EnvSchema`: `AOM_TRUST_PROXY: z.string().optional()` (no zod coercion: the parser owns validation, so the message is
  the plain one, as for `AOM_SECRET_KEY`).
- `Config`: `trustProxy: TrustProxy` with a doc comment naming `AOM_TRUST_PROXY`.
- `loadConfig`: `trustProxy: parseTrustProxy(e.AOM_TRUST_PROXY)`. The thrown Error stops `startServer` before anything
  listens (same path as the `AOM_SECRET_KEY` check at line 408), for `main.ts`, `start.ts` and `video-worker.ts`, all of
  which go through `loadConfig`.

**`apps/server/src/app.ts`** (`createApp`)

- Replace `trustProxy: true` with `trustProxy: fastifyTrustProxy(config.trustProxy)`.
- Right after the Fastify instance exists:
  - `config.trustProxy.kind === 'all'` → `app.log.warn(...)`: "AOM_TRUST_PROXY=true: every X-Forwarded-For hop is
    trusted, so a client that reaches the server without the proxy can choose its own address and get past the
    per-address limits. Set the proxy's address or a hop count instead (docs/SELF-HOSTING.md, Running behind a reverse
    proxy)."
  - Otherwise one `app.log.info({ trustProxy: describeTrustProxy(...) }, 'trusted proxy')` line (helps the manual
    check; optional).
- Keep `AomApp` typing as is (the cast already covers the options).

**`apps/server/src/video/push.ts`** (`startPushServer`)

- Replace `trustProxy: true` with `trustProxy: fastifyTrustProxy(ctx.config.trustProxy)`. The push server reads no
  client address, so behaviour does not change, but no hard-coded `true` remains. No warning here (the worker's
  `createApp` already logs it).

**No change** in the limit modules (`public-forms/limits.ts`, `assistant/limits.ts`, `media-proxy.ts`,
`journeys/hooks/route.ts`, `webhook-relay/*`): they already key on `req.ip` (3.2). No threshold changes.

**Deploy**

- `docker-compose.prod.yml`, service `app`, `environment`:
  ```yaml
  # Caddy reaches the app from its container address on the compose network: trust the header only from private
  # addresses (docs/SELF-HOSTING.md "Running behind a reverse proxy").
  AOM_TRUST_PROXY: ${AOM_TRUST_PROXY:-loopback,uniquelocal}
  ```
  Same line on `video-worker` (Caddy also proxies `/api/worker/video/*` to it; keeps the two consistent).
- `.env.prod.example`: a commented `# AOM_TRUST_PROXY=loopback,uniquelocal` with one line on when to change it.
- `deploy/Caddyfile`: no change (no `trusted_proxies`, so Caddy writes the real client address). Add one comment line
  near `reverse_proxy app:4600` saying the app trusts the header from private addresses through `AOM_TRUST_PROXY`, and
  that adding `trusted_proxies` here (for a CDN in front) needs the matching setting there.

**Docs**

- `docs/SELF-HOSTING.md`:
  - Section 4, "Advanced" table: row `AOM_TRUST_PROXY` | `loopback only` (Compose file: `loopback,uniquelocal`) |
    "Which proxies may set `X-Forwarded-For`. See Running behind a reverse proxy."
  - Section 7 "HTTPS and domains": new subsection `### Running behind a reverse proxy` with: what the setting decides
    (the client address used by every per-address limit, login limits, blog key allow lists, logs); the default;
    a table of each form with an example:
    - same-host Caddy or nginx (proxy on 127.0.0.1 or ::1): leave unset;
    - the bundled Compose stack: `loopback,uniquelocal` (already set in the file);
    - Compose with your own proxy container: that container's network address or CIDR (`172.18.0.0/16`), or `1`;
    - CDN in front of your proxy: the proxy's address plus the CDN's published ranges, or a hop count of `2`;
    - never trust (server reached directly, no proxy): `false`;
    - `true`: old behaviour, with the **warning** that on a server reachable without a proxy it lets clients choose
      their own address and get past per-address rate limits; the server logs a warning at startup.
    - Note that a hop count does not check who the peer is: use it only when the server cannot be reached except
      through the proxy; prefer addresses.
    - What an invalid value does (the server does not start, the message names the variable).
  - Section 10 "Public forms", line 400: replace with "The per-address limits use the client address the server
    resolves; behind a proxy in another container or host, set `AOM_TRUST_PROXY` (Running behind a reverse proxy)."
- `docs/security/public-forms.md`: T19 mitigation becomes "`AOM_TRUST_PROXY` (default loopback only): the header is
  honoured only from configured proxies or hop count; the per-form limit does not depend on the address", tests
  `trust-proxy.test.ts` and the rate-limit regression; remove the follow-up line "A configurable proxy hop count ..."
  from Residual risks.
- `CHANGELOG.md` `[Unreleased]`: a `### Security` entry: "The server no longer trusts every `X-Forwarded-For` hop. New
  `AOM_TRUST_PROXY` (unset: loopback only; `false`/`0`/`none`; a hop count; a list of addresses/CIDR ranges; `true` with a
  startup warning). **Default changed**: before, any client could set its own address. Same-host proxies keep working;
  a proxy on another host or container needs the setting (the bundled Compose file sets `loopback,uniquelocal`). An
  invalid value stops the server at startup." Also mention the new variable in the release's variable list when the
  version heading is written.

### 5.4 Risks

| Risk | Mitigation |
| --- | --- |
| Installs with their own proxy container or another host collapse every visitor into the proxy's address after the upgrade (limits trigger for everyone; blog key allow lists stop matching) | CHANGELOG under Security with "default changed"; SELF-HOSTING section; the startup info line shows what is trusted; bundled Compose file already set |
| Hosted service (PayFast source check, limits) | GWP-138 sets the variable in the same release as the submodule bump (3.5) |
| A builder passes a number to Fastify | The helper maps hops to a function; a test with hop count 1 and 2 catches it (a number would return the socket address) |
| Hop count lets a direct client choose the rightmost entry | Documented; addresses recommended; the bundled stack uses addresses |
| `true` set by habit | Startup warning; documented |
| `X-Forwarded-Proto/Host` trusted from any peer with a hop count | The server reads neither (3.2) |

### 5.5 Tests (apps/server/test)

**`trust-proxy.test.ts`** (new, no database):

1. `parseTrustProxy`: unset and `''` → default (loopback CIDRs); `false`, `FALSE`, `0`, `none` → off; `1`, `2`, `32` →
   hops; `true` → all; `10.0.0.5`; `10.0.0.0/8`; `::1`; `fd00::/8`; mixed `10.0.0.0/8, 2001:db8::1 ,192.168.1.1`
   (trimmed); `loopback,uniquelocal` expanded; duplicates removed. Also via `loadConfig({ ...env, AOM_TRUST_PROXY })`.
2. Invalid, each throws a message containing `AOM_TRUST_PROXY` and `hop count`: `-1`, `+2`, `33`, `1.5`, `abc`,
   `10.0.0.0/33`, `::1/129`, `10.0.0.0/255.0.0.0`, `fe80::1%eth0`, `*`, `,`, `10.0.0.1,true`.
3. Resolution, a bare `Fastify({ trustProxy: fastifyTrustProxy(t) })` with a route that returns `req.ip`, called with
   `inject({ remoteAddress, headers: { 'x-forwarded-for': ... } })`:
   - default, `remoteAddress: '203.0.113.7'`, XFF `198.51.100.1` → `203.0.113.7`;
   - default, `127.0.0.1` and `::1`, XFF `198.51.100.1` → `198.51.100.1`; also `::ffff:127.0.0.1`;
   - hops 1, socket `10.0.0.2`, XFF `6.6.6.6, 198.51.100.1` → `198.51.100.1`; hops 2, XFF `6.6.6.6, 198.51.100.1, 10.0.0.3`
     → `198.51.100.1`;
   - list `10.0.0.0/8`: socket `10.1.2.3` → forwarded; socket `203.0.113.7` → socket; IPv6 list `fd00::/8`: socket `fd00::5`
     → forwarded, `2001:db8::5` → socket; IPv4 list with an IPv4-mapped socket `::ffff:10.1.2.3` → forwarded;
   - off, socket `127.0.0.1`, XFF set → `127.0.0.1`;
   - all, socket `203.0.113.7`, XFF `198.51.100.1` → `198.51.100.1`.
4. Warning: `createApp` with `AOM_TRUST_PROXY=true` and a `logStream` writes a `warn` line naming `AOM_TRUST_PROXY`; the
   default writes no such warning. This uses `createTestApp({ env, logStream })` (needs Postgres; if the builder prefers
   no database, extract the warning into a function `trustProxyWarning(config)` and test that, plus one createTestApp
   case).

**Rate-limit regression** (existing suites, Postgres on 5433):

- `public-forms-ratelimit.test.ts`: default config, `inject` with `remoteAddress: '203.0.113.7'` and a different
  `x-forwarded-for` on each request to a public form route, more requests than `AOM_FORMS_IP_BURST` (set it low in the
  test env, as the suite does) → a 429 arrives. Same from `127.0.0.1` with distinct XFF values → separate buckets, no 429.
  (The helper's real listener is on 127.0.0.1 and cannot fake a remote socket, so use `inject` for this case, or add a
  `remoteAddress` option where the helper already supports `inject`.)
- `assistant.test.ts`: `ask()` gains an optional `remoteAddress`; default config, `remoteAddress: '203.0.113.7'`,
  rotating XFF, more than `LIMITS.perHour` messages → refused. Existing cases stay as they are (loopback socket).
- `media-proxy.test.ts`: the existing `remoteAddress: '9.9.9.9'` case plus rotating XFF still hits the limit.
- Journey hook (`journeys/hooks`): one case like the forms one if its suite allows it cheaply.
- Run the existing suites unchanged (`public-forms-limits.test.ts`, `relay-endpoint.test.ts`, `extra-origins.test.ts`)
  and the whole server suite.

Manual check (testers): Compose stack with defaults: the startup log shows the trusted setting, and a request through
Caddy is limited and logged under the real client address; `AOM_TRUST_PROXY=true` logs the warning;
`AOM_TRUST_PROXY=abc` stops the app with the message.

### 5.6 Acceptance criteria mapping

| AC | Design |
| --- | --- |
| release/1.6.0 check recorded | Section 2; posted on the card |
| No hard-coded `trustProxy: true`; value from config | 5.3 `app.ts` and `push.ts` via `config.trustProxy` |
| Unset, non-loopback socket with forged XFF → socket address | Default = loopback list; test 3 |
| Unset, 127.0.0.1 / ::1 with XFF → client | Default list; test 3 |
| Hop count N → N hops back, spoofed left entries ignored | `hop < N` function; test 3 (1 and 2 hops) |
| Address/CIDR list, IPv4 and IPv6 | Array to proxy-addr; test 3 |
| `false`/`0` never honoured, even from loopback | `kind: 'off'` → `false`; test 3 |
| `true` → old behaviour + startup warning | `kind: 'all'` → `true`, `app.log.warn`; tests 3 and 4 |
| Invalid value stops startup, names variable and forms | `parseTrustProxy` throws in `loadConfig`; test 2 |
| Forms, assistant, relay, media limits key on resolved IP; rotating XFF on a direct server still limited | All use `req.ip` (3.2); relay is per integration, not per address; regression tests 5.5 |
| SELF-HOSTING.md section, CHANGELOG default change | 5.3 Docs |
| Deploy files set the variable | `docker-compose.prod.yml` (app, video-worker), `.env.prod.example` |
