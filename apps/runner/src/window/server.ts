import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../log.ts';
import type { HeldRecord, HeldStore } from '../policy/held.ts';
import { localCommand, runnerCli } from '../policy/local-command.ts';
import type { PasskeyStore } from '../policy/passkey-store.ts';
import { type PolicyStore, policyDir } from '../policy/store.ts';
import { applyChange, buildState, headerInfo, type WindowContext, type WindowOffers } from './api.ts';
import { audit } from './audit.ts';
import { DeviceStore, PORT_MAX, PORT_MIN, readPort, SessionStore, writePort } from './pairing.ts';

/**
 * Approvals on this computer (DESIGN "Approvals window", easy-runner-setup 1.10.0): a small page the runner serves for
 * its own instance, on 127.0.0.1 only, with node:http and no dependencies.
 *
 * `startApprovalsWindow(deps)` is what runner.ts calls after the start-up check. Its deps:
 *
 * ```ts
 * interface ApprovalsWindowDeps {
 *   instance: string | null;          // the named instance (`uat`, `prod`), or null for the single runner
 *   serverOrigins: string[];          // the paired server(s), e.g. ['https://uat.example.com']
 *   version: string;                  // RUNNER_VERSION
 *   status: () => WindowStatus;       // live state, read on every page refresh
 *   held: HeldStore;                  // the held items (read; decisions go through `decide`)
 *   policy: PolicyStore;              // policy.json (writes only through window/api.ts's allowlist)
 *   passkeys: PasskeyStore;           // pending passkey offers
 *   offers: () => WindowOffers;       // organizations (with DevOps helper) and repositories the server offers
 *   log: Logger;                      // the runner log
 *   decide: (id, state, extra) => unknown;  // may return a promise (awaited)
 *                                     // the same HeldStore state change `guildwise-runner approve|deny` makes
 *                                     // (e.g. `(id, s, x) => held.decide(id, s, 'local', x)`); the Approvals tick runs it
 *   dir?: string;                     // the policy dir (default policyDir(): per instance)
 *   cli?: string;                     // the CLI part of shown commands (default runnerCli(policy): WSL-aware)
 *   now?: () => number;
 *   portRange?: [number, number];     // tests only (default 47600-47699)
 * }
 * ```
 *
 * Security contract (all of it is tested in test/window-*.test.ts):
 * - Binds 127.0.0.1 and [::1] on one port, picked once in 47600-47699 and stored in `<policy dir>/window/port`. No ::1
 *   on this machine: 127.0.0.1 alone. Either address taken: nothing is served, `windowError` says why [B1].
 * - Every request: Host exactly `127.0.0.1:<port>` (421 otherwise, `localhost` too). Non-GET: Origin
 *   `http://127.0.0.1:<port>`, Sec-Fetch-Site same-origin when sent, Content-Type application/json (403 otherwise).
 *   No CORS headers ever; CSP, X-Frame-Options, Referrer-Policy and Cache-Control on every response.
 * - Without a session only the sign-in page, its static files and the sign-in calls answer; everything else is 401.
 */

export interface WindowStatus {
  /** Per server origin: connected now. */
  connected: Record<string, boolean>;
  /** Running shifts: a short plain title each (never a secret). */
  shifts: Array<{ title: string; startedAt?: string }>;
  /** The account the runner runs as. */
  runnerUser: string;
  /** Docker as the runner sees it now ("running", "not reachable"); the mode itself comes from policy.json. */
  docker?: string;
}

/** A DevOps request that waits for a switch of this workstation (UAT 1.10.0 finding 3). */
export interface BlockedDevops {
  requestId: string;
  switch: 'allowInstall' | 'allowDocker' | 'allowedPaths';
  switchLabel: string;
  agentName: string;
  summary: string;
  at: string;
}

export interface ApprovalsWindowDeps {
  /** DevOps requests waiting for a switch (shown as one item each). */
  blocked?: () => BlockedDevops[];
  instance: string | null;
  serverOrigins: string[];
  version: string;
  status: () => WindowStatus;
  held: HeldStore;
  policy: PolicyStore;
  passkeys: PasskeyStore;
  offers: () => WindowOffers;
  log: Logger;
  decide: (
    id: string,
    state: 'approved' | 'denied',
    extra: Partial<HeldRecord>,
    /** S2: the version the page showed; the decision is a compare-and-set on it. */
    expectedVersion?: string,
  ) => unknown;
  dir?: string;
  cli?: string;
  now?: () => number;
  portRange?: [number, number];
}

export interface ApprovalsWindow {
  /** The page's port (also when it could not start: the port it tried). */
  port: number;
  /** Why the page is not served (`another program uses port N`); absent when it runs. */
  windowError?: string;
  /** Both addresses bound (127.0.0.1 always; [::1] when the machine has it). */
  addresses: string[];
  close(): Promise<void>;
}

/** The name in the header and in the signed text: the instance, or `default` for the single runner. */
export const instanceLabel = (instance: string | null): string => instance || 'default';

// ---------------------------------------------------------------- static files

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

/** URL path -> published file name in `dist/window/`. */
export const WINDOW_ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/window.js': 'window.js',
  '/window.css': 'window.css',
  '/tokens.css': 'tokens.css',
  '/logo-light.svg': 'logo-light.svg',
  '/logo-dark.svg': 'logo-dark.svg',
  '/favicon.svg': 'favicon.svg',
  '/geist-latin.woff2': 'geist-latin.woff2',
  '/geist-latin-ext.woff2': 'geist-latin-ext.woff2',
};

/**
 * Where each asset is on disk. The bundle (`dist/aom-runner.mjs`) finds them in `dist/window/` (copy-window-assets.mjs);
 * from source (dev, tests) they come from `src/window/static/`, the web app's tokens and logos, and the font package.
 */
export function assetSources(here: string = dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const dist = join(here, 'window');
  if (existsSync(join(dist, 'index.html')))
    return Object.fromEntries(Object.entries(WINDOW_ASSETS).map(([u, f]) => [u, join(dist, f)]));
  const web = join(here, '..', '..', '..', 'web');
  const req = createRequire(join(here, '..', '..', 'package.json'));
  const font = (sub: string) => {
    try {
      return req.resolve(`@fontsource-variable/geist/files/geist-${sub}-wght-normal.woff2`);
    } catch {
      return '';
    }
  };
  return {
    '/': join(here, 'static', 'index.html'),
    '/window.js': join(here, 'static', 'window.js'),
    '/window.css': join(here, 'static', 'window.css'),
    '/tokens.css': join(web, 'src', 'tokens.css'),
    '/logo-light.svg': join(web, 'public', 'brand', 'logo-light.svg'),
    '/logo-dark.svg': join(web, 'public', 'brand', 'logo-dark.svg'),
    '/favicon.svg': join(web, 'public', 'brand', 'favicon.svg'),
    '/geist-latin.woff2': font('latin'),
    '/geist-latin-ext.woff2': font('latin-ext'),
  };
}

function loadAssets(log: Logger): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  for (const [url, file] of Object.entries(assetSources())) {
    try {
      const ext = file.slice(file.lastIndexOf('.') + 1);
      out.set(url, { body: readFileSync(file), type: TYPES[ext] ?? 'application/octet-stream' });
    } catch {
      log.warn(`approvals page: asset ${url} missing (${file || 'not found'})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- binding

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const BODY_MAX = 16 * 1024;
const PAIR_BODY_MAX = 1024;

type Listen = { server: Server } | { code: string };

function listenOn(server: Server, host: string, port: number): Promise<Listen> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      resolve({ code: err.code ?? String(err) });
    };
    const onListening = () => {
      server.off('error', onError);
      resolve({ server });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true, ipv6Only: host === '::1' });
  });
}

const closeServer = (s: Server): Promise<void> =>
  new Promise((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  });

/** Binds both loopback addresses on `port`; on any failure nothing stays bound. */
async function bindBoth(
  make: () => Server,
  port: number,
): Promise<{ servers: Server[]; addresses: string[] } | { code: string }> {
  const v4 = await listenOn(make(), '127.0.0.1', port);
  if ('code' in v4) return v4;
  const v6 = await listenOn(make(), '::1', port);
  if ('code' in v6) {
    // no IPv6 loopback on this machine: 127.0.0.1 alone
    if (v6.code === 'EADDRNOTAVAIL' || v6.code === 'EAFNOSUPPORT')
      return { servers: [v4.server], addresses: ['127.0.0.1'] };
    await closeServer(v4.server);
    return v6;
  }
  return { servers: [v4.server, v6.server], addresses: ['127.0.0.1', '::1'] };
}

// ---------------------------------------------------------------- requests

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) {
      reject(new TooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new TooLarge());
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const bearer = (req: IncomingMessage): string | null => {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{1,100})$/.exec(h) : null;
  return m ? (m[1] as string) : null;
};

/** Starts the page. Never throws for a taken port: the result carries `windowError` and nothing is served. */
export async function startApprovalsWindow(deps: ApprovalsWindowDeps): Promise<ApprovalsWindow> {
  const dir = deps.dir ?? policyDir();
  const now = deps.now ?? Date.now;
  const log = deps.log;
  // review S4: from the policy setup wrote, so under WSL the page's own commands are `wsl -d <distro> -u <user> --`
  const cli = deps.cli ?? runnerCli(deps.policy.get());
  const instanceName = instanceLabel(deps.instance);
  const devices = new DeviceStore(dir, now);
  const assets = loadAssets(log);

  let port = readPort(dir) ?? 0;
  let sessions: SessionStore | null = null;
  let ctx: WindowContext | null = null;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      log.warn(`approvals page: ${String(err)}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!ctx || !sessions) return send(res, 503, { error: 'starting' });
    // DNS rebinding: only the literal address and port this page is served on
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, { error: 'use http://127.0.0.1' });
    const method = req.method ?? 'GET';
    if (method !== 'GET') {
      const site = req.headers['sec-fetch-site'];
      const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (
        req.headers.origin !== `http://127.0.0.1:${port}` ||
        (site !== undefined && site !== 'same-origin') ||
        type !== 'application/json'
      )
        return send(res, 403, { error: 'refused' });
      if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    }
    const path = (req.url ?? '/').split('?')[0] as string;

    // ---- the sign-in page: its static files and the sign-in calls, without a session
    if (method === 'GET') {
      const a = assets.get(path);
      if (a) {
        res.writeHead(200, { 'Content-Type': a.type });
        res.end(a.body);
        return;
      }
      if (path === '/api/hello') return send(res, 200, { ...headerInfo(ctx), port });
      if (path === '/api/challenge') return send(res, 200, sessions.challenge());
    } else if (path === '/api/pair' && readPort(dir) !== port) {
      // `approvals port` moved the page: until the restart this old port pairs nothing (a key paired here would survive)
      return send(res, 409, {
        error: 'The approvals page moved to another port. Restart the runner and open the new link.',
      });
    } else if (path === '/api/pair') {
      let raw: string;
      try {
        raw = await readBody(req, PAIR_BODY_MAX);
      } catch (err) {
        if (err instanceof TooLarge) {
          res.setHeader('Connection', 'close');
          return send(res, 413, { error: 'too large' });
        }
        throw err;
      }
      const body = parseJson(raw);
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      const spki = (body as { spki?: unknown } | null)?.spki;
      if (typeof spki !== 'string' || keys.length !== 1) return send(res, 400, { error: 'send {spki}' });
      let rec: ReturnType<DeviceStore['addPending']>;
      try {
        rec = devices.addPending(spki, String(req.headers['user-agent'] ?? 'unknown browser'));
      } catch {
        return send(res, 400, { error: 'not an ECDSA P-256 public key' });
      }
      audit(dir, log, { action: 'pair.request', target: `fingerprint ${rec.fingerprint}` }, now);
      return send(res, 200, {
        code: rec.code,
        fingerprint: rec.fingerprint,
        command:
          localCommand(cli, 'approvals pair', [rec.code]) ?? `guildwise-runner approvals pair ${rec.code}`,
        expiresAt: rec.expiresAt,
      });
    } else if (path === '/api/session') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const b = (body ?? {}) as { keyHash?: unknown; nonce?: unknown; sig?: unknown };
      const r = sessions.signIn(b.keyHash, b.nonce, b.sig);
      if (!r.ok) return send(res, 401, { error: 'not paired', reason: r.reason });
      return send(res, 200, { token: r.token });
    }

    // ---- everything else needs a session
    const device = sessions.check(bearer(req));
    if (!device) return send(res, 401, { error: 'not signed in' });
    if (method === 'GET' && path === '/api/state') return send(res, 200, buildState(ctx));
    if (method === 'POST' && path === '/api/change') {
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const r = await applyChange(ctx, device, body);
      return send(res, r.status, r.body);
    }
    return send(res, 404, { error: 'not found' });
  }

  async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    try {
      const body = parseJson(await readBody(req, BODY_MAX));
      if (body === undefined) send(res, 400, { error: 'not JSON' });
      return body;
    } catch (err) {
      if (err instanceof TooLarge) {
        res.setHeader('Connection', 'close');
        send(res, 413, { error: 'too large' });
        return undefined;
      }
      throw err;
    }
  }

  const make = () => {
    const s = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, handler);
    s.keepAliveTimeout = 5_000;
    return s;
  };

  let bound: { servers: Server[]; addresses: string[] } | null = null;
  let windowError: string | undefined;
  if (port) {
    const r = await bindBoth(make, port);
    if ('code' in r)
      windowError = r.code === 'EADDRINUSE' ? `another program uses port ${port}` : `port ${port}: ${r.code}`;
    else bound = r;
  } else {
    // first start: pick a free port once and keep it (browser keys are tied to it)
    const [min, max] = deps.portRange ?? [PORT_MIN, PORT_MAX];
    const span = max - min + 1;
    const start = Math.floor(Math.random() * span);
    for (let i = 0; i < span && !bound; i++) {
      const p = min + ((start + i) % span);
      const r = await bindBoth(make, p);
      if ('code' in r) {
        if (r.code !== 'EADDRINUSE') {
          windowError = `port ${p}: ${r.code}`;
          port = p;
          break;
        }
        continue;
      }
      bound = r;
      port = p;
      // a fresh pick (no port file, e.g. it was lost): browsers paired under any earlier port never carry over
      const old = new DeviceStore(dir, now);
      const forgotten = old.devices().length;
      if (forgotten > 0 || old.pending().length > 0) {
        old.writeDevices([]);
        rmSync(old.pendingDir, { recursive: true, force: true });
        audit(
          dir,
          log,
          {
            action: 'port-picked',
            target: `port ${p}`,
            before: { devices: forgotten },
            after: { devices: 0 },
          },
          now,
        );
      }
      try {
        writePort(dir, p);
      } catch (err) {
        // not kept: browser keys would not survive a restart on another port, so serve nothing now
        await Promise.all(r.servers.map(closeServer));
        bound = null;
        windowError = `could not keep port ${p}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (!bound && !windowError) windowError = `no free port in ${min}-${max}`;
  }

  if (!bound) {
    log.warn(`approvals page not started: ${windowError}`);
    return { port, windowError, addresses: [], close: async () => {} };
  }
  sessions = new SessionStore(devices, instanceName, port, now);
  ctx = { deps, dir, cli, port, instanceName, now };
  log.info(`approvals page on http://127.0.0.1:${port}/ (instance ${instanceName})`);
  const servers = bound.servers;
  return {
    port,
    addresses: bound.addresses,
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
