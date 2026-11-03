# GWP-71: web app API proxy target from an environment variable

## Question

The Vite dev server and `vite preview` proxy the API to port 4600. Test environments run the API on a random port, so the proxy target is edited by hand before every E2E run. How should the web app take the API target from an environment variable (default unchanged, validated, not in the client bundle, documented)?

## Findings

1. **The proxy already reads a variable, but nobody uses it for this.** `apps/web/vite.config.ts:10-12`:

   ```ts
   const target = process.env.AOM_API_TARGET ?? 'http://127.0.0.1:4600';
   const headers = process.env.AOM_API_TARGET ? { Origin: target } : undefined;
   ```

   `AOM_API_TARGET` was added for the screenshot harness (`apps/web/scripts/ui-shots.mjs:5`, commit c76bd309). It is not documented anywhere else and it is not validated: `AOM_API_TARGET=` (empty) gives the target `''` (`??` only catches `undefined`), and `not-a-url` reaches http-proxy unchanged and fails on every request rather than at startup.

2. **`AOM_API_TARGET` also rewrites the `Origin` header to the target.** The harness needs this: its demo server's `AOM_PUBLIC_ORIGIN` is its own address (`apps/web/scripts/ui-routes.mjs:5`, `ORIGIN ?? 'http://localhost:4611'`). The server compares `Origin` exactly with `AOM_PUBLIC_ORIGIN` (plus `AOM_EXTRA_ORIGINS`) on every non-GET `/api/` request and on WS upgrades (`apps/server/src/auth/origin-check.ts:28-41, 74`). In a test environment the browser opens the web app (for example `http://localhost:24149`), so the server's public origin is the web origin. In that setup, rewriting `Origin` to the API address (`http://localhost:24150`) makes login and every POST fail with 403 `bad_origin`. **The new variable must therefore change the target only and leave `Origin` alone.** This is the main trap on this card.

3. **Every proxied route uses the same `target` constant.** `server.proxy` has `/api` and `/ws` (both `ws: true`, plus the optional headers), then `^/blog(/|$)`, `/sitemap.xml`, `/robots.txt` and `/videos`. No route has its own port, so changing `target` covers REST, the websocket (`/ws`) and the media/stream route (`/videos`). The only 4600 literal in the web proxy config is line 11.

4. **Preview reuses the dev proxy.** In the installed Vite 7.3.7, `resolvePreviewOptions` sets `proxy: preview?.proxy ?? server.proxy` (`vite/dist/node/chunks/config.js:35313`), and the preview server binds the same proxy middleware, including WS upgrades. `preview.proxy` is not set today, so one change covers both modes. (`AOM_WEB_PORT` sets only `server.port`. Preview keeps its own port, 4173 or `--port`, which is out of scope.)

5. **`.env` files.** `vite.config.ts` reads `process.env` only, and Vite does not copy `.env` values into `process.env` for the config. `apps/web/.env.example` exists (it lists `VITE_MSW`). If we add `API_PROXY_TARGET` there, a developer who copies it to `apps/web/.env` will expect it to work. So the config should read the variable through `loadEnv(mode, webRoot, ['API_PROXY_TARGET'])`. With an explicit prefix list, `loadEnv` returns only that key, and a shell value wins over the file. `envPrefix` stays `VITE_`, so nothing reaches `import.meta.env` or the bundle. The root `.env.example` is the server's file (it starts with "Server (apps/server)"), so it gets no entry.

6. **Nobody imports the config object.** `apps/web/package.json` exports `./vite.config.ts`, but nothing in this repo or in guildwise-cloud imports it (the cloud web uses its own `vitest.config.ts` and `vite.landing.config.ts`). Switching to the function form of `defineConfig` is safe.

7. **E2E does not use the Vite proxy.** `e2e/global-setup.ts` starts the built server on 4601, which serves `apps/web/dist` with `AOM_PUBLIC_ORIGIN = BASE_URL`. `e2e/playwright.environments-msw.config.ts` runs `vite` with `VITE_MSW=1` (no API). So no e2e file or root script needs to pass the variable. The test environment's run plan, which starts `vite`/`vite preview`, is the consumer, and it sets the variable in the web process's environment.

8. **Default host.** The card says `http://localhost:4600`, but the code uses `http://127.0.0.1:4600`. The server binds `AOM_HOST=127.0.0.1` by default (`.env.example`). `localhost` can resolve to `::1` first. Keeping `127.0.0.1` is the only choice that is truly "the same as before" (AC 1, constraint "default behaviour must stay the same"). It is the same machine and port the card means.

9. **Docs that describe dev setup and ports:** `CONTRIBUTING.md:36` (dev setup, `pnpm dev # server on :4600, web app on :5173`), `README.md:245` (same line), `docs/ARCHITECTURE.md:61` ("Dev ports … proxy `/api` → `http://127.0.0.1:4600`") and `docs/ARCHITECTURE.md` section 22 (env tables, which have only the server table today), plus `apps/web/.env.example`.

10. The ledger has no earlier decision on this proxy or on naming. The open cards GWP-69 and GWP-70 do not touch `vite.config.ts`.

## Options

| | A. Reuse `AOM_API_TARGET` | B. New `API_PROXY_TARGET`, `AOM_API_TARGET` kept as the harness alias (recommended) | C. Rename: only `API_PROXY_TARGET`, drop `AOM_API_TARGET` |
|---|---|---|---|
| Matches the card / ACs (they name `API_PROXY_TARGET`) | no, the ACs and the run-plan wording would not match | yes | yes |
| Test environments work (no Origin rewrite) | no: the Origin rewrite gives 403 on login unless the env's public origin is the API address | yes | yes |
| Screenshot harness unchanged | yes | yes | no: the harness loses its Origin rewrite or needs a second flag |
| Code size | smallest | small: one helper, one branch for the alias | small, but changes harness behaviour |

**Recommendation: B.** `API_PROXY_TARGET` is the documented variable. It sets only the target and leaves `Origin` untouched. `AOM_API_TARGET` keeps its current meaning (target plus `Origin` rewrite) for the screenshot harness, gets the same validation, and is documented as the harness variable. When both are set, `API_PROXY_TARGET` wins for the target and no `Origin` rewrite is done.

## Design

### Files

| File | Change |
|---|---|
| `apps/web/src/proxy-target.ts` (new) | Pure helper `resolveProxyTarget(env)`: validation, default, alias. No Node imports and no client code imports it, so it never reaches the bundle (same pattern as `src/brand.ts`, which the config already imports). |
| `apps/web/vite.config.ts` | Function form `defineConfig(({ mode }) => …)`. Read the env with `loadEnv`, call the helper, use `target`/`headers` exactly where they are used today. Replace the comment on line 10. |
| `apps/web/src/test/proxy-target.test.ts` (new) | Unit tests for the helper (vitest, in the existing `src/test` folder). |
| `apps/web/.env.example` | Commented entry for `API_PROXY_TARGET`. Also fix the `VITE_MSW` comment ("real server on :4600" becomes "real server, see API_PROXY_TARGET"). |
| `CONTRIBUTING.md` (dev setup), `docs/ARCHITECTURE.md` (line 61 and section 22) | Documentation (see below). `README.md:245`: append "(API target: `API_PROXY_TARGET`, see CONTRIBUTING.md)" or leave it as is. One pointer is enough. |

Not changed: `apps/server/**` (listen port, routes, `AOM_PUBLIC_ORIGIN`), production serving, Dockerfile/Caddy, `apps/runner`, e2e configs, `ui-shots.mjs` (still uses `AOM_API_TARGET`, which keeps working), `MoveWizard.tsx`/`PrepareServer.tsx` (4600 there is a deploy default, not the proxy), and guildwise-cloud.

### Helper (snippet for the builder, not final code)

```ts
// apps/web/src/proxy-target.ts
/** Where `vite` and `vite preview` send /api, /ws, /blog, /sitemap.xml, /robots.txt and /videos when API_PROXY_TARGET is unset. */
export const DEFAULT_API_PROXY_TARGET = 'http://127.0.0.1:4600';

export interface ProxyTarget {
  target: string;
  /** Only for the screenshot harness's AOM_API_TARGET: its server's public origin is its own address. */
  headers?: { Origin: string };
}

const parseOrigin = (name: string, raw: string): string => {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const ok = url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  if (!ok) throw new Error(
    `${name} must be an http(s) origin such as http://localhost:24150 (scheme, host and port, no path); got ${JSON.stringify(raw)}`);
  return (url as URL).origin; // normalises a trailing slash: http://localhost:24150/ -> http://localhost:24150
};

export function resolveProxyTarget(env: Record<string, string | undefined>): ProxyTarget {
  const primary = env.API_PROXY_TARGET?.trim();
  if (primary) return { target: parseOrigin('API_PROXY_TARGET', primary) };
  const legacy = env.AOM_API_TARGET?.trim();
  if (legacy) { const target = parseOrigin('AOM_API_TARGET', legacy); return { target, headers: { Origin: target } }; }
  return { target: DEFAULT_API_PROXY_TARGET };
}
```

Notes:
- Empty or whitespace-only means unset (requirement 2). This also fixes today's `AOM_API_TARGET=` giving the target `''`.
- Rules: only an origin is accepted. A path would be prefixed to every proxied path by http-proxy, which is never what the run plan wants. Credentials in the URL are refused. If you prefer not to echo a value that holds `@`, print `got a value with credentials` instead. Either way, never print secrets.
- The error message starts with the variable's name (AC 4).

### `vite.config.ts` (shape)

```ts
import { loadEnv } from 'vite';
import { resolveProxyTarget } from './src/proxy-target.ts';

export default defineConfig(({ mode }) => {
  // API_PROXY_TARGET (shell or apps/web/.env*) points `vite` and `vite preview` at another API server; see CONTRIBUTING.md.
  const { target, headers } = resolveProxyTarget({
    ...loadEnv(mode, webRoot, ['API_PROXY_TARGET']),
    AOM_API_TARGET: process.env.AOM_API_TARGET,
  });
  return { /* the existing object, unchanged; proxy entries keep using target / headers exactly as now */ };
});
```

- `loadEnv` comes from `vite` (already a devDependency, so nothing new to install). Do not add `define` or `envPrefix` and do not touch `import.meta.env` (AC 5).
- The helper runs for every command (`serve`, `preview`, `build`, vitest). A malformed value is a misconfiguration wherever it appears, and one code path is easier to test. A build with a valid value is unaffected.
- When the config throws, Vite prints `failed to load config from …/vite.config.ts` followed by the error message, and exits non-zero, for both `vite` and `vite preview` (AC 4).
- Keep `changeOrigin: false`, `ws: true` and the per-route options as they are. Only `target`/`headers` come from the helper.

### Documentation content (AC 6)

`CONTRIBUTING.md`, under the `pnpm dev` block, a short paragraph:

> The web app's dev server (`vite`) and `vite preview` proxy `/api`, `/ws` (websocket), `/blog`, `/sitemap.xml`, `/robots.txt` and `/videos` to the API server named by **`API_PROXY_TARGET`**: a full origin (scheme, host, port), default `http://127.0.0.1:4600` (the local server on port 4600). Example for a test environment with the API on port 24150: `API_PROXY_TARGET=http://localhost:24150 pnpm --filter @aom/web exec vite preview --port 24149`. Set it in the shell or in `apps/web/.env`, then restart the dev/preview server. A value that is not an http(s) origin stops startup with an error that names the variable. It is read by the Vite config only and never reaches the browser bundle. The server's `AOM_PUBLIC_ORIGIN` must be the address you open the web app on (here `http://localhost:24149`), because the proxy passes the browser's `Origin` through unchanged.

`docs/ARCHITECTURE.md`:
- Line 61: "… proxy `/api`, `/ws`, `/blog`, `/sitemap.xml`, `/robots.txt`, `/videos` → `API_PROXY_TARGET` (default `http://127.0.0.1:4600`, including WS)".
- Section 22: a small "Web dev/preview env (`apps/web/vite.config.ts`)" table after the server table, with three rows. `API_PROXY_TARGET`: default `http://127.0.0.1:4600`, an http(s) origin, invalid stops startup, not in the bundle, the `Origin` header is passed through. `AOM_API_TARGET`: unset, the screenshot harness; also sets `Origin` to the target; ignored when `API_PROXY_TARGET` is set. `AOM_WEB_PORT`: `5173`, dev server port.

`apps/web/.env.example`:

```
# API server that `vite` and `vite preview` proxy /api, /ws, /blog, /videos ... to (full origin). Default http://127.0.0.1:4600.
# Example for a test environment: API_PROXY_TARGET=http://localhost:24150
API_PROXY_TARGET=
```

### Tests (unit, `apps/web/src/test/proxy-target.test.ts`)

| Case | Expect |
|---|---|
| `{}`, `{API_PROXY_TARGET: ''}`, `{API_PROXY_TARGET: '  '}` | `{target: 'http://127.0.0.1:4600'}`, no headers (AC 1) |
| `API_PROXY_TARGET=http://localhost:24150` (and with `/` at the end) | target `http://localhost:24150`, no headers (AC 2, finding 2) |
| `https://dev.example.test` | target `https://dev.example.test` |
| `not-a-url`, `localhost:24150`, `ftp://x`, `http://localhost:24150/api`, `http://u:p@h:1`, `http://h:1/?a=1` | throws, message contains `API_PROXY_TARGET` (AC 4) |
| `AOM_API_TARGET=http://localhost:4611` only | target plus `headers.Origin` equal to the target (harness unchanged) |
| both set | `API_PROXY_TARGET` wins, no headers |
| malformed `AOM_API_TARGET` | throws, message names `AOM_API_TARGET` |
| `DEFAULT_API_PROXY_TARGET` | `http://127.0.0.1:4600` (AC 7: the one place 4600 lives) |

Manual and test-plan checks the builder should run once (no full suites):
- `API_PROXY_TARGET=not-a-url pnpm --filter @aom/web exec vite` and the same with `vite preview`. Both must exit with the message (AC 4).
- `API_PROXY_TARGET=http://localhost:24150 pnpm --filter @aom/web build`, then `grep -r "24150\|API_PROXY_TARGET" apps/web/dist` finds nothing (AC 5).
- Optional, if the sandbox allows a local listener: start `vite --port 5199` with the variable pointing at a tiny local listener and `curl /api/health`, to see the request arrive on that port. The real login check against the API server on a random port (AC 2, AC 3 websocket) is the tester's run in a test environment.

### Risks

- **Origin rewrite (finding 2):** if the builder copies today's `headers` logic to the new variable, login fails in every test environment. The test row "no headers" guards this.
- **Test environment's `AOM_PUBLIC_ORIGIN`:** it must equal the web URL the browser opens (exact string, `localhost` and `127.0.0.1` differ). This is documented. If DevOps's run plan sets it to the API address, they must change it (or add the web URL to `AOM_EXTRA_ORIGINS`).
- **Default host:** we keep `127.0.0.1` rather than the card's `localhost` (finding 8). Same machine and port; this avoids an IPv6 `::1` miss. The reviewer should read AC 1/AC 6 "localhost:4600" as satisfied by `127.0.0.1:4600`, documented as the local server on port 4600.
- **Function-form config:** no importer exists (finding 6), so there is no regression risk. `pnpm --filter @aom/web typecheck`/`test` cover it.

### Acceptance criteria mapping

| AC | Design element |
|---|---|
| Unset: dev and preview go to 4600 as before | helper default `http://127.0.0.1:4600` (unchanged string); preview inherits `server.proxy` (finding 4); test rows 1 |
| `API_PROXY_TARGET=http://localhost:24150` works in dev and preview, no file edited | `loadEnv` + helper; target only, Origin passed through so login passes the server check; documented `AOM_PUBLIC_ORIGIN` rule; tester verifies in an env |
| Every proxied path (REST, WS, streaming) uses the port | all six routes use the one `target` (finding 3); `/ws` keeps `ws: true` |
| Malformed value stops startup naming the variable | `parseOrigin` throws `API_PROXY_TARGET must be …`; Vite aborts config load |
| Not in the bundle | no `VITE_` prefix, `loadEnv` with an explicit prefix, no `define`; build plus grep check |
| Documented (name, purpose, default, example) | CONTRIBUTING.md paragraph, ARCHITECTURE.md line 61 + section 22 table, `apps/web/.env.example` |
| No hard-coded 4600 except the documented default | the only literal is `DEFAULT_API_PROXY_TARGET` in `src/proxy-target.ts`; `vite.config.ts` no longer contains 4600 |

### For DevOps / the GWP run plan

In the web start step of each test environment, set `API_PROXY_TARGET=http://localhost:<api port>` (or `127.0.0.1`). Set the server's `AOM_PUBLIC_ORIGIN` to `http://localhost:<web port>`, the address the browser opens. No file edits are needed after this lands.
