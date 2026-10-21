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

let probes: Array<Record<string, unknown>> = [];
let published: Record<string, unknown> | null = null;
const probeDto = (scope: string, host: string | null, report: unknown) => ({
  id: crypto.randomUUID(),
  targetId: null,
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
  const saved = s === 'ready' || s === 'waiting';
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
        connection: saved ? { state: 'reachable', at: ago(5), detail: null } : null,
      },
    ],
    workstations: [
      {
        id: WS,
        name: 'Office PC',
        connected: true,
        mine: true,
        canProbe: s !== 'old',
        blocked: s === 'old' ? 'Guildwise on Office PC needs an update for guided setup.' : null,
      },
      {
        id: WS2,
        name: 'Old laptop',
        connected: false,
        mine: true,
        canProbe: false,
        blocked: 'Old laptop is offline.',
      },
    ],
    probes,
    writeBlocked: null,
    scan: null,
    scanProblem: null,
    proposal: s === 'proposal' ? proposal() : null,
    generator: SETUP_GENERATOR,
  };
}

export const deploySetupHandlers = [
  http.get(`${A}/projects/:id/delivery/setup`, () => HttpResponse.json(state())),
  http.put(`${A}/projects/:id/delivery/setup`, () => HttpResponse.json(state())),
  http.post(`${A}/projects/:id/delivery/probe`, async ({ request }) => {
    const b = (await request.json()) as { scope: string; host?: string };
    const report =
      b.scope === 'local' ? localReport() : b.scope === 'ssh_hosts' ? hostsReport() : serverReport();
    probes = [
      ...probes.filter((p) => !(p.scope === b.scope && (p.host ?? null) === (b.host ?? null))),
      probeDto(b.scope, b.host ?? null, report),
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
];
