import {
  compileSetup,
  type DeliverySetup,
  type ProbeReport,
  planChanges,
  SETUP_GENERATOR,
} from '@aom/shared';
import { HttpResponse, http } from 'msw';
import {
  ago,
  bareServerReport,
  hostsReport,
  newHash,
  proposal,
  reportFor,
  scenarioName,
  serverReport,
  setScenario,
  store,
  T1,
  T2,
  update,
  WS,
  WS2,
} from './env-store.ts';

/**
 * Mock server for the guided deploy setup and the Environments page (VITE_MSW=1 dev). The scenario comes from
 * `localStorage['aom-mock-deploy']` (see env-store.ts); the page's changes are kept in `localStorage['aom-mock-env']`.
 */
const A = '/api';
const scenario = scenarioName;
void WS2;
void T2;
void serverReport;
void bareServerReport;
void hostsReport;

const MOCK_RUNNER_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyPsQ9mQHfUXOPgmcIYCfzV7GKofuKILmFsVejRjpjKKAjQrjaeTVuH14F0X9p0w/VwGMmlaAbEE60Fou/E+1uIFsJbYpdWIO819i4jqvpZP0QJKHszgXW22NsdQVaUPjt6tXH3Zs0PLEnu0uy2aRoRQGSP505sI2/sGQf8vyJ5cDPVds9vyq9JOJqKJCL+1srIhpcFnwMuXVonT6DpR4EX8EPT6GnqHT1QtGNfSsDep6fcIUw+4nVFzE5I5UBQPPYhuUTDu6oYlVi16WdTOWAxg0IdoC+H5etwKy+ej9jFtJzZqxOaOfnj7WafB7V/ZDuk/cQowEt1j5XcCDC6rwdQIDAQAB';
const FP_ED = 'SHA256:5kXwQ2m0n7yT1p3QbZ9sJd8vLr4uHc6aGfE2iNoPtYw';
const ops = new Map<string, Record<string, unknown>>();
const op = (kind: string, ok: boolean, result: unknown, errorText: string | null = null) => {
  const id = crypto.randomUUID();
  ops.set(id, { id, kind, state: ok ? 'done' : 'failed', ok, result, errorText, at: ago(0) });
  return id;
};

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

const probeDto = (
  scope: string,
  host: string | null,
  report: unknown,
  targetId: string | null = null,
  dirs: string[] = [],
) => ({
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
  dirs,
});

const targetDto = (t: ReturnType<typeof store>['targets'][number]) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  production: t.production,
  workstationId: t.workstationId,
  workstationName: t.workstationName,
  workstationOnline: t.workstationOnline,
  host: t.host,
  appUrl: t.appUrl,
  connection: t.reach
    ? { state: t.reach, at: ago(t.reachAgo), detail: null, method: 'existing_alias' }
    : null,
  keys: [],
  role: t.role,
});

function state() {
  const st = store();
  const envs = st.setup;
  const present = !!envs;
  const names = envs ? envs.environments.map((e) => e.name) : [];
  const moving = moveScenario() === 'standby' || moveScenario() === 'retired';
  return {
    canEdit: !st.member,
    canApprove: !st.member,
    draft: st.draft ? { setup: st.draft, customScripts: {}, proposalId: null, updatedAt: ago(30) } : null,
    current: {
      setup: envs,
      handEdited: [],
      recipePresent: present,
      recipeStatus: st.status === 'none' ? null : st.status,
      observedHash: present ? st.hash : null,
      approvedHash: st.approvedHash,
      lint: [],
      dryRunOk: st.tried,
      dryRunMissing: names.filter((n) => !st.tried.includes(n)),
      envNames: names,
      custom: false,
    },
    publish: published,
    targets: [...moveTargets(), ...st.targets.filter((t) => !(moving && t.id === T2)).map(targetDto)],
    workstations: [
      {
        id: WS,
        name: 'Office PC',
        connected: true,
        mine: true,
        canProbe: !st.old,
        blocked: st.old ? 'Guildwise on Office PC needs an update for guided setup.' : null,
        canConnect: !st.old,
        canMove: !st.old,
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
    proposal: st.proposal.open ? proposal(st) : null,
    generator: SETUP_GENERATOR,
    improvedAvailable: st.improved,
    unmodelled: st.unmodelled,
  };
}

const isNative = (e: unknown) => (e as { runtime?: { kind?: string } }).runtime?.kind === 'native';

/** The compile result of a request body; an environment that runs directly on the machine is not Docker, so it is not compiled here. */
function compileBody(body: unknown) {
  const envs = ((body as { environments?: unknown[] } | null)?.environments ?? []) as unknown[];
  if (envs.some(isNative)) return { native: true as const, setup: body as DeliverySetup };
  const c = compileSetup(body);
  return c.ok ? { native: false as const, c, setup: c.setup } : { native: false as const, issues: c.issues };
}

const reportsOf = (setup: DeliverySetup) => {
  const sc = scenario();
  return Object.fromEntries(
    setup.environments.map((e) => [
      e.name,
      reportFor(sc, e.hosting === 'ssh' ? 'ssh_target' : 'local', e.host) as ProbeReport,
    ]),
  );
};

/** Changes list of an environment that runs directly on the machine (it is not compiled in the mock). */
function nativeChanges(setup: DeliverySetup) {
  return setup.environments.flatMap((e) => {
    const rt = (
      e as unknown as { runtime?: { name: string; folder: string; restart: { via: string; target: string } } }
    ).runtime;
    if (!rt) return [];
    const how =
      rt.restart.via === 'service'
        ? `restart the service ${rt.restart.target}`
        : rt.restart.via === 'pm2'
          ? `restart ${rt.restart.target} with pm2`
          : `run ${rt.restart.target}`;
    return [
      { group: 'reuse', text: `${rt.name} in ${rt.folder} is used as it is`, env: e.name },
      { group: 'each_deploy', text: 'Get the new version of the code', env: e.name },
      { group: 'each_deploy', text: 'Build it in a new folder next to the current one', env: e.name },
      { group: 'each_deploy', text: 'Switch to the new version', env: e.name },
      { group: 'each_deploy', text: `Then ${how} and check the app answers`, env: e.name },
      { group: 'each_deploy', text: 'Keep the last 5 versions so you can go back', env: e.name },
      {
        group: 'untouched',
        text: 'Your data, settings files and everything else on the machine',
        env: e.name,
      },
    ];
  });
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
  http.put(`${A}/projects/:id/delivery/setup`, async ({ request }) => {
    const b = (await request.json()) as { setup: DeliverySetup };
    update((s) => {
      s.draft = b.setup;
    });
    return HttpResponse.json(state());
  }),
  http.delete(`${A}/projects/:id/delivery/setup/draft`, () => {
    update((s) => {
      s.draft = null;
      s.unmodelled = [];
    });
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${A}/projects/:id/delivery/probe`, async ({ request }) => {
    const b = (await request.json()) as {
      scope: string;
      host?: string;
      targetId?: string;
      hints?: { dirs?: string[] };
    };
    const dirs = b.hints?.dirs ?? [];
    const report =
      b.scope === 'ssh_target' && b.targetId === T3
        ? newServerReport()
        : b.scope === 'ssh_check'
          ? reportFor(scenario(), 'ssh_hosts', undefined)
          : reportFor(scenario(), b.scope, b.host, dirs);
    const tid = b.targetId ?? null;
    probes = [
      ...probes.filter(
        (p) => !(p.scope === b.scope && (p.host ?? null) === (b.host ?? null) && p.targetId === tid),
      ),
      probeDto(b.scope, b.host ?? null, report, tid, dirs),
    ];
    return HttpResponse.json({ commandId: crypto.randomUUID(), workstationId: WS }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/setup/preview`, async ({ request }) => {
    const b = (await request.json()) as { setup: unknown; removeFiles?: string[] };
    const r = compileBody(b.setup);
    const st = store();
    const unmodelled = st.unmodelled;
    if (r.native)
      return HttpResponse.json({
        ok: true,
        issues: [],
        hash: newHash(),
        files: [],
        keep: [],
        unmodelled,
        removing: b.removeFiles ?? [],
        lint: [],
        changes: nativeChanges(r.setup),
        differsFromCurrent: true,
        needsDryRun: r.setup.environments.map((e) => e.name),
      });
    if (!r.c)
      return HttpResponse.json({
        ok: false,
        issues: r.issues,
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
      hash: r.c.hash,
      files: r.c.files,
      keep: r.c.keep,
      unmodelled,
      removing: b.removeFiles ?? [],
      lint: [],
      changes: planChanges(r.setup, reportsOf(r.setup)),
      differsFromCurrent: true,
      needsDryRun: r.setup.environments.map((e) => e.name),
    });
  }),
  http.post(`${A}/projects/:id/delivery/setup/publish`, async ({ request }) => {
    const b = (await request.json()) as { setup: DeliverySetup; removeFiles?: string[] };
    const r = compileBody(b.setup);
    update((s) => {
      const wasApproved = s.status === 'approved' || s.status === 'changed_unapproved';
      s.setup = r.native ? b.setup : r.c ? r.setup : b.setup;
      s.status = wasApproved ? 'changed_unapproved' : 'observed';
      s.hash = newHash();
      s.tried = [];
      s.draft = null;
      s.unmodelled = s.unmodelled.filter((f) => !(b.removeFiles ?? []).includes(f));
      for (const e of s.setup.environments)
        if (!s.runs[e.name]) s.runs[e.name] = { version: '', commit: '', sinceMin: 0, health: 'unknown' };
    });
    published = { setupHash: 'a'.repeat(64), commandId: 'c1', status: 'written', error: null, at: ago(0) };
    return HttpResponse.json({ commandId: 'c1', hash: 'a'.repeat(64) }, { status: 202 });
  }),
  http.post(`${A}/projects/:id/delivery/setup/dry-run`, async ({ request }) => {
    const b = (await request.json()) as { env: string };
    update((s) => {
      if (!s.tried.includes(b.env)) s.tried.push(b.env);
    });
    return HttpResponse.json({
      message:
        'Would back up the database, build the new version, copy it over and check the site. Nothing was changed.',
      runs: [{ status: 'succeeded' }],
    });
  }),
  http.post(`${A}/projects/:id/delivery/approve`, () => {
    update((s) => {
      s.status = 'approved';
      s.approvedHash = s.hash;
    });
    return HttpResponse.json({});
  }),
  http.post(`${A}/projects/:id/delivery/setup/use-proposal`, () => {
    update((s) => {
      s.draft = proposal(s).proposal.deploy as DeliverySetup;
      s.proposal.open = false;
      s.targets = s.targets.length
        ? s.targets
        : [
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
              reach: null,
              reachAgo: 0,
              role: 'active',
            },
          ];
    });
    return HttpResponse.json(state());
  }),
  http.post(`${A}/setup-proposals/:id/answers`, async ({ request }) => {
    const b = (await request.json()) as {
      answers: Array<{ path: string; value: string | number | boolean }>;
    };
    const st = update((s) => {
      for (const a of b.answers) s.proposal.answers[a.path] = a.value;
    });
    const p = proposal(st);
    const remaining = p.proposal.questions.filter((q) => st.proposal.answers[q.path] === undefined).length;
    return HttpResponse.json({ proposal: p, remaining });
  }),
  http.post(`${A}/projects/:id/scan`, async ({ request }) => {
    const b = (await request.json()) as { area?: string };
    if (b.area === 'deploy') {
      setScenario('proposal');
    }
    return HttpResponse.json({ requestId: crypto.randomUUID() }, { status: 202 });
  }),
  http.get(`${A}/projects/:id/deploy-targets`, () =>
    HttpResponse.json({
      targets: [...moveTargets(), ...store().targets].map((t) => ({
        id: t.id,
        projectId: '00000000-0000-4000-8000-000000000000',
        name: t.name,
        kind: t.kind,
        workstationId: t.workstationId,
        workstationName: t.workstationName,
        host: t.host,
        appUrl: t.appUrl,
        notes: '',
        createdAt: ago(5000),
        production: t.production,
        role: t.role,
      })),
    }),
  ),
  http.post(`${A}/projects/:id/deploy-targets`, async ({ request }) => {
    const b = (await request.json()) as {
      name: string;
      kind: 'local_docker' | 'remote_ssh';
      workstationId?: string | null;
      host?: string | null;
      appUrl?: string | null;
      production?: boolean;
    };
    const id = crypto.randomUUID();
    update((s) => {
      s.targets.push({
        id,
        name: b.name,
        kind: b.kind,
        production: !!b.production,
        workstationId: b.workstationId ?? WS,
        workstationName: 'Office PC',
        workstationOnline: true,
        host: b.host ?? null,
        appUrl: b.appUrl ?? null,
        reach: b.kind === 'remote_ssh' ? 'reachable' : null,
        reachAgo: 0,
        role: 'active',
      });
    });
    return HttpResponse.json({ id }, { status: 201 });
  }),
  http.patch(`${A}/deploy-targets/:id`, async ({ params, request }) => {
    const b = (await request.json()) as Record<string, unknown>;
    update((s) => {
      const t = s.targets.find((x) => x.id === params.id);
      if (t) Object.assign(t, b);
    });
    return HttpResponse.json({ id: params.id });
  }),
  http.delete(`${A}/deploy-targets/:id`, ({ params }) => {
    const s = store();
    const t = s.targets.find((x) => x.id === params.id);
    const users = (s.setup?.environments ?? []).filter((e) => e.target === t?.name);
    if (users.length)
      return HttpResponse.json(
        {
          error: {
            code: 'in_use',
            message: `Used by ${users.map((u) => u.label).join(', ')}: change that first.`,
          },
        },
        { status: 409 },
      );
    update((x) => {
      x.targets = x.targets.filter((y) => y.id !== params.id);
    });
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${A}/deploy-targets/merge`, async ({ request }) => {
    const b = (await request.json()) as { fromId: string; toId: string };
    update((s) => {
      const from = s.targets.find((t) => t.id === b.fromId);
      const to = s.targets.find((t) => t.id === b.toId);
      if (!from || !to) return;
      const repoint = (d: DeliverySetup | null) => {
        for (const e of d?.environments ?? []) if (e.target === from.name) e.target = to.name;
      };
      repoint(s.setup);
      repoint(s.draft);
      s.targets = s.targets.filter((t) => t.id !== from.id);
      if (s.setup) {
        s.status = 'changed_unapproved';
        s.tried = [];
        s.hash = newHash();
      }
    });
    return HttpResponse.json({ ok: true });
  }),
  http.delete(`${A}/projects/:id/delivery/environments/:name`, ({ params }) => {
    update((s) => {
      if (!s.setup) return;
      const left = s.setup.environments.filter((e) => e.name !== params.name);
      s.setup = left.length ? { ...s.setup, environments: left } : null;
      delete s.runs[String(params.name)];
      s.tried = s.tried.filter((n) => n !== params.name);
      if (!s.setup) {
        s.status = 'none';
        s.approvedHash = null;
      } else {
        s.hash = newHash();
        if (s.status === 'approved') s.status = 'changed_unapproved';
        s.tried = s.setup.environments.map((e) => e.name).filter((n) => s.tried.includes(n));
      }
    });
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${A}/projects/:id/environments/status`, () => {
    const s = store();
    const rules = localStorage.getItem('aom-mock-rules') === 'met';
    return HttpResponse.json({
      environments: (s.setup?.environments ?? []).map((e) => {
        const r = s.runs[e.name];
        const live = e.target === 'shop-live' || e.name === 'production' || e.name === 'live-site';
        return {
          env: e.name,
          version: r?.version || null,
          commit: r?.commit || null,
          since: r?.version ? ago(r.sinceMin) : null,
          health: r?.health ?? 'unknown',
          appUrl: e.app.appUrl ?? null,
          updatingStep: null,
          lastRun: r?.failed
            ? {
                id: crypto.randomUUID(),
                status: 'failed',
                at: ago(20),
                summary: null,
                failedStep: r.failed.step,
                reason: r.failed.reason,
                wentBackTo: r.failed.wentBackTo ?? null,
              }
            : r?.version
              ? {
                  id: crypto.randomUUID(),
                  status: 'succeeded',
                  at: ago(r.sinceMin),
                  summary: null,
                  failedStep: null,
                  reason: null,
                  wentBackTo: null,
                }
              : null,
          waitingRelease:
            live && r?.version && s.status === 'approved'
              ? {
                  commit: 'a1b2c3d4e5f6',
                  version: '0.9.4',
                  cards: [
                    { ref: 'P5-12', title: 'Add the order export' },
                    { ref: 'P5-15', title: 'Fix the login redirect' },
                  ],
                  rulesMet: rules,
                  waitingFor: rules ? [] : ['test site healthy for 3 more minutes'],
                  places: [
                    { runId: '00000000-0000-4000-8000-0000000000b1', targetId: T2, name: 'prod-server' },
                  ],
                }
              : null,
        };
      }),
    });
  }),
  http.get(`${A}/projects/:id/delivery`, () => {
    const s = store();
    return HttpResponse.json({
      mode: 'recipe',
      canChangeMode: !s.member,
      canApprove: !s.member,
      vault: { folder: 'projects/p5', name: 'P5 vault', storage: 'git' },
      recipe: {
        present: !!s.setup,
        status: s.status === 'none' ? 'absent' : s.status,
        observedHash: s.setup ? s.hash : null,
        approvedHash: s.approvedHash,
        version: s.approvedHash ? 3 : 0,
        approvedAt: ago(2000),
        changes: [],
        lint: [],
      },
      environments: (s.setup?.environments ?? []).map((e) => ({
        name: e.name,
        targets: [{ name: e.target, production: e.target === 'shop-live', exists: true }],
        releasedBy: e.releasedBy,
        gate: 'inline',
        triggers: e.trigger,
        secrets: e.secrets,
      })),
      secrets: [],
    });
  }),
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
