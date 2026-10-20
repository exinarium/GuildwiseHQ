import { HttpResponse, http } from 'msw';
import { db } from './db.ts';

/**
 * Mock server for the guided run steps (VITE_MSW=1 dev). The scenario comes from `localStorage['aom-mock-run']`:
 * `empty` (default), `scanning`, `proposal`, `ready`, `failure`, `own`. A saved plan or a started scan moves the scenario on.
 * `localStorage['aom-mock-targets'] = 'on'` lists sample deploy targets.
 */
const A = '/api';
const scenario = () => (typeof localStorage !== 'undefined' && localStorage.getItem('aom-mock-run')) || 'empty';
const setScenario = (s: string) => localStorage.setItem('aom-mock-run', s);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const WS = '00000000-0000-4000-8000-0000000000a1';
const WS2 = '00000000-0000-4000-8000-0000000000a2';

const repoId = (projectId: string) => db.repos.find((r) => r.projectId === projectId)?.id ?? WS;

function plan(projectId: string) {
  const r = repoId(projectId);
  return {
    version: 1,
    repos: [{ repoId: r }],
    setup: [
      {
        name: 'Install packages',
        label: 'Install packages',
        template: 'install_packages',
        repoId: r,
        cwd: 'web',
        cmd: ['npm', 'ci'],
        timeoutSec: 1200,
        when: 'changed:web/package-lock.json',
      },
      {
        name: 'Prepare the database',
        label: 'Prepare the database',
        template: 'prepare_db',
        repoId: r,
        cwd: 'web',
        cmd: ['npm', 'run', 'migrate'],
        timeoutSec: 1200,
        when: 'always',
      },
    ],
    services: [
      {
        name: 'postgres',
        label: 'Database (postgres:16)',
        template: 'docker_service',
        repoId: r,
        cwd: '.',
        cmd: ['docker', 'run', '--rm', '-p', '${port}:5432', '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:16'],
        env: {},
        ports: [{ name: 'tcp', default: 5432 }],
        health: { kind: 'tcp', port: 'tcp' },
        startTimeoutSec: 300,
        after: [],
        docker: true,
      },
      {
        name: 'web',
        label: 'The website',
        template: 'web_app',
        repoId: r,
        cwd: 'web',
        cmd: ['npm', 'run', 'dev'],
        env: {},
        ports: [{ name: 'http', default: 5173, envVar: 'PORT', url: 'http://localhost:${port}/' }],
        health: { kind: 'http', url: 'http://localhost:${port}/', expect: '2xx' },
        startTimeoutSec: 300,
        after: ['postgres'],
        docker: false,
      },
    ],
    notes: '',
  };
}

const version = (projectId: string, over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  workstationId: null,
  workstationName: null,
  version: 2,
  status: 'active',
  source: 'scan',
  plan: plan(projectId),
  savedAt: ago(120),
  savedByName: 'Ada Admin',
  lastFailure: null,
  ...over,
});

function proposal(projectId: string) {
  const p = plan(projectId);
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    area: 'run',
    status: 'open',
    requestId: '00000000-0000-4000-8000-0000000000d1',
    workstationId: WS,
    workstationName: 'Office PC',
    submittedAt: ago(3),
    proposal: {
      area: 'run',
      run: p,
      items: [
        { path: '/setup/0', confidence: 'found', evidence: [{ file: 'web/package.json', line: 6 }], note: 'package-lock.json is in web/' },
        { path: '/setup/1', confidence: 'guessed', note: 'a migrate script exists, DevOps did not read what it does' },
        { path: '/services/0', confidence: 'found', evidence: [{ file: 'docker-compose.yml', line: 3 }] },
        { path: '/services/1/ports/0/default', confidence: 'found', evidence: [{ file: 'web/vite.config.ts', line: 12 }] },
        { path: '/services/1/health', confidence: 'unknown' },
      ],
      questions: [
        {
          path: '/services/1/health',
          question: 'Which page shows that the website is ready?',
          options: ['/', '/health'],
          default: '/',
        },
      ],
      secretsNeeded: [],
      notes: 'This looks like a Vite website with a PostgreSQL database. The database password in the test container is only for testing.',
      filesRead: ['README.md', 'web/package.json', 'web/vite.config.ts', 'docker-compose.yml', '.env.example'],
    },
  };
}

const stations = [
  { id: WS, name: 'Office PC', connected: true, mine: true, canRun: true, canScan: true, scanBlocked: null },
  { id: WS2, name: 'Old laptop', connected: false, mine: true, canRun: true, canScan: false, scanBlocked: 'Old laptop is offline. Scans run on a computer that has the project\'s code.' },
];

function overview(projectId: string) {
  const s = scenario();
  const base = {
    canEdit: true,
    repos: db.repos.filter((r) => r.projectId === projectId).map((r) => ({ repoId: r.id, name: r.name })),
    workstations: stations,
    projectPlan: null as unknown,
    workstationPlans: [] as unknown[],
    scan: null as unknown,
    scanProblem: null as string | null,
    proposal: null as unknown,
    lastStart: null as unknown,
  };
  if (s === 'scanning')
    base.scan = {
      requestId: '00000000-0000-4000-8000-0000000000d1',
      area: 'run',
      status: 'running',
      workstationId: WS,
      workstationName: 'Office PC',
      startedAt: ago(1),
    };
  if (s === 'proposal') base.proposal = proposal(projectId);
  if (s === 'ready' || s === 'failure' || s === 'own') {
    base.projectPlan = version(projectId, s === 'failure' ? { lastFailure: { reason: 'step "Install packages" failed (exit 1): npm could not find package-lock.json', at: ago(30) } } : {});
    base.lastStart = {
      state: s === 'failure' ? 'failed' : 'ok',
      at: ago(s === 'failure' ? 30 : 120),
      workstationName: 'Office PC',
      failure: s === 'failure' ? 'step "Install packages" failed (exit 1): npm could not find package-lock.json' : null,
    };
  }
  if (s === 'own')
    base.workstationPlans = [
      version(projectId, {
        id: '00000000-0000-4000-8000-0000000000b2',
        workstationId: WS,
        workstationName: 'Office PC',
        source: 'devops',
        version: 1,
        savedAt: ago(40),
      }),
    ];
  return base;
}

const env = (state: string) => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  state,
  workstationName: 'Office PC',
  activity: 'running npm ci',
  canStop: true,
  servicesStatus: [{ name: 'web', state: 'healthy', ports: [], urls: ['http://localhost:5173/'], health: 'passing', restarts: 0 }],
  failureReason: null,
  lastError: null,
});

export const runHandlers = [
  http.get(`${A}/projects/:id/run-plan`, ({ params }) => HttpResponse.json(overview(String(params.id)))),
  http.put(`${A}/projects/:id/run-plan`, async ({ params, request }) => {
    const b = (await request.json()) as { plan: unknown };
    void b;
    setScenario('ready');
    return HttpResponse.json(overview(String(params.id)));
  }),
  http.delete(`${A}/projects/:id/run-plan/:planId`, ({ params }) => {
    setScenario('ready');
    return HttpResponse.json(overview(String(params.id)));
  }),
  http.post(`${A}/projects/:id/run-plan/test`, () => HttpResponse.json({ environment: env('starting') }, { status: 201 })),
  http.get(`${A}/runs/00000000-0000-4000-8000-0000000000e1`, () =>
    HttpResponse.json({ environment: env(localStorage.getItem('aom-mock-env') || 'healthy') }),
  ),
  http.post(`${A}/projects/:id/scan`, () => {
    setScenario('scanning');
    return HttpResponse.json({ requestId: '00000000-0000-4000-8000-0000000000d1' }, { status: 202 });
  }),
  http.post(`${A}/setup-proposals/:id/resolve`, () => {
    setScenario('empty');
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${A}/projects/:id/run-settings`, ({ params }) =>
    HttpResponse.json({
      runInstructions: '',
      repos: db.repos
        .filter((r) => r.projectId === params.id)
        .map((r) => ({ repoId: r.id, name: r.name, runInstructions: '' })),
      settings: { ttlHours: 8, allowDocker: true, services: [], buildGuides: [] },
      plans: [],
    }),
  ),
  http.get(`${A}/projects/:id/deploy-targets`, () =>
    HttpResponse.json({
      targets:
        localStorage.getItem('aom-mock-targets') === 'on'
          ? [
              {
                id: '00000000-0000-4000-8000-0000000000f1',
                projectId: '00000000-0000-4000-8000-000000000000',
                name: 'shop-uat',
                kind: 'local_docker',
                workstationId: WS,
                workstationName: 'Office PC',
                host: null,
                appUrl: 'http://localhost:8080',
                notes: '',
                createdAt: ago(5000),
                production: false,
              },
              {
                id: '00000000-0000-4000-8000-0000000000f2',
                projectId: '00000000-0000-4000-8000-000000000000',
                name: 'shop-live',
                kind: 'remote_ssh',
                workstationId: WS2,
                workstationName: 'Old laptop',
                host: 'prod-server',
                appUrl: 'https://shop.example.com',
                notes: '',
                createdAt: ago(5000),
                production: true,
              },
            ]
          : [],
    }),
  ),
  http.get(`${A}/projects/:id/workstations`, () =>
    HttpResponse.json({
      workstations: [
        { id: WS, name: 'Office PC', ownerId: db.users[0]?.id, ownerName: 'Ada Admin', mine: true, connected: true, hasDevops: true },
        { id: WS2, name: 'Old laptop', ownerId: db.users[0]?.id, ownerName: 'Ada Admin', mine: true, connected: false, hasDevops: true },
      ],
    }),
  ),
];
