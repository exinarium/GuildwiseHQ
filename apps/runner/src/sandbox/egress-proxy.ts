import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import {
  classifyIp,
  endpointListed,
  isTestServiceHost,
  normaliseTestServiceHost,
  orgCredentialEndpointProblem,
  testServiceDomain,
} from '@aom/shared';
import { type JsonValue, StrictJsonError, strictParse, strictStringify } from '../box/strict-json.ts';

/**
 * The network of a harness sandbox (docs/RUNNER.md, "Sandbox parity of the other runtimes"). The sandboxed CLI has no network
 * interface of its own: a bridge inside the sandbox forwards 127.0.0.1:<port> to this proxy's Unix socket, and `HTTPS_PROXY` points
 * the CLI and every command it starts at that port. The proxy
 * - lets a CONNECT through only to a host on the allow-list (the model API, the package registries, the per-shift target), on
 *   port 443 or 80, and only to a public address (a name that resolves to loopback, a private range or the metadata address is
 *   refused, so an allowed name cannot be used to reach the runner or the LAN);
 * - lets a CONNECT or plain request through to a declared local test service (`testServices`): an exact loopback `host:port`,
 *   kept apart from `privateEndpoints`;
 * - serves "routes": a local path prefix that is forwarded to one upstream with headers the proxy adds. The model API key lives in
 *   such a route, so the key never exists inside the sandbox, where the agent's shell could read it.
 */
export interface EgressRoute {
  /** Local path prefix without a trailing slash, e.g. `/gemini`. */
  prefix: string;
  /** The upstream base URL, e.g. `https://generativelanguage.googleapis.com`. Must be on the allow-list. */
  upstream: string;
  /** Headers added (and replaced) on every request; the caller's `authorization` and `x-goog-api-key` are always dropped. */
  headers: Record<string, string>;
  /**
   * The upstream is an endpoint the owner configured on this machine or network (a local Ollama): it may be loopback or private,
   * on any port. Only this route may reach it; the sandbox cannot name the address itself.
   */
  allowPrivateUpstream?: boolean;
  /**
   * The route carries an ORGANIZATION's credential to an endpoint an org admin chose: it needs https to a public address, or an
   * exact entry in `privateEndpoints` (loopback is not exempt), whatever `allowPrivateUpstream` says. Enforced on every request.
   */
  orgSourced?: boolean;
  /**
   * quiet-approvals S10 (the model proxy): only these upstream paths (exact, a query string allowed) are forwarded; any other
   * path of the route is refused (403), so a shell in the box cannot reach other account endpoints (`/api/oauth/*`).
   */
  allowPaths?: string[];
  /**
   * quiet-approvals S10: the per-session bearer the runner issued. A request must present it (`x-api-key` or
   * `authorization: Bearer`); it is never sent upstream. The route dies with the proxy at the session's end (revoked).
   */
  bearer?: string;
  /** quiet-approvals S10: headers computed per request (a login token the runner keeps fresh outside every box). */
  dynamicHeaders?: () => Record<string, string> | null;
  /**
   * runner-bare-bin (B1, B4, S9): the route rebuilds every request from a checked value. The body is buffered, parsed with
   * `strictParse` and given to the filter with the client's headers; the filter returns the value to forward and the upstream
   * header set built from scratch, or a refusal (403). Only `strictStringify(body)` goes upstream, never the original bytes,
   * and only the filter's headers plus `headers`, `dynamicHeaders` and `requiredHeaders` (added last, in that order).
   */
  requestFilter?: (
    value: JsonValue,
    headers: IncomingHttpHeaders,
    path: string,
  ) => { body: JsonValue; headers: Record<string, string> } | { refuse: string };
  /** runner-bare-bin: the largest request body a filtered route buffers (default 32 MiB); over it: 413. */
  maxRequestBytes?: number;
  /** runner-bare-bin (B2): sees each checked request and tees each upstream response (outside the box). */
  observe?: RouteObserver;
  /**
   * runner-bare-bin (S6): headers the auth mode needs, added after everything else; an `anthropic-beta` here is appended to the
   * filtered list instead of replacing it.
   */
  requiredHeaders?: Record<string, string>;
}

/** runner-bare-bin (B2): the model ledger's view of a filtered route. Errors it throws are caught and never break the pipe. */
export interface RouteObserver {
  request?(body: JsonValue, path: string): void;
  /** Called once per upstream response; the returned sink gets every body chunk, then `end`. */
  response?(
    status: number,
    headers: IncomingHttpHeaders,
  ): { write(chunk: Buffer): void; end(): void } | undefined;
}

/** runner-bare-bin (S8): requests in flight per filtered route, and bytes buffered by all filtered routes of this runner. */
export const MODEL_ROUTE_MAX_IN_FLIGHT = 6;
let maxBufferedBytes = 128 * 1024 * 1024;
let bufferedBytes = 0;
/** Review S2: bytes one filtered route (one box) may hold buffered, so one box cannot take the whole runner-wide buffer. */
export const MODEL_ROUTE_MAX_BUFFERED_BYTES = 48 * 1024 * 1024;
let maxRouteBytes = MODEL_ROUTE_MAX_BUFFERED_BYTES;
/** Test hook: the runner-wide buffer cap of the filtered routes. */
export function setFilteredRouteBufferCapForTests(bytes?: number): void {
  maxBufferedBytes = bytes ?? 128 * 1024 * 1024;
}
/** Test hook: the per-route buffer cap of the filtered routes. */
export function setPerRouteBufferCapForTests(bytes?: number): void {
  maxRouteBytes = bytes ?? MODEL_ROUTE_MAX_BUFFERED_BYTES;
}

export interface EgressProxyOptions {
  socketPath: string;
  /** Exact host names, or `*.example.com` for any subdomain. */
  allowedHosts: string[];
  routes?: EgressRoute[];
  /** Called once per refused host (never with a path or a credential). */
  onDeny?: (host: string) => void;
  /** Test hook: also reach loopback and private addresses. */
  allowPrivate?: boolean;
  /**
   * The workstation owner's private-endpoint allow-list: exact `host:port` entries (a LAN Ollama). A route to a private address
   * works only for loopback (this machine) or an entry; the sandbox's own CONNECT and plain requests may reach an entry too.
   * Link-local and metadata addresses are never reachable, listed or not. Empty by default.
   */
  privateEndpoints?: string[];
  /**
   * The shift's local test services (GWP-41): exact loopback `host:port` entries (`127.0.0.1:5433`, `[::1]:6379`,
   * `localhost:4000`). A CONNECT or plain request to exactly one of them is let through to this machine; any other port, host or
   * loopback address is refused as before. Entries that are not a loopback test-service host with a valid port are dropped.
   * Never read by the private-endpoint or org credential checks. Empty by default.
   */
  testServices?: string[];
  /**
   * quiet-approvals Rework 2 (REVIEW B4): exact `host:port` entries reached by NAME on any port, only at a public address:
   * the name is resolved at every connect and a private, loopback, link-local or CGNAT answer is refused (no rebinding).
   */
  publicEndpoints?: string[];
  /**
   * runner-bare-bin (S5): hosts a CONNECT or a plain (absolute-form) request is refused, whatever the allow-list says (the
   * model APIs from a box: the box reaches its model only through a route). Routes are not affected.
   */
  refuseHost?: (host: string) => boolean;
  /** runner-bare-bin (S5): upstream hosts only a route may reach (never a CONNECT or a plain request). */
  routeHosts?: string[];
  /** Test hook: the ports a CONNECT or plain request may use (default 80 and 443). */
  allowedPorts?: number[];
  /** Test hook: resolve names. */
  resolve?: (host: string) => Promise<string>;
}

export interface EgressProxy {
  close(): Promise<void>;
  /** Hosts refused so far. */
  denied(): string[];
  /** Hosts a CONNECT or a request asked for so far, allowed or not (for tests and diagnostics; never paths or credentials). */
  asked(): string[];
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/**
 * Loopback, private, link-local (the cloud metadata address included), unique-local, site-local, carrier-grade NAT and
 * unspecified addresses, in every notation: an IPv4 carried in an IPv4-mapped (dotted or hex), compatible, NAT64, 6to4 or Teredo
 * address is judged as the IPv4 it is (packages/shared private-endpoints.ts).
 */
export function isPrivateAddress(ip: string): boolean {
  const c = classifyIp(ip);
  return c !== undefined && c !== 'public';
}

const ALLOWED_PORTS = new Set([80, 443]);

/** 169.254/16 (the cloud metadata address included), fe80::/10, multicast and the unspecified address, in every notation. */
export function isNeverReachable(ip: string): boolean {
  return classifyIp(ip) === 'forbidden';
}

function hasBadChar(s: string): boolean {
  for (const ch of s) if (ch === '\\' || ch.charCodeAt(0) < 0x20) return true;
  return false;
}

/** A route's path after its prefix, or undefined when it could climb out of the upstream prefix (`..`, encoded dots or slashes). */
export function safeRoutePath(rest: string): string | undefined {
  const q = rest.indexOf('?');
  const path = q < 0 ? rest : rest.slice(0, q);
  if (hasBadChar(rest) || /%(2e|2f|5c|00)/i.test(path)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return undefined;
  return rest;
}

/**
 * The address to connect to, or undefined when it is not allowed: a public address; a private one only for a listed `host:port`
 * (or loopback on a route the owner configured, or the test hook); never a link-local or metadata one.
 */
async function publicAddress(
  host: string,
  o: EgressProxyOptions,
  port?: number,
  viaRoute = false,
): Promise<string | undefined> {
  const ip = isIP(host) ? host : await (o.resolve ?? (async (h) => (await lookup(h)).address))(host);
  if (o.allowPrivate) return ip;
  if (isNeverReachable(ip)) return undefined;
  if (!isPrivateAddress(ip)) return ip;
  if (port !== undefined && endpointListed(host, port, o.privateEndpoints ?? [])) return ip;
  if (viaRoute && (ip === '::1' || ip.startsWith('127.'))) return ip;
  return undefined;
}

function parseHostPort(target: string): { host: string; port: number } | undefined {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m?.[1] || !m[2]) return undefined;
  return { host: m[1], port: Number(m[2]) };
}

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * The canonical form (`testServiceDomain`) of each entry that is a loopback test-service host (127.0.0.1, ::1, localhost) with a
 * valid port; anything else (a LAN address, a wildcard, a bare host, another loopback address) is dropped.
 */
export function canonicalTestServices(entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const hp = parseHostPort(e);
    if (!hp || !validPort(hp.port)) continue;
    const host = normaliseTestServiceHost(hp.host);
    if (isTestServiceHost(host)) out.add(testServiceDomain({ host, port: hp.port }));
  }
  return [...out];
}

/**
 * True only when host and port both exactly match an entry (canonical `testServiceDomain` form). `[::1]` and `::1` are the same
 * host; no wildcard, range, whole-host or whole-loopback form exists.
 */
export function testServiceListed(host: string, port: number, entries: readonly string[]): boolean {
  if (entries.length === 0 || !validPort(port)) return false;
  const h = normaliseTestServiceHost(host);
  if (!isTestServiceHost(h)) return false;
  return entries.includes(testServiceDomain({ host: h, port }));
}

const guarded = (f: () => void): void => {
  try {
    f();
  } catch {
    // an observer error never breaks the response pipe
  }
};

function observeResponse(
  o: RouteObserver,
  upRes: IncomingMessage,
): { write(chunk: Buffer): void; end(): void } | undefined {
  try {
    return o.response?.(upRes.statusCode ?? 502, upRes.headers);
  } catch {
    return undefined;
  }
}

const inFlight = new WeakMap<EgressRoute, number>();
const routeBytes = new WeakMap<EgressRoute, number>();

/**
 * runner-bare-bin (B4, S8, S9): admission, buffering, the strict parse and the filter of one request on a filtered route. Every
 * failure is a status: 503 (busy), 415 (encoding or type), 400 (query, JSON), 413 (too big, the connection closed), 403 (the
 * filter). The route's slot and buffered bytes are released when the response ends.
 */
async function filterRequest(
  route: EgressRoute,
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  target: URL,
): Promise<
  | { fail: number; text: string; close?: boolean }
  | { body: Buffer; headers: Record<string, string>; observe?: RouteObserver }
> {
  const filter = route.requestFilter as NonNullable<EgressRoute['requestFilter']>;
  const n = inFlight.get(route) ?? 0;
  if (n >= MODEL_ROUTE_MAX_IN_FLIGHT) return { fail: 503, text: 'proxy busy' };
  inFlight.set(route, n + 1);
  let held = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inFlight.set(route, Math.max(0, (inFlight.get(route) ?? 1) - 1));
    bufferedBytes = Math.max(0, bufferedBytes - held);
    routeBytes.set(route, Math.max(0, (routeBytes.get(route) ?? 0) - held));
    held = 0;
  };
  res.on('close', release);
  res.on('finish', release);
  const enc = String(req.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  if (enc && enc !== 'identity') return { fail: 415, text: 'content-encoding not allowed' };
  const ct = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (ct !== 'application/json') return { fail: 415, text: 'content-type must be application/json' };
  if (target.search !== '' && target.search !== '?beta=true') return { fail: 400, text: 'query not allowed' };
  // the query is rebuilt, never forwarded raw
  target.search = target.search === '?beta=true' ? '?beta=true' : '';
  const max = route.maxRequestBytes ?? 32 * 1024 * 1024;
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max)
    return { fail: 413, text: 'request too large', close: true };
  const chunks: Buffer[] = [];
  const got = await new Promise<'ok' | 'big' | 'busy' | 'error'>((resolve) => {
    let size = 0;
    let settled = false;
    const done = (r: 'ok' | 'big' | 'busy' | 'error'): void => {
      if (settled) return;
      settled = true;
      if (r !== 'ok') {
        req.removeAllListeners('data');
        req.resume();
      }
      resolve(r);
    };
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > max) return done('big');
      if (bufferedBytes + c.length > maxBufferedBytes) return done('busy');
      // review S2: and this route's own share
      if ((routeBytes.get(route) ?? 0) + c.length > maxRouteBytes) return done('busy');
      bufferedBytes += c.length;
      routeBytes.set(route, (routeBytes.get(route) ?? 0) + c.length);
      held += c.length;
      chunks.push(c);
    });
    req.on('end', () => done('ok'));
    req.on('error', () => done('error'));
    req.on('aborted', () => done('error'));
  });
  if (got === 'big') return { fail: 413, text: 'request too large', close: true };
  if (got === 'busy') return { fail: 503, text: 'proxy busy' };
  if (got === 'error') return { fail: 400, text: 'request aborted' };
  let value: JsonValue;
  try {
    value = strictParse(Buffer.concat(chunks), { maxDepth: 64, maxNodes: 2_000_000 });
  } catch (err) {
    return { fail: 400, text: err instanceof StrictJsonError ? `bad JSON: ${err.message}` : 'bad JSON' };
  }
  let r: ReturnType<typeof filter>;
  try {
    r = filter(value, req.headers, target.pathname);
  } catch {
    return { fail: 400, text: 'the request could not be checked' };
  }
  if ('refuse' in r) {
    process.stderr.write(`deny model route ${target.pathname}: ${r.refuse.slice(0, 200)}\n`);
    return { fail: 403, text: `refused by the runner's model proxy: ${r.refuse}` };
  }
  let body: Buffer;
  try {
    body = Buffer.from(strictStringify(r.body), 'utf8');
  } catch {
    return { fail: 400, text: 'the request could not be rebuilt' };
  }
  const out: Record<string, string> = { ...r.headers };
  for (const [k, v] of Object.entries(route.headers)) out[k.toLowerCase()] = v;
  if (route.dynamicHeaders) {
    const extra = route.dynamicHeaders();
    if (!extra) return { fail: 503, text: 'no credential for the model on this computer' };
    for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = v;
  }
  for (const [k0, v] of Object.entries(route.requiredHeaders ?? {})) {
    const k = k0.toLowerCase();
    if (k === 'anthropic-beta' && out[k]) {
      const have = out[k].split(',').map((x) => x.trim());
      out[k] = [
        ...have,
        ...v
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && !have.includes(x)),
      ].join(',');
    } else out[k] = v;
  }
  out['content-length'] = String(body.length);
  out['accept-encoding'] = 'identity';
  if (route.observe?.request) {
    const o = route.observe;
    guarded(() => o.request?.(r.body, target.pathname));
  }
  return { body, headers: out, ...(route.observe ? { observe: route.observe } : {}) };
}

/** Starts the proxy on a Unix socket (mode 0600). The caller closes it when the session ends. */
export async function startEgressProxy(o: EgressProxyOptions): Promise<EgressProxy> {
  const denied = new Set<string>();
  const asked = new Set<string>();
  const deny = (host: string): void => {
    if (!denied.has(host)) {
      denied.add(host);
      o.onDeny?.(host);
    }
  };
  const portOk = (p: number): boolean => (o.allowedPorts ? o.allowedPorts.includes(p) : ALLOWED_PORTS.has(p));
  const sockets = new Set<Socket>();
  const routes = [...(o.routes ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);
  const testServices = canonicalTestServices(o.testServices ?? []);

  const server: Server = createHttpServer((req, res) => {
    // S8: a route never throws; whatever fails is an error status
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('proxy error');
      } catch {
        // the client is gone
      }
    });
  });

  const handle = async (req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    const fail = (code: number, text: string): void => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(text);
    };
    const raw = req.url ?? '/';
    let target: URL;
    let privateOk = false;
    let routeHit = false;
    let testHit: string | undefined;
    let filtered: { body: Buffer; headers: Record<string, string>; observe?: RouteObserver } | undefined;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
    for (const k of ['host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade'])
      delete headers[k];
    if (raw.startsWith('/')) {
      const route = routes.find(
        (r) => raw === r.prefix || raw.startsWith(`${r.prefix}/`) || raw.startsWith(`${r.prefix}?`),
      );
      if (!route) return fail(404, 'no such route');
      const rest = safeRoutePath(raw.slice(route.prefix.length));
      if (rest === undefined) return fail(400, 'bad path');
      const upstreamBase = route.upstream.replace(/\/+$/, '');
      try {
        target = new URL(upstreamBase + rest);
        const base = new URL(upstreamBase);
        const basePath = base.pathname.replace(/\/+$/, '');
        // the joined URL must stay on the upstream's origin and under its path prefix
        if (
          target.origin !== base.origin ||
          !(target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))
        )
          return fail(400, 'bad path');
      } catch {
        return fail(400, 'bad path');
      }
      if (!hostAllowed(target.hostname, [...o.allowedHosts, ...(o.routeHosts ?? [])])) {
        deny(target.hostname);
        return fail(403, 'host not allowed');
      }
      if (route.orgSourced && orgCredentialEndpointProblem(route.upstream, o.privateEndpoints ?? [])) {
        deny(target.hostname);
        return fail(403, 'endpoint not allowed');
      }
      if (route.allowPaths && !route.allowPaths.includes(target.pathname)) {
        deny(`${target.hostname}${target.pathname}`);
        return fail(403, 'path not allowed');
      }
      if (route.bearer !== undefined) {
        const given =
          (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined) ??
          (/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] || undefined);
        const a = Buffer.from(given ?? '');
        const b = Buffer.from(route.bearer);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return fail(401, 'not this session');
      }
      privateOk = route.allowPrivateUpstream === true && route.orgSourced !== true;
      routeHit = true;
      for (const k of ['authorization', 'x-goog-api-key', 'x-api-key', 'api-key', 'cookie'])
        delete headers[k];
      for (const [k, v] of Object.entries(route.headers)) headers[k.toLowerCase()] = v;
      if (route.dynamicHeaders) {
        const extra = route.dynamicHeaders();
        if (!extra) return fail(503, 'no credential for the model on this computer');
        for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
      }
      if (route.requestFilter) {
        const r = await filterRequest(route, req, res, target);
        if ('fail' in r) {
          if (r.close) res.setHeader('connection', 'close');
          return fail(r.fail, r.text);
        }
        filtered = r;
      }
    } else {
      try {
        target = new URL(raw);
      } catch {
        return fail(400, 'bad request');
      }
      // A declared local test service: exactly this loopback host and port, plain http, straight to this machine.
      if (
        target.protocol === 'http:' &&
        testServiceListed(target.hostname, Number(target.port || 80), testServices)
      )
        testHit = normaliseTestServiceHost(target.hostname);
      const listed = endpointListed(target.hostname, Number(target.port || 80), o.privateEndpoints ?? []);
      const port = Number(target.port || 80);
      if (!testHit && o.refuseHost?.(target.hostname)) {
        deny(target.hostname);
        return fail(403, 'host not allowed');
      }
      if (
        !testHit &&
        (target.protocol !== 'http:' ||
          !(
            listed ||
            endpointListed(target.hostname, port, o.publicEndpoints ?? []) ||
            (portOk(port) && hostAllowed(target.hostname, o.allowedHosts))
          ))
      ) {
        deny(target.hostname);
        return fail(403, 'host not allowed');
      }
    }
    asked.add(target.hostname);
    let ip: string | undefined = testHit;
    if (!ip)
      try {
        ip = await publicAddress(
          target.hostname,
          o,
          Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
          routeHit && privateOk,
        );
      } catch {
        return fail(502, 'name does not resolve');
      }
    if (!ip) {
      deny(target.hostname);
      return fail(403, 'address not allowed');
    }
    const secure = target.protocol === 'https:';
    const up = (secure ? httpsRequest : httpRequest)(
      {
        host: ip,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: filtered ? { ...filtered.headers, host: target.host } : { ...headers, host: target.host },
        servername: target.hostname,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        const sink = filtered?.observe ? observeResponse(filtered.observe, upRes) : undefined;
        if (sink) {
          upRes.on('data', (c: Buffer) => guarded(() => sink.write(c)));
          upRes.on('end', () => guarded(() => sink.end()));
        }
        upRes.pipe(res);
      },
    );
    up.on('error', () => fail(502, 'upstream error'));
    res.on('close', () => up.destroy());
    if (filtered) up.end(filtered.body);
    else req.pipe(up);
  };

  server.on('connect', (req, client: Socket, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const hp = parseHostPort(req.url ?? '');
    if (hp) asked.add(hp.host);
    const refuse = (code: string): void => {
      client.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
    };
    const tunnel = (ip: string, port: number): void => {
      const up = netConnect({ host: ip, port });
      sockets.add(up);
      up.on('close', () => sockets.delete(up));
      up.on('error', () => {
        refuse('502 Bad Gateway');
        up.destroy();
      });
      up.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      client.on('close', () => up.destroy());
    };
    // A declared local test service: exactly this loopback host and port, straight to this machine (never resolved by name
    // through the test hook, never through the private-address check, which would refuse loopback).
    if (hp && testServiceListed(hp.host, hp.port, testServices))
      return tunnel(normaliseTestServiceHost(hp.host), hp.port);
    if (hp && o.refuseHost?.(hp.host)) {
      deny(hp.host);
      return refuse('403 Forbidden');
    }
    const listed = !!hp && endpointListed(hp.host, hp.port, o.privateEndpoints ?? []);
    const pub = !!hp && endpointListed(hp.host, hp.port, o.publicEndpoints ?? []);
    if (!hp || !(listed || pub || (portOk(hp.port) && hostAllowed(hp.host, o.allowedHosts)))) {
      deny(hp?.host ?? '?');
      return refuse('403 Forbidden');
    }
    void publicAddress(hp.host, o, hp.port).then(
      (ip) => {
        if (!ip) {
          deny(hp.host);
          return refuse('403 Forbidden');
        }
        tunnel(ip, hp.port);
      },
      () => refuse('502 Bad Gateway'),
    );
  });

  rmSync(o.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, resolve);
  });
  try {
    chmodSync(o.socketPath, 0o600);
  } catch {
    // not supported everywhere
  }
  return {
    denied: () => [...denied],
    asked: () => [...asked],
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          rmSync(o.socketPath, { force: true });
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
