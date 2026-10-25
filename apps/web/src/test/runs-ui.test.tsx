import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunBranchDialog } from '../components/runs/RunBranchDialog.tsx';
import { RunLogs } from '../components/runs/RunLogs.tsx';
import { RunPanel, untilText } from '../components/runs/RunPanel.tsx';
import { RunSettings } from '../components/runs/RunSettings.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { keysForEvent } from '../ws/invalidate.ts';
import { LiveSocket } from '../ws/socket.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PROJECT = ID(1);
const WEB = ID(10);
const API = ID(11);
const WS = ID(20);

const repo = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: PROJECT,
  name,
  remoteUrl: `https://example.test/${name}.git`,
  remoteUrlNormalized: `example.test/${name}`,
  workingBranch: 'main',
  removedAt: null,
  knownBranches: ['main', 'feature/login'],
  ...extra,
});

const env = (over: Record<string, unknown> = {}) => ({
  id: ID(50),
  projectId: PROJECT,
  projectKey: 'TOY',
  projectName: 'Toy',
  workstationId: WS,
  workstationName: 'Desk',
  purpose: 'manual',
  cardId: null,
  cardRef: null,
  sources: [{ repoId: WEB, repoName: 'web', branch: 'feature/login', commit: 'abcdef0123456789' }],
  services: [],
  state: 'healthy',
  servicesStatus: [
    {
      name: 'web',
      state: 'healthy',
      ports: [{ name: 'http', port: 5174, wanted: 5173, url: 'http://localhost:5174/' }],
      urls: ['http://localhost:5174/'],
      health: 'passing',
      restarts: 0,
    },
  ],
  activity: null,
  planVersion: 1,
  requestedBy: { id: ID(2), name: 'Pieter' },
  devopsRequestId: ID(60),
  createdAt: new Date().toISOString(),
  healthyAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7.5 * 3_600_000).toISOString(),
  stoppedAt: null,
  stopReason: null,
  lastError: null,
  canStop: true,
  canExtend: true,
  ...over,
});

const workstation = (over: Record<string, unknown> = {}) => ({
  id: WS,
  userId: ID(2),
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk',
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: null,
  runtimes: [],
  repos: [
    { projectRepoId: WEB, localPath: '/w/web', reportedAt: new Date().toISOString() },
    { projectRepoId: API, localPath: '/w/api', reportedAt: new Date().toISOString() },
  ],
  pairedAt: new Date().toISOString(),
  runs: { capable: true, maxEnvironments: 2 },
  ...over,
});

const settings = (over: Record<string, unknown> = {}) => ({
  runInstructions: 'Start the API first.',
  repos: [
    { repoId: WEB, name: 'web', runInstructions: '' },
    { repoId: API, name: 'api', runInstructions: 'dotnet 8' },
  ],
  settings: {
    ttlHours: 8,
    allowDocker: false,
    services: [
      { name: 'db', repoId: API, cwd: '.', ports: [], after: [] },
      {
        name: 'api',
        repoId: API,
        cwd: 'src/Api',
        cmd: ['dotnet', 'run'],
        ports: [{ name: 'http', default: 5000, envVar: 'ASPNETCORE_HTTP_PORTS' }],
        after: ['db'],
      },
      { name: 'web', repoId: WEB, cwd: '.', ports: [], after: ['api'] },
    ],
  },
  plans: [],
  ...over,
});

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
      const key = `${init.method ?? 'GET'} ${String(url).split('?')[0]}`;
      return routes[key]?.(init) ?? json({});
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

describe('environment panel', () => {
  it('shows the state, the services with their links and ports, the commits and the expiry', () => {
    wrap(<RunPanel env={env() as never} />);
    expect(screen.getByTestId('run-state')).toHaveTextContent('Running');
    const link = screen.getByRole('link', { name: /http:\/\/localhost:5174\// });
    expect(link).toHaveAttribute('href', 'http://localhost:5174/');
    expect(screen.getByTestId('run-services')).toHaveTextContent('http 5174 (was 5173)');
    expect(screen.getByTestId('run-commits')).toHaveTextContent('web: feature/login at abcdef01');
    expect(screen.getByTestId('run-expiry')).toHaveTextContent(/in 7 h 2\d min|in 7 h 30 min/);
  });

  it('while it starts it says who is working on it, with no links', () => {
    wrap(
      <RunPanel
        env={
          env({
            state: 'starting',
            servicesStatus: [
              { name: 'web', state: 'starting', ports: [], urls: [], health: 'unknown', restarts: 0 },
            ],
            activity: 'running npm ci',
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-working')).toHaveTextContent('DevOps engineer of Desk');
    expect(screen.getByTestId('run-activity')).toHaveTextContent('running npm ci');
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['How it starts']);
    expect(screen.getByTestId('run-kind')).toHaveTextContent('Test copy');
    expect(screen.getByTestId('run-how-it-starts')).toHaveAttribute(
      'href',
      '/p/TOY/environments#start-steps',
    );
  });

  it('Extend and Stop call the server; Stop asks first', async () => {
    const user = userEvent.setup();
    routes['POST /api/runs/' + ID(50) + '/extend'] = () => json({ environment: env() });
    routes['POST /api/runs/' + ID(50) + '/stop'] = () =>
      json({ environment: env({ state: 'stopping' }) }, 202);
    wrap(<RunPanel env={env() as never} />);
    await user.click(screen.getByTestId('run-extend'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/extend'))).toMatchObject({ method: 'POST', body: {} }),
    );
    await user.click(screen.getByTestId('run-stop'));
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(true));
  });

  it('Restart and Update & restart call the server; a viewer who may not restart does not see them', async () => {
    const user = userEvent.setup();
    routes[`POST /api/runs/${ID(50)}/restart`] = () => json({ environment: env({ state: 'starting' }) }, 202);
    wrap(<RunPanel env={env({ canRestart: true, replayed: true }) as never} />);
    await user.click(screen.getByTestId('run-restart'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/restart'))).toMatchObject({ method: 'POST', body: {} }),
    );
    calls.length = 0;
    await user.click(screen.getByTestId('run-update-restart'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/restart'))).toMatchObject({ body: { update: true } }),
    );
  });

  it('a stopped environment that can still be restarted offers Restart, but not Stop or Extend', () => {
    wrap(
      <RunPanel
        env={
          env({
            state: 'stopped',
            canRestart: true,
            canStop: false,
            canExtend: false,
            stoppedAt: new Date().toISOString(),
            stopReason: 'stopped',
            servicesStatus: [],
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-restart')).toBeInTheDocument();
    expect(screen.getByTestId('run-update-restart')).toBeInTheDocument();
    expect(screen.queryByTestId('run-stop')).toBeNull();
    expect(screen.queryByTestId('run-extend')).toBeNull();
  });

  it('a failed environment stays visible with the reason, a link to the DevOps request, Try again and Dismiss', async () => {
    const user = userEvent.setup();
    routes[`POST /api/runs/${ID(50)}/retry`] = () =>
      json({ environment: env({ id: ID(51), state: 'requested' }) }, 201);
    routes[`POST /api/runs/${ID(50)}/dismiss`] = () => json({ environment: env({ state: 'failed' }) });
    wrap(
      <RunPanel
        env={
          env({
            state: 'failed',
            servicesStatus: [],
            canStop: false,
            canExtend: false,
            canRetry: true,
            canDismiss: true,
            stoppedAt: new Date().toISOString(),
            stopReason: 'failed',
            lastError: 'DevOps gave up',
            failureReason:
              'The environment failed: Demo-Server needs a Couchbase server and none is running.',
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-state')).toHaveTextContent('Failed');
    expect(screen.getByTestId('run-failure')).toHaveTextContent('Demo-Server needs a Couchbase server');
    expect(screen.getByTestId('run-error')).not.toHaveTextContent('DevOps gave up');
    expect(screen.getByTestId('run-devops-link')).toHaveAttribute(
      'href',
      `/workstations?devopsRequest=${ID(60)}`,
    );
    expect(screen.queryByTestId('run-stop')).toBeNull();
    await user.click(screen.getByTestId('run-retry'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/runs/${ID(50)}/retry`))).toBe(true));
    await user.click(screen.getByTestId('run-dismiss'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/runs/${ID(50)}/dismiss`))).toBe(true));
  });

  it('a failed environment without a DevOps report shows the last error; without the rights there are no buttons', () => {
    wrap(
      <RunPanel
        env={
          env({
            state: 'failed',
            servicesStatus: [],
            canStop: false,
            canExtend: false,
            lastError: 'the runner could not prepare the environment',
            failureReason: null,
            devopsRequestId: null,
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-error')).toHaveTextContent('the runner could not prepare the environment');
    expect(screen.queryByTestId('run-retry')).toBeNull();
    expect(screen.queryByTestId('run-dismiss')).toBeNull();
    expect(screen.queryByTestId('run-devops-link')).toBeNull();
  });

  it('an environment whose DevOps engineer asked the owner shows "Waiting for you" with the question and options', () => {
    wrap(
      <RunPanel
        env={
          env({
            state: 'starting',
            servicesStatus: [],
            waiting: {
              action: 'Question: Demo-Server needs Couchbase',
              reason: 'A) use 192.168.1.12 B) allow Docker',
            },
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-state')).toHaveTextContent('Waiting for you');
    expect(screen.getByTestId('run-waiting')).toHaveTextContent('Question: Demo-Server needs Couchbase');
    expect(screen.getByTestId('run-waiting')).toHaveTextContent('A) use 192.168.1.12 B) allow Docker');
    expect(screen.getByTestId('run-devops-link')).toBeInTheDocument();
    expect(screen.queryByTestId('run-working')).toBeNull();
  });

  it('a start from the saved plan says so, and services outside the sandbox are flagged', () => {
    wrap(
      <RunPanel
        env={
          env({
            state: 'starting',
            replayed: true,
            devopsRequestId: null,
            planVersion: 4,
            servicesStatus: [
              {
                name: 'db',
                state: 'healthy',
                ports: [],
                urls: [],
                health: 'passing',
                restarts: 0,
                sandbox: 'docker',
              },
              {
                name: 'web',
                state: 'starting',
                ports: [],
                urls: [],
                health: 'unknown',
                restarts: 0,
                sandbox: 'sandboxed',
              },
              {
                name: 'job',
                state: 'healthy',
                ports: [],
                urls: [],
                health: 'none',
                restarts: 0,
                sandbox: 'off',
              },
            ],
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-working')).toHaveTextContent('saved run plan (version 4)');
    expect(screen.getByTestId('run-working')).not.toHaveTextContent('working out how to run');
    const flags = screen.getAllByTestId('run-unsandboxed');
    expect(flags.map((f) => f.textContent)).toEqual(['Docker: outside the sandbox', 'No sandbox']);
  });

  it('hides the buttons the viewer may not use and for a finished environment', () => {
    const { unmount } = wrap(<RunPanel env={env({ canStop: false, canExtend: false }) as never} />);
    expect(screen.queryByTestId('run-stop')).toBeNull();
    expect(screen.queryByTestId('run-extend')).toBeNull();
    unmount();
    wrap(
      <RunPanel
        env={
          env({
            state: 'failed',
            lastError: 'port 5000 is taken',
            stoppedAt: new Date().toISOString(),
            stopReason: 'failed',
          }) as never
        }
      />,
    );
    expect(screen.getByTestId('run-state')).toHaveTextContent('Failed');
    expect(screen.getByTestId('run-error')).toHaveTextContent('port 5000 is taken');
    expect(screen.queryByTestId('run-stop')).toBeNull();
    expect(screen.queryByTestId('run-expiry')).toBeNull();
  });

  it('never makes a non-web URL a link', () => {
    const e = env();
    e.servicesStatus[0]!.urls = ['javascript:alert(1)', 'http://localhost:5174/'];
    wrap(<RunPanel env={e as never} />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('run events refresh the environments and the settings', () => {
    expect(
      keysForEvent({ type: 'RunEnvironmentEnded', streamId: `run-${ID(50)}`, projectId: PROJECT }),
    ).toEqual([['runs'], ['run-plan']]);
    expect(
      keysForEvent({ type: 'RunPlanSaved', streamId: `project-${PROJECT}`, projectId: PROJECT }),
    ).toContainEqual(['run-settings']);
  });

  it('formats the time to expiry', () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    expect(untilText('2026-10-14T17:40:00Z', now)).toBe('in 7 h 40 min');
    expect(untilText('2026-10-14T10:25:00Z', now)).toBe('in 25 min');
    expect(untilText('2026-10-14T09:57:00Z', now)).toBe('3 min ago');
  });
});

describe('logs', () => {
  it('shows what the socket delivers, per service, the history first', async () => {
    const qc = new QueryClient();
    const sock = new LiveSocket(qc, () => 'ws://x');
    sock.enableMockTransport();
    const sent: unknown[] = [];
    (sock as unknown as { send: (m: unknown) => void }).send = (m) => sent.push(m);
    const mod = await import('../ws/socket.ts');
    vi.spyOn(mod, 'getSocket').mockReturnValue(sock);
    render(
      <QueryClientProvider client={qc}>
        <RunLogs envId={ID(50)} services={['api', 'web']} />
      </QueryClientProvider>,
    );
    expect(sent).toContainEqual({ type: 'run.watch', envId: ID(50) });
    act(() =>
      sock.handle({
        type: 'run.log',
        envId: ID(50),
        service: 'api',
        lines: ['booting', 'listening'],
        history: true,
      }),
    );
    expect(screen.getByTestId('run-log-lines')).toHaveValue('booting\nlistening');
    act(() => sock.handle({ type: 'run.log', envId: ID(50), service: 'api', lines: ['GET /health 200'] }));
    expect(screen.getByTestId('run-log-lines')).toHaveValue('booting\nlistening\nGET /health 200');
    await userEvent.setup().selectOptions(screen.getByTestId('run-logs-service'), 'web');
    expect(screen.getByTestId('run-log-lines')).toHaveValue('No output yet.');
    act(() => sock.handle({ type: 'run.log', envId: ID(50), service: 'web', lines: ['vite ready'] }));
    expect(screen.getByTestId('run-log-lines')).toHaveValue('vite ready');
  });

  it('a run.changed message refreshes the environments', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const sock = new LiveSocket(qc, () => 'ws://x');
    sock.handle({ type: 'run.changed', envId: ID(50) });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['runs'] });
  });
});

describe('run branch dialog', () => {
  const setupRoutes = () => {
    routes['GET /api/projects/' + PROJECT] = () =>
      json({
        project: { id: PROJECT, key: 'TOY', name: 'Toy', myRole: 'owner' },
        repos: [repo(WEB, 'web'), repo(API, 'api', { knownBranches: ['main', 'develop'] })],
        members: [],
        environments: [],
      });
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () => json(settings());
    routes['GET /api/workstations'] = () =>
      json({
        workstations: [
          workstation({ id: ID(21), name: 'Old', runs: { capable: false, maxEnvironments: 2 } }),
          workstation({ id: ID(22), name: 'Offline', connected: false }),
          workstation(),
        ],
      });
    routes['POST /api/runs'] = () => json({ environment: env() }, 201);
  };

  it('project mode: picks branches per repository, ticks services with their dependencies, and starts on a ready workstation only', async () => {
    setupRoutes();
    const user = userEvent.setup();
    const started = vi.fn();
    wrap(<RunBranchDialog projectId={PROJECT} onStarted={started} />);
    await user.click(screen.getByTestId('run-branch-open'));
    // only the capable, online workstation is offered
    const ws = await screen.findByTestId('run-workstation');
    await waitFor(() =>
      expect(
        within(ws)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Desk']),
    );
    await user.selectOptions(screen.getByTestId('run-branch-web'), 'feature/login');
    await user.selectOptions(screen.getByTestId('run-branch-api'), 'develop');

    // untick api: web still needs it, so it stays on and greyed out; untick web too and only db is left
    await user.click(await screen.findByTestId('run-service-api'));
    expect(screen.getByTestId('run-service-api')).toBeChecked();
    expect(screen.getByTestId('run-service-api')).toBeDisabled();
    await user.click(screen.getByTestId('run-service-web'));
    expect(screen.getByTestId('run-service-api')).not.toBeChecked();
    expect(screen.getByTestId('run-service-db')).toBeChecked();
    // web on again brings api back, greyed out
    await user.click(screen.getByTestId('run-service-web'));
    expect(screen.getByTestId('run-service-api')).toBeChecked();
    expect(screen.getByTestId('run-service-api')).toBeDisabled();
    await user.click(screen.getByTestId('run-service-web'));
    expect(screen.getByTestId('run-service-api')).not.toBeChecked();

    await user.click(screen.getByTestId('run-branch-start'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/runs')).toBeTruthy());
    const body = calls.find((c) => c.method === 'POST' && c.url === '/api/runs')!.body;
    expect(body).toEqual({
      projectId: PROJECT,
      workstationId: WS,
      sources: [
        { repoId: WEB, branch: 'feature/login' },
        { repoId: API, branch: 'develop' },
      ],
      services: ['db'],
    });
    await waitFor(() => expect(started).toHaveBeenCalledWith(ID(50)));
  });

  it('card mode: starts the card (the server picks its branch) and shows no branch pickers', async () => {
    setupRoutes();
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () =>
      json(settings({ settings: { ttlHours: 8, allowDocker: false, services: [] } }));
    const user = userEvent.setup();
    wrap(
      <RunBranchDialog
        projectId={PROJECT}
        card={{ id: ID(70), ref: 'TOY-7', repoId: WEB, homeWorkstationId: WS }}
      />,
    );
    await user.click(screen.getByTestId('run-branch-open'));
    expect(await screen.findByText(/Runs the branch of TOY-7/)).toBeInTheDocument();
    expect(screen.queryByTestId('run-branch-web')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('run-branch-start')).toBeEnabled());
    await user.click(screen.getByTestId('run-branch-start'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/runs')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/runs')!.body).toEqual({
      projectId: PROJECT,
      workstationId: WS,
      cardId: ID(70),
    });
  });

  it('says so when no workstation can run it, and shows the server refusal', async () => {
    setupRoutes();
    routes['GET /api/workstations'] = () =>
      json({ workstations: [workstation({ runs: { capable: false, maxEnvironments: 2 } })] });
    const user = userEvent.setup();
    const { unmount } = wrap(<RunBranchDialog projectId={PROJECT} />);
    await user.click(screen.getByTestId('run-branch-open'));
    expect(await screen.findByText(/No workstation is ready/)).toBeInTheDocument();
    expect(screen.getByTestId('run-branch-start')).toBeDisabled();
    unmount();

    setupRoutes();
    routes['POST /api/runs'] = () =>
      json(
        {
          error: {
            code: 'run_cap',
            message: 'Desk already runs 2 environments (the limit is 2): stop one first',
          },
        },
        409,
      );
    wrap(<RunBranchDialog projectId={PROJECT} />);
    await user.click(screen.getByTestId('run-branch-open'));
    await waitFor(() => expect(screen.getByTestId('run-branch-start')).toBeEnabled());
    await user.click(screen.getByTestId('run-branch-start'));
    expect(await screen.findByText(/already runs 2 environments/)).toBeInTheDocument();
  });
});

describe('run and test settings', () => {
  it('shows instructions, services and the saved plan read-only; saving sends the structured settings', async () => {
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () =>
      json(
        settings({
          plans: [
            {
              id: ID(80),
              workstationId: WS,
              workstationName: 'Desk',
              version: 3,
              status: 'active',
              savedAt: new Date().toISOString(),
              plan: {
                version: 1,
                repos: [],
                setup: [
                  {
                    name: 'npm ci',
                    repoId: WEB,
                    cwd: '.',
                    cmd: ['npm', 'ci'],
                    timeoutSec: 1200,
                    when: 'always',
                  },
                ],
                services: [
                  {
                    name: 'web',
                    repoId: WEB,
                    cwd: '.',
                    cmd: ['npm', 'run', 'dev'],
                    env: {},
                    ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
                    health: { kind: 'none', graceSec: 3 },
                    startTimeoutSec: 300,
                    after: [],
                    docker: false,
                  },
                ],
                notes: 'plain vite',
              },
            },
          ],
        }),
      );
    routes['PUT /api/projects/' + PROJECT + '/run-settings'] = (init) =>
      json({ ...settings(), runInstructions: JSON.parse(String(init.body)).runInstructions });
    const user = userEvent.setup();
    wrap(<RunSettings projectId={PROJECT} canEdit />);
    const instr = await screen.findByTestId('run-instructions');
    expect(instr).toHaveValue('Start the API first.');
    expect(screen.getByTestId('run-instructions-api')).toHaveValue('dotnet 8');
    const plan = screen.getByTestId('run-plan-Desk');
    expect(plan).toHaveTextContent('version 3, active');
    expect(plan).toHaveTextContent('npm ci: npm ci');
    expect(plan).toHaveTextContent('web: npm run dev');
    expect(plan).toHaveTextContent('plain vite');
    expect(screen.getByDisplayValue('dotnet run')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http:5000:ASPNETCORE_HTTP_PORTS')).toBeInTheDocument();

    await user.clear(instr);
    await user.type(instr, 'Use the sample data.');
    await user.click(screen.getByTestId('run-docker'));
    expect(screen.getByText(/root-equivalent access/)).toBeInTheDocument();
    await user.type(
      screen.getByTestId('run-build-guides'),
      '/home/u/src/demo/sources/BUILD.md{enter}/home/u/other.md',
    );
    await user.click(screen.getByTestId('run-settings-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = calls.find((c) => c.method === 'PUT')!.body;
    expect(body.runInstructions).toBe('Use the sample data.');
    expect(body.settings).toMatchObject({
      ttlHours: 8,
      allowDocker: true,
      buildGuides: ['/home/u/src/demo/sources/BUILD.md', '/home/u/other.md'],
    });
    expect(body.settings.services.map((s: any) => s.name)).toEqual(['db', 'api', 'web']);
    expect(body.settings.services[1]).toMatchObject({
      name: 'api',
      cwd: 'src/Api',
      cmd: ['dotnet', 'run'],
      ports: [{ name: 'http', default: 5000, envVar: 'ASPNETCORE_HTTP_PORTS' }],
      after: ['db'],
    });
    expect(body.repoInstructions).toEqual([
      { repoId: WEB, runInstructions: '' },
      { repoId: API, runInstructions: 'dotnet 8' },
    ]);
  });

  it('says when a saved plan is stale and what happens next', async () => {
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () =>
      json(
        settings({
          plans: [
            {
              id: ID(81),
              workstationId: WS,
              workstationName: 'Desk',
              version: 2,
              status: 'stale',
              savedAt: new Date().toISOString(),
              plan: { version: 1, repos: [], setup: [], services: [], notes: '' },
            },
          ],
        }),
      );
    wrap(<RunSettings projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('run-plan-stale')).toHaveTextContent(
      'next start goes through the DevOps engineer',
    );
    expect(screen.getByTestId('run-plan-Desk')).toHaveTextContent('version 2, stale');
  });

  it('refuses a malformed port or a dependency cycle before sending anything', async () => {
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () => json(settings());
    const user = userEvent.setup();
    wrap(<RunSettings projectId={PROJECT} canEdit />);
    await screen.findByTestId('run-instructions');
    const ports = screen.getAllByLabelText('Ports')[1] as HTMLElement;
    await user.clear(ports);
    await user.type(ports, 'nonsense');
    await user.click(screen.getByTestId('run-settings-save'));
    expect(await screen.findByTestId('run-settings-problem')).toHaveTextContent(/name:number/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('is read-only for someone who is not the project owner', async () => {
    routes['GET /api/projects/' + PROJECT + '/run-settings'] = () => json(settings());
    wrap(<RunSettings projectId={PROJECT} canEdit={false} />);
    expect(await screen.findByTestId('run-instructions')).toBeDisabled();
    expect(screen.queryByTestId('run-settings-save')).toBeNull();
    expect(screen.getByText(/Only the project owner changes these/)).toBeInTheDocument();
  });
});
