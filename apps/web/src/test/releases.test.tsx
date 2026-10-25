import { describeGate } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, type RouteObject, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseSheet } from '../components/environments/ReleaseSheet.tsx';
import { RollbackSheet } from '../components/environments/RollbackSheet.tsx';
import { FollowupEditor, followupProblems } from '../components/FollowupEditor.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { Releases } from '../pages/Releases.tsx';
import { routes } from '../router.tsx';

const manage = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/orgRole.ts', () => ({
  useCanManageOrg: () => manage.value,
  useActiveOrgRole: () => (manage.value ? 'owner' : 'member'),
}));

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const calls: Array<{ url: string; method: string; body: unknown }> = [];
beforeEach(() => {
  manage.value = true;
  calls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const live = [
  {
    projectId: U(1),
    projectKey: 'P5',
    projectName: 'P5',
    env: 'production',
    label: 'Live site',
    role: 'live',
    version: '0.9.2',
    commit: 'aaa',
    since: ago(4320),
    health: 'healthy',
    releasesPaused: true,
    placeName: 'prod-server',
    appUrl: null,
    waitingRelease: 1,
  },
  {
    projectId: U(1),
    projectKey: 'P5',
    projectName: 'P5',
    env: 'uat',
    label: 'Test site',
    role: 'test',
    version: '0.9.4',
    commit: 'bbb',
    since: ago(12),
    health: 'updating',
    placeName: 'Office PC',
    appUrl: null,
    waitingRelease: 0,
  },
];
const queueItem = (satisfied: boolean) => ({
  projectId: U(1),
  projectKey: 'P5',
  env: 'production',
  commit: 'a1b2c3d4e5f6',
  waitingFor: 'owner',
  requestedAt: ago(5),
  gateNow: { satisfied, missing: satisfied ? [] : ['test site healthy for 3 more minutes'] },
  targets: [
    {
      runId: U(9),
      targetId: U(5),
      targetName: 'prod-server',
      production: true,
      host: 'h',
      workstationName: 'PC',
    },
  ],
});
const status = (rulesMet: boolean) => ({
  environments: [
    {
      env: 'production',
      label: 'Live site',
      role: 'live',
      hosting: 'ssh',
      runtime: 'docker',
      placeId: U(5),
      placeName: 'prod-server',
      appUrl: null,
      releasedBy: 'owner',
      updates: 'when you release',
      rules: [],
      current: {
        runId: U(8),
        commit: 'aaa',
        version: '0.9.2',
        since: ago(4320),
        releasedBy: 'Ada',
        kind: 'release',
      },
      health: { state: 'healthy', at: ago(2), detail: null },
      lastRun: null,
      waitingRelease: { runId: U(9), commit: 'a1b2c3d4e5f6', waitingFor: 'owner' },
      blockedBy: rulesMet ? [] : ['test site healthy for 3 more minutes'],
      savedState: 'saved',
      triedState: 'tried',
      approvalState: 'approved',
      openQuestions: 0,
      state: rulesMet ? 'healthy' : 'blocked',
      stateText: rulesMet ? 'Version 0.9.2 is live.' : 'Waiting for: test site healthy for 3 more minutes.',
    },
  ],
  openQuestions: 0,
  deliveryMode: 'recipe',
  generatedAt: ago(0),
});

function route(over: { queue?: unknown; status?: unknown; release?: () => unknown } = {}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u === '/api/org/live') return json({ rows: live });
    if (u === '/api/delivery/release' && over.release) return json(over.release());
    if (u === '/api/delivery/queue') return json({ items: over.queue ?? [queueItem(false)] });
    if (u.startsWith('/api/delivery/runs')) return json({ runs: [] });
    if (u.endsWith('/environments/status')) return json(over.status ?? status(false));
    if (u.includes('/environments/production/releases'))
      return json({
        releases: [
          {
            runId: U(40),
            commit: 'now',
            version: '0.9.2',
            at: ago(10),
            releasedBy: 'Ada',
            targetName: 'p',
            kind: 'release',
            current: true,
            backupNote: null,
          },
          {
            runId: U(41),
            commit: 'c1',
            version: '0.9.1',
            at: ago(2000),
            releasedBy: 'Ada',
            targetName: 'p',
            kind: 'release',
            current: false,
            backupNote: '/opt/backups/b1.sql.gz',
          },
          {
            runId: U(42),
            commit: 'c0',
            version: '0.9.0',
            at: ago(4000),
            releasedBy: 'Ben',
            targetName: 'p',
            kind: 'release',
            current: false,
            backupNote: '/opt/backups/b0.sql.gz',
          },
        ],
        canRollback: true,
      });
    if (method === 'POST') return json({ message: 'ok', runs: [] });
    return json({});
  });
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: React.ReactNode, at = '/') =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[at]}>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Releases page', () => {
  it('shows the four tabs to an Owner and opens What is live from the tab', async () => {
    route();
    wrap(<Releases />);
    expect(await screen.findByTestId('release-queue')).toBeInTheDocument();
    for (const name of ['Waiting for you', 'What is live', 'History', 'Rules'])
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'What is live' }));
    expect(await screen.findByTestId('live-row-P5-production')).toHaveTextContent('0.9.2');
    expect(screen.getByTestId('live-row-P5-uat')).toHaveTextContent('Updating');
    expect(screen.getByTestId('live-waiting-P5-production')).toHaveTextContent('1 release waiting');
    expect(screen.getByTestId('live-paused-row-P5-production')).toHaveTextContent('Releases paused');
    expect(screen.queryByTestId('live-paused-row-P5-uat')).toBeNull();
  });

  it('What is live: a healthy site with nothing waiting offers Release; paused or updating say why it is off', async () => {
    live.push({
      ...live[1],
      env: 'staging',
      label: 'Staging',
      health: 'healthy',
      waitingRelease: 0,
    } as never);
    try {
      route();
      wrap(<Releases />, '/releases?tab=live');
      const link = await screen.findByTestId('live-row-release-P5-staging');
      expect(link).toHaveTextContent('Release the newest version');
      expect(link).toHaveAttribute('href', '/p/P5/environments');
      expect(screen.getByTestId('live-row-off-P5-uat')).toHaveTextContent('Updating now');
      // production has a release waiting: the waiting link is shown, not a second Release
      expect(screen.queryByTestId('live-row-release-P5-production')).toBeNull();
    } finally {
      live.pop();
    }
  });

  it('opens on the tab named in the address', async () => {
    route();
    wrap(<Releases />, '/releases?tab=history');
    expect(await screen.findByTestId('deploy-runs')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });

  it('waiting for you: the rule is named and Release is off with the reason', async () => {
    route();
    wrap(<Releases />);
    expect(await screen.findByTestId('queue-waiting-for')).toHaveTextContent(
      'Waiting for: test site healthy for 3 more minutes',
    );
    expect(screen.getByTestId('release-P5-production-button')).toBeDisabled();
    expect(screen.getByTestId('release-disabled-reason')).toBeInTheDocument();
  });

  it('empty queue says nothing is waiting', async () => {
    route({ queue: [] });
    wrap(<Releases />);
    expect(await screen.findByTestId('release-queue-empty')).toHaveTextContent('Nothing is waiting');
  });

  it('a Member sees What is live and History only, with no action buttons', async () => {
    manage.value = false;
    route();
    wrap(<Releases />);
    expect(await screen.findByTestId('live-row-P5-production')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Waiting for you/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Rules' })).toBeNull();
    expect(screen.getByTestId('releases-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release/ })).toBeNull();
    // the waiting count is text, not a link to the queue
    expect(screen.getByTestId('live-waiting-P5-production').tagName).toBe('SPAN');
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByTestId('history-empty')).toBeInTheDocument();
  });

  it('/deploys lands on /releases', async () => {
    const app = (routes as RouteObject[]).flatMap((r) => r.children ?? []);
    const pick = app.filter((r) => r.path === '/deploys' || r.path === '/releases');
    expect(pick.map((r) => r.path)).toEqual(['/releases', '/deploys']);
    const router = createMemoryRouter(
      pick.map((r) => (r.path === '/releases' ? { path: r.path, element: <p>Releases here</p> } : r)),
      { initialEntries: ['/deploys'] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('Releases here')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/releases');
  });
});

describe('plain rules', () => {
  it('says each rule in a sentence', () => {
    expect(
      describeGate({
        requires: [
          { envHealthy: 'uat', sameCommit: true, forMinutes: 10 },
          { checksPassed: 'regression', sameCommit: true },
        ],
        window: { days: 'mon-fri', hours: '08-16', tz: 'org' },
      }),
    ).toEqual([
      'uat is healthy on the same version for 10 minutes',
      'Regression tests passed for this version',
      'Only on weekdays between 08:00 and 16:00',
    ]);
  });
});

describe('ReleaseSheet', () => {
  it('keeps Release now off and says what it waits for', async () => {
    route();
    wrap(<ReleaseSheet projectId={U(1)} env="production" label="Live site" onClose={() => undefined} />);
    expect(await screen.findByTestId('release-waiting-for')).toHaveTextContent(
      'Waiting for: test site healthy for 3 more minutes',
    );
    expect(screen.getByTestId('release-version')).toHaveTextContent('a1b2c3d');
    expect(screen.getByTestId('release-backup')).toHaveTextContent('backup');
    expect(screen.getByTestId('release-now')).toBeDisabled();
    expect(screen.getByTestId('release-disabled-reason')).toBeInTheDocument();
  });

  it('releases the waiting run when the rules hold', async () => {
    route({ status: status(true) });
    const onClose = vi.fn();
    wrap(<ReleaseSheet projectId={U(1)} env="production" label="Live site" onClose={onClose} />);
    const btn = await screen.findByTestId('release-now');
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/delivery/release');
    expect(post?.body).toEqual({ runIds: [U(9)] });
  });

  const twoPlaces = () => {
    const item = queueItem(true);
    return [
      {
        ...item,
        targets: [
          item.targets[0],
          { ...item.targets[0], runId: U(10), targetId: U(6), targetName: 'prod-server-2' },
        ],
      },
    ];
  };

  it('some places queued and others refused: the refused ones stay on screen with their reasons', async () => {
    let n = 0;
    route({
      status: status(true),
      queue: twoPlaces(),
      release: () => {
        n += 1;
        return {
          message: 'one started',
          runs: [
            { runId: U(9), target: 'prod-server', status: 'queued' },
            {
              runId: U(10),
              target: 'prod-server-2',
              status: 'refused',
              refusal: 'run_in_progress',
              detail: 'production on prod-server-2 is being deployed right now',
            },
          ],
        };
      },
    });
    const onClose = vi.fn();
    wrap(<ReleaseSheet projectId={U(1)} env="production" label="Live site" onClose={onClose} />);
    await userEvent.click(await screen.findByTestId('release-place-prod-server'));
    await userEvent.click(screen.getByTestId('release-place-prod-server-2'));
    const btn = screen.getByTestId('release-now');
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    const box = await screen.findByTestId('release-refused');
    expect(box).toHaveTextContent('prod-server-2');
    expect(box).toHaveTextContent('is being deployed right now');
    expect(box).not.toHaveTextContent('prod-server:');
    expect(onClose).not.toHaveBeenCalled();
    expect(n).toBe(1);
  });

  it('a retry after a refusal clears the old reason first, and closes when it works', async () => {
    let n = 0;
    route({
      status: status(true),
      release: () => {
        n += 1;
        return n === 1
          ? {
              message: 'Refused (run_in_progress): busy',
              runs: [{ runId: U(9), target: 'prod-server', status: 'refused', refusal: 'run_in_progress' }],
            }
          : { message: 'ok', runs: [{ runId: U(9), target: 'prod-server', status: 'queued' }] };
      },
    });
    const onClose = vi.fn();
    wrap(<ReleaseSheet projectId={U(1)} env="production" label="Live site" onClose={onClose} />);
    const btn = await screen.findByTestId('release-now');
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    expect(await screen.findByTestId('release-refused')).toHaveTextContent('busy');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(btn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId('release-refused')).toBeNull();
    expect(n).toBe(2);
  });
});

describe('RollbackSheet', () => {
  it('lists the earlier versions, explains the data and sends a rollback after the choice', async () => {
    route();
    const onClose = vi.fn();
    wrap(<RollbackSheet projectId={U(1)} env="production" label="Live site" onClose={onClose} />);
    const items = await screen.findAllByTestId('rollback-candidate');
    // the newest success is what runs now: only earlier ones are offered
    expect(items).toHaveLength(2);
    expect(screen.getByTestId('rollback-sheet')).toHaveTextContent('Your data is not rolled back');
    expect(screen.getByTestId('rollback-confirm')).toBeDisabled();
    await userEvent.click(within(items[0] as HTMLElement).getByRole('radio'));
    expect(screen.getByTestId('rollback-backup')).toHaveTextContent('/opt/backups/b1.sql.gz');
    await userEvent.click(screen.getByRole('button', { name: 'Go back to 0.9.1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`/api/projects/${U(1)}/releases/rollback`);
    expect(post?.body).toEqual({ env: 'production', runId: U(41) });
  });

  it('a Member gets the Owner note and no confirm', async () => {
    manage.value = false;
    route();
    wrap(<RollbackSheet projectId={U(1)} env="production" label="Live site" onClose={() => undefined} />);
    expect(await screen.findByTestId('rollback-owner-note')).toBeInTheDocument();
    expect(screen.getByTestId('rollback-confirm')).toBeDisabled();
  });
});

describe('follow-ups choose an environment', () => {
  const setupState = {
    canEdit: true,
    canApprove: true,
    draft: null,
    current: {
      setup: {
        environments: [
          { name: 'production', label: 'Live site', target: 'shop-live' },
          { name: 'uat', label: 'Test site', target: 'shop-uat' },
        ],
      },
      handEdited: [],
      recipePresent: true,
      recipeStatus: 'approved',
      observedHash: null,
      approvedHash: null,
      lint: [],
      dryRunOk: [],
      custom: false,
    },
    publish: null,
    targets: [
      { id: U(21), name: 'shop-uat', kind: 'local_docker', production: false },
      { id: U(22), name: 'shop-live', kind: 'remote_ssh', production: true },
    ],
    workstations: [],
    probes: [],
    writeBlocked: null,
    scan: null,
    scanProblem: null,
    proposal: null,
    generator: 'x',
  };

  it('writes the environment and keeps the target id for an older server', async () => {
    fetchMock.mockImplementation(async () => json(setupState));
    const onChange = vi.fn();
    wrap(<FollowupEditor value={[]} onChange={onChange} targets={[]} projectId={U(1)} />);
    // the test site comes first and the live site says it waits
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('add-deploy'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith([{ kind: 'deploy', environment: 'uat', note: '' }]);
  });

  it('shows "Release to" with the sites and a plain sentence', async () => {
    fetchMock.mockImplementation(async () => json(setupState));
    wrap(
      <FollowupEditor
        value={[
          { kind: 'deploy', targetId: U(21), environment: 'uat', note: '' } as never,
          { kind: 'deploy', targetId: U(22), environment: 'production', note: '' } as never,
        ]}
        onChange={() => undefined}
        targets={[]}
        projectId={U(1)}
      />,
    );
    const select = await screen.findAllByLabelText('Release to');
    expect(select).toHaveLength(2);
    expect(await screen.findByTestId('followup-sentence')).toHaveTextContent(
      'release to Test site, then Live site (waits for you)',
    );
    expect(followupProblems([{ kind: 'deploy', targetId: '', note: '' }], [], [])).toEqual([
      'Follow-up 1: choose a deploy target',
    ]);
  });
});
