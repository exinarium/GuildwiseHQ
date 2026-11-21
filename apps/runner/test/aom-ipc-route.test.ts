import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCeoSettings,
  buildChatSettings,
  buildShiftSettings,
  ipcDomains,
  scanSandboxBlock,
} from '../src/adapters/claude-policy.ts';
import { connectFallback, ipcFetch, proxyFetch, sandboxProxy, socketFetch } from '../src/aom/aom-cli.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

/**
 * The 1.10.0 UAT blocker: with the credential scrub on, Claude Code runs `aom` inside the sandbox, where Unix sockets are
 * refused. The route is the runner's loopback endpoint through the sandbox's proxy: exactly one allowlist entry, and the
 * CLI's last fallback. aom-sandbox-real.test.ts proves it against the real Claude Code.
 */

const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};
const URL_ = 'http://127.0.0.1:45319';

describe('ipcDomains: the runner endpoint as the one sandbox network entry', () => {
  it('takes only an http loopback literal with an explicit port', () => {
    expect(ipcDomains({ ipcUrl: URL_ })).toEqual(['127.0.0.1:45319']);
    expect(ipcDomains({ ipcUrl: `${URL_}/` })).toEqual(['127.0.0.1:45319']);
    expect(ipcDomains({ ipcUrl: 'http://[::1]:8080' })).toEqual(['[::1]:8080']);
    for (const bad of [
      undefined,
      '',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
      'https://127.0.0.1:443',
      'http://localhost:4000',
      'http://10.0.0.1:4000',
      'http://127.0.0.1:4000/path',
      'http://127.0.0.1:4000@evil.example:80',
      'http://*:4000',
    ])
      expect(ipcDomains({ ipcUrl: bad }), String(bad)).toEqual([]);
  });

  it('every sandboxed profile gets it (shift roles, offline reviewer, chat, CEO, scan) and nothing else changes', () => {
    const ctx = policyCtx({ ipcUrl: URL_, ipcSocket: '/tmp/aom-ipc-x/ipc.sock' });
    const without = policyCtx({ ipcSocket: '/tmp/aom-ipc-x/ipc.sock' });
    for (const r of BUILTIN_ROLES.filter((x) => x.key !== 'devops')) {
      const a = buildShiftSettings(r.permissions, ctx, POLICY_PATHS, r.key).sandbox;
      const b = buildShiftSettings(r.permissions, without, POLICY_PATHS, r.key).sandbox;
      expect(a?.network.allowedDomains, r.key).toContain('127.0.0.1:45319');
      expect(
        a?.network.allowedDomains.filter((d) => d !== '127.0.0.1:45319'),
        r.key,
      ).toEqual(b?.network.allowedDomains);
      expect(a?.network.allowUnixSockets).toEqual(['/tmp/aom-ipc-x/ipc.sock']);
      expect(a?.allowUnsandboxedCommands).toBe(false);
    }
    const offline = buildShiftSettings(role('reviewer').permissions, ctx, POLICY_PATHS, 'reviewer', false, {
      offline: true,
    });
    expect(offline.sandbox?.network.allowedDomains).toEqual(['127.0.0.1:45319']);
    expect(buildChatSettings(true, [], ctx, POLICY_PATHS).sandbox?.network.allowedDomains).toEqual([
      '127.0.0.1:45319',
    ]);
    expect(buildCeoSettings(ctx, POLICY_PATHS).sandbox?.network.allowedDomains).toEqual(['127.0.0.1:45319']);
    expect(buildCeoSettings(without, POLICY_PATHS).sandbox?.network.allowedDomains).toEqual([]);
    expect(scanSandboxBlock(ctx, POLICY_PATHS).network.allowedDomains).toEqual(['127.0.0.1:45319']);
  });

  it('the DevOps engineer (unsandboxed) has no sandbox block to widen', () => {
    const s = buildShiftSettings(
      role('devops').permissions,
      policyCtx({ ipcUrl: URL_ }),
      POLICY_PATHS,
      'devops',
      true,
    );
    expect(s.sandbox).toBeUndefined();
  });
});

describe('aom over the sandbox proxy', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const listen = async (
    handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void,
  ): Promise<number> => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => handler(req, body, res));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as { port: number }).port;
  };
  /** A refused loopback port (bound then closed). */
  const deadPort = async (): Promise<number> => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    return p;
  };

  it('sandboxProxy reads HTTP_PROXY (credential kept), ignores NO_PROXY, skips a non-URL', () => {
    expect(sandboxProxy({ HTTP_PROXY: 'http://u:p@127.0.0.1:3128', NO_PROXY: '127.0.0.1' })?.host).toBe(
      '127.0.0.1:3128',
    );
    expect(sandboxProxy({ http_proxy: 'nope', HTTPS_PROXY: 'http://127.0.0.1:3129' })?.port).toBe('3129');
    expect(sandboxProxy({})).toBeUndefined();
    // REVIEW B2: an inherited proxy on another host never carries a shift's call
    for (const off of [
      'http://proxy.corp:3128',
      'http://10.0.0.1:3128',
      'http://127.0.0.1.evil.example:3128',
    ])
      expect(sandboxProxy({ HTTP_PROXY: off }), off).toBeUndefined();
    expect(sandboxProxy({ HTTP_PROXY: 'http://u:p@localhost:3128' })?.hostname).toBe('localhost');
    expect(sandboxProxy({ HTTP_PROXY: 'http://[::1]:3128' })?.port).toBe('3128');
    expect(sandboxProxy({ HTTP_PROXY: 'socks5://127.0.0.1:1080' })).toBeUndefined();
  });

  it('sends the call to the runner through the proxy: absolute URL, proxy credential, body and token', async () => {
    let seen: { url?: string; auth?: string; token?: string; body?: string } = {};
    const proxyPort = await listen((req, body, res) => {
      seen = {
        url: req.url,
        auth: req.headers['proxy-authorization'] as string,
        token: req.headers.authorization as string,
        body,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"result":{"message":"hi"}}');
    });
    const f = proxyFetch(new URL(`http://us%40r:p%3Ass@127.0.0.1:${proxyPort}`));
    const r = await f(`${URL_}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: '{"method":"ceo"}',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, result: { message: 'hi' } });
    expect(seen).toEqual({
      url: `${URL_}/v1/rpc`,
      auth: `Basic ${Buffer.from('us@r:p:ss').toString('base64')}`,
      token: 'Bearer tok',
      body: '{"method":"ceo"}',
    });
  });

  it("the proxy's own refusal is an error that names the endpoint, not a runner answer", async () => {
    const proxyPort = await listen((_req, _body, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Connection blocked by network allowlist');
    });
    await expect(proxyFetch(new URL(`http://127.0.0.1:${proxyPort}`))(`${URL_}/v1/rpc`)).rejects.toThrow(
      /sandbox proxy refused the runner's endpoint 127\.0\.0\.1:45319 \(Connection blocked/,
    );
  });

  it('ipcFetch: socket refused (EPERM in the sandbox), loopback refused, then the proxy reaches the runner', async () => {
    const runner = await listen((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: req.url, body }));
    });
    // a forward proxy that relays absolute-form requests to the runner
    const proxyPort = await listen((req, body, res) => {
      const u = new URL(req.url ?? '');
      fetch(`http://127.0.0.1:${runner}${u.pathname}`, { method: req.method, body: body || undefined }).then(
        async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        },
        () => res.end(),
      );
    });
    const dead = await deadPort();
    const f = ipcFetch({
      AOM_IPC_SOCKET: '/nonexistent/aom-ipc/ipc.sock',
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    const r = await f(`http://127.0.0.1:${dead}/v1/rpc`, { method: 'POST', body: '{"x":1}' });
    expect(await r.json()).toEqual({ via: '/v1/rpc', body: '{"x":1}' });
  });

  it('ipcFetch without a proxy fails as before, with the hint and both causes', async () => {
    const dead = await deadPort();
    const f = ipcFetch({ AOM_IPC_SOCKET: '/nonexistent/aom-ipc/ipc.sock' });
    await expect(f(`http://127.0.0.1:${dead}/v1/rpc`, { method: 'POST', body: '{}' })).rejects.toThrow(
      /Run aom as a standalone command.*ENOENT; fetch failed/,
    );
  });

  it('ipcFetch with a non-loopback HTTP_PROXY sends nothing to it (REVIEW B2)', async () => {
    let hits = 0;
    // a "company proxy" that would answer: never asked (0.0.0.0 reaches this machine on Linux but is not a loopback name)
    const proxyPort = await listen((_req, _body, res) => {
      hits++;
      res.end('{}');
    });
    const dead = await deadPort();
    const f = ipcFetch({
      AOM_IPC_SOCKET: '/nonexistent/aom-ipc/ipc.sock',
      HTTP_PROXY: `http://0.0.0.0:${proxyPort}`,
    });
    await expect(
      f(`http://127.0.0.1:${dead}/v1/rpc`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok' },
        body: '{"method":"handoff"}',
      }),
    ).rejects.toThrow(/ECONNREFUSED|fetch failed/);
    expect(hits).toBe(0);
  });

  it('socketFetch falls back only when the socket was never reached; a reset after connecting is not resent (REVIEW S1)', async () => {
    const { createServer: netServer } = await import('node:net');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const sock = join(mkdtempSync(join(tmpdir(), 'aom-s1-')), 's.sock');
    // accepts the connection, reads the call, then drops it without an answer: the call may have run
    const srv = netServer((c) => c.once('data', () => c.destroy()));
    await new Promise<void>((r) => srv.listen(sock, r));
    let sent = 0;
    const next = (async () => {
      sent++;
      return new Response('{}');
    }) as typeof fetch;
    try {
      await expect(
        socketFetch(sock, next)('http://localhost/v1/rpc', {
          method: 'POST',
          body: '{"method":"devops.install"}',
        }),
      ).rejects.toThrow(/ECONNRESET|socket hang up/);
      expect(sent).toBe(0);
      // a socket that is not there at all: nothing was sent, the next route is used
      await socketFetch(join(dirname(sock), 'none.sock'), next)('http://localhost/v1/rpc', {
        method: 'POST',
        body: '{}',
      });
      expect(sent).toBe(1);
    } finally {
      srv.close();
    }
  });

  it('connectFallback never resends a call that reached the runner (only connect-phase errors fall through)', async () => {
    let second = 0;
    const next = (async () => {
      second++;
      return new Response('{}');
    }) as typeof fetch;
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(
      connectFallback((async () => Promise.reject(reset)) as typeof fetch, next)('http://x/'),
    ).rejects.toBe(reset);
    expect(second).toBe(0);
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    });
    await connectFallback((async () => Promise.reject(refused)) as typeof fetch, next)('http://x/');
    expect(second).toBe(1);
  });
});
