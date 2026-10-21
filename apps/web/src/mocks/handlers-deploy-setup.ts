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

/** The compile result of a request body. */
function compileBody(body: unknown) {
  const c = compileSetup(body);
  return c.ok ? ({ ok: true, c, setup: c.setup } as const) : ({ ok: false, issues: c.issues } as const);
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

/** What the Places endpoint says (section 13.1): one place per target, with what uses it and why it cannot go. */
function placesDto() {
  const st = store();
  const saved = st.setup?.environments ?? [];
  const draft = st.draft?.environments ?? [];
  const active = st.targets.filter((t) => t.role === 'active');
  const places = st.targets.map((t) => {
    const usedBy = saved.filter((e) => e.target === t.name).map((e) => ({ env: e.name, label: e.label }));
    const usedByDraft = draft
      .filter((e) => e.target === t.name && !usedBy.some((u) => u.env === e.name))
      .map((e) => e.name);
    const first = active.find(
      (o) =>
        o.id !== t.id &&
        o.kind === t.kind &&
        (t.kind === 'remote_ssh'
          ? !!t.host && o.host === t.host
          : (o.workstationId ?? null) === (t.workstationId ?? null)) &&
        st.targets.indexOf(o) < st.targets.indexOf(t),
    );
    const names = [...usedBy.map((u) => u.label), ...usedByDraft];
    return {
      id: t.id,
      name: t.name,
      kind: t.kind === 'remote_ssh' ? 'server' : 'computer',
      workstationId: t.workstationId,
      workstationName: t.workstationName,
      workstationOnline: t.workstationOnline,
      host: t.host,
      appUrl: t.appUrl,
      production: t.production,
      role: t.role,
      reachability: t.reach
        ? { state: t.reach, at: ago(t.reachAgo), detail: null, method: 'existing_alias' }
        : null,
      lastProbeAt: ago(5),
      usedBy,
      usedByDraft,
      usedByFollowups: 0,
      duplicateOf:
        first && t.role === 'active'
          ? {
              id: first.id,
              name: first.name,
              reason: t.kind === 'remote_ssh' ? 'same_server' : 'same_computer',
            }
          : null,
      keyCount: 0,
      canRemove: names.length === 0,
      removeBlockedReason: names.length ? `Used by ${names.join(', ')}: change that first.` : null,
    };
  });
  return { places, canEdit: !st.member };
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
  http.post(`${A}/projects/:id/delivery/setup/discard-draft`, () => {
    update((s) => {
      s.draft = null;
      s.unmodelled = [];
    });
    return HttpResponse.json(state());
  }),
  http.post(`${A}/projects/:id/delivery/setup/remove-environment`, async ({ request }) => {
    const b = (await request.json()) as { env: string };
    const st = store();
    const base = st.draft ?? st.setup;
    if (!base || base.environments.length <= 1)
      return HttpResponse.json(
        { error: { code: 'last_environment', message: 'This is the last environment.' } },
        { status: 422 },
      );
    const gone = base.environments.find((e) => e.name === b.env);
    const left = base.environments
      .filter((e) => e.name !== b.env)
      .map((e) =>
        typeof e.gate === 'object' && e.gate.requires.some((r) => 'envHealthy' in r && r.envHealthy === b.env)
          ? { ...e, gate: 'none' as const }
          : e,
      );
    const impact = base.environments
      .filter(
        (e) =>
          e.name !== b.env &&
          typeof e.gate === 'object' &&
          e.gate.requires.some((r) => 'envHealthy' in r && r.envHealthy === b.env),
      )
      .map((e) => `${e.label} was waiting for ${gone?.label ?? b.env}: that rule is dropped.`);
    update((x) => {
      x.draft = { ...base, environments: left };
    });
    return HttpResponse.json({ ...state(), impact, lastEnvironment: false });
  }),
  http.post(`${A}/projects/:id/delivery/setup/stop-guided`, () => {
    update((s) => {
      s.setup = null;
      s.draft = null;
      s.status = 'none';
      s.approvedHash = null;
      s.tried = [];
    });
    return HttpResponse.json(state());
  }),
  http.put(`${A}/projects/:id/delivery/setup/environments/:env/place`, async ({ params, request }) => {
    const b = (await request.json()) as { placeId: string };
    const st = store();
    const t = st.targets.find((x) => x.id === b.placeId);
    const base = st.draft ?? st.setup;
    const e = base?.environments.find((x) => x.name === params.env);
    if (!t || !base || !e)
      return HttpResponse.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
    if ((e.hosting === 'ssh') !== (t.kind === 'remote_ssh'))
      return HttpResponse.json(
        { error: { code: 'kind_mismatch', message: 'That place does not fit.' } },
        { status: 422 },
      );
    update((x) => {
      x.draft = {
        ...base,
        environments: base.environments.map((y) =>
          y.name === params.env ? { ...y, target: t.name, ...(t.host ? { host: t.host } : {}) } : y,
        ),
      };
    });
    return HttpResponse.json(state());
  }),
  http.get(`${A}/projects/:id/places`, () => HttpResponse.json(placesDto())),
  http.post(`${A}/projects/:id/places/:placeId/remove`, async ({ params, request }) => {
    const b = (await request.json().catch(() => ({}))) as { removeKey?: boolean };
    const p = placesDto().places.find((x) => x.id === params.placeId);
    if (p && !p.canRemove)
      return HttpResponse.json(
        { error: { code: 'place_in_use', message: p.removeBlockedReason } },
        { status: 409 },
      );
    update((x) => {
      x.targets = x.targets.filter((t) => t.id !== params.placeId);
    });
    if (b.removeKey && p?.kind === 'server') {
      const fail = localStorage.getItem('aom-mock-revoke') === 'fail';
      const id = op(
        'revoke',
        !fail,
        { ok: !fail },
        fail ? 'The server did not answer, so Guildwise could not take its key off it.' : null,
      );
      if (fail) (ops.get(id) as Record<string, unknown>).localKeyKept = true;
      return HttpResponse.json({
        removed: true,
        keyCleanup: { state: 'started', commandId: id, reason: null },
      });
    }
    return HttpResponse.json({ removed: true, keyCleanup: { state: 'none', commandId: null, reason: null } });
  }),
  http.post(`${A}/projects/:id/delivery/ops/:commandId/forget-key`, ({ params }) => {
    const o = ops.get(String(params.commandId));
    if (o) {
      o.localKeyKept = false;
      o.errorText = null;
    }
    return HttpResponse.json({ ok: true });
  }),
  http.post(`${A}/projects/:id/places/merge`, async ({ request }) => {
    const b = (await request.json()) as { fromId: string; toId: string };
    const st = store();
    const from = st.targets.find((t) => t.id === b.fromId);
    const to = st.targets.find((t) => t.id === b.toId);
    if (!from || !to)
      return HttpResponse.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
    const base = st.draft ?? st.setup;
    const repointed = (base?.environments ?? []).filter((e) => e.target === from.name).map((e) => e.name);
    const stillUsedBySaved = (st.setup?.environments ?? [])
      .filter((e) => e.target === from.name)
      .map((e) => e.name);
    update((x) => {
      if (base && repointed.length)
        x.draft = {
          ...base,
          environments: base.environments.map((e) =>
            e.target === from.name ? { ...e, target: to.name } : e,
          ),
        };
      if (stillUsedBySaved.length === 0) x.targets = x.targets.filter((t) => t.id !== from.id);
    });
    return HttpResponse.json({
      repointed,
      followupsRepointed: 0,
      removed: stillUsedBySaved.length === 0,
      stillUsedBySaved,
    });
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
    if (!r.ok)
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
      s.setup = r.ok ? r.setup : b.setup;
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
    const st = store();
    const p = proposal(st);
    if (
      p.proposal.questions.some(
        (q: { answer?: string; optional?: boolean }) => !q.optional && q.answer === undefined,
      )
    )
      return HttpResponse.json(
        { error: { code: 'questions_open', message: 'Answer the questions first.' } },
        { status: 409 },
      );
    const incoming = (p.proposal.deploy as DeliverySetup).environments;
    const base = st.draft ?? st.setup;
    const existing = base?.environments ?? [];
    const merged = [...existing.filter((e) => !incoming.some((i) => i.name === e.name)), ...incoming];
    update((s) => {
      s.draft = { ...(base ?? (p.proposal.deploy as DeliverySetup)), environments: merged };
      s.proposal.open = false;
      if (s.targets.length === 0)
        s.targets = [
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
    return HttpResponse.json({
      ...state(),
      merge: {
        added: incoming.filter((i) => !existing.some((e) => e.name === i.name)).map((i) => i.name),
        replaced: incoming.filter((i) => existing.some((e) => e.name === i.name)).map((i) => i.name),
        notCovered: existing.filter((e) => !incoming.some((i) => i.name === e.name)).map((e) => e.name),
      },
    });
  }),
  http.post(`${A}/setup-proposals/:id/answers`, async ({ request }) => {
    const b = (await request.json()) as {
      answers: Array<{ path: string; value: string }>;
      confirmed?: string[];
    };
    const needs = b.answers
      .filter((a) => /sudo$/.test(a.path) && a.value === 'yes' && !(b.confirmed ?? []).includes(a.path))
      .map((a) => ({
        path: a.path,
        kind: 'sudo',
        text: 'Guildwise will use sudo to restart invoice-web.service on billing-vps. It only does this for that one command, and only if the server allows sudo without a password.',
      }));
    const st = update((s) => {
      for (const a of b.answers)
        if (!needs.some((n) => n.path === a.path)) s.proposal.answers[a.path] = a.value;
    });
    return HttpResponse.json({ ...proposal(st), needsConfirmation: needs });
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
    const p = placesDto().places.find((x) => x.id === params.id);
    if (p && !p.canRemove)
      return HttpResponse.json(
        { error: { code: 'place_in_use', message: p.removeBlockedReason } },
        { status: 409 },
      );
    update((x) => {
      x.targets = x.targets.filter((y) => y.id !== params.id);
    });
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${A}/projects/:id/environments/status`, () => {
    const s = store();
    const rules = localStorage.getItem('aom-mock-rules') === 'met';
    const envs = s.setup?.environments ?? [];
    const draftEnvs = (s.draft?.environments ?? []).filter((d) => !envs.some((e) => e.name === d.name));
    const approved = s.status === 'approved';
    const row = (e: DeliverySetup['environments'][number], draftOnly: boolean) => {
      const r = s.runs[e.name];
      const live = typeof e.gate === 'object' && e.gate.requires.length > 0;
      const changed =
        !draftOnly &&
        !!s.draft &&
        JSON.stringify(s.draft.environments.find((d) => d.name === e.name)) !== JSON.stringify(e);
      const target = s.targets.find((t) => t.name === e.target);
      const unreachable = target?.reach === 'unreachable' || target?.reach === 'host_key_changed';
      const tried = s.tried.includes(e.name);
      const waiting = live && !!r?.version && approved;
      const blockedBy = waiting && !rules ? ['test site healthy for 3 more minutes'] : [];
      const state = draftOnly
        ? 'draft'
        : unreachable
          ? 'cannot_reach'
          : r?.failed
            ? 'failed'
            : s.status === 'changed_unapproved'
              ? tried
                ? 'waiting_approval'
                : 'needs_try'
              : !tried
                ? 'needs_try'
                : !approved
                  ? 'waiting_approval'
                  : blockedBy.length
                    ? 'blocked'
                    : 'healthy';
      const text: Record<string, string> = {
        draft: 'Not saved. Nothing has changed yet.',
        cannot_reach: `${target?.name ?? 'The place'} cannot be reached. Updates are blocked until it is back.`,
        failed: `The update stopped at ${r?.failed?.step}: ${r?.failed?.reason}. Went back to ${r?.failed?.wentBackTo}.`,
        needs_try: 'Saved. Try it before the Owner approves.',
        waiting_approval: 'Tried: would work. Waiting for the Owner to approve.',
        blocked: `Waiting for: ${blockedBy.join('; ')}.`,
        healthy: r?.version ? `Version ${r.version} is live.` : 'Nothing has been updated here yet.',
      };
      return {
        env: e.name,
        label: e.label,
        role: live ? 'live' : e.trigger[0] === 'after_merge' ? 'test' : 'other',
        hosting: e.hosting,
        runtime: e.runtime ?? 'docker',
        placeId: target?.id ?? null,
        placeName:
          target?.workstationName && target.kind === 'local_docker'
            ? target.workstationName
            : (target?.name ?? ''),
        appUrl: e.app.appUrl ?? null,
        releasedBy: e.releasedBy,
        updates: e.trigger[0] === 'after_merge' ? 'after each merge' : 'when you release',
        rules: live ? ['test site is healthy on the same version for 10 minutes'] : [],
        current: r?.version
          ? {
              runId: crypto.randomUUID(),
              commit: r.commit,
              version: r.version,
              since: ago(r.sinceMin),
              releasedBy: 'Ada Admin',
              kind: 'release',
            }
          : null,
        health: {
          state: r?.version ? (r.health === 'updating' ? 'unknown' : r.health) : 'unknown',
          at: r?.version ? ago(3) : null,
          detail: null,
        },
        lastRun: r?.failed
          ? {
              runId: crypto.randomUUID(),
              status: 'failed',
              at: ago(20),
              summary: r.failed.reason,
              rolledBack: !!r.failed.wentBackTo,
            }
          : r?.version
            ? {
                runId: crypto.randomUUID(),
                status: 'succeeded',
                at: ago(r.sinceMin),
                summary: null,
                rolledBack: false,
              }
            : null,
        waitingRelease: waiting
          ? { runId: '00000000-0000-4000-8000-0000000000b1', commit: 'a1b2c3d4e5f6', waitingFor: 'owner' }
          : null,
        blockedBy,
        savedState: draftOnly ? 'none' : changed ? 'draft' : 'saved',
        triedState: draftOnly ? 'none' : tried ? 'tried' : 'needs_try',
        approvalState: draftOnly
          ? 'none'
          : approved
            ? 'approved'
            : s.status === 'changed_unapproved'
              ? 'changed'
              : 'unapproved',
        openQuestions: 0,
        state,
        stateText: text[state] ?? '',
      };
    };
    return HttpResponse.json({
      environments: [...envs.map((e) => row(e, false)), ...draftEnvs.map((e) => row(e, true))],
      openQuestions: 0,
      deliveryMode: s.setup ? 'recipe' : 'instructions',
      generatedAt: ago(0),
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
  http.post(`${A}/projects/:id/delivery/targets/:targetId/check`, ({ params }) => {
    localStorage.setItem('aom-mock-reach', 'ok');
    update((s) => {
      const t = s.targets.find((x) => x.id === params.targetId);
      if (t) {
        t.reach = 'reachable';
        t.reachAgo = 0;
      }
    });
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
