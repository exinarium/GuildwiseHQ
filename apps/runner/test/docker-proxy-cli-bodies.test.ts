import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DockerGate, LABEL, startDockerProxy, type Verdict } from '../src/box/docker-proxy.ts';
import { cleanupTmp, tmp } from './helpers.ts';

/**
 * gate-fixes-2 F5: the gatekeeper against the bodies the REAL docker CLI 29.10.0 (API 1.57) and compose v5.8.0 send,
 * captured on this machine by test/fixtures/docker-cli/capture.mjs (a recording relay on a unix socket, DOCKER_HOST at it).
 */
cleanupTmp();
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

type Fixture = {
  command: string;
  requests: Array<{ method: string; path: string }>;
  bodies: Array<{ method: string; path: string; body: unknown }>;
};
const FIX = join(import.meta.dirname, 'fixtures', 'docker-cli');
const CAPTURED_BIND = '/tmp/gwcap-bind';
const load = (name: string, bindRoot = CAPTURED_BIND): Fixture =>
  JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8').replaceAll(CAPTURED_BIND, bindRoot));
const FIXTURES = readdirSync(FIX)
  .filter((f) => f.endsWith('.json') && f !== 'VERSIONS.json')
  .map((f) => f.slice(0, -5));

const env = () => {
  const root = realpathSync(tmp('aom-dkc-'));
  const bind = join(root, 'scratch');
  mkdirSync(bind);
  const gate = new DockerGate({ instance: 'inst-1', bindRoots: [bind], containerEgress: false });
  // the networks the captured commands made (through the gate, in the outer box)
  for (const n of ['gwcap-net', 'gwcap_default']) gate.networks.add(n);
  return { gate, bind };
};

/** Which gate check a captured POST goes to. */
const checkOf = (gate: DockerGate, path: string): ((b: unknown) => Verdict) => {
  const p = path.split('?')[0]?.replace(/^\/v\d+\.\d+/, '') ?? '';
  if (p === '/containers/create') return (b) => gate.createContainer(b);
  if (/^\/containers\/[^/]+\/exec$/.test(p)) return (b) => gate.execCreate(b);
  if (p === '/networks/create') return (b) => gate.createNetwork(b);
  if (p === '/volumes/create') return (b) => gate.createVolume(b);
  if (/^\/networks\/[^/]+\/connect$/.test(p)) return (b) => gate.networkConnect(b);
  throw new Error(`no check for ${path}`);
};

/**
 * The test's own schema of what may reach the daemon (independent of the proxy's lists): 1 = a scalar or a list of
 * scalars, `{'*': S}` = a map of names to S, `[S]` = a list of S.
 */
type Schema = 1 | { [k: string]: Schema } | [Schema];
const ENDPOINT: Schema = { Aliases: 1, DNSNames: 1 };
const CREATE_SCHEMA: Schema = {
  Image: 1,
  Cmd: 1,
  Entrypoint: 1,
  Env: 1,
  WorkingDir: 1,
  Labels: { '*': 1 },
  ExposedPorts: { '*': {} },
  Tty: 1,
  OpenStdin: 1,
  StdinOnce: 1,
  AttachStdin: 1,
  AttachStdout: 1,
  AttachStderr: 1,
  StopSignal: 1,
  StopTimeout: 1,
  Hostname: 1,
  User: 1,
  Healthcheck: { Test: 1, Interval: 1, Timeout: 1, StartPeriod: 1, StartInterval: 1, Retries: 1 },
  NetworkingConfig: { EndpointsConfig: { '*': ENDPOINT } },
  HostConfig: {
    Binds: 1,
    NetworkMode: 1,
    Memory: 1,
    NanoCpus: 1,
    AutoRemove: 1,
    Init: 1,
    ShmSize: 1,
    ConsoleSize: 1,
    Tmpfs: { '*': 1 },
    RestartPolicy: { Name: 1, MaximumRetryCount: 1 },
    PortBindings: { '*': [{ HostIp: 1, HostPort: 1 }] },
    Mounts: [
      {
        Type: 1,
        Source: 1,
        Target: 1,
        ReadOnly: 1,
        VolumeOptions: { NoCopy: 1, Labels: { '*': 1 } },
        TmpfsOptions: { SizeBytes: 1, Mode: 1 },
        BindOptions: { CreateMountpoint: 1 },
      },
    ],
  },
};
const SCHEMAS: Record<string, Schema> = {
  '/containers/create': CREATE_SCHEMA,
  exec: {
    AttachStdin: 1,
    AttachStdout: 1,
    AttachStderr: 1,
    Tty: 1,
    Cmd: 1,
    Env: 1,
    WorkingDir: 1,
    DetachKeys: 1,
    ConsoleSize: 1,
  },
  '/networks/create': { Name: 1, Labels: { '*': 1 }, Internal: 1 },
  '/volumes/create': { Name: 1, Labels: { '*': 1 } },
};
const schemaOf = (path: string): Schema => {
  const p = path.split('?')[0]?.replace(/^\/v\d+\.\d+/, '') ?? '';
  return SCHEMAS[/\/exec$/.test(p) ? 'exec' : p] as Schema;
};
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
/** Every path in `v` that `s` does not allow. */
function outside(v: unknown, s: Schema, at: string): string[] {
  if (s === 1) return isScalar(v) || (Array.isArray(v) && v.every(isScalar)) ? [] : [at];
  if (v === null) return [];
  if (Array.isArray(s)) return Array.isArray(v) ? v.flatMap((x, i) => outside(x, s[0], `${at}[${i}]`)) : [at];
  if (typeof v !== 'object' || Array.isArray(v)) return [at];
  const o = v as Record<string, unknown>;
  if (Object.hasOwn(s, '*'))
    return Object.keys(o).flatMap((k) => outside(o[k], s['*'] as Schema, `${at}.${k}`));
  return Object.keys(o).flatMap((k) =>
    Object.hasOwn(s, k) ? outside(o[k], s[k] as Schema, `${at}.${k}`) : [`${at}.${k}`],
  );
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// biome-ignore lint/suspicious/noExplicitAny: the tests mutate captured JSON bodies at any depth
type Body = Record<string, any>;
const bodyOf = (name: string, i: number, bindRoot?: string): Body =>
  clone(load(name, bindRoot).bodies[i]?.body) as Body;

describe('gate-fixes-2 F5: the bodies the real docker CLI and compose send', () => {
  it('the fixtures are the real CLI’s (versions recorded) and cover the commands the box allows', () => {
    const v = JSON.parse(readFileSync(join(FIX, 'VERSIONS.json'), 'utf8'));
    expect(v).toMatchObject({ docker: '29.10.0', api: '1.57', compose: '5.8.0' });
    expect(FIXTURES.sort()).toEqual(
      [
        'compose-exec',
        'compose-up',
        'create',
        'exec',
        'exec-tty',
        'network-create',
        'run',
        'run-mounts',
        'run-network-none',
        'run-tty',
        'volume-create',
      ].sort(),
    );
    // the CLI really does send zero values off the allowlist (the bug: `body.Domainname is not allowed`)
    expect(bodyOf('run', 0)).toMatchObject({
      Domainname: '',
      HostConfig: { Privileged: false, CapAdd: null },
    });
  });

  it.each(FIXTURES)(
    '%s: every captured body is accepted, and only allowlisted keys reach the daemon',
    (name) => {
      const { gate, bind } = env();
      const f = load(name, bind);
      expect(f.bodies.length).toBeGreaterThan(0);
      for (const { path, body } of f.bodies) {
        const v = checkOf(gate, path)(body);
        expect(v, `${name} ${path}: ${JSON.stringify(v)}`).toMatchObject({ ok: true });
        if (!v.ok) continue;
        expect(outside(v.body, schemaOf(path), 'body'), `${name} ${path}`).toEqual([]);
      }
    },
  );

  it('S5: classify() refuses none of the requests the captured commands make', () => {
    const { gate } = env();
    for (const name of FIXTURES)
      for (const { method, path } of load(name).requests)
        expect(gate.classify(method, path).kind, `${name}: ${method} ${path}`).not.toBe('refuse');
  });

  it('the settled zero values: default network re-keyed, null Binds absent, anonymous volumes, the CLI defaults dropped', () => {
    const { gate, bind } = env();
    // `docker run`: NetworkMode "default" and the CLI's all-zero `default` endpoint go to the gate's internal network
    const run = gate.createContainer(bodyOf('run', 0));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const b = run.body as Body;
    expect(run.defaultNetwork).toBe(true);
    expect(b.HostConfig.NetworkMode).toBe(gate.defaultNetworkName);
    expect(b.NetworkingConfig).toEqual({
      EndpointsConfig: { [gate.defaultNetworkName]: { Aliases: null, DNSNames: null } },
    });
    expect(b.HostConfig).not.toHaveProperty('Binds');
    expect(b.HostConfig).not.toHaveProperty('MemorySwappiness');
    expect(b.HostConfig.RestartPolicy).toEqual({ Name: 'no', MaximumRetryCount: 0 });
    expect(b).not.toHaveProperty('Volumes');
    expect(b).not.toHaveProperty('Domainname');
    expect(b.Labels).toEqual({ [LABEL]: 'inst-1' });
    // `default` with any other network mode is still refused
    const other = bodyOf('run', 0);
    other.HostConfig.NetworkMode = 'gwcap-net';
    expect(gate.createContainer(other).ok).toBe(false);
    // mounts: the named volume is checked against the daemon, the bind root is kept, `-v /anon` makes no volume
    const m = gate.createContainer(bodyOf('run-mounts', 0, bind));
    expect(m).toMatchObject({ ok: true, volumes: ['gwcap-vol'] });
    if (m.ok) {
      expect((m.body as Body).HostConfig.Mounts).toEqual([
        { Type: 'volume', Source: 'gwcap-vol', Target: '/q' },
        { Type: 'bind', Source: bind, Target: '/w', ReadOnly: true },
      ]);
      expect((m.body as Body).HostConfig.PortBindings).toEqual({
        '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }],
      });
    }
    // compose v5 puts its named volume in Binds: the labelled check applies
    const db = gate.createContainer(bodyOf('compose-up', 1));
    expect(db).toMatchObject({ ok: true, volumes: ['gwcap_gwcapdata'] });
    if (db.ok)
      expect((db.body as Body).HostConfig.Binds).toEqual(['gwcap_gwcapdata:/var/lib/postgresql/data:rw']);
    // a mount volume Source "" is an anonymous volume, like an absent one
    const anon = gate.createContainer({
      Image: 'x',
      HostConfig: { Mounts: [{ Type: 'volume', Source: '', Target: '/d' }] },
    });
    expect(anon).toMatchObject({ ok: true });
    if (anon.ok) expect((anon.body as Body).HostConfig.Mounts).toEqual([{ Type: 'volume', Target: '/d' }]);
    // exec drops the zero User and Privileged
    const ex = gate.execCreate(bodyOf('exec-tty', 0));
    expect(ex).toMatchObject({ ok: true });
    if (ex.ok) {
      expect(ex.body).not.toHaveProperty('User');
      expect(ex.body).not.toHaveProperty('Privileged');
      expect((ex.body as Body).ConsoleSize).toEqual([24, 80]);
    }
    // network and volume create: the daemon defaults are dropped, the label is added, internal without egress
    const n = gate.createNetwork(bodyOf('network-create', 0));
    expect(n).toMatchObject({
      ok: true,
      body: { Name: 'gwcap-net', Labels: { [LABEL]: 'inst-1' }, Internal: true },
    });
    const vol = gate.createVolume(bodyOf('volume-create', 0));
    expect(vol).toEqual({ ok: true, body: { Name: 'gwcap-vol', Labels: { [LABEL]: 'inst-1' } } });
  });

  it('zero-drop: MaskedPaths [], ReadonlyPaths [], Devices [{}] and MemorySwappiness 0 are accepted and never forwarded', () => {
    const { gate } = env();
    const b = bodyOf('run', 0);
    Object.assign(b.HostConfig, { MaskedPaths: [], ReadonlyPaths: [], Devices: [{}], MemorySwappiness: 0 });
    const v = gate.createContainer(b);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    for (const k of ['MaskedPaths', 'ReadonlyPaths', 'Devices', 'MemorySwappiness'])
      expect((v.body as Body).HostConfig, k).not.toHaveProperty(k);
  });

  describe('negatives: each a captured body with one field mutated, each refused', () => {
    const create: Array<[string, (b: Body) => void]> = [
      ['Domainname "x"', (b) => (b.Domainname = 'x')],
      ['MacAddress', (b) => (b.MacAddress = '02:42:ac:11:00:02')],
      ['image "y"', (b) => (b.image = 'y')],
      ['Privileged true', (b) => (b.HostConfig.Privileged = true)],
      ['privileged true', (b) => (b.HostConfig.privileged = true)],
      ['CapAdd SYS_ADMIN', (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
      ...(['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'] as const).map(
        (k): [string, (b: Body) => void] => [`${k} host`, (b) => (b.HostConfig[k] = 'host')],
      ),
      ['Devices /dev/kvm', (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }])],
      ['DeviceRequests', (b) => (b.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }])],
      ['DeviceCgroupRules', (b) => (b.HostConfig.DeviceCgroupRules = ['c 1:3 mr'])],
      ['SecurityOpt', (b) => (b.HostConfig.SecurityOpt = ['seccomp=unconfined'])],
      ['LogConfig syslog', (b) => (b.HostConfig.LogConfig = { Type: 'syslog', Config: {} })],
      [
        'LogConfig syslog-address',
        (b) => (b.HostConfig.LogConfig = { Type: '', Config: { 'syslog-address': 'tcp://x' } }),
      ],
      ['Links', (b) => (b.HostConfig.Links = ['a:b'])],
      ['VolumesFrom', (b) => (b.HostConfig.VolumesFrom = ['a'])],
      ['VolumeDriver', (b) => (b.HostConfig.VolumeDriver = 'nfs')],
      ['Sysctls', (b) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
      ['CgroupParent', (b) => (b.HostConfig.CgroupParent = '/')],
      ['PublishAllPorts', (b) => (b.HostConfig.PublishAllPorts = true)],
      ['Runtime', (b) => (b.HostConfig.Runtime = 'runc-unsafe')],
      ['GroupAdd', (b) => (b.HostConfig.GroupAdd = ['docker'])],
      ['OomScoreAdj -1000', (b) => (b.HostConfig.OomScoreAdj = -1000)],
      ['ExtraHosts', (b) => (b.HostConfig.ExtraHosts = ['a:1.2.3.4'])],
      ['MaskedPaths "0"', (b) => (b.HostConfig.MaskedPaths = ['0'])],
      ['Mounts npipe', (b) => b.HostConfig.Mounts.push({ Type: 'npipe', Source: '/x', Target: '/y' })],
      ['Mounts bind /etc', (b) => b.HostConfig.Mounts.push({ Type: 'bind', Source: '/etc', Target: '/y' })],
      [
        'BindOptions Propagation rshared',
        (b) => (b.HostConfig.Mounts[1].BindOptions = { Propagation: 'rshared' }),
      ],
      [
        'VolumeOptions DriverConfig',
        (b) => (b.HostConfig.Mounts[0].VolumeOptions = { DriverConfig: { Name: 'local' } }),
      ],
      ['VolumeOptions Subpath', (b) => (b.HostConfig.Mounts[0].VolumeOptions = { Subpath: 'x' })],
      [
        'TmpfsOptions Options',
        (b) =>
          b.HostConfig.Mounts.push({ Type: 'tmpfs', Target: '/t', TmpfsOptions: { Options: [['exec']] } }),
      ],
      ['NetworkMode host', (b) => (b.HostConfig.NetworkMode = 'host')],
      ['NetworkMode container:x', (b) => (b.HostConfig.NetworkMode = 'container:x')],
      ['EndpointsConfig bridge', (b) => (b.NetworkingConfig = { EndpointsConfig: { bridge: {} } })],
      ...(['IPAMConfig', 'MacAddress', 'DriverOpts', 'Links'] as const).map(
        (k): [string, (b: Body) => void] => [
          `gate network endpoint ${k}`,
          (b) =>
            (b.NetworkingConfig = {
              EndpointsConfig: {
                'gwcap-net': {
                  [k]:
                    k === 'IPAMConfig'
                      ? { IPv4Address: '10.0.0.9' }
                      : k === 'MacAddress'
                        ? '02:42:ac:11:00:09'
                        : k === 'DriverOpts'
                          ? { x: 'y' }
                          : ['a:b'],
                },
              },
            }),
        ],
      ),
      ['PortBindings HostIp ""', (b) => (b.HostConfig.PortBindings['5432/tcp'][0].HostIp = '')],
      ['PortBindings HostIp 0.0.0.0', (b) => (b.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0')],
      ['RestartPolicy X', (b) => (b.HostConfig.RestartPolicy = { Name: 'no', X: 1 })],
      ['Healthcheck X', (b) => (b.Healthcheck = { Test: ['NONE'], X: 'y' })],
      ['host bind :rshared', (b) => (b.HostConfig.Binds = [`${b.HostConfig.Mounts[1].Source}:/w:rshared`])],
      ['host bind :z', (b) => (b.HostConfig.Binds = [`${b.HostConfig.Mounts[1].Source}:/w:z`])],
      ['host bind :Z', (b) => (b.HostConfig.Binds = [`${b.HostConfig.Mounts[1].Source}:/w:Z`])],
      ['host bind a:b:ro:x', (b) => (b.HostConfig.Binds = [`${b.HostConfig.Mounts[1].Source}:/w:ro:x`])],
      [
        'host bind ro,rshared',
        (b) => (b.HostConfig.Binds = [`${b.HostConfig.Mounts[1].Source}:/w:ro,rshared`]),
      ],
      ['named volume bind :z', (b) => (b.HostConfig.Binds = ['gwcap-vol:/q:z'])],
      ['ExposedPorts value', (b) => (b.ExposedPorts = { '5432/tcp': { x: 1 } })],
      ['Labels non-string', (b) => (b.Labels = { a: { b: 'c' } })],
      ['Cmd object', (b) => (b.Cmd = [{ a: 1 }])],
    ];
    it.each(create)('create: %s', (_, mutate) => {
      const { gate, bind } = env();
      const b = bodyOf('run-mounts', 0, bind);
      expect(gate.createContainer(clone(b)).ok).toBe(true);
      mutate(b);
      expect(gate.createContainer(b)).toMatchObject({ ok: false });
    });

    it('default endpoint with a gate NetworkMode', () => {
      const { gate } = env();
      const b = bodyOf('run', 0);
      b.HostConfig.NetworkMode = 'gwcap-net';
      expect(gate.createContainer(b).ok).toBe(false);
    });

    it('a named-volume bind of a foreign volume goes to the labelled check (and is refused end to end)', async () => {
      const { gate } = env();
      const b = bodyOf('compose-up', 1);
      b.HostConfig.Binds = ['aom-uat_pgdata:/var/lib/postgresql/data:rw'];
      expect(gate.createContainer(b)).toMatchObject({ ok: true, volumes: ['aom-uat_pgdata'] });
      const d = await fakeDaemon();
      b.HostConfig.NetworkMode = 'none';
      delete b.NetworkingConfig;
      expect((await d.call('POST', '/v1.57/containers/create?name=x', JSON.stringify(b))).status).toBe(403);
      b.HostConfig.Binds = ['gw-vol:/var/lib/postgresql/data:rw'];
      expect((await d.call('POST', '/v1.57/containers/create?name=x', JSON.stringify(b))).status).toBe(200);
      await d.proxy.close();
    });

    const network: Array<[string, (b: Body) => void]> = [
      ['Driver macvlan', (b) => (b.Driver = 'macvlan')],
      ['IPAM Driver x', (b) => (b.IPAM.Driver = 'x')],
      ['IPAM Subnet', (b) => (b.IPAM.Config = [{ Subnet: '10.9.0.0/16' }])],
      ['Options bridge.name', (b) => (b.Options = { 'com.docker.network.bridge.name': 'docker0' })],
      ['Ingress', (b) => (b.Ingress = true)],
      ['ConfigFrom', (b) => (b.ConfigFrom = { Network: 'x' })],
      ['Scope swarm', (b) => (b.Scope = 'swarm')],
      ['EnableIPv6', (b) => (b.EnableIPv6 = true)],
    ];
    it.each(network)('network create: %s', (_, mutate) => {
      const { gate } = env();
      const b = bodyOf('network-create', 0);
      expect(gate.createNetwork(clone(b)).ok).toBe(true);
      mutate(b);
      expect(gate.createNetwork(b).ok).toBe(false);
    });

    it('volume create: Driver nfs, DriverOpts bind', () => {
      const { gate } = env();
      const b = bodyOf('volume-create', 0);
      expect(gate.createVolume({ ...b, Driver: 'nfs' }).ok).toBe(false);
      expect(gate.createVolume({ ...b, DriverOpts: { type: 'none', o: 'bind', device: '/' } }).ok).toBe(
        false,
      );
    });

    it('exec: Privileged true, User root; connect: EndpointConfig IPAMConfig', () => {
      const { gate } = env();
      const b = bodyOf('exec', 0);
      expect(gate.execCreate({ ...b, Privileged: true }).ok).toBe(false);
      expect(gate.execCreate({ ...b, User: 'root' }).ok).toBe(false);
      expect(
        gate.networkConnect({ Container: 'c', EndpointConfig: { Aliases: ['a'], DNSNames: ['a'] } }).ok,
      ).toBe(true);
      expect(
        gate.networkConnect({ Container: 'c', EndpointConfig: { IPAMConfig: { IPv4Address: '10.0.0.2' } } })
          .ok,
      ).toBe(false);
    });

    it('S1: __proto__ at body level, in HostConfig, Labels and PortBindings', () => {
      const { gate, bind } = env();
      const raw = JSON.stringify(bodyOf('run-mounts', 0, bind));
      const variants = [
        raw.replace('{', '{"__proto__":1,'),
        raw.replace('"HostConfig":{', '"HostConfig":{"__proto__":1,'),
        raw.replace('"Labels":{', '"Labels":{"__proto__":"x"'),
        raw.replace('"PortBindings":{', '"PortBindings":{"__proto__":[{"HostIp":"127.0.0.1"}],'),
        raw.replace('{', '{"__proto__":{},'),
      ];
      for (const v of variants) {
        expect(v).not.toBe(raw);
        expect(gate.createContainer(JSON.parse(v)), v.slice(0, 80)).toMatchObject({ ok: false });
      }
      expect(({} as Body).polluted).toBeUndefined();
    });
  });

  it('S2: an array nested 10,000 deep gets a 400, and the next request is still answered', async () => {
    const d = await fakeDaemon();
    const deep = `{"Image":"x","HostConfig":{"NetworkMode":"none","Foo":${'['.repeat(10_000)}${']'.repeat(10_000)}}}`;
    expect((await d.call('POST', '/v1.57/containers/create', deep)).status).toBe(400);
    expect((await d.call('GET', '/v1.57/_ping')).status).toBe(200);
    expect(
      (await d.call('POST', '/v1.57/containers/create', '{"Image":"x","HostConfig":{"NetworkMode":"none"}}'))
        .status,
    ).toBe(200);
    await d.proxy.close();
  });
});

describe('gate-fixes-2 F5: a streamed answer', () => {
  it('the answer headers of a scoped request reach the client before its body (docker run waits on them)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-dkw-'));
    const upstream = join(dir, 'docker.sock');
    let finish: (() => void) | undefined;
    const fake = createServer((req, res) => {
      req.resume();
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes('/wait')) {
        // like dockerd: headers flushed now, the body only when the container is gone
        res.writeHead(200);
        res.flushHeaders();
        finish = () => res.end('{"StatusCode":0}');
        return;
      }
      res.end(JSON.stringify({ Config: { Labels: { [LABEL]: 'i' } } }));
    });
    servers.push(fake);
    await new Promise<void>((r) => fake.listen(upstream, () => r()));
    const socketPath = join(dir, 'gate.sock');
    const proxy = await startDockerProxy({
      socketPath,
      upstream,
      policy: { instance: 'i', bindRoots: [], containerEgress: false },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer headers within 2 s')), 2_000);
      httpRequest(
        { socketPath, path: '/v1.57/containers/mine/wait?condition=removed', method: 'POST' },
        (res) => {
          clearTimeout(t);
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      ).end();
    });
    expect(status).toBe(200);
    finish?.();
    await proxy.close();
  });
});

/** A fake daemon behind a real proxy: volumes `gw-vol` and containers `mine` are the gate's own. */
async function fakeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'aom-dkf-'));
  const upstream = join(dir, 'docker.sock');
  const fake = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const u = (req.url ?? '').replace(/^\/v1\.\d+/, '');
      const v = /^\/volumes\/([^/]+)$/.exec(u);
      if (v)
        return res.end(JSON.stringify({ Labels: v[1] === 'gw-vol' ? { [LABEL]: 'i' } : { other: '1' } }));
      if (u === '/_ping') return res.end('OK');
      res.end('{}');
    });
  });
  servers.push(fake);
  await new Promise<void>((r) => fake.listen(upstream, () => r()));
  const socketPath = join(dir, 'gate.sock');
  const proxy = await startDockerProxy({
    socketPath,
    upstream,
    policy: { instance: 'i', bindRoots: [], containerEgress: false },
  });
  const call = (method: string, path: string, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const req = httpRequest(
        { socketPath, path, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.end(body);
    });
  return { proxy, call };
}

/**
 * S5: the real docker CLI and compose through the gatekeeper to the real daemon on this computer. Opt-in
 * (`GW_LIVE_DOCKER=1`): it starts containers. Names are `gwlive<pid>*` only, removed by exact name.
 */
describe.skipIf(process.env.GW_LIVE_DOCKER !== '1')(
  'gate-fixes-2 F5 live: the real CLI through the gatekeeper',
  () => {
    it('docker run, compose up -d --wait, compose exec and compose down work through the proxy', async () => {
      const upstream = process.env.GW_LIVE_DOCKER_SOCKET ?? '/var/run/docker.sock';
      const dir = mkdtempSync(join(tmpdir(), 'gwlive-'));
      const instance = `gwlive${process.pid}`;
      const project = `gwlive${process.pid}`;
      const socketPath = join(dir, 'gate.sock');
      const refused: string[] = [];
      const proxy = await startDockerProxy({
        socketPath,
        upstream,
        policy: { instance, bindRoots: [], containerEgress: false },
        onRefuse: (r) => refused.push(r),
      });
      // async: the proxy runs in this process, so a blocking spawn would starve it
      const docker = (...args: string[]) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const p = spawn('docker', args, {
            cwd: dir,
            env: { ...process.env, DOCKER_HOST: `unix://${socketPath}`, DOCKER_CONTEXT: '' },
            timeout: 120_000,
          });
          let out = '';
          p.stdout.on('data', (c) => (out += c));
          p.stderr.on('data', (c) => (out += c));
          p.on('close', (code) => resolve({ code, out }));
        });
      const real = (...args: string[]) =>
        spawnSync('docker', ['-H', `unix://${upstream}`, ...args], { encoding: 'utf8', timeout: 60_000 });
      writeFileSync(
        join(dir, 'compose.test-services.yml'),
        [
          'services:',
          '  db:',
          '    image: postgres:16',
          '    environment:',
          '      POSTGRES_PASSWORD: test',
          '    ports:',
          '      - "127.0.0.1::5432"',
          '    volumes:',
          '      - data:/var/lib/postgresql/data',
          '    healthcheck:',
          '      test: ["CMD", "pg_isready", "-U", "postgres"]',
          '      interval: 1s',
          '      retries: 30',
          'volumes:',
          '  data: {}',
          '',
        ].join('\n'),
      );
      const compose = (...a: string[]) =>
        docker('compose', '-p', project, '-f', 'compose.test-services.yml', ...a);
      try {
        const run = await docker('run', '--rm', 'postgres:16', 'true');
        console.log(`[live] docker run --rm postgres:16 true -> exit ${run.code}\n${run.out}`);
        expect(run.code, run.out).toBe(0);
        const up = await compose('up', '-d', '--wait');
        console.log(`[live] docker compose up -d --wait -> exit ${up.code}\n${up.out}`);
        expect(up.code, up.out).toBe(0);
        const ex = await compose('exec', '-T', 'db', 'true');
        console.log(`[live] docker compose exec -T db true -> exit ${ex.code}\n${ex.out}`);
        expect(ex.code, ex.out).toBe(0);
        const down = await compose('down', '-v', '--timeout', '1');
        console.log(`[live] docker compose down -v -> exit ${down.code}\n${down.out}`);
        expect(down.code, down.out).toBe(0);
        console.log(`[live] refusals: ${JSON.stringify(refused)}`);
        // only compose's lookups of its own objects before they exist, or after down removed them (by name or id): 404
        for (const r of refused)
          expect(r).toMatch(
            new RegExp(`^(networks|volumes) (${project}_(default|data)|[0-9a-f]{64}) is not Guildwise's$`),
          );
      } finally {
        // exact names only, on the real daemon
        real('rm', '-f', `${project}-db-1`);
        real('volume', 'rm', `${project}_data`);
        real('network', 'rm', `${project}_default`, proxy.gate.defaultNetworkName);
        await proxy.close();
      }
    }, 300_000);
  },
);
