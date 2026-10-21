import { compileSetup, localAdoptEnv, type ProbeReport, sshShipEnv } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploySetup } from '../components/delivery/setup/DeploySetup.tsx';
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
} from '../components/delivery/setup/model.ts';
import { ToastProvider } from '../components/ui.tsx';

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
      name: 'uat',
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

describe('overview', () => {
  it('empty: says nothing is deployed and offers the wizard and a DevOps look', async () => {
    serve(state());
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('setup-empty')).toHaveTextContent(
      'Your app is not deployed anywhere yet',
    );
    expect(screen.getByTestId('setup-start')).toBeEnabled();
    expect(screen.getByTestId('setup-scan')).toBeEnabled();
  });

  it('a runner without guided setup is explained, the developer view stays', async () => {
    serve(
      state({
        workstations: [
          workstation({
            canProbe: false,
            blocked: 'Guildwise on Office PC needs an update for guided setup.',
          }),
        ],
      }),
    );
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('setup-runner-old')).toHaveTextContent(
      'needs an update for guided setup',
    );
    expect(screen.getByTestId('setup-advanced')).toBeInTheDocument();
  });

  it('a non-owner cannot start; the environments show where, who deploys, reachability and the approval', async () => {
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'Test copy',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
          appUrl: 'http://localhost:4700',
        }),
        sshShipEnv(
          {
            name: 'production',
            label: 'Live site',
            target: 'Live',
            host: 'prod',
            composeFile: '/opt/p/c.yml',
            service: 'app',
            imageName: 'p',
            imageVar: 'P_IMAGE',
            healthUrl: 'https://p.example.com/ready',
          },
          'uat',
        ),
      ],
    });
    if (!c.ok) throw new Error('compile');
    serve(
      state({
        canEdit: false,
        current: {
          setup: c.setup,
          handEdited: ['uat'],
          recipePresent: true,
          recipeStatus: 'observed',
          observedHash: 'a'.repeat(64),
          approvedHash: null,
          lint: [],
          dryRunOk: [],
          custom: false,
        },
        targets: [
          {
            id: T_LOCAL,
            name: 'Test copy',
            kind: 'local_docker',
            production: false,
            workstationId: WS,
            workstationName: 'Office PC',
            workstationOnline: true,
            host: null,
            appUrl: null,
            connection: null,
          },
          {
            id: T_PROD,
            name: 'Live',
            kind: 'remote_ssh',
            production: true,
            workstationId: WS,
            workstationName: 'Office PC',
            workstationOnline: false,
            host: 'prod',
            appUrl: null,
            connection: { state: 'asks_password', at, detail: null },
          },
        ],
      }),
    );
    wrap(<DeploySetup projectId={PROJECT} />);
    const prod = await screen.findByTestId('env-card-production');
    expect(prod).toHaveTextContent('Production');
    expect(prod).toHaveTextContent('On the server prod');
    expect(prod).toHaveTextContent('Deploys from Office PC');
    expect(prod).toHaveTextContent('Offline');
    expect(prod).toHaveTextContent('Needs a sign-in');
    expect(prod).toHaveTextContent('Only when you press Release');
    const uat = screen.getByTestId('env-card-uat');
    expect(uat).toHaveTextContent('Automatically after changes are merged');
    expect(screen.getByTestId('env-hand-edited-uat')).toHaveTextContent('edited by hand');
    expect(screen.queryByTestId('env-edit-uat')).toBeNull();
  });

  it('the nudge: an improved version of the steps is offered, updating saves the same setup again and says it needs approval', async () => {
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'T',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
        }),
      ],
    });
    if (!c.ok) throw new Error('compile');
    const user = userEvent.setup();
    serve(
      state({
        improvedAvailable: true,
        current: {
          setup: { ...c.setup, generator: 'setup-1.0' },
          handEdited: [],
          recipePresent: true,
          recipeStatus: 'approved',
          observedHash: 'a'.repeat(64),
          approvedHash: 'a'.repeat(64),
          lint: [],
          dryRunOk: ['uat'],
          custom: false,
        },
      }),
    );
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = () =>
      json({
        ok: true,
        issues: [],
        hash: 'b'.repeat(64),
        files: [],
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: true,
        needsDryRun: ['uat'],
      });
    routes[`POST /api/projects/${PROJECT}/delivery/setup/publish`] = () =>
      json({ commandId: ID(5), hash: 'b'.repeat(64) }, 202);
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('setup-improved')).toHaveTextContent(
      'An improved version of these steps is available',
    );
    await user.click(screen.getByTestId('setup-improved-update'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/setup/publish'))?.body).toMatchObject({
        setupHash: 'b'.repeat(64),
      }),
    );
    expect(calls.find((x) => x.url.endsWith('/setup/publish'))?.body.setup.generator).toBe('setup-1.0');
    expect(await screen.findByText(/needs the Owner’s approval/)).toBeInTheDocument();
  });

  it('approval: a script edited by hand, or a recipe nobody generated, is tried too (every environment)', async () => {
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'T',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
        }),
      ],
    });
    if (!c.ok) throw new Error('compile');
    serve(
      state({
        current: {
          setup: c.setup,
          handEdited: ['uat'],
          recipePresent: true,
          recipeStatus: 'observed',
          observedHash: 'a'.repeat(64),
          approvedHash: null,
          lint: [],
          dryRunOk: [],
          dryRunMissing: ['uat'],
          envNames: ['uat'],
          custom: false,
        },
      }),
    );
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('dryrun-uat')).toHaveTextContent('Not tried yet');
    expect(screen.getByTestId('setup-approve')).toBeDisabled();
  });

  it('approval: each guided environment is tried first; the button waits for that', async () => {
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'T',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
        }),
      ],
    });
    if (!c.ok) throw new Error('compile');
    const user = userEvent.setup();
    const cur = (dryRunOk: string[]) => ({
      setup: c.setup,
      handEdited: [],
      recipePresent: true,
      recipeStatus: 'observed',
      observedHash: 'a'.repeat(64),
      approvedHash: null,
      lint: [],
      dryRunOk,
      custom: false,
    });
    serve(state({ current: cur([]) }));
    routes[`POST /api/projects/${PROJECT}/delivery/setup/dry-run`] = () =>
      json({ message: 'queued', runs: [{ status: 'queued' }] });
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('setup-approve')).toBeDisabled();
    expect(screen.getByTestId('dryrun-uat')).toHaveTextContent('Not tried yet');
    await user.click(screen.getByTestId('dryrun-run-uat'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/setup/dry-run'))?.body).toEqual({ env: 'uat' }),
    );
    expect(await screen.findByTestId('dryrun-message')).toHaveTextContent('queued');
  });

  it('approval: tried, and only the Owner presses Approve', async () => {
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'T',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
        }),
      ],
    });
    if (!c.ok) throw new Error('compile');
    const user = userEvent.setup();
    serve(
      state({
        canApprove: true,
        current: {
          setup: c.setup,
          handEdited: [],
          recipePresent: true,
          recipeStatus: 'observed',
          observedHash: 'b'.repeat(64),
          approvedHash: null,
          lint: [],
          dryRunOk: ['uat'],
          custom: false,
        },
      }),
    );
    routes[`POST /api/projects/${PROJECT}/delivery/approve`] = () => json({});
    wrap(<DeploySetup projectId={PROJECT} />);
    const btn = await screen.findByTestId('setup-approve');
    expect(btn).toBeEnabled();
    await user.click(btn);
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/delivery/approve'))?.body).toEqual({ hash: 'b'.repeat(64) }),
    );
  });
});

describe('the wizard: on this computer', () => {
  it('walks from the kind to the review, shows what was found and not touched, and saves the previewed hash', async () => {
    const user = userEvent.setup();
    let probes: unknown[] = [];
    let publish: unknown = null;
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ probes, publish }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () => {
      probes = [probe({ report: uatReport() })];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    routes[`POST /api/projects/${PROJECT}/deploy-targets`] = () => json({ id: T_LOCAL });
    routes[`PUT /api/projects/${PROJECT}/delivery/setup`] = () => json(state());
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = (init) => {
      const body = JSON.parse(String(init.body));
      const c = compileSetup(body.setup);
      return json({
        ok: true,
        issues: [],
        hash: c.ok ? c.hash : null,
        files: [],
        keep: [],
        unmodelled: ['scripts/smoke.sh'],
        removing: body.removeFiles ?? [],
        lint: [],
        changes: [
          {
            group: 'each_deploy',
            env: 'uat',
            text: 'Back up the database (postgres) to /home/u/uat/backups',
          },
        ],
        differsFromCurrent: true,
        needsDryRun: ['uat'],
      });
    };
    routes[`POST /api/projects/${PROJECT}/delivery/setup/publish`] = () => {
      publish = { setupHash: 'x', commandId: ID(88), status: 'written', error: null, at };
      return json({ commandId: ID(88), hash: 'x' }, 202);
    };
    wrap(<DeploySetup projectId={PROJECT} />);
    await user.click(await screen.findByTestId('setup-start'));
    expect(screen.getByTestId('wizard-step')).toHaveTextContent('Step 1 of 6');
    await user.click(screen.getByTestId('wizard-next')); // test copy (default)
    await user.click(screen.getByTestId('where-computer'));
    await user.click(screen.getByTestId('wizard-next'));
    // the look at Docker starts by itself and the stack shows up
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/delivery/probe'))?.body).toMatchObject({
        scope: 'local',
        workstationId: WS,
      }),
    );
    const stack = await screen.findByTestId('stack-choice', undefined, { timeout: 5000 });
    expect(stack).toHaveTextContent('uat');
    expect(stack).toHaveTextContent('3 parts (postgres, app, mailpit)');
    expect(stack).toHaveTextContent('Running now');
    await user.click(stack);
    // what we found: reuse, each update, not touched
    const found = await screen.findByTestId('found-changes');
    expect(within(found).getByTestId('changes-reuse')).toHaveTextContent('Compose file');
    expect(within(found).getByTestId('changes-each_deploy')).toHaveTextContent(
      'Rebuild and restart only "app"',
    );
    const untouched = within(found).getByTestId('changes-untouched');
    expect(untouched).toHaveTextContent('Part "mailpit"');
    expect(untouched).toHaveTextContent('Container other-redis');
    expect(untouched).toHaveTextContent('Volume "other_data"');
    expect((screen.getByTestId('details-app') as HTMLSelectElement).value).toBe('app');
    expect((screen.getByTestId('details-db') as HTMLSelectElement).value).toBe('postgres');
    expect(screen.getByTestId('details-production')).not.toBeChecked();
    await user.click(screen.getByTestId('wizard-next'));
    // when: automatic after merge is the default
    expect(screen.getByTestId('when-auto')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('wizard-next'));
    // the target is made (a test copy, not production), the preview shows, and Save sends the hash that was previewed
    await waitFor(() =>
      expect(calls.find((x) => x.method === 'POST' && x.url.endsWith('/deploy-targets'))?.body).toMatchObject(
        { name: 'Test copy', kind: 'local_docker', workstationId: WS, production: false },
      ),
    );
    const save = await screen.findByTestId('review-save');
    await waitFor(() => expect(save).toBeEnabled());
    // a file the setup does not make is kept unless it is ticked
    const other = await screen.findByTestId('review-unmodelled');
    expect(other).toHaveTextContent('scripts/smoke.sh');
    expect(other).toHaveTextContent('kept');
    await user.click(within(other).getByRole('checkbox'));
    await waitFor(() =>
      expect(calls.filter((x) => x.url.endsWith('/setup/preview')).at(-1)?.body).toMatchObject({
        removeFiles: ['scripts/smoke.sh'],
      }),
    );
    await user.click(await screen.findByTestId('review-save'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/setup/publish'))?.body).toMatchObject({
        setupHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        removeFiles: ['scripts/smoke.sh'],
      }),
    );
    const published = calls.find((x) => x.url.endsWith('/setup/publish'))?.body;
    const previewed = calls.find((x) => x.url.endsWith('/setup/preview'))?.body;
    expect(compileSetup(published.setup)).toMatchObject({ ok: true, hash: published.setupHash });
    expect(published.setup).toEqual(previewed.setup);
    expect(published.setup.environments[0]).toMatchObject({
      name: 'uat',
      trigger: ['after_merge'],
      app: {
        service: 'app',
        composeProject: 'uat',
        composeFile: expect.stringMatching(/uat\/docker-compose.yml$/),
      },
    });
    expect(await screen.findByTestId('review-saved')).toHaveTextContent('Nothing runs before that');
  });

  it('Docker missing is an answer with Check again; nothing running offers a DevOps look', async () => {
    const user = userEvent.setup();
    let probes: unknown[] = [];
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ probes }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () => {
      probes = [
        probe({
          error: 'docker_missing',
          errorText: 'Docker is not installed on this computer. Install Docker, then check again.',
        }),
      ];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    wrap(<DeploySetup projectId={PROJECT} />);
    await user.click(await screen.findByTestId('setup-start'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('where-computer'));
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('probe-error', undefined, { timeout: 5000 })).toHaveTextContent(
      'Docker is not installed',
    );
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
  });

  it('"Not sure" starts a deploy scan', async () => {
    const user = userEvent.setup();
    serve(state());
    routes[`POST /api/projects/${PROJECT}/scan`] = () => json({ requestId: ID(5) }, 202);
    wrap(<DeploySetup projectId={PROJECT} />);
    await user.click(await screen.findByTestId('setup-start'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('where-scan'));
    await waitFor(() => expect(calls.find((x) => x.url.endsWith('/scan'))?.body).toEqual({ area: 'deploy' }));
  });
});

describe('the wizard: on my own server', () => {
  const hosts = (...h: Array<Record<string, unknown>>) => report({ scope: 'ssh_hosts', sshHosts: h });
  const serverReport = () =>
    report({
      scope: 'ssh_target',
      host: 'prod-server',
      containers: [
        {
          name: 'g-app-1',
          project: 'g',
          service: 'app',
          image: 'guildwise-hq:4f2c1ab',
          state: 'running',
          ports: [],
        },
        { name: 'caddy', image: 'caddy:2', state: 'running', ports: [] },
      ],
      composeFiles: [
        {
          path: '/opt/app/docker-compose.yml',
          project: 'g',
          services: [
            {
              name: 'app',
              image: '${GUILDWISE_IMAGE}',
              ports: [],
              volumes: [],
              envFiles: [],
              vars: ['GUILDWISE_IMAGE'],
            },
            {
              name: 'postgres',
              image: 'postgres:18',
              database: 'postgres',
              ports: [],
              volumes: [],
              envFiles: [],
              vars: [],
            },
          ],
          volumes: ['pgdata'],
        },
      ],
      folders: [
        {
          path: '/opt/app',
          exists: true,
          entries: ['docker-compose.yml', '.env'],
          envKeys: ['GUILDWISE_IMAGE'],
          imageVars: [{ name: 'GUILDWISE_IMAGE', value: 'guildwise-hq:4f2c1ab' }],
        },
      ],
      proxies: [{ kind: 'caddy', via: 'container', name: 'caddy', sites: ['hq.example.com'] }],
      urls: [{ url: 'https://hq.example.com/ready', status: 200 }],
    });

  async function toSignIn(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen
        .findByTestId('setup-start', undefined, { timeout: 1500 })
        .catch(() => screen.findByTestId('setup-add')),
    );
    await user.click(screen.getByTestId('kind-live'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(screen.getByTestId('where-server'));
    await user.click(screen.getByTestId('wizard-next'));
  }

  it('lists the servers this computer can reach, with the sign-in it already has; only a working one can be used', async () => {
    const user = userEvent.setup();
    serve(
      state({
        probes: [
          probe({
            scope: 'ssh_hosts',
            report: hosts(
              {
                alias: 'prod-server',
                hostname: '192.0.2.10',
                user: 'root',
                hasIdentity: true,
                state: 'reachable',
              },
              {
                alias: 'other',
                state: 'asks_password',
                detail: 'it did not accept the sign-in without a password',
              },
              { alias: 'moved', state: 'host_key_changed' },
            ),
          }),
        ],
      }),
    );
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () =>
      json({ commandId: ID(77), workstationId: WS }, 202);
    wrap(<DeploySetup projectId={PROJECT} />);
    await toSignIn(user);
    const list = await screen.findByTestId('ssh-hosts', undefined, { timeout: 5000 });
    expect(list).toHaveTextContent('Use the sign-in this computer already has');
    expect(within(list).getByTestId('host-prod-server')).toHaveTextContent('Can sign in');
    expect(within(list).getByTestId('host-prod-server')).toBeEnabled();
    expect(within(list).getByTestId('host-other')).toBeDisabled();
    expect(within(list).getByTestId('host-other')).toHaveTextContent('Asks for a password');
    expect(within(list).getByTestId('host-moved')).toBeDisabled();
    expect(within(list).getByTestId('host-moved')).toHaveTextContent('identity changed');
  });

  it('offers a dedicated key for a working sign-in (optional, with the exact change) and a new sign-in for one that asks for a password', async () => {
    const user = userEvent.setup();
    let probes: unknown[] = [
      probe({
        scope: 'ssh_hosts',
        report: hosts(
          { alias: 'prod-server', hostname: '192.0.2.10', user: 'root', state: 'reachable' },
          {
            alias: 'other',
            hostname: 'other.example.com',
            user: 'deploy',
            port: 2222,
            state: 'asks_password',
          },
        ),
      }),
    ];
    serve(state({ probes }));
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () => json(state({ probes }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = (init) => {
      if (JSON.parse(String(init.body)).scope === 'ssh_target')
        probes = [
          ...probes.filter((x: any) => x.scope !== 'ssh_target'),
          probe({
            id: ID(900 + probes.length),
            scope: 'ssh_target',
            host: 'prod-server',
            report: serverReport(),
          }),
        ];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    routes[`POST /api/projects/${PROJECT}/delivery/connect`] = () =>
      json({ commandId: 'c9', workstationId: WS, targetId: T_PROD, alias: 'prod-server' }, 202);
    routes[`GET /api/projects/${PROJECT}/delivery/ops/c9`] = () =>
      json({
        id: 'c9',
        kind: 'connect',
        state: 'done',
        ok: true,
        result: { ok: true, installed: 'added' },
        errorText: null,
        at,
      });
    wrap(<DeploySetup projectId={PROJECT} />);
    await toSignIn(user);
    await screen.findByTestId('ssh-hosts', undefined, { timeout: 5000 });
    // a host that asks for a password can be set up again, with what is known filled in
    await user.click(screen.getByTestId('host-connect-other'));
    expect((await screen.findByTestId('connect-address')) as HTMLInputElement).toHaveValue(
      'other.example.com',
    );
    expect(screen.getByTestId('connect-user')).toHaveValue('deploy');
    await user.click(screen.getByTestId('connect-back'));
    // pick the working one: the dedicated key is offered, never forced
    await user.click(await screen.findByTestId('host-prod-server'));
    expect(calls.some((c) => c.url.endsWith('/delivery/connect'))).toBe(false);
    await user.click(await screen.findByTestId('dedicated-key-open'));
    expect(screen.getByTestId('dedicated-key-confirm')).toHaveTextContent(
      'Your keys and your ssh settings stay exactly as they are',
    );
    await user.click(screen.getByTestId('dedicated-key-add'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/delivery/connect'))?.body).toMatchObject({
        method: 'alias',
        alias: 'prod-server',
        workstationId: WS,
      }),
    );
    expect(calls.find((c) => c.url.endsWith('/delivery/connect'))?.body.ciphertext).toBeUndefined();
    expect(await screen.findByTestId('dedicated-key-done')).toBeInTheDocument();
  });

  it('"Connect a different server" opens the guided connect and the server it makes is looked at', async () => {
    const user = userEvent.setup();
    serve(state({ probes: [probe({ scope: 'ssh_hosts', report: hosts() })] }));
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = () =>
      json({ commandId: ID(77), workstationId: WS }, 202);
    wrap(<DeploySetup projectId={PROJECT} />);
    await toSignIn(user);
    await user.click(await screen.findByTestId('connect-different', undefined, { timeout: 5000 }));
    expect(await screen.findByTestId('connect-server')).toHaveAttribute('data-step', 'where');
    expect(screen.getByTestId('connect-where')).toHaveTextContent('Guildwise signs in to your server');
  });

  it('a chosen server is looked at; the live site is pre-ticked as production, the Owner releases it, and the image setting is found', async () => {
    const user = userEvent.setup();
    let probes: unknown[] = [
      probe({ scope: 'ssh_hosts', report: hosts({ alias: 'prod-server', state: 'reachable' }) }),
    ];
    routes[`GET /api/projects/${PROJECT}/delivery/setup`] = () =>
      json(
        state({
          probes,
          current: {
            setup: (
              compileSetup({
                environments: [
                  localAdoptEnv({
                    name: 'uat',
                    label: 'Test copy',
                    target: 'T',
                    composeFile: '~/uat/c.yml',
                    service: 'app',
                    imageName: 'a',
                  }),
                ],
              }) as { ok: true; setup: unknown }
            ).setup,
            handEdited: [],
            recipePresent: true,
            recipeStatus: 'approved',
            observedHash: 'a'.repeat(64),
            approvedHash: 'a'.repeat(64),
            lint: [],
            dryRunOk: ['uat'],
            custom: false,
          },
        }),
      );
    routes[`POST /api/projects/${PROJECT}/delivery/probe`] = (init) => {
      const b = JSON.parse(String(init.body));
      if (b.scope === 'ssh_target')
        probes = [
          ...probes.filter((p: any) => p.scope !== 'ssh_target'),
          probe({ scope: 'ssh_target', host: 'prod-server', report: serverReport() }),
        ];
      return json({ commandId: ID(77), workstationId: WS }, 202);
    };
    wrap(<DeploySetup projectId={PROJECT} />);
    await toSignIn(user);
    await user.click(await screen.findByTestId('host-prod-server', undefined, { timeout: 5000 }));
    await waitFor(() =>
      expect(
        calls.some(
          (x) =>
            x.url.endsWith('/delivery/probe') &&
            x.body?.scope === 'ssh_target' &&
            x.body?.host === 'prod-server',
        ),
      ).toBe(true),
    );
    const stack = await screen.findByTestId('stack-choice', undefined, { timeout: 5000 });
    expect(stack).toHaveTextContent('/opt/app/docker-compose.yml');
    await user.click(stack);
    expect(screen.getByTestId('details-production')).toBeChecked();
    expect((screen.getByTestId('details-imagevar') as HTMLSelectElement).value).toBe('GUILDWISE_IMAGE');
    expect((screen.getByTestId('details-health') as HTMLInputElement).value).toBe(
      'https://hq.example.com/ready',
    );
    const found = screen.getByTestId('found-changes');
    expect(within(found).getByTestId('changes-untouched')).toHaveTextContent(
      'Caddy proxy (caddy) for hq.example.com is not touched',
    );
    expect(within(found).getByTestId('changes-reuse')).toHaveTextContent(
      'GUILDWISE_IMAGE now points at guildwise-hq:4f2c1ab',
    );
    await user.click(screen.getByTestId('wizard-next'));
    // the live site: Release only, the test copy first, the Owner approves each release
    expect(screen.getByText('Only when you press Release')).toBeInTheDocument();
    expect(screen.getByTestId('when-test-first')).toBeChecked();
  });
});

describe('technical details', () => {
  it('shows the setup as fields, previews the generated files, and marks a hand-edited script custom', async () => {
    const user = userEvent.setup();
    const c = compileSetup({
      environments: [
        localAdoptEnv({
          name: 'uat',
          label: 'Test copy',
          target: 'T',
          composeFile: '~/uat/c.yml',
          service: 'app',
          imageName: 'a',
          appUrl: 'http://localhost:4700',
        }),
      ],
    });
    if (!c.ok) throw new Error('compile');
    serve(
      state({
        current: {
          setup: c.setup,
          handEdited: [],
          recipePresent: true,
          recipeStatus: 'observed',
          observedHash: 'a'.repeat(64),
          approvedHash: null,
          lint: [],
          dryRunOk: [],
          custom: false,
        },
      }),
    );
    routes[`POST /api/projects/${PROJECT}/delivery/setup/preview`] = () =>
      json({
        ok: true,
        issues: [],
        hash: c.hash,
        files: c.files,
        keep: [],
        lint: [],
        changes: [],
        differsFromCurrent: false,
        needsDryRun: ['uat'],
      });
    wrap(<DeploySetup projectId={PROJECT} />);
    await user.click(await screen.findByTestId('setup-advanced'));
    expect(((await screen.findByTestId('advanced-json')) as HTMLTextAreaElement).value).toContain(
      '"composeFile": "~/uat/c.yml"',
    );
    await user.click(screen.getByTestId('advanced-preview'));
    const result = await screen.findByTestId('advanced-preview-result');
    expect(result).toHaveTextContent('scripts/uat.sh');
    expect(result).toHaveTextContent('recipe.yaml');
    await user.click(screen.getByTestId('edit-script-uat'));
    const script = await screen.findByTestId('script-uat');
    expect((script as HTMLTextAreaElement).value).toContain('Generated by Guildwise setup-1.3');
    expect(screen.getByTestId('advanced-env-uat')).toHaveTextContent('custom (script by hand)');
    expect((screen.getByTestId('advanced-json') as HTMLTextAreaElement).value).toContain('"mode": "custom"');
    await user.click(screen.getByTestId('back-to-guided-uat'));
    expect((screen.getByTestId('advanced-json') as HTMLTextAreaElement).value).toContain('"mode": "guided"');
  });

  it('invalid values are explained next to the fields', async () => {
    const user = userEvent.setup();
    serve(state());
    wrap(<DeploySetup projectId={PROJECT} />);
    await user.click(await screen.findByTestId('setup-advanced'));
    const box = await screen.findByTestId('advanced-json');
    await user.clear(box);
    await user.click(box);
    await user.paste('{"environments": []}');
    expect(await screen.findByTestId('advanced-errors')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-preview')).toBeDisabled();
  });
});

describe('deploy scan', () => {
  const proposal = () => {
    const env = localAdoptEnv({
      name: 'uat',
      label: 'Test copy',
      target: 'T',
      composeFile: '~/uat/c.yml',
      service: 'app',
      imageName: 'a',
    });
    return {
      id: ID(40),
      area: 'deploy',
      status: 'open',
      requestId: ID(41),
      workstationId: WS,
      workstationName: 'Office PC',
      submittedAt: at,
      proposal: {
        area: 'deploy',
        deploy: { version: 1, generator: 'setup-1.3', environments: [env] },
        items: [
          {
            path: '/environments/0/app/service',
            confidence: 'guessed',
            evidence: [],
            note: 'the only part built from the code',
          },
        ],
        questions: [
          {
            path: '/environments/0/app/service',
            question: 'Which part is your app?',
            options: ['app', 'web'],
            default: 'app',
          },
        ],
        secretsNeeded: [],
        notes: 'Found a compose project called uat.',
        filesRead: ['docker-compose.yml'],
      },
    };
  };

  it('the suggestion is announced, reviewed with its questions, and used as the draft', async () => {
    const user = userEvent.setup();
    serve(state({ proposal: proposal() }));
    routes[`POST /api/projects/${PROJECT}/delivery/setup/use-proposal`] = () => json(state());
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('deploy-proposal-waiting')).toHaveTextContent(
      '1 environment, 1 questions for you',
    );
    await user.click(screen.getByTestId('deploy-proposal-open'));
    expect(await screen.findByTestId('proposal-review')).toHaveTextContent('DevOps has a suggestion');
    expect(screen.getByTestId('deploy-proposal-envs')).toHaveTextContent('Guessed: please check');
    expect(screen.getByTestId('proposal-use')).toBeDisabled();
    await user.click(
      within(screen.getByTestId('proposal-questions')).getByRole('button', { name: 'Answer' }),
    );
    expect(screen.getByTestId('proposal-use')).toBeEnabled();
    await user.click(screen.getByTestId('proposal-use'));
    await waitFor(() =>
      expect(calls.find((x) => x.url.endsWith('/use-proposal'))?.body).toEqual({ proposalId: ID(40) }),
    );
  });

  it('progress and problems are shown while there is no suggestion', async () => {
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
    wrap(<DeploySetup projectId={PROJECT} />);
    expect(await screen.findByTestId('deploy-scan-progress')).toHaveTextContent('On Office PC');
  });
});
