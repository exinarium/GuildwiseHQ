import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { caLine, healthFetch, instanceCaPath, loadInstanceCa, tlsHint } from '../src/health/instance-ca.ts';
import { binHome } from './bin-home.ts';

/**
 * runner-bare-bin (requirement 3, criterion 5): `guildwise-runner doctor` run by hand (no NODE_EXTRA_CA_CERTS) uses the
 * instance CA file the unit passes, for its health fetches only; a missing file stays a clear FAIL, never a crash.
 */
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** A CA and a server certificate for 127.0.0.1 signed by it, in a 0700 folder outside /tmp. */
function pki(): { dir: string; ca: string; key: string; cert: string } {
  const dir = binHome();
  const run = (args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  run([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Test Instance CA',
  ]);
  run([
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    'srv.key',
    '-out',
    'srv.csr',
    '-subj',
    '/CN=127.0.0.1',
  ]);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
  run([
    'x509',
    '-req',
    '-in',
    'srv.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'srv.pem',
    '-days',
    '2',
    '-extfile',
    'ext.cnf',
  ]);
  chmodSync(join(dir, 'ca.pem'), 0o644);
  return { dir, ca: join(dir, 'ca.pem'), key: join(dir, 'srv.key'), cert: join(dir, 'srv.pem') };
}

async function healthServer(p: { key: string; cert: string }): Promise<string> {
  const s = createServer({ key: readFileSync(p.key), cert: readFileSync(p.cert) }, (_q, r) => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end('{"ok":true}');
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `https://127.0.0.1:${(s.address() as { port: number }).port}/api/health`;
}

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('runner-bare-bin: doctor loads the instance CA', () => {
  it('names the file the installer and the unit use, for both runner users and a person', () => {
    expect(instanceCaPath('guildwise-runner', '/home/x')).toBe('/etc/guildwise-runner/ca.pem');
    expect(instanceCaPath('guildwise-runner-uat', '/home/x')).toBe('/etc/guildwise-runner-uat/ca.pem');
    expect(instanceCaPath('alice', '/home/alice')).toBe('/home/alice/.local/share/guildwise/runner/ca.pem');
  });

  it.skipIf(!hasOpenssl)(
    'a hand run without NODE_EXTRA_CA_CERTS reaches the server with the instance CA; without it, a TLS error',
    async () => {
      const p = pki();
      const url = await healthServer(p);
      const ca = loadInstanceCa({ env: NO_ENV, user: 'alice', home: '/nowhere', path: p.ca });
      expect(ca.kind).toBe('ok');
      expect(caLine(ca)).toEqual({ ok: true, detail: p.ca });
      expect(await healthFetch(url, ca.kind === 'ok' ? ca.pem : undefined)).toEqual({
        ok: true,
        status: 200,
      });
      // without the CA (what a hand run did before): a certificate error, and the hint names the missing file
      const missing = loadInstanceCa({
        env: NO_ENV,
        user: 'alice',
        home: '/nowhere',
        path: join(p.dir, 'none.pem'),
      });
      expect(missing.kind).toBe('missing');
      expect(caLine(missing)).toBeNull();
      let err: unknown;
      try {
        await healthFetch(url, undefined);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(tlsHint(err, missing)).toMatch(/no usable instance CA at .*none\.pem/);
    },
  );

  it('NODE_EXTRA_CA_CERTS set: Node already has it, nothing is loaded', () => {
    expect(loadInstanceCa({ env: { NODE_EXTRA_CA_CERTS: '/x/ca.pem' }, user: 'alice', home: '/h' })).toEqual({
      kind: 'env',
      path: '/x/ca.pem',
    });
  });

  it.skipIf(!hasOpenssl)(
    'refuses a link, a group-writable file or parent, a private key and garbage (a FAIL line, no throw)',
    () => {
      const p = pki();
      const at = (name: string, body: string, mode = 0o644): string => {
        const f = join(p.dir, name);
        writeFileSync(f, body);
        chmodSync(f, mode);
        return f;
      };
      const load = (path: string) => loadInstanceCa({ env: NO_ENV, user: 'alice', home: '/nowhere', path });
      const pem = readFileSync(p.ca, 'utf8');
      const link = join(p.dir, 'link.pem');
      symlinkSync(p.ca, link);
      expect(load(link)).toMatchObject({ kind: 'refused', reason: /symbolic link/ });
      expect(load(at('gw.pem', pem, 0o664))).toMatchObject({ kind: 'refused', reason: /group or others/ });
      expect(load(at('key.pem', `${pem}\n${readFileSync(p.key, 'utf8')}`))).toMatchObject({
        kind: 'refused',
        reason: /private key/,
      });
      expect(load(at('junk.pem', 'hello'))).toMatchObject({ kind: 'refused', reason: /no certificate/ });
      expect(
        load(at('bad.pem', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n')),
      ).toMatchObject({ kind: 'refused', reason: /does not parse/ });
      const sub = join(p.dir, 'open');
      mkdirSync(sub);
      chmodSync(sub, 0o777);
      writeFileSync(join(sub, 'ca.pem'), pem, { mode: 0o644 });
      const r = load(join(sub, 'ca.pem'));
      expect(r).toMatchObject({ kind: 'refused', reason: /writable by group or others/ });
      expect(caLine(r)).toMatchObject({ ok: false });
      // the /etc layout wants root: the same good file, owned by this user, is refused there
      expect(
        loadInstanceCa({
          env: NO_ENV,
          user: 'guildwise-runner-uat',
          home: '/h',
          path: p.ca,
          etcLayout: true,
          rootUid: 0,
        }),
      ).toMatchObject({ kind: 'refused', reason: /belongs to uid/ });
    },
  );
});
