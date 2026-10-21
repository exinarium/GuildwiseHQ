import { HttpResponse, http } from 'msw';

/**
 * Mock server for the Releases page, the release sheet and the rollback sheet (VITE_MSW=1 dev). The Environments page's own
 * scenarios (setup state, probes) live in handlers-deploy-setup.ts. Sample world: P5 has a test site on v0.9.4 and a live site
 * on v0.9.2 with one release waiting; P7 has a live site only.
 */
const A = '/api';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const P5 = '00000000-0000-4000-8000-000000000001';
const P7 = '00000000-0000-4000-8000-000000000007';
const T_LIVE = '00000000-0000-4000-8000-0000000000f2';
const RUN_WAITING = '00000000-0000-4000-8000-0000000000b1';
const rolledBack = () =>
  typeof localStorage !== 'undefined' && localStorage.getItem('aom-mock-rollback') === '1';

const liveRows = () => [
  {
    projectId: P5,
    projectKey: 'P5',
    projectName: 'P5',
    env: 'production',
    label: 'Live site',
    role: 'live',
    version: rolledBack() ? '0.9.1' : '0.9.2',
    commit: rolledBack() ? '9e1d2c3f4a5b' : '4f2c1ab0d2e4',
    since: rolledBack() ? ago(1) : ago(60 * 24 * 3),
    health: 'healthy',
    placeName: 'prod-server',
    appUrl: 'https://shop.example.com',
    waitingRelease: 1,
  },
  {
    projectId: P5,
    projectKey: 'P5',
    projectName: 'P5',
    env: 'uat',
    label: 'Test site',
    role: 'test',
    version: '0.9.4',
    commit: 'a1b2c3d4e5f6',
    since: ago(12),
    health: 'healthy',
    placeName: 'Office PC',
    appUrl: 'http://localhost:8080',
    waitingRelease: 0,
  },
  {
    projectId: P7,
    projectKey: 'P7',
    projectName: 'Orders',
    env: 'production',
    label: 'Live site',
    role: 'live',
    version: '1.1.0',
    commit: 'c0ffee123456',
    since: ago(60 * 24 * 9),
    health: 'unhealthy',
    placeName: 'orders-vps',
    appUrl: 'https://orders.example.com',
    waitingRelease: 1,
  },
];

const queueItems = () => [
  {
    projectId: P5,
    projectKey: 'P5',
    env: 'production',
    commit: 'a1b2c3d4e5f6',
    waitingFor: 'owner',
    requestedAt: ago(14),
    gateNow: { satisfied: false, missing: ['test site healthy for 3 more minutes'] },
    targets: [
      {
        runId: RUN_WAITING,
        targetId: T_LIVE,
        targetName: 'prod-server',
        production: true,
        host: 'prod-server',
        workstationName: 'Office PC',
      },
    ],
  },
  {
    projectId: P7,
    projectKey: 'P7',
    env: 'production',
    commit: '7d6c5b4a3f2e',
    waitingFor: 'owner',
    requestedAt: ago(90),
    gateNow: { satisfied: true, missing: [] },
    targets: [
      {
        runId: '00000000-0000-4000-8000-0000000000b2',
        targetId: null,
        targetName: 'orders-vps',
        production: true,
        host: 'orders-vps',
        workstationName: 'Office PC',
      },
    ],
  },
];

const run = (id: number, over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-00000000c${String(id).padStart(3, '0')}`,
  projectId: P5,
  projectKey: 'P5',
  env: 'production',
  targetName: 'prod-server',
  targetId: T_LIVE,
  commit: '4f2c1ab0d2e4',
  deployedCommit: '4f2c1ab0d2e4',
  status: 'succeeded',
  waitingFor: null,
  releasedByPolicy: 'owner',
  trigger: 'manual',
  trial: false,
  dryRun: false,
  requestedBy: { kind: 'user', id: null, name: 'Ada' },
  releasedBy: { kind: 'user', id: null, name: 'Ada' },
  recipeHash: 'a'.repeat(64),
  evidence: [
    { requirement: 'envHealthy', ref: null, detail: 'Test site healthy on the same version for 12 minutes' },
  ],
  missing: [],
  refusal: null,
  refusalDetail: null,
  health: { ok: true },
  smoke: null,
  summary: 'Released and answering',
  logTail: null,
  url: 'https://shop.example.com',
  createdAt: ago(60 * 24 * 3 + 2),
  startedAt: ago(60 * 24 * 3 + 2),
  finishedAt: ago(60 * 24 * 3),
  ...over,
});

export const releaseHandlers = [
  http.get(`${A}/org/live`, () => HttpResponse.json({ rows: liveRows() })),
  http.get(`${A}/delivery/queue`, () => HttpResponse.json({ items: queueItems() })),
  http.get(`${A}/delivery/runs`, () =>
    HttpResponse.json({
      runs: [
        ...(rolledBack()
          ? [
              run(9, {
                trigger: 'rollback',
                commit: '9e1d2c3f4a5b',
                deployedCommit: '9e1d2c3f4a5b',
                createdAt: ago(2),
                finishedAt: ago(1),
                summary: 'Went back to 0.9.1',
              }),
            ]
          : []),
        run(1, {}),
        run(2, {
          commit: '9e1d2c3f4a5b',
          deployedCommit: '9e1d2c3f4a5b',
          createdAt: ago(60 * 24 * 12),
          finishedAt: ago(60 * 24 * 12),
        }),
        run(3, {
          commit: '5a5a5a5a5a5a',
          deployedCommit: '5a5a5a5a5a5a',
          createdAt: ago(60 * 24 * 20),
          finishedAt: ago(60 * 24 * 20),
        }),
        run(4, {
          status: 'refused',
          refusal: 'gate',
          refusalDetail: 'Waiting for: test site healthy for 3 more minutes',
          missing: ['test site healthy for 3 more minutes'],
          commit: 'a1b2c3d4e5f6',
          deployedCommit: null,
          createdAt: ago(30),
          finishedAt: ago(30),
        }),
        run(5, {
          env: 'uat',
          targetName: 'Office PC',
          targetId: null,
          trigger: 'after_merge',
          releasedByPolicy: 'auto',
          commit: 'a1b2c3d4e5f6',
          deployedCommit: 'a1b2c3d4e5f6',
          createdAt: ago(14),
          finishedAt: ago(12),
          evidence: [],
        }),
      ],
    }),
  ),
  http.post(`${A}/delivery/release`, () => HttpResponse.json({ message: 'Releasing', runs: [] })),
  http.get(`${A}/projects/:id/environments/:env/rollback-candidates`, () =>
    HttpResponse.json({
      candidates: [
        {
          commit: '4f2c1ab0d2e4',
          version: '0.9.2',
          at: ago(60 * 24 * 3),
          releasedBy: 'Ada',
          backupPath: '/opt/app/backups/production-before-4f2c1ab.sql.gz',
        },
        {
          commit: '9e1d2c3f4a5b',
          version: '0.9.1',
          at: ago(60 * 24 * 12),
          releasedBy: 'Ada',
          backupPath: '/opt/app/backups/production-before-9e1d2c3.sql.gz',
        },
        {
          commit: '5a5a5a5a5a5a',
          version: '0.9.0',
          at: ago(60 * 24 * 20),
          releasedBy: 'Ben',
          backupPath: '/opt/app/backups/production-before-5a5a5a5.sql.gz',
        },
      ],
    }),
  ),
  http.post(`${A}/projects/:id/releases`, () => {
    localStorage.setItem('aom-mock-rollback', '1');
    return HttpResponse.json({ message: 'Going back to the earlier version' }, { status: 202 });
  }),
  http.get(`${A}/projects/:id/environments/status`, () =>
    HttpResponse.json({
      environments: [
        {
          env: 'uat',
          version: '0.9.4',
          commit: 'a1b2c3d4e5f6',
          since: ago(12),
          health: 'healthy',
          appUrl: 'http://localhost:8080',
          lastRun: {
            id: 'r1',
            status: 'succeeded',
            at: ago(12),
            summary: 'Updated and answering',
            failedStep: null,
            reason: null,
            wentBackTo: null,
          },
          waitingRelease: null,
        },
        {
          env: 'production',
          version: rolledBack() ? '0.9.1' : '0.9.2',
          commit: rolledBack() ? '9e1d2c3f4a5b' : '4f2c1ab0d2e4',
          since: rolledBack() ? ago(1) : ago(60 * 24 * 3),
          health: 'healthy',
          appUrl: 'https://shop.example.com',
          lastRun: {
            id: 'r2',
            status: 'succeeded',
            at: ago(60 * 24 * 3),
            summary: 'Released and answering',
            failedStep: null,
            reason: null,
            wentBackTo: null,
          },
          waitingRelease: {
            commit: 'a1b2c3d4e5f6',
            version: '0.9.4',
            cards: [
              { ref: 'P5-12', title: 'Show the order total on the checkout page' },
              { ref: 'P5-15', title: 'Fix the date on the invoice' },
              { ref: 'P5-17', title: 'Faster product search' },
            ],
            rulesMet: false,
            waitingFor: ['test site healthy for 3 more minutes'],
            places: [{ runId: RUN_WAITING, targetId: T_LIVE, name: 'prod-server' }],
          },
        },
      ],
    }),
  ),
];
