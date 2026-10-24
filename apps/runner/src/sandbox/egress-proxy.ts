import { lookup } from 'node:dns/promises';
import { chmodSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, connect as netConnect, type Socket } from 'node:net';

/**
 * The network of a harness sandbox (docs/RUNNER.md, "Sandbox parity of the other runtimes"). The sandboxed CLI has no network
 * interface of its own: a bridge inside the sandbox forwards 127.0.0.1:<port> to this proxy's Unix socket, and `HTTPS_PROXY` points
 * the CLI and every command it starts at that port. The proxy
 * - lets a CONNECT through only to a host on the allow-list (the model API, the package registries, the per-shift target), on
 *   port 443 or 80, and only to a public address (a name that resolves to loopback, a private range or the metadata address is
 *   refused, so an allowed name cannot be used to reach the runner or the LAN);
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

/** Loopback, private, link-local (the cloud metadata address included), unique-local, carrier-grade NAT and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

const ALLOWED_PORTS = new Set([80, 443]);

async function publicAddress(host: string, o: EgressProxyOptions): Promise<string | undefined> {
  const ip = isIP(host) ? host : await (o.resolve ?? (async (h) => (await lookup(h)).address))(host);
  if (!o.allowPrivate && isPrivateAddress(ip)) return undefined;
  return ip;
}

function parseHostPort(target: string): { host: string; port: number } | undefined {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m?.[1] || !m[2]) return undefined;
  return { host: m[1], port: Number(m[2]) };
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
  const sockets = new Set<Socket>();
  const routes = [...(o.routes ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  const handle = async (req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    const fail = (code: number, text: string): void => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(text);
    };
    const raw = req.url ?? '/';
    let target: URL;
    let privateOk = false;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
    for (const k of ['host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade'])
      delete headers[k];
    if (raw.startsWith('/')) {
      const route = routes.find(
        (r) => raw === r.prefix || raw.startsWith(`${r.prefix}/`) || raw.startsWith(`${r.prefix}?`),
      );
      if (!route) return fail(404, 'no such route');
      target = new URL(route.upstream.replace(/\/+$/, '') + raw.slice(route.prefix.length));
      if (!hostAllowed(target.hostname, o.allowedHosts)) {
        deny(target.hostname);
        return fail(403, 'host not allowed');
      }
      privateOk = route.allowPrivateUpstream === true;
      for (const k of ['authorization', 'x-goog-api-key', 'x-api-key', 'api-key', 'cookie'])
        delete headers[k];
      for (const [k, v] of Object.entries(route.headers)) headers[k.toLowerCase()] = v;
    } else {
      try {
        target = new URL(raw);
      } catch {
        return fail(400, 'bad request');
      }
      if (target.protocol !== 'http:' || !hostAllowed(target.hostname, o.allowedHosts)) {
        deny(target.hostname);
        return fail(403, 'host not allowed');
      }
    }
    asked.add(target.hostname);
    let ip: string | undefined;
    try {
      ip = await publicAddress(target.hostname, privateOk ? { ...o, allowPrivate: true } : o);
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
        headers: { ...headers, host: target.host },
        servername: target.hostname,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => fail(502, 'upstream error'));
    res.on('close', () => up.destroy());
    req.pipe(up);
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
    if (!hp || !ALLOWED_PORTS.has(hp.port) || !hostAllowed(hp.host, o.allowedHosts)) {
      deny(hp?.host ?? '?');
      return refuse('403 Forbidden');
    }
    void publicAddress(hp.host, o).then(
      (ip) => {
        if (!ip) {
          deny(hp.host);
          return refuse('403 Forbidden');
        }
        const up = netConnect({ host: ip, port: hp.port });
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
