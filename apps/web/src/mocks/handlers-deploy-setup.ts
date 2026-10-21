import {
  compileSetup,
  localAdoptEnv,
  type ProbeReport,
  planChanges,
  SETUP_GENERATOR,
  sshShipEnv,
} from '@aom/shared';
import { HttpResponse, http } from 'msw';

/**
 * Mock server for the guided deploy setup (VITE_MSW=1 dev). The scenario comes from `localStorage['aom-mock-deploy']`:
 * `empty` (default), `ready` (a test copy and the live site, saved), `waiting` (saved, nobody tried it yet), `proposal`
 * (DevOps has a suggestion), `old` (the runner needs an update). A probe answers at once from fixed sample facts.
 */
const A = '/api';
const scenario = () =>
  (typeof localStorage !== 'undefined' && localStorage.getItem('aom-mock-deploy')) || 'empty';
const setScenario = (s: string) => localStorage.setItem('aom-mock-deploy', s);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const WS = '00000000-0000-4000-8000-0000000000a1';
const WS2 = '00000000-0000-4000-8000-0000000000a2';
const T1 = '00000000-0000-4000-8000-0000000000f1';
const T2 = '00000000-0000-4000-8000-0000000000f2';

const uatEnv = () =>
  localAdoptEnv({
    name: 'uat',
    label: 'Test copy',
    target: 'shop-uat',
    composeFile: '~/shop-uat/docker-compose.yml',
    composeProject: 'shop-uat',
    service: 'app',
    imageName: 'shop-uat-app',
    appUrl: 'http://localhost:8080',
    database: { service: 'postgres', dir: '~/shop-uat/backups' },
  });
const prodEnv = () =>
  sshShipEnv(
    {
      name: 'production',
      label: 'Live site',
      target: 'shop-live',
      host: 'prod-server',
      composeFile: '/opt/shop/docker-compose.yml',
      service: 'app',
      imageName: 'shop',
      imageVar: 'SHOP_IMAGE',
      healthUrl: 'https://shop.example.com/ready',
      database: { service: 'postgres', dir: '/opt/shop/backups' },
    },
    'uat',
  );
/** A throwaway RSA public key (SPKI, base64) so the browser can really seal a password; nobody holds the private half. */
const MOCK_RUNNER_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyPsQ9mQHfUXOPgmcIYCfzV7GKofuKILmFsVejRjpjKKAjQrjaeTVuH14F0X9p0w/VwGMmlaAbEE60Fou/E+1uIFsJbYpdWIO819i4jqvpZP0QJKHszgXW22NsdQVaUPjt6tXH3Zs0PLEnu0uy2aRoRQGSP505sI2/sGQf8vyJ5cDPVds9vyq9JOJqKJCL+1srIhpcFnwMuXVonT6DpR4EX8EPT6GnqHT1QtGNfSsDep6fcIUw+4nVFzE5I5UBQPPYhuUTDu6oYlVi16WdTOWAxg0IdoC+H5etwKy+ej9jFtJzZqxOaOfnj7WafB7V/ZDuk/cQowEt1j5XcCDC6rwdQIDAQAB';
const FP_ED = 'SHA256:5kXwQ2m0n7yT1p3QbZ9sJd8vLr4uHc6aGfE2iNoPtYw';
const ops = new Map<string, Record<string, unknown>>();
const op = (kind: string, ok: boolean, result: unknown, errorText: string | null = null) => {
  const id = crypto.randomUUID();
  ops.set(id, { id, kind, state: ok ? 'done' : 'failed', ok, result, errorText, at: ago(0) });
  return id;
};
const setup = () => {
  const c = compileSetup({ environments: [uatEnv(), prodEnv()] });
  return c.ok ? c.setup : null;
};

const base = {
  version: 1,
  mode: 'guided',
};
void base;

const part = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  ports: [],
  volumes: [],
  envFiles: [],
  vars: [],
  ...extra,
});
const localReport = () => ({
  scope: 'local',
  at: ago(1),
  docker: { installed: true, usable: true, version: '29.1.2', composeVersion: '2.40.0' },
  containers: [
    {
      name: 'shop-uat-app-1',
      project: 'shop-uat',
      service: 'app',
      image: 'shop-uat-app',
      state: 'running',
      status: 'Up 3 days',
      ports: [{ host: 8080, container: 4600, bind: '0.0.0.0' }],
    },
    {
      name: 'shop-uat-postgres-1',
      project: 'shop-uat',
      service: 'postgres',
      image: 'postgres:18',
      state: 'running',
      status: 'Up 3 days',
      ports: [],
    },
    {
      name: 'shop-uat-mailpit-1',
      project: 'shop-uat',
      service: 'mailpit',
      image: 'axllent/mailpit',
      state: 'running',
      ports: [],
    },
    { name: 'notes-db-1', project: 'notes', service: 'db', image: 'redis:7', state: 'running', ports: [] },
  ],
  composeFiles: [
    {
      path: '/home/ada/shop-uat/docker-compose.yml',
      project: 'shop-uat',
      services: [
        part('postgres', { image: 'postgres:18', database: 'postgres', volumes: ['pgdata'] }),
        part('app', { build: '/home/ada/src/shop', ports: ['8080:4600'] }),
        part('mailpit', { image: 'axllent/mailpit:latest' }),
      ],
      volumes: ['pgdata'],
    },
  ],
  volumes: ['shop-uat_pgdata', 'notes_data'],
  folders: [],
  backups: [
    {
      dir: '/home/ada/shop-uat/backups',
      count: 4,
      newestName: 'uat-before-ab12cd34.sql.gz',
      newestAt: ago(2880),
    },
  ],
  proxies: [],
  urls: [{ url: 'http://localhost:8080/api/health', status: 200 }],
  listeners: [],
});
const hostsReport = () => ({
  scope: 'ssh_hosts',
  at: ago(1),
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
  sshHosts: [
    { alias: 'prod-server', hostname: '192.0.2.10', user: 'root', hasIdentity: true, state: 'reachable' },
    { alias: 'fresh-vps', hostname: '192.0.2.77', user: 'root', hasIdentity: true, state: 'reachable' },
    {
      alias: 'backup-box',
      hostname: '192.0.2.44',
      user: 'ada',
      hasIdentity: false,
      state: 'asks_password',
      detail: 'it did not accept the sign-in without a password',
    },
    {
      alias: 'old-vps',
      hostname: '192.0.2.99',
      user: 'root',
      hasIdentity: true,
      state: 'host_key_changed',
      detail: "the server's identity changed",
    },
  ],
});
const serverReport = () => ({
  scope: 'ssh_target',
  host: 'prod-server',
  at: ago(1),
  docker: { installed: true, usable: true, version: '29.1.2', composeVersion: '2.40.0' },
  containers: [
    {
      name: 'shop-app-1',
      project: 'shop',
      service: 'app',
      image: 'shop:4f2c1ab',
      state: 'running',
      status: 'Up 2 days',
      ports: [],
    },
    {
      name: 'shop-postgres-1',
      project: 'shop',
      service: 'postgres',
      image: 'postgres:18',
      state: 'running',
      ports: [],
    },
    {
      name: 'caddy',
      image: 'caddy:2',
      state: 'running',
      ports: [{ host: 443, container: 443, bind: '0.0.0.0' }],
    },
  ],
  composeFiles: [
    {
      path: '/opt/shop/docker-compose.yml',
      project: 'shop',
      services: [
        part('app', { image: '${SHOP_IMAGE}', vars: ['SHOP_IMAGE'] }),
        part('postgres', { image: 'postgres:18', database: 'postgres' }),
      ],
      volumes: ['pgdata'],
    },
  ],
  volumes: ['shop_pgdata'],
  folders: [
    {
      path: '/opt/shop',
      exists: true,
      entries: ['docker-compose.yml', '.env', 'backups'],
      envKeys: ['SHOP_IMAGE', 'DATABASE_URL'],
      imageVars: [{ name: 'SHOP_IMAGE', value: 'shop:4f2c1ab' }],
    },
  ],
  backups: [
    {
      dir: '/opt/shop/backups',
      count: 9,
      newestName: 'production-before-4f2c1ab-2026.sql.gz',
      newestAt: ago(4320),
    },
  ],
  proxies: [{ kind: 'caddy', via: 'container', name: 'caddy', sites: ['shop.example.com'] }],
  urls: [{ url: 'https://shop.example.com/ready', status: 200 }],
  listeners: [80, 443],
});

const bareServerReport = () => ({
  scope: 'ssh_target',
  host: 'fresh-vps',
  at: ago(0),
  os: 'Linux x86_64',
  docker: { installed: false, usable: false },
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
});
const bareLocalReport = () => ({
  ...localReport(),
  containers: [],
  composeFiles: [],
  backups: [],
  volumes: [],
  urls: [],
});

let probes: Array<Record<string, unknown>> = [];
let published: Record<string, unknown> | null = null;
// ---- moving to a new server (v3): `localStorage['aom-mock-move']` is none | connected | preparing | failed | ready | moving | domain | done | standby | retired
const T3 = '00000000-0000-4000-8000-0000000000f3';
const MOVE_ID = '00000000-0000-4000-8000-0000000000e1';
const moveScenario = () =>
  (typeof localStorage !== 'undefined' && localStorage.getItem('aom-mock-move')) || 'none';
const setMove = (s: string) => {
  localStorage.setItem('aom-mock-move', s);
  localStorage.setItem('aom-mock-move-polls', '0');
};
const polls = () => Number(localStorage.getItem('aom-mock-move-polls') ?? '0');
const poll = () => localStorage.setItem('aom-mock-move-polls', String(polls() + 1));
const moveTargets = () => {
  const m = moveScenario();
  if (m === 'none') return [];
  const live = m === 'standby' || m === 'retired';
  return [
    {
      id: T3,
      name: live ? 'shop-live' : 'shop-new',
      kind: 'remote_ssh',
      production: live,
      workstationId: WS,
      workstationName: 'Office PC',
      workstationOnline: true,
      host: 'aom-shop-new',
      appUrl: live ? 'https://shop.example.com' : null,
      connection: { state: 'reachable', at: ago(2), detail: null, method: 'deploy_key' },
      keys: [],
      role: 'active',
    },
    ...(live
      ? [
          {
            id: T2,
            name: 'shop-live (old server)',
            kind: 'remote_ssh',
            production: true,
            workstationId: WS,
            workstationName: 'Office PC',
            workstationOnline: true,
            host: 'prod-server',
            appUrl: 'https://shop.example.com',
            connection: { state: 'reachable', at: ago(2), detail: null, method: 'existing_alias' },
            keys: [],
            role: m === 'retired' ? 'retired' : 'standby',
          },
        ]
      : []),
  ];
};
const stepDone = (step: string, text: string) => ({
  step,
  ok: true,
  detail: text,
  checks: [{ id: step, ok: true, text }],
  at: ago(1),
});
const moveDto = () => {
  const m = moveScenario();
  const waitedPrep = polls() >= 3;
  const waitedMove = polls() >= 3;
  const state =
    m === 'preparing'
      ? waitedPrep
        ? 'ready'
        : 'preparing'
      : m === 'moving'
        ? waitedMove
          ? 'app_ready'
          : 'moving'
        : m === 'domain'
          ? 'app_ready'
          : m === 'failed'
            ? 'failed'
            : m === 'ready'
              ? 'ready'
              : m;
  const prep = [
    stepDone('check', 'Docker works on both servers'),
    stepDone(
      'copy_config',
      '3 files (the compose file and 2 settings files, 14 settings) copied; nothing is shown',
    ),
    stepDone('copy_image', 'The app (shop:3f9c1ab0d2e4) was copied to the new server'),
    stepDone('start_database', 'The database on the new server is running and ready (still empty)'),
  ];
  const moved = [
    stepDone(
      'stop_and_backup',
      'A last backup is saved on the old server (/opt/shop/backups/move-20261021-120000.sql.gz)',
    ),
    stepDone('restore', 'The data is on the new server (24 tables, like the old database)'),
    stepDone('start_app', 'The app on the new server answers (/ready)'),
  ];
  const steps =
    state === 'preparing'
      ? prep.slice(0, Math.min(polls() + 1, 3))
      : state === 'ready'
        ? prep
        : state === 'moving'
          ? [...prep, moved[0]]
          : state === 'app_ready'
            ? [...prep, ...moved]
            : state === 'failed'
              ? [prep[0]]
              : [...prep, ...moved];
  return {
    id: MOVE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    envName: 'production',
    fromTargetId: T2,
    fromName: m === 'standby' || m === 'retired' ? 'shop-live (old server)' : 'shop-live',
    toTargetId: T3,
    toName: m === 'standby' || m === 'retired' ? 'shop-live' : 'shop-new',
    workstationId: WS,
    workstationName: 'Office PC',
    state: m === 'standby' || m === 'retired' ? 'completed' : state,
    currentStep:
      state === 'preparing'
        ? (['check', 'copy_config', 'copy_image'][Math.min(polls(), 2)] ?? 'check')
        : state === 'moving'
          ? 'restore'
          : state === 'failed'
            ? 'check'
            : null,
    steps,
    error: state === 'failed' ? 'The database (postgres) is not running on the old server' : null,
    oldAppStopped: state === 'moving' || state === 'app_ready',
    facts: { image: 'shop:3f9c1ab0d2e4', appPort: 4600 },
    domain: 'shop.example.com',
    newAddresses: ['203.0.113.9'],
    startedAt: ago(8),
    finishedAt: m === 'standby' || m === 'retired' ? ago(1) : null,
  };
};
const newServerReport = () => ({
  scope: 'ssh_target',
  at: ago(0),
  host: 'aom-shop-new',
  os: 'Linux x86_64',
  docker: { installed: true, usable: true, version: '27.3.1', composeVersion: '2.29.7' },
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [{ path: '/opt/shop', exists: false, entries: [] }],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
});

const probeDto = (scope: string, host: string | null, report: unknown, targetId: string | null = null) => ({
  id: crypto.randomUUID(),
  targetId,
  workstationId: WS,
  workstationName: 'Office PC',
  scope,
  host,
  at: ago(0),
  report,
  error: null,
  errorText: null,
});

function proposal() {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    area: 'deploy',
    status: 'open',
    requestId: '00000000-0000-4000-8000-0000000000d1',
    workstationId: WS,
    workstationName: 'Office PC',
    submittedAt: ago(3),
    proposal: {
      area: 'deploy',
      deploy: setup(),
      items: [
        { path: '/environments/0', confidence: 'found', evidence: [{ file: 'docker-compose.yml' }] },
        {
          path: '/environments/1/app/imageVar',
          confidence: 'guessed',
          evidence: [],
          note: 'the only setting that names an image',
        },
      ],
      questions: [
        {
          path: '/environments/1/app/imageVar',
          question: 'Which setting holds the app version on the server?',
          options: ['SHOP_IMAGE'],
          default: 'SHOP_IMAGE',
        },
      ],
      secretsNeeded: [],
      notes:
        'The test copy is a Docker Compose project called shop-uat. The live site is built here and shipped over ssh.',
      filesRead: ['docker-compose.yml', 'Dockerfile', 'deploy/Caddyfile', 'README.md'],
    },
  };
}

function state() {
  const s = scenario();
  const saved = s === 'ready' || s === 'waiting' || s === 'improved';
  const envs = saved ? setup() : null;
  return {
    canEdit: true,
    canApprove: true,
    draft: null,
    current: {
      setup: envs,
      handEdited: [],
      recipePresent: saved,
      recipeStatus: saved ? 'observed' : null,
      observedHash: saved ? 'a'.repeat(64) : null,
      approvedHash: null,
      lint: [],
      dryRunOk: s === 'ready' ? ['uat'] : [],
      custom: false,
    },
    publish: published,
    targets: [
      ...moveTargets(),
      {
        id: T1,
        name: 'shop-uat',
        kind: 'local_docker',
        production: false,
        workstationId: WS,
        workstationName: 'Office PC',
        workstationOnline: true,
        host: null,
        appUrl: 'http://localhost:8080',
        connection: null,
      },
      ...(moveScenario() === 'standby' || moveScenario() === 'retired'
        ? []
        : [
            {
              id: T2,
              name: 'shop-live',
              kind: 'remote_ssh',
              production: true,
              workstationId: WS,
              workstationName: 'Office PC',
              workstationOnline: true,
              host: 'prod-server',
              appUrl: 'https://shop.example.com',
              connection: saved
                ? { state: 'reachable', at: ago(5), detail: null, method: 'existing_alias' }
                : null,
              keys: [],
              role: 'active',
            },
          ]),
    ],
    workstations: [
      {
        id: WS,
        name: 'Office PC',
        connected: true,
        mine: true,
        canProbe: s !== 'old',
        blocked: s === 'old' ? 'Guildwise on Office PC needs an update for guided setup.' : null,
        canConnect: s !== 'old',
        canMove: s !== 'old',
      },
      {
        id: WS2,
        name: 'Old laptop',
        connected: false,
        mine: true,
        canProbe: false,
        blocked: 'Old laptop is offline.',
        canConnect: false,
      },
    ],
    probes,
    writeBlocked: null,
    scan: null,
    scanProblem: null,
    proposal: s === 'proposal' ? proposal() : null,
    generator: SETUP_GENERATOR,
    improvedAvailable: s === 'improved',
  };
}

export const deploySetupHandlers = [
  http.get(`${A}/projects/:id/delivery/moves`, () => {
    const m = moveScenario();
    if (m === 'preparing' || m === 'moving') poll();
    return HttpResponse.json({ moves: m === 'none' || m === 'connected' ? [] : [moveDto()] });
  }),
  http.post(`${A}/projects/:id/delivery/moves`, () => {
    setMove('preparing');
    return HttpResponse.json(moveDto(), { status: 201 });
  }),
  http.get(`${A}/projects/:id/delivery/moves/:moveId`, () => HttpResponse.json(moveDto())),
  http.post(`${A}/projects/:id/delivery/moves/:moveId/switch`, () => {
    setMove('moving');
    return HttpResponse.json(moveDto(), { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/moves/:moveId/retry`, () => {
    setMove('preparing');
    return HttpResponse.json(moveDto(), { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/moves/:moveId/cancel`, () => {
    setMove('none');
    return HttpResponse.json(moveDto(), { status: 202 });
  }),
  http.get(`${A}/projects/:id/delivery/moves/:moveId/dns`, () => {
    const n = Number(localStorage.getItem('aom-mock-dns') ?? '0');
    localStorage.setItem('aom-mock-dns', String(n + 1));
    const pointed = n >= 2 || localStorage.getItem('aom-mock-dns-new') === '1';
    return HttpResponse.json({
      domain: 'shop.example.com',
      state: pointed ? 'new' : 'old',
      expected: ['203.0.113.9'],
      found: [pointed ? '203.0.113.9' : '198.51.100.7'],
      oldAddresses: ['198.51.100.7'],
      at: ago(0),
      text: pointed
        ? 'shop.example.com points to the new server. Visitors reach it from now on.'
        : 'shop.example.com still points to the old server. Change it to 203.0.113.9 where your domain is managed; it can take a few minutes (sometimes hours) to spread.',
    });
  }),
  http.post(`${A}/projects/:id/delivery/moves/:moveId/complete`, () => {
    setMove('standby');
    return HttpResponse.json(moveDto());
  }),
  http.post(`${A}/projects/:id/delivery/targets/:targetId/retire`, () => {
    setMove('retired');
    return HttpResponse.json({ commandId: crypto.randomUUID() }, { status: 202 });
  }),
  http.get(`${A}/projects/:id/delivery/setup`, () => HttpResponse.json(state())),
  http.put(`${A}/projects/:id/delivery/setup`, () => HttpResponse.json(state())),
  http.post(`${A}/projects/:id/delivery/probe`, async ({ request }) => {
    const b = (await request.json()) as { scope: string; host?: string };
    const report =
      b.scope === 'ssh_target' && (b as { targetId?: string }).targetId === T3
        ? newServerReport()
        : b.scope === 'local'
          ? localStorage.getItem('aom-mock-local') === 'bare'
            ? bareLocalReport()
            : localReport()
          : b.scope === 'ssh_hosts'
            ? hostsReport()
            : b.host === 'fresh-vps'
              ? bareServerReport()
              : serverReport();
    const tid = (b as { targetId?: string }).targetId ?? null;
    probes = [
      ...probes.filter(
        (p) => !(p.scope === b.scope && (p.host ?? null) === (b.host ?? null) && p.targetId === tid),
      ),
      probeDto(b.scope, b.host ?? null, report, tid),
    ];
    return HttpResponse.json({ commandId: crypto.randomUUID(), workstationId: WS }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/setup/preview`, async ({ request }) => {
    const b = (await request.json()) as { setup: unknown };
    const c = compileSetup(b.setup);
    if (!c.ok)
      return HttpResponse.json({
        ok: false,
        issues: c.issues,
        hash: null,
        files: [],
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: false,
        needsDryRun: [],
      });
    return HttpResponse.json({
      ok: true,
      issues: [],
      hash: c.hash,
      files: c.files,
      keep: c.keep,
      lint: [],
      changes: planChanges(c.setup, {
        uat: localReport() as unknown as ProbeReport,
        production: serverReport() as unknown as ProbeReport,
      }),
      differsFromCurrent: true,
      needsDryRun: c.setup.environments.map((e) => e.name),
    });
  }),
  http.post(`${A}/projects/:id/delivery/setup/publish`, async () => {
    published = { setupHash: 'a'.repeat(64), commandId: 'c1', status: 'written', error: null, at: ago(0) };
    setScenario('waiting');
    return HttpResponse.json({ commandId: 'c1', hash: 'a'.repeat(64) }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/setup/dry-run`, () => {
    setScenario('ready');
    return HttpResponse.json({ message: 'Queued on Office PC.', runs: [{ status: 'queued' }] });
  }),
  http.post(`${A}/projects/:id/delivery/setup/use-proposal`, () => {
    setScenario('waiting');
    return HttpResponse.json(state());
  }),
  http.post(`${A}/projects/:id/scan`, async ({ request }) => {
    const b = (await request.json()) as { area?: string };
    if (b.area === 'deploy') setScenario('proposal');
    return HttpResponse.json({ requestId: crypto.randomUUID() }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/deploy-targets`, () => HttpResponse.json({ id: T1 })),
  http.patch(`${A}/deploy-targets/:id`, () => HttpResponse.json({ id: T1 })),
  http.get(`${A}/projects/:id/delivery/probes`, () => HttpResponse.json({ probes })),
  // guided connect (v2): every operation answers at once with sample facts
  http.get(`${A}/workstations/:id/sudo-key`, () =>
    HttpResponse.json({ keyId: 'mock-key', publicKey: MOCK_RUNNER_KEY }),
  ),
  http.post(`${A}/projects/:id/delivery/hostkey`, async ({ request }) => {
    const b = (await request.json()) as { address: string };
    const id = /^(nowhere|bad)/.test(b.address)
      ? op(
          'hostkey',
          false,
          { ok: false, error: 'unreachable' },
          'This computer cannot reach that address. Check the address and that the server is on.',
        )
      : op('hostkey', true, { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP_ED, bits: 256 }] });
    return HttpResponse.json({ commandId: id, workstationId: WS }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/key`, () =>
    HttpResponse.json(
      {
        commandId: op('key', true, {
          ok: true,
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuildwiseDedicatedKeyForShop guildwise-deploy:9f3a7c1e:Office-PC',
          fingerprint: FP_ED,
          existed: false,
        }),
        workstationId: WS,
      },
      { status: 202 },
    ),
  ),
  http.post(`${A}/projects/:id/delivery/connect`, async ({ request }) => {
    const b = (await request.json()) as { newTarget?: { name: string }; targetId?: string; method: string };
    const ok = localStorage.getItem('aom-mock-connect') !== 'wrong';
    const id = ok
      ? op('connect', true, { ok: true, installed: b.method === 'panel' ? 'pasted' : 'added' })
      : op(
          'connect',
          false,
          { ok: false, error: 'bad_password' },
          'The server did not accept that user name and password. Check them in your hosting company’s email or panel, then try again.',
        );
    localStorage.setItem('aom-mock-reach', 'ok');
    return HttpResponse.json(
      { commandId: id, workstationId: WS, targetId: b.targetId ?? T2, alias: 'aom-shop-live' },
      { status: 202 },
    );
  }),
  http.post(`${A}/projects/:id/delivery/targets/:targetId/revoke-key`, () =>
    HttpResponse.json(
      { commandId: op('revoke', true, { ok: true, removed: 1 }), workstationId: WS },
      { status: 202 },
    ),
  ),
  http.post(`${A}/projects/:id/delivery/targets/:targetId/check`, () => {
    localStorage.setItem('aom-mock-reach', 'ok');
    return HttpResponse.json({ commandId: crypto.randomUUID(), workstationId: WS }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/prepare`, async ({ request }) => {
    const b = (await request.json()) as {
      dryRun: boolean;
      actions: Array<{ kind: string; path?: string; domain?: string }>;
    };
    const steps = b.actions.map((a) => ({
      kind: a.kind,
      outcome: b.dryRun
        ? 'would'
        : a.kind === 'create_dir' && a.path?.endsWith('backups')
          ? 'skipped'
          : 'done',
      detail:
        a.kind === 'install_docker'
          ? b.dryRun
            ? 'install Docker with the system packages'
            : 'Docker installed'
          : a.kind === 'caddy_site'
            ? `${b.dryRun ? 'add' : 'added'} ${a.domain} to Caddy`
            : a.kind === 'write_compose'
              ? `${b.dryRun ? 'write' : 'wrote'} ${a.path}`
              : `${b.dryRun ? 'create' : 'created'} ${a.path ?? ''}`,
    }));
    return HttpResponse.json(
      { commandId: op('prepare', true, { ok: true, steps }), workstationId: WS },
      { status: 202 },
    );
  }),
  http.get(`${A}/projects/:id/delivery/ops/:commandId`, ({ params }) => {
    const o = ops.get(String(params.commandId));
    return o
      ? HttpResponse.json(o)
      : HttpResponse.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
  }),
];
