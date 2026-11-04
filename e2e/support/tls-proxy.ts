import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { requireBindable, requireDeclared } from './test-services.ts';

/**
 * A transparent TLS-terminating proxy in front of the hosted build. It NEVER adds, changes or removes a response header:
 * if it did, an HSTS check would test the proxy and not the build. It only adds the x-forwarded-* request headers the
 * app (trustProxy) reads to see an https request.
 */
export function makeCert(dir: string): { certPath: string; keyPath: string } {
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'proxy-cert.pem');
  const keyPath = join(dir, 'proxy-key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  return { certPath, keyPath };
}

export type TlsProxy = { url: string; port: number; caPath: string; close: () => Promise<void> };

export async function startTlsProxy(opts: {
  target: string;
  port: number;
  host?: string;
  certDir: string;
  /** skip the test-services checks (unit tests on ephemeral ports) */
  unchecked?: boolean;
}): Promise<TlsProxy> {
  const target = new URL(opts.target);
  const targetPort = Number(target.port || 80);
  if (!opts.unchecked) {
    requireDeclared(targetPort, 'hosted build');
    requireBindable(opts.port, 'TLS proxy');
  }
  const { certPath, keyPath } = makeCert(opts.certDir);
  const host = opts.host ?? '127.0.0.1';

  const forwarded = (req: http.IncomingMessage): http.OutgoingHttpHeaders => ({
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-for': req.socket.remoteAddress ?? '',
  });

  const server = https.createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (req, res) => {
      const up = http.request(
        {
          host: target.hostname,
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: forwarded(req),
        },
        (r) => {
          // status and headers are copied exactly as the upstream sent them
          res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders as unknown as string[]);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`hosted build at ${opts.target} refused the connection`);
      });
      req.pipe(up);
    },
  );

  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(targetPort, target.hostname, () => {
      const h = forwarded(req);
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(h)) for (const x of [v].flat()) raw += `${k}: ${x}\r\n`;
      up.write(`${raw}\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(
              `port ${opts.port} (TLS proxy) is in use: it is declared as a local test service and bridged, or a stale proxy still runs`,
            )
          : e,
      );
    });
    server.listen(opts.port, host, resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `https://localhost:${port}`,
    port,
    caPath: certPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(opts.certDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
