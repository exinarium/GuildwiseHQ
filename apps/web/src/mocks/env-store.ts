import {
  compileSetup,
  type DeliverySetup,
  directEnv,
  localAdoptEnv,
  type ProbeReport,
  SETUP_GENERATOR,
  type SetupEnv,
  sshShipEnv,
} from '@aom/shared';

/**
 * The state behind the mocked Environments page (VITE_MSW=1 dev and the screenshots). A scenario name in
 * `localStorage['aom-mock-deploy']` seeds a small world (saved setup, places, what was tried and approved, a DevOps
 * suggestion, what is live); every change the page makes (save, try, approve, add or remove a place) is kept in
 * `localStorage['aom-mock-env']`, so a reload shows it and the journeys of docs/design/environments-ux.md can be walked.
 *
 * Scenarios: `empty` (default), `proposal` (DevOps has a suggestion with questions), `waiting` (saved, nobody tried it),
 * `ready` (test site tried), `approved` (everything approved and live), `p5` (a local stack and a server whose stack lives
 * under /home/administrator, a literal image tag, a duplicate place, an unfinished draft, an old file), `failed`,
 * `offline` (a server nobody can sign in to), `member` (read-only), `old` (the runner needs an update), `improved`.
 */

export const WS = '00000000-0000-4000-8000-0000000000a1';
export const WS2 = '00000000-0000-4000-8000-0000000000a2';
export const T1 = '00000000-0000-4000-8000-0000000000f1';
export const T2 = '00000000-0000-4000-8000-0000000000f2';
export const T4 = '00000000-0000-4000-8000-0000000000f4';
export const T5 = '00000000-0000-4000-8000-0000000000f5';
export const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000c1';

export const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export interface TargetRec {
  id: string;
  name: string;
  kind: 'local_docker' | 'remote_ssh';
  production: boolean;
  workstationId: string | null;
  workstationName: string | null;
  workstationOnline: boolean | null;
  host: string | null;
  appUrl: string | null;
  reach: 'reachable' | 'unreachable' | 'host_key_changed' | 'asks_password' | null;
  reachAgo: number;
  role: 'active' | 'standby' | 'retired';
}

export interface RunRec {
  version: string;
  commit: string;
  sinceMin: number;
  health: 'healthy' | 'unhealthy' | 'unknown' | 'updating';
  failed?: { step: string; reason: string; wentBackTo?: string };
}

export interface Store {
  scenario: string;
  setup: DeliverySetup | null;
  status: 'none' | 'observed' | 'approved' | 'changed_unapproved';
  hash: string;
  approvedHash: string | null;
  tried: string[];
  targets: TargetRec[];
  draft: DeliverySetup | null;
  unmodelled: string[];
  proposal: { open: boolean; answers: Record<string, string | number | boolean> };
  runs: Record<string, RunRec>;
  member: boolean;
  old: boolean;
  improved: boolean;
}

const hex = () => Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

// ------------------------------------------------------------------------------------------------ environments

export const uatEnv = (): SetupEnv =>
  localAdoptEnv({
    name: 'uat',
    label: 'Test site',
    target: 'shop-uat',
    composeFile: '~/shop-uat/docker-compose.yml',
    composeProject: 'shop-uat',
    service: 'app',
    imageName: 'shop-uat-app',
    appUrl: 'http://localhost:8080',
    database: { service: 'postgres', dir: '~/shop-uat/backups' },
  });
export const prodEnv = (): SetupEnv =>
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
      appUrl: 'https://shop.example.com',
      database: { service: 'postgres', dir: '/opt/shop/backups' },
    },
    'uat',
  );

const p5Test = (): SetupEnv =>
  localAdoptEnv({
    name: 'test-site',
    label: 'Test site',
    target: 'flow5-local',
    composeFile: '/home/user/projects/demo-app/docker-compose.yml',
    composeProject: 'flow5',
    service: 'app',
    imageName: 'flow5-app',
    appUrl: 'http://localhost:4700',
    database: { service: 'postgres', dir: '/home/user/projects/demo-app/backups' },
  });
const p5Live = (): SetupEnv =>
  sshShipEnv(
    {
      name: 'live-site',
      label: 'Live site',
      target: 'flow5-server',
      host: 'flow5-server',
      composeFile: '/home/administrator/dcode/flow5-full/docker-compose.yml',
      composeProject: 'flow5-full',
      service: 'app',
      imageName: 'flow5/app',
      method: 'ship',
      healthUrl: 'http://192.168.1.13:8080/api/health',
      appUrl: 'http://192.168.1.13:8080',
      database: { service: 'postgres', dir: '/home/administrator/dcode/flow5-full/backups' },
    },
    'test-site',
  );

const crmEnv = (): SetupEnv =>
  directEnv({
    name: 'test-site',
    label: 'Test site',
    target: 'crm-local',
    appDir: '/home/user/apps/crm-app',
    currentLink: '/home/user/apps/crm',
    adoptFolder: true,
    manager: { kind: 'pm2', name: 'crm-api' },
    build: [
      { label: 'npm ci', argv: ['npm', 'ci'] },
      { label: 'npm run build', argv: ['npm', 'run', 'build'] },
    ],
    shared: ['.env'],
    appUrl: 'http://localhost:3100',
    appName: 'crm-api',
  });
const invoiceEnv = (): SetupEnv =>
  directEnv(
    {
      name: 'live-site',
      label: 'Live site',
      target: 'billing-vps',
      host: 'billing-vps',
      appDir: '/srv/invoice',
      manager: { kind: 'systemd', unit: 'invoice-web.service', scope: 'system', sudo: true },
      build: [{ label: 'npm ci', argv: ['npm', 'ci'] }],
      shared: ['.env', 'uploads'],
      database: { engine: 'postgres', database: 'invoice', dir: '/srv/invoice/backups' },
      healthUrl: 'http://192.168.1.40:3000/health',
      appUrl: 'http://192.168.1.40:3000',
      live: true,
      appName: 'invoice-web',
    },
    'test-site',
  );

const norm = (envs: SetupEnv[]): DeliverySetup => {
  const c = compileSetup({ environments: envs });
  if (!c.ok) throw new Error(`mock setup does not compile: ${c.issues.join('; ')}`);
  return c.setup;
};

const office = (over: Partial<TargetRec>): TargetRec => ({
  id: T1,
  name: 'shop-uat',
  kind: 'local_docker',
  production: false,
  workstationId: WS,
  workstationName: 'Office PC',
  workstationOnline: true,
  host: null,
  appUrl: 'http://localhost:8080',
  reach: null,
  reachAgo: 0,
  role: 'active',
  ...over,
});
const vps = (over: Partial<TargetRec>): TargetRec => ({
  id: T2,
  name: 'shop-live',
  kind: 'remote_ssh',
  production: true,
  workstationId: WS,
  workstationName: 'Office PC',
  workstationOnline: true,
  host: 'prod-server',
  appUrl: 'https://shop.example.com',
  reach: 'reachable',
  reachAgo: 4,
  role: 'active',
  ...over,
});

function seed(scenario: string): Store {
  const base: Store = {
    scenario,
    setup: null,
    status: 'none',
    hash: '',
    approvedHash: null,
    tried: [],
    targets: [],
    draft: null,
    unmodelled: [],
    proposal: { open: false, answers: {} },
    runs: {},
    member: scenario === 'member' || localStorage.getItem('aom-mock-member') === '1',
    old: scenario === 'old',
    improved: scenario === 'improved',
  };
  const saved = (setup: DeliverySetup, status: Store['status'], tried: string[]): Store => ({
    ...base,
    setup,
    status,
    hash: hex(),
    approvedHash: status === 'approved' ? hex() : null,
    tried,
  });
  switch (scenario) {
    case 'proposal':
    case 'confirm':
      return { ...base, proposal: { open: true, answers: {} } };
    case 'waiting':
    case 'improved':
      return { ...saved(norm([uatEnv(), prodEnv()]), 'observed', []), targets: [office({}), vps({})] };
    case 'ready':
      return { ...saved(norm([uatEnv(), prodEnv()]), 'observed', ['uat']), targets: [office({}), vps({})] };
    case 'approved':
    case 'member':
    case 'failed':
    case 'offline': {
      const s = saved(norm([uatEnv(), prodEnv()]), 'approved', ['uat', 'production']);
      s.targets = [office({}), vps(scenario === 'offline' ? { reach: 'unreachable', reachAgo: 190 } : {})];
      s.runs = {
        uat: { version: '0.9.4', commit: 'a1b2c3d4e5f6', sinceMin: 12, health: 'healthy' },
        production: {
          version: '0.9.2',
          commit: '4f2c1ab0d2e4',
          sinceMin: 60 * 24 * 3,
          health: 'healthy',
          ...(scenario === 'failed'
            ? {
                failed: {
                  step: 'Check the site',
                  reason: 'no answer from https://shop.example.com/ready',
                  wentBackTo: '0.9.2',
                },
              }
            : {}),
        },
      };
      return s;
    }
    case 'native': {
      const s = saved(norm([crmEnv(), invoiceEnv()]), 'approved', ['test-site', 'live-site']);
      s.targets = [
        office({ id: T1, name: 'crm-local', appUrl: 'http://localhost:3100' }),
        vps({ id: T5, name: 'billing-vps', host: 'billing-vps', appUrl: 'http://192.168.1.40:3000' }),
      ];
      s.runs = {
        'test-site': { version: '2.3.0', commit: 'b7c1d9e0a8b2', sinceMin: 25, health: 'healthy' },
        'live-site': { version: '2.2.4', commit: '5d2e1f0a9c33', sinceMin: 60 * 24 * 2, health: 'healthy' },
      };
      return s;
    }
    case 'p5': {
      const s = saved(norm([p5Test(), p5Live()]), 'observed', ['test-site']);
      s.targets = [
        office({
          id: T1,
          name: 'flow5-local',
          appUrl: 'http://localhost:4700',
        }),
        office({ id: T4, name: 'Test copy', appUrl: null }),
        vps({
          id: T5,
          name: 'flow5-server',
          production: true,
          host: 'flow5-server',
          appUrl: 'http://192.168.1.13:8080',
          reach: 'reachable',
        }),
      ];
      s.draft = norm([
        p5Test(),
        p5Live(),
        {
          ...localAdoptEnv({
            name: 'demo',
            label: 'Demo',
            target: 'flow5-local',
            composeFile: '/home/user/projects/demo-app/docker-compose.yml',
            composeProject: 'flow5',
            service: 'app',
            imageName: 'flow5-app',
            appUrl: 'http://localhost:4701',
          }),
        },
      ]);
      s.unmodelled = ['delivery/smoke-test.sh'];
      s.runs = {
        'test-site': { version: '1.4.2', commit: '7c1d9e0a8b21', sinceMin: 45, health: 'healthy' },
        'live-site': { version: '1.4.1', commit: '3a8e5f6d2c10', sinceMin: 60 * 24 * 6, health: 'healthy' },
      };
      return s;
    }
    default:
      return base;
  }
}

// ------------------------------------------------------------------------------------------------ the store

const KEY = 'aom-mock-env';
export const scenarioName = () =>
  (typeof localStorage !== 'undefined' && localStorage.getItem('aom-mock-deploy')) || 'empty';

export function store(): Store {
  const want = scenarioName();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Store;
      if (s.scenario === want) return s;
    }
  } catch {
    // fall through to a fresh seed
  }
  const s = seed(want);
  save(s);
  return s;
}

export function save(s: Store) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function update(fn: (s: Store) => void): Store {
  const s = store();
  fn(s);
  save(s);
  return s;
}

export function setScenario(name: string) {
  localStorage.setItem('aom-mock-deploy', name);
  localStorage.removeItem(KEY);
  // the start steps (handlers-run.ts) follow the same story
  localStorage.setItem(
    'aom-mock-run',
    name === 'proposal' ? 'proposal' : name === 'empty' ? 'empty' : 'ready',
  );
}

export const newHash = hex;

export { SETUP_GENERATOR };

// ------------------------------------------------------------------------------------------------ probe reports

const part = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  ports: [],
  volumes: [],
  envFiles: [],
  vars: [],
  ...extra,
});

const emptyReport = (scope: string, extra: Record<string, unknown> = {}) => ({
  scope,
  at: ago(0),
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
  ...extra,
});

const docker = { installed: true, usable: true, version: '29.1.2', composeVersion: '2.40.0' };

export const localReport = () =>
  emptyReport('local', {
    docker,
    containers: [
      {
        name: 'shop-uat-app-1',
        project: 'shop-uat',
        service: 'app',
        image: 'shop-uat-app',
        state: 'running',
        status: 'Up 3 days',
        ports: [{ host: 8080, container: 4600, bind: '0.0.0.0' }],
        composeFile: '/home/ada/shop-uat/docker-compose.yml',
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
    backups: [
      {
        dir: '/home/ada/shop-uat/backups',
        count: 4,
        newestName: 'uat-before-ab12cd34.sql.gz',
        newestAt: ago(2880),
      },
    ],
    urls: [{ url: 'http://localhost:8080/api/health', status: 200 }],
  });

/** P5: a stack in the user's home folder (not in /opt) that runs on this computer. */
export const localReportP5 = () => ({
  ...localReport(),
  containers: [
    {
      name: 'flow5-app-1',
      project: 'flow5',
      service: 'app',
      image: 'flow5-app',
      state: 'running',
      status: 'Up 2 days',
      ports: [{ host: 4700, container: 4600, bind: '0.0.0.0' }],
      composeFile: '/home/user/projects/demo-app/docker-compose.yml',
    },
    {
      name: 'flow5-postgres-1',
      project: 'flow5',
      service: 'postgres',
      image: 'postgres:18',
      state: 'running',
      status: 'Up 2 days',
      ports: [],
    },
    {
      name: 'flow5-redis-1',
      project: 'flow5',
      service: 'redis',
      image: 'redis:7',
      state: 'running',
      ports: [],
    },
  ],
  composeFiles: [
    {
      path: '/home/user/projects/demo-app/docker-compose.yml',
      project: 'flow5',
      services: [
        part('postgres', { image: 'postgres:18', database: 'postgres', volumes: ['pgdata'] }),
        part('app', { build: '.', ports: ['4700:4600'] }),
        part('redis', { image: 'redis:7', database: 'redis' }),
      ],
      volumes: ['pgdata'],
    },
  ],
  urls: [{ url: 'http://localhost:4700/api/health', status: 200 }],
});

/**
 * Two checkouts of one repo on this computer, both with deploy/local/docker-compose.yml and the same compose project name; the app runs
 * from `p5-run-trial` (a registry image with a port in its address).
 */
export const localReportCopies = () => {
  const dir = (n: string) => `/home/user/projects/${n}/deploy/local`;
  const file = (n: string) => ({
    path: `${dir(n)}/docker-compose.yml`,
    project: 'dcode-flow-local',
    services: [
      part('dcode-server', {
        image: '192.168.1.11:5000/dcode-server:showcase-cd30f7bb33',
        ports: ['5500:500'],
      }),
    ],
    volumes: [],
  });
  return {
    ...bareLocalReport(),
    containers: [
      {
        name: 'dcode-flow-local-dcode-server-1',
        project: 'dcode-flow-local',
        service: 'dcode-server',
        image: '192.168.1.11:5000/dcode-server:showcase-cd30f7bb33',
        state: 'running',
        status: 'Up 2 days',
        ports: [{ host: 5500, container: 500, bind: '0.0.0.0' }],
        composeFile: `${dir('p5-run-trial')}/docker-compose.yml`,
        workingDir: dir('p5-run-trial'),
      },
    ],
    composeFiles: [file('mm-fixes-wt'), file('p5-run-trial')],
    urls: [{ url: 'http://localhost:5500/api/health', status: 200 }],
  };
};

/** A computer with Docker and nothing running: the "usual places" are listed so the page can say what it checked. */
export const bareLocalReport = (homeStack = false) =>
  emptyReport('local', {
    docker,
    folders: [
      { path: '/home/ada', exists: true, entries: ['src', 'Documents'] },
      { path: '/opt', exists: true, entries: [] },
      { path: '/srv', exists: true, entries: [] },
    ],
    ...(homeStack
      ? {
          composeFiles: localReportP5().composeFiles,
          containers: localReportP5().containers,
        }
      : {}),
  });

export const hostsReport = () =>
  emptyReport('ssh_hosts', {
    sshHosts: [
      {
        alias: 'prod-server',
        hostname: '192.0.2.10',
        user: 'root',
        hasIdentity: true,
        state: 'reachable',
      },
      {
        alias: 'flow5-server',
        hostname: '192.168.1.13',
        user: 'administrator',
        hasIdentity: true,
        state: 'reachable',
      },
      {
        alias: 'billing-vps',
        hostname: '192.168.1.40',
        user: 'deploy',
        hasIdentity: true,
        state: 'reachable',
      },
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

export const serverReport = () =>
  emptyReport('ssh_target', {
    host: 'prod-server',
    docker,
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
        newestName: 'production-before-4f2c1ab.sql.gz',
        newestAt: ago(4320),
      },
    ],
    proxies: [{ kind: 'caddy', via: 'container', name: 'caddy', sites: ['shop.example.com'] }],
    urls: [{ url: 'https://shop.example.com/ready', status: 200 }],
    listeners: [80, 443],
  });

/** P5's server: the stack is in the administrator's home folder, the app image is a literal tag (no settings variable). */
export const serverReportP5 = () =>
  emptyReport('ssh_target', {
    host: 'flow5-server',
    docker,
    containers: [
      {
        name: 'flow5-full-app-1',
        project: 'flow5-full',
        service: 'app',
        image: 'flow5/app:1.4.1',
        state: 'running',
        status: 'Up 6 days',
        ports: [{ host: 8080, container: 4600, bind: '0.0.0.0' }],
        composeFile: '/home/administrator/dcode/flow5-full/docker-compose.yml',
      },
      {
        name: 'flow5-full-postgres-1',
        project: 'flow5-full',
        service: 'postgres',
        image: 'postgres:18',
        state: 'running',
        ports: [],
      },
      {
        name: 'flow5-full-worker-1',
        project: 'flow5-full',
        service: 'worker',
        image: 'flow5/app:1.4.1',
        state: 'running',
        ports: [],
      },
    ],
    composeFiles: [
      {
        path: '/home/administrator/dcode/flow5-full/docker-compose.yml',
        project: 'flow5-full',
        services: [
          part('app', { image: 'flow5/app:1.4.1', ports: ['8080:4600'] }),
          part('worker', { image: 'flow5/app:1.4.1' }),
          part('postgres', { image: 'postgres:18', database: 'postgres' }),
        ],
        volumes: ['pgdata'],
      },
    ],
    volumes: ['flow5-full_pgdata'],
    folders: [
      {
        path: '/home/administrator/dcode/flow5-full',
        exists: true,
        entries: ['docker-compose.yml', '.env', 'backups'],
        envKeys: ['DATABASE_URL', 'SECRET_KEY_BASE'],
      },
      { path: '/opt', exists: true, entries: [] },
      { path: '/srv', exists: true, entries: [] },
    ],
    urls: [{ url: 'http://192.168.1.13:8080/api/health', status: 200 }],
    listeners: [22, 8080],
  });

export const bareServerReport = (host: string) =>
  emptyReport('ssh_target', {
    host,
    os: 'Linux x86_64',
    docker: { installed: false, usable: false },
    folders: [
      { path: '/opt', exists: true, entries: [] },
      { path: '/srv', exists: true, entries: [] },
      { path: '/home/root', exists: true, entries: [] },
    ],
  });

/** What a look at `scope` (and `host`) finds, in this scenario. `dirs` are the folders the person typed. */
export function reportFor(
  scenario: string,
  scope: string,
  host: string | undefined,
  dirs: string[] = [],
): ProbeReport {
  const typed = dirs.some((d) => /flow5|myapp|dcode/.test(d));
  if (scope === 'ssh_hosts') return hostsReport() as unknown as ProbeReport;
  if (scenario === 'native' || scenario === 'nativeempty') {
    if (scope === 'local')
      return {
        ...bareLocalReport(),
        services: [
          {
            manager: 'pm2',
            name: 'crm-api',
            state: 'online',
            workingDir: '/home/user/apps/crm',
            command: 'node dist/server.js',
            ports: [3100],
            user: 'pieter',
            statePaths: ['uploads', '.env'],
          },
          {
            manager: 'process',
            name: 'node server.js',
            state: 'running',
            workingDir: '/home/user/apps/blog',
            ports: [4000],
            user: 'pieter',
          },
        ],
        appDirs: ['/home/user/apps/crm', '/home/user/apps/blog'],
      } as unknown as ProbeReport;
    if (host === 'billing-vps')
      return {
        ...bareServerReport(host),
        docker: { installed: true, usable: true },
        services: [
          {
            manager: 'systemd',
            name: 'invoice-web.service',
            state: 'running',
            workingDir: '/srv/invoice/current',
            command: 'node dist/main.js',
            ports: [3000],
            user: 'www-data',
            releaseLayout: true,
          },
          {
            manager: 'process',
            name: 'node dist/worker.js',
            state: 'running',
            workingDir: '/srv/invoice/current',
            ports: [],
            user: 'www-data',
          },
        ],
        appDirs: ['/srv/invoice'],
      } as unknown as ProbeReport;
  }
  if (scenario === 'unsupported' && scope === 'local') {
    const r = localReport();
    (r.composeFiles[0] as unknown as { unsupported?: string }).unsupported =
      'it is started from two compose files (docker-compose.yml and docker-compose.prod.yml)';
    return r as unknown as ProbeReport;
  }
  if (scope === 'local') {
    if (localStorage.getItem('aom-mock-local') === 'copies')
      return localReportCopies() as unknown as ProbeReport;
    if (localStorage.getItem('aom-mock-local') === 'bare')
      return bareLocalReport(typed) as unknown as ProbeReport;
    return (scenario === 'p5' ? localReportP5() : localReport()) as unknown as ProbeReport;
  }
  if (host === 'fresh-vps') return bareServerReport(host) as unknown as ProbeReport;
  if (host === 'flow5-server') {
    // the stack is found by the usual places and container labels; a folder typed by the person finds it too
    return serverReportP5() as unknown as ProbeReport;
  }
  return serverReport() as unknown as ProbeReport;
}

// ------------------------------------------------------------------------------------------------ the DevOps suggestion

export function proposal(s: Store) {
  const env1 = uatEnv();
  const env2 = prodEnv();
  const answers = s.proposal.answers;
  const imageVar = (answers['/environments/1/app/imageVar'] as string | undefined) ?? env2.app.imageVar;
  const dep = norm([
    {
      ...env1,
      app: { ...env1.app, service: (answers['/environments/0/app/service'] as string | undefined) ?? 'app' },
    },
    { ...env2, app: { ...env2.app, ...(imageVar ? { imageVar } : {}) } },
  ]);
  return {
    id: PROPOSAL_ID,
    area: 'deploy',
    status: 'open',
    requestId: '00000000-0000-4000-8000-0000000000d1',
    workstationId: WS,
    workstationName: 'Office PC',
    submittedAt: ago(3),
    proposal: {
      area: 'deploy',
      deploy: dep,
      items: [
        { path: '/environments/0', confidence: 'found', evidence: [{ file: 'docker-compose.yml' }] },
        {
          path: '/environments/0/app/service',
          confidence: 'unknown',
          evidence: [],
          note: 'the compose file has three parts and none is built from your code',
        },
        {
          path: '/environments/1/app/imageVar',
          confidence: 'guessed',
          evidence: [],
          note: 'the only setting that names an image',
        },
        { path: '/environments/1/app/appUrl', confidence: 'found', evidence: [{ probe: 'caddy site' }] },
      ],
      questions:
        s.scenario === 'confirm'
          ? [
              {
                path: '/environments/1/direct/manager/sudo',
                question: 'Does restarting the app need administrator rights (sudo)?',
                kind: 'confirm',
                ...(answers['/environments/1/direct/manager/sudo'] !== undefined
                  ? { answer: String(answers['/environments/1/direct/manager/sudo']) }
                  : {}),
              },
            ]
          : [
              {
                path: '/environments/0/app/service',
                question: 'Which part is your app?',
                options: ['app', 'worker', 'web'],
                kind: 'choice',
                ...(answers['/environments/0/app/service'] !== undefined
                  ? { answer: String(answers['/environments/0/app/service']) }
                  : {}),
              },
              {
                path: '/environments/0/app/appUrl',
                question: 'Which port does the website use?',
                default: '3000',
                kind: 'text',
                ...(answers['/environments/0/app/appUrl'] !== undefined
                  ? { answer: String(answers['/environments/0/app/appUrl']) }
                  : {}),
              },
              {
                path: '/environments/1/production',
                question: 'Is this server the live site?',
                kind: 'confirm',
                ...(answers['/environments/1/production'] !== undefined
                  ? { answer: String(answers['/environments/1/production']) }
                  : {}),
              },
            ],
      secretsNeeded: [],
      notes:
        'The test site is a Docker Compose project called shop-uat on Office PC. The live site is built here and shipped over ssh.',
      filesRead: ['docker-compose.yml', 'Dockerfile', 'deploy/Caddyfile', 'README.md'],
    },
  };
}
