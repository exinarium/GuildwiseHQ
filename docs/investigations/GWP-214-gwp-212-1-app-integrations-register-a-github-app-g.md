# GWP-214: App integrations (GitHub App first): workspace registration, sealed key, automatic installation tokens

Status: design, ready to build. Group `gwp-212-github-app`: this card comes first. GWP-215 (per-project "post as" choice and
fallback), GWP-216 (shifts act as the app) and GWP-217 (ticket posts as the app) use the token broker and the org-level
registry built here.

## 1. The question

An organization Owner wants to register an automated app (a GitHub App for now; GitLab, Bitbucket and Azure DevOps bot apps
later). Agents will later act as that app. This card covers:

- where the app's private key lives when several workstations run shifts for the same organization;
- how the server knows about the app without ever holding the key;
- how installation tokens are minted, cached and refreshed with no manual re-authentication;
- how all of this fits the integration registry and the adapter list that already exist;
- a provider interface with no GitHub types in it.

## 2. Findings (what exists today)

| Area | What is there | What it means for this card |
|---|---|---|
| Integration registry | `packages/shared/src/integrations/registry.ts` (one entry per kind) and `schema.ts` (`INTEGRATION_KIND_IDS`, `IntegrationStatusSchema`) | A new kind `github-app` gets one registry entry. The workstation Integrations page then lists it with no new screen (design D1 in `docs/design/integrations-page.md`). |
| Runner adapters | `apps/runner/src/integrations/index.ts` `buildIntegrationAdapters`, `types.ts` `IntegrationAdapter` / `AdapterEnv`, `headless.ts` (CLI uses the same adapters) | The app adapter is added to this list. The CLI and the runner share one `connect()`. |
| Closest model | `integrations/google-sheets.ts` and `outbound-delivery/google-sheets.ts`: a service-account PEM sealed in `secrets/google-sheets.json`, an RS256 JWT signed with `createSign`, a token cache in memory, and one retry on a 401 with a cached token | The same shape as a GitHub App. The JWT signing, sealed store and retry logic can follow it closely. |
| Sealed storage | `secrets/sealed-file.ts` `SealedFile<T>` (AES-256-GCM, key derived from the runner key, file mode 0600, `secretsOf` registers values for redaction on load and save) and `forge/tokens.ts` `FileTokenStore` | The private key goes into a new `SealedFile`. Tokens are never put in it. |
| Redaction | `secrets/redact.ts` `registerSecret` / `redact` (logger, executor, audit log, integration service) and `redactSecrets` (registry plus patterns, including PEM blocks and `ghs_` tokens) | **Gap:** the Claude stream parser (`adapters/claude-stream-parser.ts`) imports `apps/runner/src/redact.ts`. That `redactSecrets` uses patterns only: it does not consult the registry and has no PEM pattern. A registered secret is therefore not masked in Claude activity summaries unless it happens to match a pattern. Fixed here (section 6.6). |
| Browser to runner secrets | `sealForRunner` / `apps/web/src/lib/runner-seal.ts` `sealIntegration`: a hybrid RSA-OAEP + AES-GCM envelope with AAD bound to workstation, ref, kind, instance and op; `RunnerKeys.open` and the `ReplayCache` on the runner | The PEM is sealed in the browser for each target workstation. The server relays only ciphertext. |
| Org-wide secret on many workstations | Org provider keys (`commands/org-provider-keys.ts`, ARCHITECTURE section 38.5): the Owner or an Admin seals the key in the browser to each target workstation, the server keeps the ciphertext only until the runner stores it, and revoke clears it everywhere. `targetWorkstations` lists the workstations that serve the organization, with their key id and capability. | **This is the distribution model to reuse** for "several workstations run shifts for the same project". |
| Org-level metadata, credential on the runner | Storage connections (ARCHITECTURE section 42, migration 2810): events plus a projection with metadata only, a short-lived `storage_requests` table polled by the page, a durable `storage.remove`, and `storage.sync` after `welcome` so a removal made while the runner was offline still deletes the token | The same request / poll / sync pattern is used here. |
| Per-workstation status | `integrations.report` goes into `workstation_integrations` (migration 1870; kept over a projection rebuild) | Per-workstation health of an app comes free. The org page joins on `(kind='github-app', instance)`. |
| Roles | `isOrgOwner` in `packages/shared/src/authz/index.ts`, `orgRoleOf` in `auth/org-context.ts` | The card says **Owner only**, not Admin. Use `isOrgOwner`. |
| Commit identity | `commands/commit-as.ts` (project `commit_as`) | This card only resolves and stores the bot identity. Using it is GWP-215 and GWP-216. |

GitHub API facts the design relies on (GitHub docs, REST API version `2022-11-28`):

- **App JWT:**
  - RS256; `iss` = App ID or client ID (both accepted);
  - `iat` = now − 60 s; `exp` no more than 10 minutes after `iat` (the token is refused otherwise);
  - a skewed clock gets `401` with a message about `exp` or `iat`.
- **App and installation calls:**
  - `GET /app`: id, slug, name, owner;
  - `GET /app/installations`: id, `account.login`, `account.type`, `repository_selection`, `permissions`, `suspended_at`;
  - `GET /app/installations/{id}`: `404` when the app is uninstalled. A suspended installation has `suspended_at` set, and minting a token for it gives `403`.
- **Minting:** `POST /app/installations/{id}/access_tokens` with optional `repositories` (names) and optional `permissions` (each one no more than the installation grants). Answer `201`: `{ token: "ghs_…", expires_at }`. The token lives 1 hour.
- **Bot user:**
  - `GET /users/{slug}[bot]` gives `{ login: "<slug>[bot]", id }`;
  - commit e-mail: `<id>+<slug>[bot]@users.noreply.github.com`;
  - on GitHub Enterprise Server, `users.noreply.<host>`;
  - API base: `https://api.github.com`, or `https://<host>/api/v3` on GHES.
- **Private keys:** GitHub hands out PKCS#1 PEM files (`BEGIN RSA PRIVATE KEY`). `crypto.createPrivateKey` reads both PKCS#1 and PKCS#8.

## 3. Options for where the key lives

| | A. Each workstation's user connects it locally (like forge tokens) | B. The Owner seals it in the browser to each chosen workstation (like org provider keys) | C. The server holds it encrypted for the organization |
|---|---|---|---|
| Server never holds the key | yes | yes (ciphertext in transit only, emptied on result) | **no**: breaks standing order 1800e58c and the card |
| Org-level registration by the Owner only | weak: every workstation user must type the key, including members | yes: one dialog, the Owner picks the workstations | yes |
| Shifts on several workstations | yes, if every user connects it | yes | yes |
| Headless machines | CLI | CLI as well (section 6.8), plus the web | n/a |
| Code reuse | adapter only | adapter, `sealIntegration`, `targetWorkstations`, the storage request pattern | new |

**Decision D1: B, with A as the headless path.**

- The Owner registers the app once on Settings > Automated apps and picks the workstations that serve the organization (their own, plus members' workstations they choose).
- The browser seals the PEM separately for each picked workstation.
- Each runner verifies the key with GitHub before it stores it.
- A workstation added later gets the key entered again: no runner-to-runner reseal in this card. A backlog suggestion for it is filed.
- On a headless workstation the Owner can run `guildwise-runner apps connect` (section 6.8). They then "adopt" that copy on the org page.

Least privilege note for the Owner, shown in the dialog: anyone who controls a workstation that holds the key can act as the app. Pick only workstations you trust with that.

## 4. Design overview

```
Browser (Owner) ──seal PEM per workstation──▶ Server (metadata, ciphertext in transit) ──app.connect──▶ Runner
                                                 ▲                                                     │ verify: JWT, GET /app,
                                                 │ command.result: identity (no secrets)               │ installation, mint, bot user
                                                 └─────────────────────────────────────────────────────┘ store PEM sealed
Runner: AppKeyStore (sealed PEM) ─▶ AutomatedAppProvider (GitHubAppProvider) ─▶ AppTokenBroker (memory cache, single-flight,
        refresh at < 10 min left, 401 re-mint once) ─▶ consumers in GWP-216 / GWP-217 (git, forge API, external posts)
integrations.report ─▶ workstation_integrations ─▶ org page shows status per workstation (state, last refresh, last error)
```

## 5. Shared (`packages/shared`)

### 5.1 New module `packages/shared/src/apps/index.ts` (exported from the package index)

Generic types only. Nothing in this module names GitHub, except the id `'github-app'` in the provider list.

```ts
export const APP_PROVIDER_IDS = ['github-app'] as const;            // later: 'gitlab-app', 'bitbucket-app', 'azure-devops-app'
export type AppProviderId = (typeof APP_PROVIDER_IDS)[number];
export const APP_INTEGRATIONS_CAPABILITY = 'app-integrations:1';    // runner announces it in hello capabilities

/** The canonical runner instance of an app integration: one installation of one app. */
export const appInstance = (appId: string, installationId: string) => `${appId}:${installationId}`;
export function parseAppInstance(i: string): { appId: string; installationId: string } | null;

export const AppPermissionLevelSchema = z.enum(['read', 'write']);
export const AppPermissionsSchema = z.record(z.string().regex(/^[a-z_]{1,40}$/), AppPermissionLevelSchema);
/** Least privilege default (card constraints). `workflows` only when a project opts in (GWP-215/216). */
export const DEFAULT_APP_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' } as const;

/** The non-secret facts a runner returns after a verify. Strict: an unknown key (a token) is a parse failure. */
export const AppIdentitySchema = z.object({
  provider: z.enum(APP_PROVIDER_IDS),
  host: z.string().max(200),                // 'github.com' or a GHES host
  appId: z.string().max(40), appSlug: z.string().max(100), appName: z.string().max(200),
  installationId: z.string().max(40),
  account: z.string().max(200),             // installation target (org or user login)
  accountType: z.string().max(40).optional(),
  repositorySelection: z.enum(['all', 'selected']).optional(),
  botLogin: z.string().max(140), botUserId: z.string().max(40),
  commitName: z.string().max(140), commitEmail: z.string().max(254),
  permissions: AppPermissionsSchema,        // what the installation grants
  missingPermissions: z.array(z.string().max(40)).max(20),   // DEFAULT_APP_PERMISSIONS it does not grant
}).strict();

export const APP_ERROR_CODES = ['key_invalid','jwt_rejected','clock_skew','app_not_found','installation_not_found',
  'installation_suspended','choose_installation','permission_missing','token_rejected','repository_not_accessible',
  'rate_limited','unreachable','app_mismatch','runner_too_old','unexpected'] as const;
export const APP_ERROR_TEXT: Record<AppErrorCode, string>;   // one sentence each, never a value

/** `command.result` of app.connect / app.test. Strict. */
export const AppCommandResultSchema = z.object({
  ok: z.boolean(),
  instance: z.string().max(200).optional(),
  identity: AppIdentitySchema.optional(),
  code: z.enum(APP_ERROR_CODES).optional(),
  message: z.string().max(300).optional(),
  installations: z.array(z.object({ id: z.string().max(40), account: z.string().max(200),
    accountType: z.string().max(40).optional(), suspended: z.boolean() }).strict()).max(100).optional(),
}).strict();
```

The API DTOs and requests go in the same module:

- **`OrgAppDto`:**
  - id, provider, label, host, appId, appSlug, appName, installationId, account, botLogin, commitName, commitEmail, permissions, missingPermissions, createdAt;
  - `state: 'connected' | 'error' | 'pending'`, computed from the workstation rows;
  - `workstations: Array<{ id, name, ownerName, state, refreshedAt?, errorCode?, message?, checkedAt? }>`.
- **`OrgAppsResponse`:** `{ apps, canManage, targets?, serverTime }`. `targets` is returned to the Owner only: `{ id, name, ownerName, keyId, publicKey, online, supported }`.
- **`AddOrgAppRequest`:** `{ requestId, provider, label, host, appRef, installationId?, shares: [{ workstationId, ref, keyId, envelope }] }`, `.strict()`.
- **`ShareOrgAppRequest`:** `{ requestId, shares }`.
- **`RenameOrgAppRequest`:** `{ label }`.
- **`AdoptOrgAppRequest`:** `{ requestId, workstationId, instance, label }`.
- **`OrgAppRequestDto`:** `{ id, state: 'pending'|'needs_choice'|'done'|'failed'|'expired', appId?, installations?, results: [{ workstationId, ok, code?, message? }] }`.

### 5.2 Integration kind and status (`integrations/schema.ts`, `registry.ts`)

Schema changes (all additive):
- Add `'github-app'` to `INTEGRATION_KIND_IDS`.
- Add to `IntegrationStatusSchema`: `refreshedAt: z.iso.datetime().optional()` (last successful mint) and `errorCode: z.string().max(40).optional()`.
- Add `'installation'` to the registry's `instances.by` union. The web reads `by` only for `'account'`, so this is safe.

The registry entry (group `git`):

| Field | Value |
|---|---|
| `id` / label | `github-app` / `GitHub App` |
| `instances` | `{ by: 'installation', label: 'App and installation', placeholder: '123456:7890123' }` |
| `scope` | `'workstation'` |
| `methods` | one method, `app_key`, label "App private key", **`flow: 'local_only'`**, with steps. On the workstation page the tile shows status and the CLI line only; connecting is done on Settings > Automated apps (D2). |
| `scopes` | the permissions to grant: Contents read/write, Pull requests read/write, Issues read/write, Metadata read (required); Workflows write (optional, off) |
| `test` | `{ label: 'Check the app with GitHub', what: 'Signs an app JWT, reads the installation and mints a short-lived token.' }` |
| `storage` | `"secrets/app-integrations.json, encrypted (AES-256-GCM) with this runner's key, this workstation only. Tokens are kept in memory only."` |
| `cli` | `'guildwise-runner apps connect github --app-id <id> --installation <id> --key-file <path>'` |
| `minRunner` | the next runner version (see 6.9) |
| `minIntegrationsVersion` | 1 |

**D2. App keys are not connected through the generic `integration.connect` path.**

- That path is the workstation user's (design D4: the workstation's own user only). The card makes the app an organization object, managed by the Owner only.
- Because the method is `local_only`, `checkIntegrationRequest` already refuses a web connect for this kind.
- The server's `POST /api/workstations/:id/integrations/test|remove` refuse `kind === 'github-app'` with `403 manage_in_org` ("Manage this app in Settings > Automated apps").
- The tile shows a link there instead of Test and Remove.

### 5.3 Events (`packages/shared/src/events/apps.ts`, registered in the events index)

All events go on stream `streamId.appIntegration(id)` (new helper), with `orgScope(orgId)` and actor = user. None of them carries a key, token, envelope or JWT.

| Event | Payload |
|---|---|
| `OrgAppIntegrationAdded` | integrationId, orgId, label, plus every `AppIdentity` field, `by` |
| `OrgAppIntegrationUpdated` | integrationId, `label?`, `identity?` (only when a later verify returned changed facts: renamed slug, new permissions), `by` |
| `OrgAppIntegrationShared` | integrationId, workstationId, `via: 'browser' \| 'adopted'`, `by` (emitted when that runner verified and stored it) |
| `OrgAppIntegrationUnshared` | integrationId, workstationId, `by` |
| `OrgAppIntegrationRemoved` | integrationId, `by` (GWP-215 projects its fallback from this event) |

## 6. Runner (`apps/runner`)

### 6.1 Provider interface: `apps/runner/src/apps/types.ts` (new folder `apps/`)

```ts
export interface AppAccessScope { repositories?: string[]; permissions?: Record<string, 'read' | 'write'> }
/** Runner-only: never serialized to the server, never logged, never written to disk. */
export interface AppAccessToken { token: string; expiresAt: number /* epoch ms */ }
export type AppIdentity = z.infer<typeof AppIdentitySchema>;     // from shared: facts only

export class AppTokenError extends Error {
  constructor(readonly code: AppErrorCode, message: string, readonly opts: { status?: number; retryAfterMs?: number } = {}) { super(message); }
}

/** One installation of one automated app. GitHub App is the only implementation now. */
export interface AutomatedAppProvider {
  readonly provider: AppProviderId;
  /** The identity from the last verify (stored with the key); no network. */
  describe(): AppIdentity;
  /** Light health check: JWT + read the installation (no token minted). Throws AppTokenError. */
  status(): Promise<{ suspended: boolean }>;
  /** Full check used on save and Test: JWT, app, installation, one least-privilege token, bot user. */
  verify(): Promise<AppIdentity>;
  /** Mints a new token for the scope. No caching here: the broker caches. Throws AppTokenError. */
  mint(scope: AppAccessScope): Promise<AppAccessToken>;
}

export interface AppProviderFactory {
  provider: AppProviderId;
  create(cfg: StoredApp, deps: { fetch: typeof fetch; now: () => number }): AutomatedAppProvider;
  /** Before anything is stored: discover installations when none was given. */
  installations(input: AppConnectInput, deps): Promise<Array<{ id: string; account: string; accountType?: string; suspended: boolean }>>;
}
export const APP_PROVIDERS: Record<AppProviderId, AppProviderFactory>;   // apps/runner/src/apps/providers.ts
```

The signatures use only `AppAccessScope`, `AppAccessToken`, `AppIdentity` and `AppTokenError`, so the "no GitHub types" acceptance criterion holds. GitHub API shapes stay private to `github-app.ts`.

### 6.2 GitHub App: `apps/runner/src/apps/github-app.ts`

**`signAppJwt(appRef, privateKey: KeyObject, nowSec)`:**
- header `{ alg: 'RS256', typ: 'JWT' }`;
- claims `{ iat: nowSec - 60, exp: nowSec + 540, iss: appRef }`, so `exp − iat` = 600 s, the most GitHub allows;
- signed with `createSign('RSA-SHA256')`, as in `outbound-delivery/google-sheets.ts`;
- a numeric `appRef` goes into `iss` as a number, a client ID as a string.

**Key parsing:**
- `createPrivateKey(pem)`;
- refuse with `key_invalid` unless `asymmetricKeyType === 'rsa'` and the modulus is at least 2048 bits;
- the message never quotes the key.

**HTTP:**
- `apiBase(host)`: `https://api.github.com` for `github.com`, otherwise `https://<host>/api/v3`;
- headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: guildwise-runner`;
- `AbortSignal.timeout(15_000)`;
- injected `fetch` and `now`.

**Clock skew:**
- On a `401` from a JWT call whose message mentions `exp` or `iat`, read the response `Date` header and keep `skewMs` on the provider instance.
- Re-sign once with the corrected time.
- If it fails again, throw `clock_skew` ("This workstation's clock is off by about N minutes; fix the system time").

**Error classification** (one function, unit-tested from recorded responses):

| Response | Code |
|---|---|
| JWT call `401` "could not be decoded" or bad signature | `jwt_rejected` ("GitHub refused the app key or App ID: check both, or generate a new private key") |
| `GET /app` `404` | `app_not_found` |
| installation `404` | `installation_not_found` ("The app is not installed there any more") |
| `suspended_at` set, or `403` on mint with "suspended" | `installation_suspended` |
| mint `422` or `403` asking for a permission or repository the installation lacks | `permission_missing` / `repository_not_accessible` |
| `403`/`429` with `x-ratelimit-remaining: 0` or `retry-after` | `rate_limited` (with `retryAfterMs`) |
| network error or 5xx | `unreachable` |
| anything else | `unexpected` |

All messages pass through `redact()`. They never include the response body, only GitHub's `message` field, cut to 160 characters.

**`verify()`:**
1. `GET /app`: id, slug, name.
2. `GET /app/installations/{id}`: account, type, `repository_selection`, permissions, suspended.
3. `mint({ permissions: { metadata: 'read' } })`: the least-privilege test token.
4. `GET /users/{slug}%5Bbot%5D` with that token: the bot `id`.
5. Derive `commitName = "<slug>[bot]"` and `commitEmail = "<id>+<slug>[bot]@users.noreply.<github.com|host>"`.
6. `missingPermissions` = the keys of `DEFAULT_APP_PERMISSIONS` the installation does not grant at the needed level. This is a warning on the page, not a failure.
7. The test token is registered for redaction and dropped. It is not cached.

**`installations()`:**
- `GET /app/installations` (first 100).
- Used by `connect` when no installation was given: exactly one, it is used; several, the result is `choose_installation` with the list; none, `installation_not_found`.

### 6.3 Key store: `apps/runner/src/apps/store.ts`

`AppKeyStore` wraps `SealedFile<AppSecrets>` at `secrets/app-integrations.json`:

```ts
interface StoredApp {
  provider: AppProviderId; host: string; appRef: string; appId: string; installationId: string;
  privateKey: string;                 // PEM, the only secret
  identity: AppIdentity;              // from the last verify
  /** Which org registrations use this copy; `local`: connected from the CLI (kept until removed locally or adopted+removed). */
  refs: Array<{ orgId: string; integrationId: string }>; local: boolean;
  savedAt: string;
}
type AppSecrets = { apps: Record<string /* instance */, StoredApp> };
```

- **`secretsOf`** returns, for each app:
  - the full PEM;
  - the PEM body joined into one line;
  - each base64 body line of 16 or more characters.

  So a partial echo of the key (a parse error that prints one line) is masked as well. This is the existing `SealedFile` hook, so registration happens on every load and save.
- **API:**
  - `get(instance)`, `list()` (without `privateKey`), `put(instance, app)`, `addRef`, `dropRef`;
  - `remove(instance)`: deletes the entry and calls `unregisterSecret` for its values. The file itself is removed when the last entry goes.
- An unreadable file is moved aside with `quarantine()` before it is overwritten, the same rule as `FileTokenStore.write`.

### 6.4 Token broker: `apps/runner/src/apps/broker.ts`

```ts
export class AppTokenBroker {
  constructor(deps: { store: AppKeyStore; fetch: typeof fetch; now: () => number; providers?: typeof APP_PROVIDERS;
                      onChange?: (instance: string) => void /* triggers integrations.report */ });
  /** A token with more than 10 minutes left, from memory or freshly minted. Single-flight per cache key. */
  getAccessToken(instance: string, scope?: AppAccessScope): Promise<AppAccessToken>;
  /** Runs `fn` with a token; on a 401-like answer (fn returns { status: 401 } or throws AppTokenError 'token_rejected')
   *  invalidates that key, mints once more and retries once. A second failure throws AppTokenError('token_rejected'). */
  withToken<T>(instance: string, scope: AppAccessScope | undefined, fn: (t: string) => Promise<T & { status?: number }>): Promise<T>;
  identity(instance: string): AppIdentity | undefined;
  health(instance: string): { refreshedAt?: number; error?: { code: AppErrorCode; message: string; at: number } };
  invalidate(instance: string): void;     // remove, key replaced: drops cache entries and unregisters their tokens
}
```

**Cache:**
- A `Map` keyed by `instance + '|' + canonical(scope)`; repositories and permission keys are sorted, so the same scope always gives the same key.
- Memory only. Nothing in the broker imports `fs`; a test proves no file holds the token (section 9).

**Freshness:** `REFRESH_MARGIN_MS = 10 * 60_000`. A cached token is returned while `expiresAt − now() > REFRESH_MARGIN_MS`; otherwise a new one is minted. With the 1-hour lifetime that means a caller at minute 49 gets the cached token and a caller at minute 55 gets a new one.

**Single-flight:**
- `inflight: Map<key, Promise<AppAccessToken>>`.
- Concurrent callers await the same promise. It is deleted in `finally`.
- A failed mint is not cached: the next caller retries.
- A `rate_limited` failure is remembered until its `retryAfterMs` has passed, so callers do not hammer GitHub.

**Redaction:**
- Each minted token is registered with `registerSecret` as soon as it is received.
- When an entry is replaced or invalidated, the old token is unregistered 5 minutes later. A log line written just after a refresh is still masked, and the registry does not grow without bound.

**Health:** every mint success sets `refreshedAt`. Every failure sets `error { code, message }` and calls `onChange`, which triggers `integrations.report`. The status therefore turns to error without waiting for the 10-minute rescan.

**Long shifts:** refresh is on demand. Every consumer asks the broker for each operation (GWP-216 plugs a git credential helper and the forge client into `getAccessToken`), so a shift that runs for hours always gets a token with at least 10 minutes left. No timer is needed. The key itself never expires, so no human ever re-authenticates while the key is valid.

**Construction:** one broker per runner process. It is created in `runner.ts` next to the other stores and passed as `AdapterEnv.apps?: AppTokenBroker`, which is optional like `sealKey`. `headless.ts` builds its own broker for the CLI.

### 6.5 Integration adapter: `apps/runner/src/integrations/automated-app.ts`

`AutomatedAppIntegration implements IntegrationAdapter` is generic. `buildIntegrationAdapters` gets one more line: `new AutomatedAppIntegration('github-app', env)`. Another provider later is one more line here plus one factory in `APP_PROVIDERS`.

**`scopeOf()`:** `'workstation'`.

**`instances()`:** the store's keys whose provider matches.

**`status(instance)`:**
- Runs `provider.status()`, cached for 5 minutes, and merges in `broker.health()`.
- Healthy: `connected`, with `method 'app_key'`, `account = botLogin`, `site = account`, `savedAt`, `refreshedAt`, and `missingScopes = missingPermissions`.
- Failure: `refused` (key, app, installation, permission or token codes), or `unreachable` (network or rate limit), with `errorCode` and `detail` = `APP_ERROR_TEXT[code]` or the classified message.
- It never throws.

**`test(instance)`:** `provider.verify()`. When the identity changed, it is written back to the store and the broker cache for that instance is invalidated.

**`connect(instance, 'app_key', fields)`:**
- Fields: `{ appRef, installationId?, privateKey, host? }`.
- Calls `registerSecret` on the key first.
- Parses the key, discovers the installation if needed, then runs `verify()`.
- **Stores only after `verify()` succeeded.** It refuses `app_mismatch` when the instance already holds a different app.
- Returns the status. Used by the CLI and by `AppCommands`.

**`remove(instance)`:** `store.remove`, `broker.invalidate`, `touchRecheck`.

### 6.6 Redaction gap fix

`apps/runner/src/redact.ts` `redactSecrets` gets two changes:
- It first runs the registry: `import { redact } from './secrets/redact.ts'`, then `redact(text)`.
- It adds the PEM pattern that `secrets/redact.ts` already has.

Now Claude activity summaries and the audit lines built on them mask registered keys and tokens, the same way the Gemini, opencode and Codex parsers already do.

Check, when building, that the hot path stays cheap: `redact` returns at once when the set is empty.

### 6.7 Runner commands: `apps/runner/src/apps/commands.ts`, routed in `runner.ts`

New `RunnerCommandName` values with payload schemas in `CommandPayloadSchemas`:

| Command | Payload | Result (`AppCommandResultSchema`) | Delivery |
|---|---|---|---|
| `app.connect` | `{ requestId, orgId, integrationId?, provider, host, appRef, installationId?, envelope }` (the envelope seals `{ privateKey }` with kind `github-app`, op `connect`, instance = `appRef[:installationId]` as entered, ref = the share's `ref`) | `{ ok, instance, identity }`, `{ ok:false, code:'choose_installation', installations }` or `{ ok:false, code, message }` | durable, `expires_at` = envelope TTL, payload wiped on result |
| `app.test` | `{ requestId, instance }` | `{ ok, instance, identity }` or `{ ok:false, code, message }` | durable, 10 min expiry |
| `app.adopt` | `{ requestId, orgId, integrationId, instance }` | like `app.test`, and adds the ref | durable, 10 min expiry |
| `app.remove` | `{ orgId, integrationId, instance }` | `{ ok }` | durable, **no expiry** (the key must be deleted even if the runner is offline for days) |
| `app.sync` | `{ orgIds, apps: [{ orgId, integrationId, instance }] }` | `{ ok }` | sent after every `welcome` (as `storage.sync`) |

How a runner handles them:
- **`app.connect`:**
  1. Open the envelope with `RunnerKeys.open`, using AAD rebuilt from the outer fields.
  2. Claim the `ref` in the existing `ReplayCache`.
  3. `registerSecret(privateKey)`.
  4. Run `adapter.connect(...)`.
  5. On success, add the ref `{ orgId, integrationId ?? requestId }`. The server sends the real integration id to keep in a later `app.sync`.
  6. `unregisterSecret` only if nothing was stored (when stored, the store keeps it registered).
- **`app.remove`:** drops the ref. When no refs remain and `local` is false, it deletes the entry and invalidates the broker.
- **`app.sync`:** drops refs for the listed orgs that the server no longer has. That covers a removal made while the runner was offline.
- **Policy:** an app connect is an organization command, not a web connect of the workstation's own credential. `allowWeb: false` (D8 of the Integrations page) still refuses it, with `allow_web_off`. That keeps the owner's local off-switch meaningful.

The runner announces `APP_INTEGRATIONS_CAPABILITY` in `hello` capabilities.

### 6.8 Headless CLI (`cli.ts`)

New command group, using the same adapter through `headlessAdapters`:

```
guildwise-runner apps list
guildwise-runner apps connect github --app-id <id|client id> [--installation <id>] [--host github.com] [--key-file <path> | --key-stdin]
guildwise-runner apps test <instance>
guildwise-runner apps remove <instance>
```

The key is read from the file, from stdin, or from a hidden multi-line prompt that ends at the `-----END … PRIVATE KEY-----` line. It is never an argument value and never echoed; the existing `promptSecret` approach is extended for several lines. The CLI prints the bot login, the commit identity and the instance. It suggests deleting the downloaded `.pem` file once it is stored; it never deletes it on its own. The connected copy is `local: true`, and the org page offers "Add to organization" for it (adopt, section 7).

### 6.9 Version

`RUNNER_VERSION` is bumped to the next unreleased version, 0.1.75 at the time of writing. Check `apps/runner/src/version.ts` and the last release when building. Set the same version as the registry's `minRunner`. The real gate is the `app-integrations:1` capability: the server answers `422 runner_too_old` without it.

## 7. Server (`apps/server`)

### 7.1 Migration `apps/server/migrations/2970_app_integrations.sql`

The number follows the last file, 2960. If another migration lands first, take the next free number; applied migrations are never edited.

```sql
-- Automated app integrations (GitHub App first). Metadata only: the private key and every token stay on the runners.
CREATE TABLE IF NOT EXISTS org_app_integrations (            -- projection of OrgAppIntegration* events (no FKs: rebuildable)
  id uuid PRIMARY KEY, org_id uuid NOT NULL, provider text NOT NULL, label text NOT NULL, host text NOT NULL,
  app_id text NOT NULL, app_slug text NOT NULL, app_name text NOT NULL, installation_id text NOT NULL,
  account text NOT NULL, account_type text, repository_selection text,
  bot_login text NOT NULL, bot_user_id text NOT NULL, commit_name text NOT NULL, commit_email text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb, missing_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',                     -- active | removed
  created_by uuid NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, removed_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS org_app_integrations_one ON org_app_integrations (org_id, provider, host, app_id, installation_id)
  WHERE status = 'active';
CREATE TABLE IF NOT EXISTS org_app_integration_workstations ( -- projection of …Shared / …Unshared
  integration_id uuid NOT NULL, workstation_id uuid NOT NULL, via text NOT NULL, added_by uuid, added_at timestamptz NOT NULL,
  PRIMARY KEY (integration_id, workstation_id));
CREATE TABLE IF NOT EXISTS app_integration_requests (         -- operational, short-lived (pruned after 24 h)
  id uuid PRIMARY KEY, org_id uuid NOT NULL, integration_id uuid, user_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('add','share','test','adopt')),
  label text, state text NOT NULL,                            -- pending | needs_choice | done | failed | expired
  results jsonb NOT NULL DEFAULT '[]'::jsonb,                 -- [{workstationId, commandId, ok?, code?, message?}] never a value
  installations jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
```

- Add both projections to the projection registry. Add `app_integration_requests` to the 24-hour prune that runs beside `storage_requests` and `integration_requests`.
- Health per workstation is **not** a new table. It is `workstation_integrations` rows with `kind = 'github-app'` and `instance = app_id || ':' || installation_id`, where `status->>'refreshedAt'` and `status->>'errorCode'` give the last refresh and the last error.

### 7.2 Commands and routes

Commands live in `apps/server/src/commands/org-apps.ts` and routes in `apps/server/src/routes/org-apps.ts`. The paths follow `/api/org/providers`: the current organization comes from the session's org context.

| Method and path | Who | What |
|---|---|---|
| `GET /api/org/apps` | any active org member | `OrgAppsResponse`. `canManage` is true for the Owner only. Members see apps and the aggregate state but no workstation rows, account names of other members' workstations or `targets` (Q3 of the Integrations page design: state only). |
| `POST /api/org/apps` | **Owner** | Add (section 7.3). 202 `{ requestId }`. |
| `GET /api/org/apps/requests/:rid` | Owner (the requester) | Poll `OrgAppRequestDto`. |
| `PATCH /api/org/apps/:id` | **Owner** | Rename (`OrgAppIntegrationUpdated`). |
| `POST /api/org/apps/:id/shares` | **Owner** | Seal to more workstations, or replace the key on chosen ones (the runner refuses `app_mismatch` if the PEM belongs to another app). |
| `DELETE /api/org/apps/:id/workstations/:wsId` | **Owner** | Unshare: `app.remove` to that workstation, `OrgAppIntegrationUnshared`. |
| `POST /api/org/apps/:id/test` | **Owner** | `app.test` to each workstation that holds it (or one, `?workstationId=`). |
| `POST /api/org/apps/adopt` | **Owner** | Register a copy a workstation already reports (CLI connect): `app.adopt`, and the integration is created from its identity. |
| `DELETE /api/org/apps/:id` | **Owner** | Remove (section 7.4). |

**Authorisation helper `requireOrgOwner(db, user, orgId)`:**
- not a member: `404`;
- member or Admin: `403 forbidden('only the organization Owner can manage automated apps')`.

This is acceptance criterion 1. Every write route calls it inside the transaction, as `requireManager` does for provider keys.

**Validation:**
- Every request schema is `.strict()`. An unknown field such as `privateKey` is a `400`.
- `envelope` is the existing `SealedEnvelopeSchema`, treated as opaque.
- Extra guard: a body whose raw JSON contains `PRIVATE KEY-----` is refused with `400 plaintext_key_refused`, and the body is never echoed. This catches a broken client that would post the PEM in the clear.
- `label` at most 80 characters; `appRef` matches `^(\d{1,12}|Iv[0-9A-Za-z.]{4,40})$`; `installationId` `^\d{1,15}$`; `host` is a host name.
- Each share targets an active workstation from `targetWorkstations(orgId)`; reuse or extract it from `org-provider-keys.ts`, with the capability `app-integrations:1`.
- The share's `keyId` must equal the stored key; otherwise `409 runner_key_changed`.
- Not supported: `422 runner_too_old`. Offline: still queued (durable). The page shows "will be checked when <name> is online", and the envelope expires after 10 minutes.

**pino:** add `req.body.shares[*].envelope` and `*.shares[*].envelope` to the redact paths. `*.envelope` covers one level only.

### 7.3 Add flow and its result handling

1. The browser calls `GET /api/org/apps` (Owner: `targets`, `serverTime`). For each chosen workstation it seals `{ privateKey }` with `sealIntegration({ kind: 'github-app', op: 'connect', instance: appRef[:installationId], ref: <uuid per share> })`. It clears the PEM from component state right after sealing.
2. `POST /api/org/apps`:
   - refuse `409 app_exists` if an active row for the same (provider, host, app, installation) exists, when the installation is known;
   - insert `app_integration_requests (op 'add', state 'pending')`;
   - queue one `app.connect` per share, carrying `requestId`, `orgId` and the envelope, `expires_at = now + ENVELOPE_TTL_MS`;
   - `deliver(ctx, workstationIds)`.
3. `command.result` for `app.connect`, in `runner-gateway/handlers.ts` calling `applyAppCommandResult`:
   - Parse the result with `AppCommandResultSchema` (strict; a parse failure counts as `unexpected`). Set the command payload to `'{}'`, as `applySudoSetResult` does.
   - **First `ok`:** in one append transaction, create the integration (`OrgAppIntegrationAdded` with the identity) and `OrgAppIntegrationShared` for that workstation. Mark the request `done`.
   - **Later `ok`:** if the identity's (app, installation) equals the integration, emit `OrgAppIntegrationShared`. If not, the result is recorded as `app_mismatch` and the key is not shared: an `app.remove` is queued to that workstation.
   - **`choose_installation`:** the request becomes `needs_choice` with the installation list. The page shows a picker and posts again with `installationId`. The browser still holds the PEM in the open dialog, so this is a re-seal, not a re-type.
   - **Every share failed:** the request becomes `failed` with each workstation's code and message. **No integration and no event exist**, so nothing is "saved as connected" (acceptance criterion 2). The runner did not store anything either, because it stores only after `verify()`.
4. The sweep in the existing job loop marks expired `app.connect` commands failed with the payload wiped, and requests past `expires_at` as `expired`.

### 7.4 Remove flow

`DELETE /api/org/apps/:id`, in one transaction:
- `OrgAppIntegrationRemoved`; the projection sets `status='removed'`, so `GET` no longer lists it;
- `app.remove` to every workstation in `org_app_integration_workstations`, and to every workstation whose report shows the instance;
- pending `app.connect`/`app.test` commands of this integration are failed with their payload wiped.

After the next `welcome`, `app.sync` covers runners that were offline. The runner deletes the sealed key when no organization uses the copy, unregisters it and drops cached tokens (acceptance criterion 8). The project fallback is GWP-215's projection of `OrgAppIntegrationRemoved`. This card emits the event and documents the contract.

### 7.5 Reports and notices

- `applyIntegrationsReport` already stores `github-app` statuses. No change beyond schema validation of the new optional fields.
- **Optional (cut first if tight):** when an app's state moves from `connected` to `refused` on any workstation, open one Owner desk notice per integration, `app_integration_error`, coalesced with `desk-coalesce.ts`. Close it when the integration is healthy again. The org page shows the error either way, which is what the card asks for.

### 7.6 Workstation integration routes

`commands/integrations.ts` `requestTest` and `requestRemove` (and connect, defensively) refuse `kind === 'github-app'` with `403 manage_in_org`.

## 8. Web (`apps/web`)

### Settings > Automated apps

New tab `apps` in `pages/OrgSettings.tsx`, shown to all members (actions only for the Owner). Body component `pages/OrgApps.tsx`, route `/settings/apps`. Query hooks go in `api/queries/org-apps.ts`.

**App cards show:**
- label;
- "GitHub App" with the slug and App ID;
- installation account;
- bot login;
- commit identity, with a copy button;
- the permissions the installation grants, with missing ones in amber and a link to the app's permission page;
- per workstation (Owner only): state badge (Connected / Error / Pending / Not on this workstation), last token refresh ("12 min ago") and last error sentence.

**Owner actions:** Add app, Rename, Add workstations / Replace key, Test, Remove. For a non-Owner they are not rendered at all, not just disabled (acceptance criterion 1, "the UI hides the action"). "Found on <workstation>, not registered" rows offer Add to organization (adopt).

### Add dialog (`components/apps/AddAppDialog.tsx`)

1. **Provider:** GitHub App, the only option, shown so the shape is generic. Also: label, App ID or client ID (`inputMode="numeric"` when numeric), and installation ID (optional: "leave empty to pick from the installations").
2. **Private key:**
   - the main control is a file picker (`accept=".pem"`, read with `FileReader`);
   - "Paste instead" opens a textarea with `autocomplete="off"`, `spellcheck={false}` and `autoCapitalize="off"`;
   - the value is kept only in a ref, never in the react-query cache, the URL or localStorage, and is cleared after sealing and on close.
3. **Workstations:** checkboxes from `targets`. The Owner's own online, supported workstations are preselected. Unsupported ones show "update the runner". The least-privilege note from D1 is shown here.
4. **Advanced:** GitHub host, default `github.com`.
5. **Submit:** the button reads "Encrypting for N workstations…", then "Checking with GitHub…" while it polls the request every second. On success it shows the bot login and the commit identity. On `needs_choice` it shows an installation picker (account login, type, suspended flag) and re-submits. On failure it shows the per-workstation sentence from `APP_ERROR_TEXT`. It never shows a value.

**All devices, touch included (standing order "design"):**
- the dialog is full-screen below the `sm` breakpoint;
- the footer buttons sit in the scrolling body, not fixed to the bottom, so the soft keyboard never covers the field being typed in;
- focused inputs call `scrollIntoView({ block: 'center' })`;
- the file picker is the default because pasting a multi-line PEM on a phone is unreliable;
- tap targets are at least 44 px.

### Workstation Integrations page

The registry entry gives a `GitHub App` tile per instance:
- status, bot login, last refresh (`refreshedAt`) and the error sentence;
- "Manage in Settings > Automated apps" instead of Connect, Test and Remove;
- the CLI line under "From a terminal".

Check `IntegrationTile` for `local_only` handling, and for `refreshedAt`/`errorCode` display.

## 9. Tests (who covers which acceptance criterion)

**Runner, unit (vitest, no network: fetch fakes with recorded GitHub responses as fixtures under `apps/runner/test/fixtures/github-app/`; the test RSA key is generated in the test with `generateKeyPairSync`, never committed):**
- `apps/github-app.test.ts`:
  - JWT header and claims: `alg` RS256, `iat = now − 60`, `exp − iat = 600`, `iss`; the signature verifies with the public key;
  - PKCS#1 and PKCS#8 keys are both read; a non-RSA key or one under 2048 bits gives `key_invalid`;
  - `verify()` happy path builds `"<slug>[bot]"` and `"<id>+<slug>[bot]@users.noreply.github.com"` (GHES host variant too);
  - error classification for 401 bad JWT, 401 exp/iat (clock skew: one re-sign using the `Date` header, then `clock_skew`), 404 app, 404 installation, suspended, 403/422 permission, rate limit and network.
- `apps/broker.test.ts`, with a fake clock:
  - a fresh token is cached; at minute 49 the same token comes back, at minute 55 a new mint happens (AC5);
  - two concurrent callers produce exactly one mint request (AC5);
  - different scopes give different cache keys;
  - `withToken`: a 401 gives one re-mint and one retry; a second 401 gives `AppTokenError('token_rejected')`, and `health()` holds the error, which `status()` reports as `refused` with `errorCode` (AC6);
  - a failed mint is not cached;
  - `rate_limited` is held back until `retryAfterMs`.
- `apps/store.test.ts`:
  - the file on disk is an envelope (no `BEGIN` and no base64 body line in it);
  - remove deletes the entry, deletes the file when it was the last, and unregisters the secrets (`redact(pem)` then returns the PEM unchanged) (AC3, AC8).
  - **Tokens never on disk (AC7):** mint through the broker with a temp data dir, then walk every file under it and assert that none contains the token string.
- `apps/redaction.test.ts` (AC4):
  - with a stored key and a minted token, force an error path (a provider message that quotes them) and check: the logger line, the integrations audit log (`audit-log.ts`), the command result, and a Claude stream-parser activity summary (through the fixed `apps/runner/src/redact.ts`) all show `***`;
  - one line of the PEM body alone is also masked.
- `integrations/automated-app.test.ts`:
  - `connect` stores only after verify; a wrong key, wrong App ID or uninstalled app stores nothing and returns the typed code (AC2);
  - `choose_installation` with several installations;
  - `app_mismatch`;
  - status mapping;
  - `buildIntegrationAdapters` contains `github-app` (AC9).
- `apps/commands.test.ts`:
  - `app.connect` opens a real sealed envelope (seal with `sealForRunner` in the test), refuses a replayed ref, a tampered AAD and `allowWeb` off;
  - `app.remove` and `app.sync` ref handling (a key used by two orgs is kept until both are gone).
- A type-level test, or a small `tsd`-style assertion: `apps/types.ts` imports nothing from `github-app.ts` (AC9).

**Shared, unit:**
- the registry validity test still passes with the new kind;
- `AppIdentitySchema` and `AppCommandResultSchema` are strict: an extra `token` key fails;
- `appInstance` and `parseAppInstance`.

**Server (vitest with Postgres, own database `aom_test_gwp214`):**
- Owner add gives 202. An Admin and a member get 403 on every write route; a non-member gets 404 (AC1).
- A fake runner answers `app.connect` ok: the integration is created with its identity, `GET` lists it, and the per-workstation row reads `workstation_integrations`.
- Every share fails: no row and no event (AC2).
- `needs_choice` round trip.
- Remove: the event, `app.remove` queued with no expiry, gone from the list; `app.sync` after `welcome` lists only active apps (AC8).
- **Key material never stored (AC3):**
  1. Generate a PEM in the test and seal it.
  2. Run add, test and remove through the routes with a fake runner.
  3. Grep for the PEM body and any line of it in: every `events` row payload, every projection row, the `runner_commands` rows after the result (payload `{}`), `app_integration_requests`, every API response body, and the captured pino output.
  4. A body that posts `privateKey` in the clear gets 400 and the logger output does not contain it.
- The workstation integration test and remove routes return 403 `manage_in_org` for `github-app`.

**Web (vitest + testing-library):**
- `OrgApps.test.tsx`: an Owner sees the actions; a member sees none of the buttons (AC1).
- The add dialog's request body holds only envelopes (no PEM text in it); the file picker path and the paste path; `needs_choice` picker; error sentences per code; success shows the bot login and commit identity (AC2).
- Remove confirm.

**Left for testers or manual QA:** a real GitHub App on a sandbox org, installed on a scratch repository: add it, check status and the bot identity, then confirm a refresh after more than one hour of uptime with no re-auth. No end-to-end spec is required by this card.

## 10. Acceptance criteria mapped to the design

| # | Criterion | Where it is met |
|---|---|---|
| 1 | Owner can add; a non-owner gets forbidden; the UI hides the action | `requireOrgOwner` on every write route (7.2); `canManage` and the actions not rendered for others (8); server and web tests |
| 2 | Save runs a real mint and shows the bot login and commit identity; errors are clear; nothing saved as connected on failure | Runner `verify()` mints a least-privilege token and resolves the bot (6.2); typed codes and `APP_ERROR_TEXT`; the runner stores only after verify, and the server creates the integration only on the first `ok` (7.3) |
| 3 | Key only in the sealed store; never in DB, logs, events or API | `AppKeyStore` (6.3); ciphertext-only relay, payload wiped; strict schemas plus the `PRIVATE KEY-----` guard and pino paths (7.2); the grep test (9) |
| 4 | Key and tokens masked in runner logs, audit log and transcripts | `secretsOf` with partial lines, tokens registered on mint (6.3, 6.4); the stream-parser redaction fix (6.6); redaction test |
| 5 | Cache while more than 10 min remain; minute 55 gets a new token; one mint for concurrent callers | Broker freshness and single-flight (6.4); fake-clock tests |
| 6 | 401 gives exactly one re-mint and retry; a second failure gives a typed error and status error | `withToken` (6.4); health feeds `status()` (6.5); `onChange` reports at once; the org DTO derives `state: 'error'` |
| 7 | Tokens never on disk | The broker holds tokens in memory only, with no `fs` import; the walk-the-data-dir test |
| 8 | Remove deletes the key, unregisters, disappears from the list; projects fall back | Remove flow (7.4); runner `app.remove`/`app.sync` (6.7); `OrgAppIntegrationRemoved` is the contract for GWP-215 |
| 9 | Provider interface has no GitHub types; GitHub App registered through the adapter list | `apps/types.ts` (6.1); `AutomatedAppIntegration` in `buildIntegrationAdapters` (6.5) |

## 11. Files

**Shared:**
- create `src/apps/index.ts`, `src/events/apps.ts`;
- modify `src/integrations/schema.ts` (kind, `refreshedAt`, `errorCode`), `src/integrations/registry.ts` (entry, `by: 'installation'`), the events index, `streamId` (`appIntegration`), `protocol` (`RunnerCommandName`, `CommandPayloadSchemas` for `app.*`), and the package index.

**Runner:**
- create `src/apps/{types,providers,github-app,store,broker,commands}.ts` and `src/integrations/automated-app.ts`;
- modify `src/integrations/index.ts` (adapter list), `src/integrations/types.ts` (`AdapterEnv.apps?`), `src/integrations/headless.ts` (broker for the CLI), `src/runner.ts` (broker construction, command routing, `hello` capability), `src/cli.ts` (`apps` group, multi-line hidden prompt), `src/redact.ts` (registry plus PEM), `src/version.ts`.

**Server:**
- create `migrations/2970_app_integrations.sql`, `src/commands/org-apps.ts`, `src/routes/org-apps.ts`, and a projection for the two tables (`src/projections/…`, registered);
- modify `src/runner-gateway/handlers.ts` (`command.result` for `app.*`, `app.sync` after `welcome`), `src/commands/integrations.ts` (`manage_in_org`), the pino redact paths in `src/app.ts`, the job-loop sweep and prune, and route registration.

**Web:**
- create `src/pages/OrgApps.tsx`, `src/components/apps/AddAppDialog.tsx` (plus small `AppCard`/`InstallationPicker` components), `src/api/queries/org-apps.ts`;
- modify `src/pages/OrgSettings.tsx` (tab), `src/router.tsx`, and `IntegrationTile` (`local_only` link, `refreshedAt`).

**Docs:**
- `docs/USER-GUIDE.md`: new subsection after 3.4a, "Add a GitHub App for your organization":
  1. create the app (org settings > Developer settings > GitHub Apps > New);
  2. no webhook needed (untick Active);
  3. permissions: Contents RW, Pull requests RW, Issues RW, Metadata R; Workflows only if agents must edit `.github/workflows`;
  4. install it on the org with only the project repositories;
  5. generate a private key;
  6. add it under Settings > Automated apps and pick the workstations;
  7. delete the downloaded `.pem` afterwards;
  8. one integration per installation.
- `docs/RUNNER.md`: the `apps` commands and storage.
- `docs/ARCHITECTURE.md`: new section 46 "Automated app integrations".
- A help article line on the Integrations help page.

## 12. Risks

- **R1. Large and cross-cutting** (shared, runner, server, web, docs; about 1,500 changed lines with tests). Recorded as a large risk. Build order:
  1. shared;
  2. runner store, provider and broker with their tests (this is what GWP-216/217 need);
  3. runner commands and CLI;
  4. server;
  5. web;
  6. docs.

  If the run is tight, cut from the end: the desk notice (7.5), the adopt flow (the CLI copy can be removed and re-added from the web instead), then Rename. Never cut the Owner check, the store-after-verify rule, the redaction fix or the grep tests.
- **R2. A member's workstation holding the key can act as the bot.** This is inherent in running on that machine. It is mitigated by the Owner choosing the workstations, the warning in the dialog, unshare and remove.
- **R3. Clock skew** beyond what the `Date` header correction covers: a typed `clock_skew` error that names the fix.
- **R4. GitHub rate limits** on mint when many shifts start at once: single-flight per scope plus the cache keeps it to about one mint per scope per 50 minutes. `rate_limited` is respected.
- **R5. Redaction cost.** Every token adds an entry to the registry. Unregistering 5 minutes after replacement keeps it bounded, at about one entry per scope per hour.
- **R6. Client ID versus App ID:** both are accepted as `iss`. The canonical instance always uses the numeric App ID from `GET /app`, so the same app entered either way is one integration.
- **R7. Migration number collision** with parallel cards: take the next free number when building.

## 13. Recommendation

Build D1 (Owner seals the PEM in the browser to chosen workstations; runners verify, then store it sealed; the server keeps metadata only), with the generic `AutomatedAppProvider` and `AppTokenBroker` on the runner as specified.

- GWP-216 and GWP-217 should record a dependency on GWP-214. They consume `AdapterEnv.apps` (`getAccessToken`, `withToken`, `identity`).
- GWP-215 consumes `org_app_integrations`, `OrgAppIntegrationRemoved` and `GET /api/org/apps`.

Follow-up for the backlog, outside this card: reshare an app key from one runner to a new workstation without typing it again, using the same mechanism as `provider.key.reseal`.
