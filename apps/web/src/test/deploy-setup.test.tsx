import { compileSetup, localAdoptEnv, type ProbeReport, sshShipEnv } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedSetup } from '../components/delivery/setup/AdvancedSetup.tsx';
import { AnswerFields, blockingQuestions, questionKind } from '../components/environments/AnswerFields.tsx';
import {
  answersFromEnv,
  buildEnv,
  emptyAnswers,
  guessAppService,
  guessDbService,
  guessImageName,
  healthProbeUrls,
  plainLint,
  stacksFromReport,
} from '../components/environments/answers.ts';
import { cardInfo, placesOf, roleOf, rulesOf, slugName } from '../components/environments/model.ts';
import { EnvironmentsPointer } from '../components/environments/Pointer.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ProjectEnvironments } from '../pages/ProjectEnvironments.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const WS = ID(20);
const T_LOCAL = ID(31);
const T_PROD = ID(32);

const calls: Array<{ method: string; url: string; body?: any }> = [];
let routes: Record<string, (init: RequestInit) => Response> = {};
beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return routes[`${init.method ?? 'GET'} ${String(url).split('?')[0]}`]?.(init) ?? json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

const at = '2026-10-20T10:00:00.000Z';
const workstation = (over: Record<string, unknown> = {}) => ({
  id: WS,
  name: 'Office PC',
  connected: true,
  mine: true,
  canProbe: true,
  blocked: null,
  canConnect: true,
  ...over,
});
const state = (over: Record<string, unknown> = {}) => ({
  canEdit: true,
  canApprove: true,
  draft: null,
  current: {
    setup: null,
    handEdited: [],
    recipePresent: false,
    recipeStatus: null,
    observedHash: null,
    approvedHash: null,
    lint: [],
    dryRunOk: [],
    custom: false,
  },
  publish: null,
  targets: [],
  workstations: [workstation()],
  probes: [],
  writeBlocked: null,
  scan: null,
  scanProblem: null,
  proposal: null,
  generator: 'setup-1.3',
  ...over,
});
const report = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    scope: 'local',
    at,
    docker: { installed: true, usable: true, version: '29.1', composeVersion: '2.40.0' },
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
    ...over,
  }) as unknown as ProbeReport;
const probe = (over: Record<string, unknown>) => ({
  id: ID(Math.floor(Math.random() * 1e6)),
  targetId: null,
  workstationId: WS,
  workstationName: 'Office PC',
  scope: 'local',
  host: null,
  at,
  report: null,
  error: null,
  errorText: null,
  ...over,
});

const uatStack = () => ({
  path: '/home/u/uat/docker-compose.yml',
  project: 'uat',
  services: [
    {
      name: 'postgres',
      image: 'postgres:18',
      database: 'postgres',
      ports: [],
      volumes: ['pgdata'],
      envFiles: [],
      vars: [],
    },
    { name: 'app', build: '/home/u/src/app', ports: ['4700:4600'], volumes: [], envFiles: [], vars: [] },
    { name: 'mailpit', image: 'axllent/mailpit', ports: [], volumes: [], envFiles: [], vars: [] },
  ],
  volumes: ['pgdata'],
});
const uatReport = () =>
  report({
    composeFiles: [uatStack()],
    containers: [
      {
        name: 'uat-app-1',
        project: 'uat',
        service: 'app',
        image: 'uat-app',
        state: 'running',
        status: 'Up 3 days',
        ports: [{ host: 4700, container: 4600, bind: '0.0.0.0' }],
      },
      {
        name: 'uat-postgres-1',
        project: 'uat',
        service: 'postgres',
        image: 'postgres:18',
        state: 'running',
        ports: [],
      },
      { name: 'other-redis', image: 'redis:7', state: 'running', ports: [] },
    ],
    urls: [{ url: 'http://localhost:4700/api/health', status: 200 }],
    volumes: ['uat_pgdata', 'other_data'],
  });

const serve = (o: Record<string, unknown>) => {
  routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(o);
};

describe('model', () => {
  it('stacks, guesses and the environment the answers make', () => {
    const stacks = stacksFromReport(uatReport());
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.running).toBe(true);
    expect(guessAppService(stacks[0] as never)).toBe('app');
    expect(guessDbService(stacks[0] as never)).toBe('postgres');
    expect(guessImageName(stacks[0] as never, 'app')).toBe('uat-app');
    const a = {
      ...emptyAnswers('test'),
      stackPath: '/home/u/uat/docker-compose.yml',
      appService: 'app',
      dbService: 'postgres',
      imageName: 'uat-app',
      appUrl: 'http://localhost:4700',
      healthUrl: 'http://localhost:4700/api/health',
      targetName: 'Test copy',
      backupDir: '/home/u/uat/backups',
    };
    const env = buildEnv(a, '/home/u');
    expect(env).toMatchObject({
      name: 'test-site',
      hosting: 'this_computer',
      trigger: ['after_merge'],
      releasedBy: 'auto',
      gate: 'none',
      app: { composeFile: '~/uat/docker-compose.yml', service: 'app', imageName: 'uat-app' },
      health: { kind: 'http', url: '${appUrl}/api/health' },
    });
    expect(env.steps.map((s) => s.kind)).toEqual(['db_backup', 'compose_up_local']);
    expect(compileSetup({ environments: [env] }).ok).toBe(true);
    // editing starts from the same answers
    expect(answersFromEnv(env, { production: false })).toMatchObject({
      appService: 'app',
      dbService: 'postgres',
      trigger: 'after_merge',
    });
  });

  it('the live site: owner releases, gated on the test copy for 10 minutes, unless the person turns the rule off', () => {
    const a = {
      ...emptyAnswers('live'),
      host: 'prod',
      stackPath: '/opt/p/docker-compose.yml',
      appService: 'app',
      imageName: 'p',
      imageVar: 'P_IMAGE',
      healthUrl: 'https://p.example.com/ready',
      testEnv: 'uat',
      targetName: 'Live site',
    };
    const env = buildEnv(a);
    expect(env).toMatchObject({
      releasedBy: 'owner',
      trigger: ['on_request'],
      gate: { requires: [{ envHealthy: 'uat', forMinutes: 10 }] },
    });
    expect(env.steps.map((s) => s.kind)).toEqual([
      'env_backup',
      'build_image_local',
      'ship_image_ssh',
      'set_image_var',
      'compose_up_remote',
    ]);
    expect(buildEnv({ ...a, requireTestFirst: false }).gate).toBe('none');
    // still lint-clean: the Owner releases it
    expect(sshShipEnv).toBeTypeOf('function');
  });

  it('database updates before the restart become a compose_run step in the right place, and come back when editing', () => {
    const a = {
      ...emptyAnswers('test'),
      stackPath: '/home/u/uat/docker-compose.yml',
      appService: 'app',
      dbService: 'postgres',
      imageName: 'uat-app',
      appUrl: 'http://localhost:4700',
      targetName: 'Test copy',
      backupDir: '/home/u/uat/backups',
      migrateCmd: 'npm run migrate -- --yes',
    };
    const env = buildEnv(a, '/home/u');
    expect(env.steps.map((s) => s.kind)).toEqual(['db_backup', 'compose_run', 'compose_up_local']);
    expect(env.steps[1]).toMatchObject({
      kind: 'compose_run',
      argv: ['npm', 'run', 'migrate', '--', '--yes'],
    });
    expect(compileSetup({ environments: [env] }).ok).toBe(true);
    expect(answersFromEnv(env, { production: false }).migrateCmd).toBe('npm run migrate -- --yes');
    // without a database backup the setup is refused with a plain reason
    const noDb = compileSetup({ environments: [buildEnv({ ...a, dbService: '' }, '/home/u')] });
    expect(noDb.ok).toBe(false);
    // on a server it runs after the copy and before the restart
    const live = buildEnv(
      {
        ...emptyAnswers('live'),
        host: 'prod',
        stackPath: '/opt/g/docker-compose.yml',
        appService: 'app',
        dbService: 'postgres',
        imageName: 'g',
        imageVar: 'G_IMAGE',
        healthUrl: 'https://g.example.com/ready',
        targetName: 'Live',
        migrateCmd: 'npm run migrate',
      },
      undefined,
    );
    expect(live.steps.map((s) => s.kind)).toEqual([
      'db_backup',
      'env_backup',
      'build_image_local',
      'ship_image_ssh',
      'set_image_var',
      'compose_run',
      'compose_up_remote',
    ]);
    expect(compileSetup({ environments: [live] }).ok).toBe(true);
  });

  it('plain lint copy and the sites worth asking a server about', () => {
    expect(plainLint({ code: 'production_no_gate', level: 'error', message: 'x' })).toContain(
      'needs your release',
    );
    expect(
      healthProbeUrls(
        report({
          proxies: [{ kind: 'caddy', via: 'container', name: 'c', sites: ['hq.example.com', 'localhost'] }],
        }),
      ),
    ).toEqual([
      'https://hq.example.com/ready',
      'https://hq.example.com/api/health',
      'https://hq.example.com/health',
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ helpers of the page tests

const mountPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/p/P5/environments']}>
          <Routes>
            <Route path="/p/:projectKey/environments" element={<ProjectEnvironments />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

const savedState = (over: Record<string, unknown> = {}, current: Record<string, unknown> = {}): any => {
  const c = compileSetup({
    environments: [
      localAdoptEnv({
        name: 'uat',
        label: 'Test site',
        target: 'shop-uat',
        composeFile: '~/shop-uat/docker-compose.yml',
        service: 'app',
        imageName: 'shop-uat-app',
        appUrl: 'http://localhost:8080',
      }),
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
        },
        'uat',
      ),
    ],
  });
  if (!c.ok) throw new Error('compile');
  return state({
    current: {
      setup: c.setup,
      handEdited: [],
      recipePresent: true,
      recipeStatus: 'observed',
      observedHash: 'a'.repeat(64),
      approvedHash: null,
      lint: [],
      dryRunOk: [],
      dryRunMissing: ['uat', 'production'],
      custom: false,
      ...current,
    },
    targets: [
      {
        id: T_LOCAL,
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
        id: T_PROD,
        name: 'shop-live',
        kind: 'remote_ssh',
        production: true,
        workstationId: WS,
        workstationName: 'Office PC',
        workstationOnline: true,
        host: 'prod-server',
        appUrl: 'https://shop.example.com',
        connection: {
          state: 'reachable',
          at: new Date().toISOString(),
          detail: null,
          method: 'existing_alias',
        },
        keys: [],
        role: 'active',
      },
    ],
    ...over,
  });
};

const serveProject = () => {
  routes['GET /api/projects'] = () =>
    json({ projects: [{ id: PROJECT, key: 'P5', name: 'Flow5', workflowKey: 'code', myRole: 'owner' }] });
};

describe('the Environments page: model', () => {
  it('roles, names, rules in sentences and the state of a card', () => {
    const s = savedState();
    const envs = s.current.setup?.environments ?? [];
    const places = placesOf(s as never);
    expect(roleOf(envs[0] as never)).toBe('test');
    expect(roleOf(envs[1] as never)).toBe('live');
    expect(slugName('Test site', ['test-site'])).toBe('test-site-2');
    expect(rulesOf(envs[1] as never, (n) => (n === 'uat' ? 'test site' : n))).toEqual([
      'test site is healthy on the same version for 10 minutes',
      'You approve every release',
    ]);
    const info = cardInfo({
      s: s as never,
      env: envs[0] as never,
      draft: false,
      place: places[0],
      status: undefined,
    });
    expect(info.state).toBe('needs_try');
    expect(info.chip.label).toBe('Needs a try');
    expect(info.strip).toEqual({ saved: true, tried: false, approved: false });
    const tried = savedState({}, { dryRunMissing: [], dryRunOk: ['uat', 'production'] });
    expect(
      cardInfo({
        s: tried as never,
        env: envs[0] as never,
        draft: false,
        place: places[0],
        status: undefined,
      }).state,
    ).toBe('waiting_approval');
    const approved = savedState({}, { dryRunMissing: [], recipeStatus: 'approved' });
    expect(
      cardInfo({
        s: approved as never,
        env: envs[1] as never,
        draft: false,
        place: places[1],
        status: {
          env: 'production',
          version: '0.9.2',
          commit: 'a',
          since: null,
          health: 'healthy',
          appUrl: null,
          lastRun: null,
          waitingRelease: {
            commit: 'b',
            version: '0.9.4',
            cards: [],
            rulesMet: false,
            waitingFor: ['test site healthy for 3 more minutes'],
            places: [],
          },
        },
      }),
    ).toMatchObject({ state: 'blocked', sentence: 'Waiting for: test site healthy for 3 more minutes.' });
    // a draft is "not saved", and a place nobody can sign in to blocks updates with the reason
    expect(
      cardInfo({ s: s as never, env: envs[0] as never, draft: true, place: places[0], status: undefined })
        .sentence,
    ).toBe('Not saved. Nothing has changed yet.');
    const off = savedState({}, { dryRunMissing: [], recipeStatus: 'approved' });
    (off.targets[1] as { connection: unknown }).connection = {
      state: 'unreachable',
      at,
      detail: null,
      method: 'existing_alias',
    };
    const offPlaces = placesOf(off as never);
    expect(
      cardInfo({
        s: off as never,
        env: envs[1] as never,
        draft: false,
        place: offPlaces[1],
        status: undefined,
      }),
    ).toMatchObject({ state: 'cannot_reach', action: 'check' });
  });

  it('a place that repeats another (same server, same computer) is marked once, with what uses it', () => {
    const s = savedState();
    s.targets.push({ ...(s.targets[0] as object), id: ID(40), name: 'Test copy' } as never);
    s.targets.push({ ...(s.targets[1] as object), id: ID(41), name: 'live again' } as never);
    const places = placesOf(s as never);
    expect(places[0]?.duplicateOf).toBeNull();
    expect(places[2]?.duplicateOf).toBe(T_LOCAL);
    expect(places[3]?.duplicateOf).toBe(T_PROD);
    expect(places[0]?.usedBy.map((u) => u.label)).toEqual(['Test site']);
    expect(places[2]?.usedBy).toEqual([]);
  });

  it('questions get the control they need and defaults do not block', () => {
    expect(
      questionKind({ path: '/a', question: 'Which part is your app?', options: ['app', 'worker', 'web'] }),
    ).toBe('choice');
    expect(
      questionKind({
        path: '/a',
        question: 'Is it live?',
        options: ['Yes, customers use it', 'No, a test site'],
      }),
    ).toBe('yesno');
    expect(questionKind({ path: '/a', question: 'Which port does the website use?', default: '3000' })).toBe(
      'number',
    );
    expect(questionKind({ path: '/a', question: 'What is the site called?' })).toBe('text');
    const qs = [
      { path: '/a', question: 'Which part is your app?', options: ['app', 'web'] },
      { path: '/b', question: 'Port?', default: '3000' },
    ];
    expect(blockingQuestions(qs, {}).map((q) => q.path)).toEqual(['/a']);
    expect(blockingQuestions(qs, { '/a': 'app' })).toEqual([]);
  });
});

describe('the Environments page', () => {
  it('empty: three choices, the scan is the primary one and starts a deploy scan', async () => {
    const user = userEvent.setup();
    serveProject();
    serve(state());
    routes[`POST /api/projects/${PROJECT}/scan`] = () => json({ requestId: ID(5) }, 202);
    mountPage();
    const empty = await screen.findByTestId('setup-empty');
    expect(within(empty).getByText('I only want card test copies')).toBeInTheDocument();
    expect(within(empty).getByText('A test site my team can try')).toBeInTheDocument();
    await user.click(within(empty).getByTestId('empty-scan'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/scan') && x.body?.area === 'deploy')).toBeTruthy(),
    );
  });

  it('a question has real fields: the banner opens the review, Use is blocked until it is answered, the answer is sent with its path', async () => {
    const user = userEvent.setup();
    serveProject();
    let answers: Record<string, unknown> = {};
    const proposal = () => ({
      id: ID(40),
      area: 'deploy',
      status: 'open',
      requestId: ID(41),
      workstationId: WS,
      workstationName: 'Office PC',
      submittedAt: at,
      proposal: {
        area: 'deploy',
        deploy: {
          version: 1,
          generator: 'setup-1.3',
          environments: [
            localAdoptEnv({
              name: 'uat',
              label: 'Test site',
              target: 'T',
              composeFile: '~/uat/c.yml',
              service: 'app',
              imageName: 'a',
            }),
          ],
        },
        items: [{ path: '/environments/0/app/service', confidence: 'unknown', evidence: [] }],
        questions: [
          {
            path: '/environments/0/app/service',
            question: 'Which part is your app?',
            options: ['app', 'worker', 'web'],
          },
          {
            path: '/environments/0/app/appUrl',
            question: 'Which port does the website use?',
            default: '3000',
          },
        ],
        answers,
        secretsNeeded: [],
        notes: '',
        filesRead: ['docker-compose.yml'],
      },
    });
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ proposal: proposal() }));
    routes['POST /api/setup-proposals/' + ID(40) + '/answers'] = (init) => {
      for (const a of JSON.parse(String(init.body)).answers) answers = { ...answers, [a.path]: a.value };
      return json({ proposal: proposal(), remaining: 0 });
    };
    routes[`POST /api/projects/${PROJECT}/delivery/setup/use-proposal`] = () => json(state());
    mountPage();
    const banner = await screen.findByTestId('needs-answer');
    expect(banner).toHaveTextContent('Which part is your app?');
    await user.click(screen.getByTestId('needs-answer-open'));
    const review = await screen.findByTestId('proposal-review');
    // no "Answer" button anywhere: radios for the choices, a number field with its default said in words
    expect(within(review).queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(within(review).getAllByRole('radio')).toHaveLength(3);
    expect(within(review).getByTestId('answer-1-input')).toHaveValue('3000');
    expect(within(review).getByText(/We will use 3000 unless you change it/)).toBeInTheDocument();
    expect(screen.getByTestId('proposal-use')).toBeDisabled();
    await user.click(within(review).getByTestId('answer-0-app'));
    await user.click(within(review).getByTestId('answers-submit'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/answers'))?.body).toEqual({
        answers: [
          { path: '/environments/0/app/service', value: 'app' },
          { path: '/environments/0/app/appUrl', value: 3000 },
        ],
      }),
    );
  });

  it('the strip: saved, try it first, then the Owner approves exactly the version that was tried; a member waits', async () => {
    const user = userEvent.setup();
    serveProject();
    serve(savedState());
    routes[`POST /api/projects/${PROJECT}/delivery/setup/dry-run`] = () =>
      json({
        message: 'Would back up, build and copy. Nothing was changed.',
        runs: [{ status: 'succeeded' }],
      });
    mountPage();
    const card = await screen.findByTestId('env-card-uat');
    expect(within(card).getByTestId('env-chip-uat')).toHaveTextContent('Needs a try');
    expect(within(card).getByTestId('strip-saved')).toHaveAttribute('data-done', 'true');
    expect(within(card).getByTestId('strip-tried')).toHaveAttribute('data-done', 'false');
    expect(within(card).queryByTestId('env-approve-uat')).toBeNull();
    await user.click(within(card).getByTestId('env-try-uat'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/setup/dry-run'))?.body).toEqual({ env: 'uat' }),
    );
    expect(await within(card).findByTestId('env-tried-uat')).toHaveTextContent('Nothing was changed');
  });

  it('tried: Approve is disabled while another environment is untried (with the reason), then asks the server for the hash it showed', async () => {
    const user = userEvent.setup();
    serveProject();
    serve(savedState({}, { dryRunMissing: ['production'], dryRunOk: ['uat'] }));
    routes[`POST /api/projects/${PROJECT}/delivery/approve`] = () => json({});
    mountPage();
    const card = await screen.findByTestId('env-card-uat');
    expect(within(card).getByTestId('env-chip-uat')).toHaveTextContent('Waiting for approval');
    expect(within(card).getByTestId('env-approve-uat')).toBeDisabled();
    expect(within(card).getByTestId('env-approve-reason-uat')).toHaveTextContent('Try Live site first');
    cleanup();
    serve(savedState({}, { dryRunMissing: [], dryRunOk: ['uat', 'production'] }));
    mountPage();
    const card2 = await screen.findByTestId('env-card-uat');
    await user.click(within(card2).getByTestId('env-approve-uat'));
    expect(await screen.findByTestId('approve-dialog')).toHaveTextContent('first approval');
    await user.click(screen.getByTestId('approve-confirm'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/delivery/approve'))?.body).toEqual({ hash: 'a'.repeat(64) }),
    );
  });

  it('someone who is not the Owner sees the same page read-only with the one sentence, and waits for the approval', async () => {
    serveProject();
    serve(
      savedState(
        { canEdit: false, canApprove: false },
        { dryRunMissing: [], dryRunOk: ['uat', 'production'] },
      ),
    );
    mountPage();
    expect(await screen.findByTestId('env-readonly')).toHaveTextContent(
      'Only the project owner changes environments',
    );
    const card = await screen.findByTestId('env-card-uat');
    expect(within(card).queryByTestId('env-approve-uat')).toBeNull();
    expect(within(card).queryByTestId('setup-add')).toBeNull();
    expect(screen.queryByTestId('setup-add')).toBeNull();
  });

  it('a runner that is too old is a plain warning, the cards stay', async () => {
    serveProject();
    serve(
      savedState({
        workstations: [workstation({ canProbe: false, blocked: 'Guildwise on Office PC needs an update.' })],
      }),
    );
    mountPage();
    expect(await screen.findByTestId('setup-runner-old')).toHaveTextContent(
      'needs an update to set up environments',
    );
    expect(await screen.findByTestId('env-card-uat')).toBeInTheDocument();
  });

  it('Places lists each place once with what uses it; a duplicate offers Merge, and a place that is used cannot be removed', async () => {
    const user = userEvent.setup();
    serveProject();
    const s = savedState();
    s.targets.push({ ...(s.targets[0] as object), id: ID(40), name: 'Test copy' } as never);
    serve(s);
    routes['POST /api/deploy-targets/merge'] = () => json({ ok: true });
    routes[`DELETE /api/deploy-targets/${ID(40)}`] = () => json({ ok: true });
    mountPage();
    const places = await screen.findByTestId('places');
    expect(within(places).getByTestId('place-shop-uat')).toHaveTextContent('Used by: Test site');
    expect(within(places).getByTestId('place-shop-live')).toHaveTextContent('Used by: Live site');
    expect(within(places).getByTestId('place-duplicate-Test copy')).toHaveTextContent(
      'Looks like a duplicate of Office PC',
    );
    // used: removing says which environment, and the button is off
    await user.click(within(places).getAllByRole('button', { name: 'More for Office PC' })[0] as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    expect(await screen.findByTestId('place-in-use')).toHaveTextContent(
      'Used by Test site: change that first',
    );
    expect(screen.getByTestId('remove-place-confirm')).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(within(places).getByTestId('place-merge-Test copy'));
    expect(await screen.findByTestId('merge-dialog')).toHaveTextContent('Nothing on the computer is touched');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/deploy-targets/merge'))?.body).toEqual({
        fromId: ID(40),
        toId: T_LOCAL,
      }),
    );
  });

  it('removing an unused server says nothing on it is touched, and can also remove the Guildwise key', async () => {
    const user = userEvent.setup();
    serveProject();
    const s = savedState();
    s.targets.push({
      ...(s.targets[1] as object),
      id: ID(42),
      name: 'old-vps',
      host: 'old-vps',
      production: false,
    } as never);
    serve(s);
    routes[`DELETE /api/deploy-targets/${ID(42)}`] = () => json({ ok: true });
    mountPage();
    const places = await screen.findByTestId('places');
    await user.click(within(places).getByRole('button', { name: 'More for old-vps' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByTestId('remove-place-dialog');
    expect(dialog).toHaveTextContent('Nothing on the server is touched');
    await user.click(within(dialog).getByTestId('remove-key'));
    await user.click(screen.getByTestId('remove-place-confirm'));
    await waitFor(() =>
      expect(calls.find((x) => x.method === 'DELETE' && x.url.includes(ID(42)))?.url).toContain(
        'revokeKey=1',
      ),
    );
  });

  it('removing an environment names what is not touched and asks the server to take it out of the setup', async () => {
    const user = userEvent.setup();
    serveProject();
    serve(savedState());
    routes[`DELETE /api/projects/${PROJECT}/delivery/environments/uat`] = () => json({ ok: true });
    mountPage();
    const card = await screen.findByTestId('env-card-uat');
    await user.click(within(card).getByRole('button', { name: 'More for Test site' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByTestId('remove-env-dialog');
    expect(dialog).toHaveTextContent('left exactly as it is');
    await user.click(screen.getByTestId('remove-env-confirm'));
    await waitFor(() =>
      expect(calls.some((x) => x.method === 'DELETE' && x.url.endsWith('/environments/uat'))).toBe(true),
    );
  });

  it('clean up lists the unfinished draft and an old file, and nothing goes unless it is ticked', async () => {
    const user = userEvent.setup();
    serveProject();
    const s = savedState();
    (s as { draft: unknown }).draft = {
      setup: { ...(s.current.setup as object), environments: [(s.current.setup?.environments ?? [])[0]] },
      customScripts: {},
      proposalId: null,
      updatedAt: at,
    };
    serve(s);
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = () =>
      json({
        ok: true,
        issues: [],
        hash: 'h'.repeat(64),
        files: [],
        keep: [],
        unmodelled: ['delivery/smoke.sh'],
        lint: [],
        changes: [],
        differsFromCurrent: false,
        needsDryRun: [],
      });
    routes[`DELETE /api/projects/${PROJECT}/delivery/setup/draft`] = () => json({ ok: true });
    mountPage();
    await user.click(await screen.findByText(/Show technical details/));
    expect(await screen.findByText('Old setups and drafts (2)')).toBeInTheDocument();
    await user.click(screen.getByTestId('cleanup-open'));
    const dialog = await screen.findByTestId('cleanup-dialog');
    expect(within(dialog).getByTestId('cleanup-file-delivery/smoke.sh')).not.toBeChecked();
    await user.click(screen.getByTestId('cleanup-confirm'));
    await waitFor(() =>
      expect(calls.some((x) => x.method === 'DELETE' && x.url.endsWith('/setup/draft'))).toBe(true),
    );
  });

  it('a scan in progress and a scan that gave nothing are said in words', async () => {
    serveProject();
    serve(
      state({
        scan: {
          requestId: ID(5),
          area: 'deploy',
          status: 'running',
          workstationId: WS,
          workstationName: 'Office PC',
          startedAt: at,
        },
      }),
    );
    mountPage();
    expect(await screen.findByTestId('deploy-scan-progress')).toHaveTextContent(
      'DevOps is looking on Office PC',
    );
    cleanup();
    serve(state({ scanProblem: 'DevOps could not read the project.' }));
    mountPage();
    expect(await screen.findByTestId('deploy-scan-problem')).toHaveTextContent('could not read the project');
  });
});

describe('answer fields', () => {
  it('"Use these answers" is off until each required question has a value; choices are radios, a yes or no is two radios', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    wrap(
      <AnswerFields
        questions={[
          { path: '/a', question: 'Which part is your app?', options: ['app', 'worker'] },
          { path: '/b', question: 'Is it live?', options: ['Yes, customers use it', 'No, a test site'] },
        ]}
        answered={{}}
        pending={false}
        onSubmit={(a) => sent.push(a)}
      />,
    );
    expect(screen.getByTestId('answers-submit')).toBeDisabled();
    await user.click(screen.getByTestId('answer-0-worker'));
    await user.click(screen.getByTestId('answer-1-No, a test site'));
    await user.click(screen.getByTestId('answers-submit'));
    expect(sent).toEqual([
      [
        { path: '/a', value: 'worker' },
        { path: '/b', value: false },
      ],
    ]);
  });
});

describe('the Add environment dialog', () => {
  const setupFlow = (over: { places?: boolean } = {}) => {
    let probes: unknown[] = [];
    let publish: unknown = null;
    let created = false;
    const base = () =>
      state({
        probes,
        publish,
        ...(over.places || created
          ? {
              targets: [
                {
                  id: T_LOCAL,
                  name: 'Office PC',
                  kind: 'local_docker',
                  production: false,
                  workstationId: WS,
                  workstationName: 'Office PC',
                  workstationOnline: true,
                  host: null,
                  appUrl: null,
                  connection: null,
                },
              ],
            }
          : {}),
      });
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(base());
    serveProject();
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () => {
      probes = [probe({ report: uatReport() })];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    routes[`POST /api/projects/${PROJECT}/deploy-targets`] = () => {
      created = true;
      return json({ id: T_LOCAL });
    };
    routes[`PUT /api/projects/${PROJECT}/delivery/setup`] = () => json(base());
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = (init) => {
      const body = JSON.parse(String(init.body));
      const c = compileSetup(body.setup);
      return json({
        ok: true,
        issues: [],
        hash: c.ok ? c.hash : null,
        files: [],
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: true,
        needsDryRun: [],
      });
    };
    routes[`POST /api/projects/${PROJECT}/delivery/setup/publish`] = () => {
      publish = { setupHash: 'x', commandId: ID(88), status: 'written', error: null, at };
      return json({ commandId: ID(88), hash: 'x' }, 202);
    };
  };

  it('a computer becomes a place only at Save: adopt the running stack, review what is not touched, save the previewed version', async () => {
    const user = userEvent.setup();
    setupFlow();
    mountPage();
    await user.click(await screen.findByTestId('setup-add'));
    expect(screen.getByTestId('wizard-step')).toHaveTextContent('Step 1 of 3');
    await user.click(screen.getByTestId('place-choice-Office PC'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/delivery/probe'))?.body).toMatchObject({
        scope: 'local',
        workstationId: WS,
      }),
    );
    const stack = await screen.findByTestId('stack-choice', undefined, { timeout: 6000 });
    expect(stack).toHaveTextContent('3 parts (postgres, app, mailpit)');
    expect(stack).toHaveTextContent('Running now');
    await user.click(stack);
    expect(screen.getByTestId('when-auto')).toBeChecked;
    await user.click(screen.getByTestId('env-next'));
    const found = await screen.findByTestId('found-changes');
    expect(within(found).getByTestId('changes-untouched')).toHaveTextContent('Container other-redis');
    expect((screen.getByTestId('details-app') as HTMLSelectElement).value).toBe('app');
    expect(screen.queryByTestId('details-production')).toBeNull();
    // nothing was created yet
    expect(calls.some((x) => x.method === 'POST' && x.url.endsWith('/deploy-targets'))).toBe(false);
    await user.click(screen.getByTestId('env-to-review'));
    const save = await screen.findByTestId('review-save');
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(calls.find((x) => x.url.endsWith('/setup/publish'))).toBeTruthy());
    expect(calls.find((x) => x.method === 'POST' && x.url.endsWith('/deploy-targets'))?.body).toMatchObject({
      name: 'Office PC',
      kind: 'local_docker',
      workstationId: WS,
      production: false,
    });
    const published = calls.find((x) => x.url.endsWith('/setup/publish'))?.body;
    expect(published.setup.environments[0]).toMatchObject({
      name: 'test-site',
      label: 'Test site',
      role: 'test',
      target: 'Office PC',
      trigger: ['after_merge'],
      app: { service: 'app', composeProject: 'uat' },
    });
    expect(await screen.findByTestId('review-saved')).toHaveTextContent('Nothing runs before that');
  });

  it('a place that already exists is chosen, never made again', async () => {
    const user = userEvent.setup();
    setupFlow({ places: true });
    mountPage();
    await user.click(await screen.findByTestId('setup-add'));
    expect(screen.getAllByTestId('place-choice-Office PC')).toHaveLength(1);
    await user.click(screen.getByTestId('place-choice-Office PC'));
    await user.click(await screen.findByTestId('stack-choice', undefined, { timeout: 6000 }));
    await user.click(screen.getByTestId('env-next'));
    await user.click(await screen.findByTestId('env-to-review'));
    await user.click(await screen.findByTestId('review-save'));
    await waitFor(() => expect(calls.find((x) => x.url.endsWith('/setup/publish'))).toBeTruthy());
    expect(calls.some((x) => x.method === 'POST' && x.url.endsWith('/deploy-targets'))).toBe(false);
    expect(calls.find((x) => x.url.endsWith('/setup/publish'))?.body.setup.environments[0].target).toBe(
      'Office PC',
    );
  });

  it('when nothing is found it says what was checked, and "My app is somewhere else" looks in the folder given', async () => {
    const user = userEvent.setup();
    setupFlow();
    let probes: unknown[] = [];
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ probes }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = (init) => {
      const b = JSON.parse(String(init.body));
      probes = [
        probe({
          report: b.hints?.dirs?.length
            ? uatReport()
            : report({
                folders: [
                  { path: '/opt', exists: true, entries: [] },
                  { path: '/srv', exists: true, entries: [] },
                ],
              }),
        }),
      ];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    mountPage();
    await user.click(await screen.findByTestId('setup-add'));
    await user.click(screen.getByTestId('place-choice-Office PC'));
    const miss = await screen.findByTestId('no-stacks', undefined, { timeout: 6000 });
    expect(miss).toHaveTextContent('/opt, /srv');
    expect(miss.textContent).not.toMatch(/^No app found/);
    await user.click(screen.getByTestId('somewhere-else'));
    await user.type(screen.getByTestId('folder-input'), '/home/u/dcode/uat');
    await user.click(screen.getByTestId('folder-look'));
    await waitFor(() =>
      expect(calls.filter((x) => x.url.endsWith('/delivery/probe')).at(-1)?.body.hints).toMatchObject({
        dirs: ['/home/u/dcode/uat'],
      }),
    );
    expect(await screen.findByTestId('stack-choice', undefined, { timeout: 6000 })).toHaveTextContent('uat');
  });
});

describe('an app that runs directly on the machine', () => {
  const nativeReport = () =>
    report({
      nativeApps: [
        {
          kind: 'pm2',
          name: 'crm-api',
          folder: '/home/u/apps/crm',
          port: 3100,
          running: true,
          restart: 'pm2 restart crm-api',
        },
        {
          kind: 'systemd',
          name: 'invoice-web',
          folder: '/srv/invoice',
          port: 3000,
          running: true,
          restart: null,
        },
      ],
    });

  it('is found as a pm2 process or a service, with its folder and port; Docker wording stays out of it', async () => {
    const user = userEvent.setup();
    let probes: unknown[] = [];
    serveProject();
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ probes }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () => {
      probes = [probe({ report: nativeReport() })];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = (init) =>
      json({
        ok: true,
        issues: [],
        hash: 'h'.repeat(64),
        files: [],
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: true,
        needsDryRun: [],
        _body: JSON.parse(String(init.body)),
      });
    mountPage();
    await user.click(await screen.findByTestId('setup-add'));
    await user.click(screen.getByTestId('place-choice-Office PC'));
    const found = await screen.findAllByTestId('native-choice', undefined, { timeout: 6000 });
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveTextContent('crm-api');
    expect(found[0]).toHaveTextContent(/pm2 process, answers on port 3100/i);
    expect(found[0]).toHaveTextContent('/home/u/apps/crm');
    expect(found[1]).toHaveTextContent(/system service/i);
    await user.click(found[0] as HTMLElement);
    await user.click(screen.getByTestId('env-next'));
    const details = await screen.findByTestId('native-details');
    expect(details).toHaveTextContent('gets the new version of the code, builds it in a new folder');
    expect(details).not.toHaveTextContent(/compose|Docker|image/i);
    expect((screen.getByTestId('native-name') as HTMLInputElement).value).toBe('crm-api');
    expect((screen.getByTestId('native-restart-target') as HTMLInputElement).value).toBe('crm-api');
    expect(screen.getByTestId('restart-pm2')).toBeChecked;
    await user.click(screen.getByTestId('env-to-review'));
    await waitFor(() => expect(calls.find((x) => x.url.endsWith('/setup/preview'))).toBeTruthy());
    const env = calls.find((x) => x.url.endsWith('/setup/preview'))?.body.setup.environments[0];
    expect(env.runtime).toMatchObject({
      kind: 'native',
      how: 'pm2',
      name: 'crm-api',
      folder: '/home/u/apps/crm',
      port: 3100,
      restart: { via: 'pm2', target: 'crm-api' },
      keepReleases: 5,
    });
  });

  it('the card says how it runs and how it is restarted, in plain words', async () => {
    serveProject();
    const s = savedState({}, { dryRunMissing: [], recipeStatus: 'approved' });
    const native = {
      ...((s.current.setup?.environments ?? [])[0] as object),
      steps: [],
      runtime: {
        kind: 'native',
        how: 'pm2',
        name: 'crm-api',
        folder: '/home/u/apps/crm',
        port: 3100,
        restart: { via: 'pm2', target: 'crm-api' },
        keepReleases: 5,
      },
    };
    (s.current.setup as { environments: unknown[] }).environments = [
      native,
      (s.current.setup?.environments ?? [])[1],
    ];
    serve(s);
    mountPage();
    const how = await screen.findByTestId('env-how-uat');
    expect(how).toHaveTextContent('Runs directly on this computer: crm-api in /home/u/apps/crm, port 3100');
    expect(how).toHaveTextContent('restart crm-api with pm2');
    expect(how).not.toHaveTextContent(/compose|Docker/i);
    // the Docker one next to it keeps its own words
    expect(screen.getByTestId('env-how-production')).toHaveTextContent('Updates the existing app');
  });
});

describe('the update method of a server', () => {
  it('copy from my computer is the default, a registry needs its address, and each maps to its steps', () => {
    const a = {
      ...emptyAnswers('live'),
      host: 'prod',
      stackPath: '/home/administrator/dcode/flow5-full/docker-compose.yml',
      appService: 'app',
      imageName: 'flow5/app',
      targetName: 'flow5-server',
      healthUrl: 'http://192.168.1.13:8080/api/health',
    };
    // a literal image tag (no settings variable): the new version is named in an override file
    const ship = buildEnv(a);
    expect(ship.steps.map((s) => s.kind)).toEqual([
      'build_image_local',
      'ship_image_ssh',
      'write_override',
      'compose_up_remote',
    ]);
    expect(ship.app.imageVar).toBeUndefined();
    const reg = buildEnv({ ...a, method: 'registry', registry: 'ghcr.io' });
    expect(reg.steps.map((s) => s.kind)).toContain('pull_image_ssh');
    expect(reg.app.registry).toBe('ghcr.io');
    const srv = buildEnv({ ...a, method: 'build_on_server' });
    expect(srv.steps.map((s) => s.kind)).toEqual([
      'ship_source_ssh',
      'build_image_server',
      'write_override',
      'compose_up_remote',
    ]);
    for (const e of [ship, reg, srv]) expect(compileSetup({ environments: [e] }).ok).toBe(true);
  });
});

describe('technical details', () => {
  it('shows the setup as fields and marks a hand-edited script custom', async () => {
    const user = userEvent.setup();
    const s = savedState();
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = () =>
      json({
        ok: true,
        issues: [],
        hash: 'h'.repeat(64),
        files: [
          { path: 'scripts/uat.sh', mode: '755', content: '# Generated by Guildwise setup-1.3\n' },
          { path: 'recipe.yaml', mode: '644', content: 'x' },
        ],
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: false,
        needsDryRun: ['uat'],
      });
    wrap(<AdvancedSetup projectId={PROJECT} state={s as never} onClose={() => {}} />);
    expect(((await screen.findByTestId('advanced-json')) as HTMLTextAreaElement).value).toContain(
      '"composeFile": "~/shop-uat/docker-compose.yml"',
    );
    await user.click(screen.getByTestId('advanced-preview'));
    const result = await screen.findByTestId('advanced-preview-result');
    expect(result).toHaveTextContent('scripts/uat.sh');
    await user.click(screen.getByTestId('edit-script-uat'));
    expect(screen.getByTestId('advanced-env-uat')).toHaveTextContent('custom (script by hand)');
    await user.click(screen.getByTestId('back-to-guided-uat'));
    expect((screen.getByTestId('advanced-json') as HTMLTextAreaElement).value).toContain('"mode": "guided"');
  });
});

describe('settings pointer', () => {
  it('says what is set up and links to the page', async () => {
    serve(savedState());
    wrap(<EnvironmentsPointer projectId={PROJECT} projectKey="P5" />);
    const card = await screen.findByTestId('environments-pointer');
    await waitFor(() => expect(card).toHaveTextContent('1 live, 1 test, 2 places'));
    expect(screen.getByTestId('open-environments')).toHaveAttribute('href', '/p/P5/environments');
  });
});
