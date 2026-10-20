import { type RunPlan, RunPlanSchema } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entriesToPlan, moveEntry, type PlanEntry, planToEntries } from '../components/runs/plan-entries.ts';
import { RunStepsCard } from '../components/runs/RunStepsCard.tsx';
import { RunStepsEditor } from '../components/runs/RunStepsEditor.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const WEB = ID(10);
const WS = ID(20);
const REPOS = [{ repoId: WEB, name: 'toy' }];

const step = (over: Record<string, unknown> = {}) => ({
  name: 'Install packages',
  label: 'Install packages',
  template: 'install_packages',
  repoId: WEB,
  cwd: '.',
  cmd: ['npm', 'ci'],
  timeoutSec: 1200,
  when: 'changed:package-lock.json',
  ...over,
});
const svc = (over: Record<string, unknown> = {}) => ({
  name: 'web',
  label: 'The website',
  template: 'web_app',
  repoId: WEB,
  cwd: '.',
  cmd: ['npm', 'run', 'dev'],
  env: {},
  ports: [{ name: 'http', default: 5173, envVar: 'PORT', url: 'http://localhost:${port}/' }],
  health: { kind: 'http', url: 'http://localhost:${port}/', expect: '2xx' },
  startTimeoutSec: 300,
  after: [],
  docker: false,
  ...over,
});
const plan = (over: Record<string, unknown> = {}): RunPlan =>
  RunPlanSchema.parse({ repos: [{ repoId: WEB }], setup: [step()], services: [svc()], notes: '', ...over });

const version = (over: Record<string, unknown> = {}) => ({
  id: ID(30),
  workstationId: null,
  workstationName: null,
  version: 2,
  status: 'active',
  source: 'owner',
  plan: plan(),
  savedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  savedByName: 'Mia',
  lastFailure: null,
  ...over,
});
const station = (over: Record<string, unknown> = {}) => ({
  id: WS,
  name: 'Office PC',
  connected: true,
  mine: true,
  canRun: true,
  canScan: true,
  scanBlocked: null,
  ...over,
});
const overview = (over: Record<string, unknown> = {}) => ({
  canEdit: true,
  repos: REPOS,
  workstations: [station()],
  projectPlan: null,
  workstationPlans: [],
  scan: null,
  scanProblem: null,
  proposal: null,
  lastStart: null,
  ...over,
});
const proposal = (over: Record<string, unknown> = {}) => ({
  id: ID(40),
  area: 'run',
  status: 'open',
  requestId: ID(41),
  workstationId: WS,
  workstationName: 'Office PC',
  submittedAt: new Date().toISOString(),
  proposal: {
    area: 'run',
    run: plan({ notes: 'Looks like a Vite app.' }),
    items: [
      { path: '/setup/0', confidence: 'found', evidence: [{ file: 'package.json', line: 7 }] },
      { path: '/services/0/ports/0/default', confidence: 'guessed', note: 'the usual Vite port' },
      { path: '/services/0/health', confidence: 'unknown' },
    ],
    questions: [{ path: '/services/0/health', question: 'Which page shows the app is ready?', default: '/' }],
    secretsNeeded: [],
    notes: 'Read package.json and vite.config.ts.',
    filesRead: ['package.json', 'vite.config.ts'],
  },
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
const serve = (o: Record<string, unknown>) => {
  routes[`GET /api/projects/${PROJECT}/run-plan`] = () => json(o);
  routes[`GET /api/projects/${PROJECT}/run-settings`] = () =>
    json({
      runInstructions: '',
      repos: [{ repoId: WEB, name: 'toy', runInstructions: '' }],
      settings: { ttlHours: 8, allowDocker: false, services: [], buildGuides: [] },
      plans: [],
    });
};

// ---------------------------------------------------------------------------------------- entries

describe('plan entries', () => {
  it('round-trip a plan, keep the sections apart when moving, and report unanswered unknowns', () => {
    const p = plan({
      setup: [
        step(),
        step({ name: 'Build', label: 'Build', template: 'build', cmd: ['npm', 'run', 'build'] }),
      ],
    });
    const entries = planToEntries(p);
    expect(entries.map((e) => e.kind)).toEqual(['step', 'step', 'service']);
    expect(entriesToPlan(p, entries)).toEqual(p);
    const moved = moveEntry(entries, entries[1]?.key as string, -1);
    expect(moved.map((e) => e.item.name)).toEqual(['Build', 'Install packages', 'web']);
    // the first part cannot move up into the steps
    expect(moveEntry(entries, entries[2]?.key as string, -1)).toBe(entries);
  });
});

// ---------------------------------------------------------------------------------------- editor

function Harness({ initial, onPlan }: { initial: PlanEntry[]; onPlan?: (p: RunPlan) => void }) {
  const [entries, setEntries] = useState(initial);
  onPlan?.(entriesToPlan(RunPlanSchema.parse({}), entries));
  return <RunStepsEditor entries={entries} onChange={setEntries} repos={REPOS} />;
}

describe('RunStepsEditor', () => {
  it('lists the steps and the parts in plain words', () => {
    wrap(<Harness initial={planToEntries(plan())} />);
    const before = screen.getByTestId('run-steps-before');
    expect(within(before).getByText('Install packages')).toBeInTheDocument();
    expect(
      within(before).getByText(/Runs npm ci\. Again when package-lock\.json changes\./),
    ).toBeInTheDocument();
    const parts = screen.getByTestId('run-steps-parts');
    expect(within(parts).getByText('The website')).toBeInTheDocument();
    expect(within(parts).getByText(/on port 5173\. Ready when the page opens\./)).toBeInTheDocument();
  });

  it('adds a website part through its template: asks only what it needs, validates in plain words', async () => {
    const user = userEvent.setup();
    let latest: RunPlan | undefined;
    wrap(<Harness initial={[]} onPlan={(p) => (latest = p)} />);
    expect(screen.getByText('Nothing runs before the app starts.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add a part/ }));
    await user.click(screen.getByTestId('template-web_app'));
    const dialog = screen.getByRole('dialog');
    // no port yet: plain error
    await user.type(within(dialog).getByLabelText('What command starts it?'), 'npm run dev');
    await user.click(within(dialog).getByTestId('step-add'));
    expect(within(dialog).getByTestId('step-error')).toHaveTextContent(/Which port does the app use/);
    await user.type(within(dialog).getByLabelText('Which port does it use?'), '3000');
    await user.click(within(dialog).getByTestId('step-add'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(latest?.services).toHaveLength(1);
    expect(latest?.services[0]).toMatchObject({
      name: 'web',
      template: 'web_app',
      cmd: ['npm', 'run', 'dev'],
      ports: [{ name: 'http', default: 3000, envVar: 'PORT' }],
      health: { kind: 'http', url: 'http://localhost:${port}/' },
    });
  });

  it('the picker offers templates for the section; "More" hides the generic ones', async () => {
    const user = userEvent.setup();
    wrap(<Harness initial={[]} />);
    await user.click(screen.getByRole('button', { name: /Add a step/ }));
    const picker = screen.getByTestId('template-picker');
    expect(within(picker).getByText('Install packages')).toBeInTheDocument();
    expect(within(picker).getByText('Build')).toBeInTheDocument();
    expect(within(picker).getByText('Prepare the database')).toBeInTheDocument();
    expect(within(picker).queryByText('Start the website or app')).toBeNull();
    await user.click(screen.getByTestId('template-install_packages'));
    await user.selectOptions(screen.getByLabelText('How are the packages installed?'), 'pnpm');
    await user.type(screen.getByLabelText('Which folder?'), '{Control>}a{/Control}web');
    await user.click(screen.getByTestId('step-add'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const card = screen.getByTestId('run-entry-Install packages (web)');
    expect(card).toHaveTextContent('Runs pnpm install --frozen-lockfile in web.');
  });

  it('edits a card, shows the real command under technical details, and the typed command wins', async () => {
    const user = userEvent.setup();
    let latest: RunPlan | undefined;
    wrap(<Harness initial={planToEntries(plan())} onPlan={(p) => (latest = p)} />);
    await user.click(screen.getByRole('button', { name: 'Edit The website' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Which port does it use?')).toHaveValue('5173');
    expect(within(dialog).getByLabelText('Command')).toHaveValue('npm run dev');
    await user.clear(within(dialog).getByLabelText('Which port does it use?'));
    await user.type(within(dialog).getByLabelText('Which port does it use?'), '8080');
    await user.clear(within(dialog).getByLabelText('Command'));
    await user.type(within(dialog).getByLabelText('Command'), 'npm run serve -- --host');
    await user.click(within(dialog).getByTestId('step-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(latest?.services[0]).toMatchObject({
      name: 'web',
      ports: [{ default: 8080 }],
      cmd: ['npm', 'run', 'serve', '--', '--host'],
    });
  });

  it('removing a part drops the "start after" of the parts that waited for it; move buttons reorder steps', async () => {
    const user = userEvent.setup();
    let latest: RunPlan | undefined;
    const p = plan({
      setup: [
        step(),
        step({ name: 'Build', label: 'Build', template: 'build', cmd: ['make'], when: 'always' }),
      ],
      services: [
        svc({ name: 'db', label: 'Database', template: 'custom_service', after: [] }),
        svc({ after: ['db'] }),
      ],
    });
    wrap(<Harness initial={planToEntries(p)} onPlan={(x) => (latest = x)} />);
    await user.click(screen.getByRole('button', { name: 'Move Build up' }));
    expect(latest?.setup.map((s) => s.name)).toEqual(['Build', 'Install packages']);
    expect(screen.getByRole('button', { name: 'Move Build up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove Database' }));
    expect(latest?.services.map((s) => s.name)).toEqual(['web']);
    expect(latest?.services[0]?.after).toEqual([]);
  });

  it('docker template builds a throwaway container with a preset', async () => {
    const user = userEvent.setup();
    let latest: RunPlan | undefined;
    wrap(<Harness initial={[]} onPlan={(p) => (latest = p)} />);
    await user.click(screen.getByRole('button', { name: /Add a part/ }));
    await user.click(screen.getByTestId('template-docker_service'));
    await user.click(screen.getByTestId('step-add'));
    expect(latest?.services[0]).toMatchObject({
      name: 'postgres',
      docker: true,
      cmd: ['docker', 'run', '--rm', '-p', '${port}:5432', '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:16'],
    });
  });
});

// ---------------------------------------------------------------------------------------- the card

describe('RunStepsCard', () => {
  it('not set up: says so and offers Scan with DevOps and Set up myself', async () => {
    serve(overview());
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('run-steps-state')).toHaveTextContent(/Not set up yet/);
    expect(screen.getByTestId('scan-open')).toBeEnabled();
    expect(screen.getByTestId('run-steps-edit-open')).toHaveTextContent('Set up myself');
  });

  it('ready: summary, last start, the steps in words; a non-owner sees no actions', async () => {
    serve(
      overview({
        canEdit: false,
        projectPlan: version(),
        lastStart: {
          state: 'ok',
          at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          workstationName: 'Office PC',
          failure: null,
        },
      }),
    );
    wrap(<RunStepsCard projectId={PROJECT} canEdit={false} />);
    expect(await screen.findByTestId('run-steps-state')).toHaveTextContent(
      'Starts in 2 steps on any computer of this project. Last start: worked 2h ago on Office PC.',
    );
    expect(screen.getByTestId('run-plan-summary')).toHaveTextContent('Runs npm run dev, on port 5173');
    expect(screen.queryByTestId('scan-open')).toBeNull();
    expect(screen.getByText('Only the project owner can change the run steps.')).toBeInTheDocument();
  });

  it('a scan in progress shows the wait and disables a second scan', async () => {
    serve(
      overview({
        scan: {
          requestId: ID(41),
          area: 'run',
          status: 'running',
          workstationId: WS,
          workstationName: 'Office PC',
          startedAt: new Date().toISOString(),
        },
      }),
    );
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('scan-progress')).toHaveTextContent(
      /On Office PC, usually 2 to 5 minutes/,
    );
    expect(screen.getByTestId('scan-open')).toBeDisabled();
  });

  it('Scan with DevOps sends the area, the computer and the note', async () => {
    const user = userEvent.setup();
    serve(overview({ workstations: [station(), station({ id: ID(21), name: 'Laptop' })] }));
    routes[`POST /api/projects/${PROJECT}/scan`] = () => json({ requestId: ID(41) }, 202);
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('scan-open'));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Which computer?'), ID(21));
    await user.type(within(dialog).getByLabelText(/Anything DevOps should know/), 'The site is in web/');
    await user.click(within(dialog).getByTestId('scan-start'));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/scan'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/scan'))?.body).toEqual({
      area: 'run',
      workstationId: ID(21),
      note: 'The site is in web/',
    });
  });

  it('when no computer can scan it says why', async () => {
    const user = userEvent.setup();
    serve(
      overview({
        workstations: [
          station({ canScan: false, scanBlocked: 'Guildwise on Office PC is too old for scans: update it.' }),
        ],
      }),
    );
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('scan-open'));
    expect(screen.getByTestId('scan-blocked')).toHaveTextContent('too old for scans');
    expect(screen.getByTestId('scan-start')).toBeDisabled();
  });

  it('a scan that failed shows why, and a failed start shows the reason', async () => {
    serve(
      overview({
        scanProblem: 'The scan did not finish: the repository is empty',
        projectPlan: version({
          lastFailure: { reason: 'step "Install packages" failed (exit 1)', at: new Date().toISOString() },
        }),
      }),
    );
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('scan-problem')).toHaveTextContent('the repository is empty');
    expect(screen.getByTestId('run-steps-failure')).toHaveTextContent('Install packages');
  });

  it('Edit steps: changes are saved as the project plan; problems in plain words disable saving', async () => {
    const user = userEvent.setup();
    serve(overview({ projectPlan: version() }));
    routes[`PUT /api/projects/${PROJECT}/run-plan`] = () =>
      json(overview({ projectPlan: version({ version: 3 }) }));
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('run-steps-edit-open'));
    // remove the only part: nothing keeps running
    await user.click(screen.getByRole('button', { name: 'Remove The website' }));
    expect(screen.getByTestId('run-steps-problems')).toHaveTextContent(
      'Add at least one part that keeps running',
    );
    expect(screen.getByTestId('run-steps-save')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Add a part/ }));
    await user.click(screen.getByTestId('template-web_app'));
    await user.type(screen.getByLabelText('What command starts it?'), 'npm start');
    await user.type(screen.getByLabelText('Which port does it use?'), '3000');
    await user.click(screen.getByTestId('step-add'));
    await waitFor(() => expect(screen.queryByTestId('run-steps-problems')).toBeNull());
    await user.click(screen.getByTestId('run-steps-save'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-plan'))).toBeTruthy(),
    );
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-plan'));
    expect(put?.body).toMatchObject({ scope: 'project', source: 'owner' });
    expect(put?.body.plan.services[0]).toMatchObject({ name: 'web', cmd: ['npm', 'start'] });
    expect(put?.body.plan.setup[0]).toMatchObject({ name: 'Install packages' });
  });

  it('Test these steps starts a test run on the chosen computer and reports success in plain words', async () => {
    const user = userEvent.setup();
    serve(overview({ projectPlan: version() }));
    const env = {
      id: ID(50),
      state: 'healthy',
      workstationName: 'Office PC',
      activity: null,
      canStop: true,
      servicesStatus: [
        {
          name: 'web',
          state: 'healthy',
          ports: [],
          urls: ['http://localhost:5173/'],
          health: 'passing',
          restarts: 0,
        },
      ],
      failureReason: null,
      lastError: null,
    };
    routes[`POST /api/projects/${PROJECT}/run-plan/test`] = () => json({ environment: env }, 201);
    routes[`GET /api/runs/${ID(50)}`] = () => json({ environment: env });
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('run-test-button'));
    expect(await screen.findByTestId('run-test-ok')).toHaveTextContent('Open it: http://localhost:5173/');
    expect(calls.find((c) => c.url.endsWith('/run-plan/test'))?.body).toEqual({ workstationId: WS });
  });

  it('a failed test says what went wrong', async () => {
    const user = userEvent.setup();
    serve(overview({ projectPlan: version() }));
    const env = {
      id: ID(50),
      state: 'failed',
      workstationName: 'Office PC',
      canStop: false,
      servicesStatus: [],
      failureReason: null,
      lastError: 'step "Install packages" failed (exit 1)',
    };
    routes[`POST /api/projects/${PROJECT}/run-plan/test`] = () => json({ environment: env }, 201);
    routes[`GET /api/runs/${ID(50)}`] = () => json({ environment: env });
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('run-test-button'));
    expect(await screen.findByTestId('run-test-failed')).toHaveTextContent('Install packages');
  });

  it('computers with their own steps: use the project version here / make this the project version', async () => {
    const user = userEvent.setup();
    const own = version({
      id: ID(31),
      workstationId: WS,
      workstationName: 'Office PC',
      source: 'devops',
      plan: plan({ notes: 'repair' }),
    });
    serve(overview({ projectPlan: version(), workstationPlans: [own] }));
    routes[`DELETE /api/projects/${PROJECT}/run-plan/${ID(31)}`] = () =>
      json(overview({ projectPlan: version() }));
    routes[`PUT /api/projects/${PROJECT}/run-plan`] = () => json(overview({ projectPlan: version() }));
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    const box = await screen.findByTestId('own-plan-Office PC');
    expect(box).toHaveTextContent(
      'Office PC uses its own version (saved by DevOps after a start went wrong)',
    );
    await user.click(within(box).getByRole('button', { name: 'Use the project version here' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(`/api/projects/${PROJECT}/run-plan/${ID(31)}`);
  });

  it('"Make this the project version" saves that computer\'s steps for the whole project', async () => {
    const user = userEvent.setup();
    const own = version({
      id: ID(31),
      workstationId: WS,
      workstationName: 'Office PC',
      source: 'devops',
      plan: plan({ notes: 'repair' }),
    });
    serve(overview({ projectPlan: version(), workstationPlans: [own] }));
    routes[`PUT /api/projects/${PROJECT}/run-plan`] = () => json(overview({ projectPlan: version() }));
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    const box = await screen.findByTestId('own-plan-Office PC');
    await user.click(within(box).getByRole('button', { name: 'Make this the project version' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body.plan.notes).toBe('repair'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ scope: 'project', source: 'owner' });
  });

  it('Docker steps with Docker off: a hint with a button that allows it', async () => {
    const user = userEvent.setup();
    serve(overview({ projectPlan: version({ plan: plan({ services: [svc({ docker: true })] }) }) }));
    routes[`PUT /api/projects/${PROJECT}/run-settings`] = () => json({});
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    const hint = await screen.findByTestId('docker-hint');
    await user.click(within(hint).getByRole('button', { name: 'Allow Docker' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-settings'))).toBeTruthy(),
    );
    expect(
      calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-settings'))?.body.settings.allowDocker,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------- review

describe('reviewing a scan', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, o: Record<string, unknown> = {}) => {
    serve(overview({ proposal: proposal(), ...o }));
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    await user.click(await screen.findByTestId('proposal-review-open'));
  };

  it('the waiting suggestion is announced with its size and open questions', async () => {
    serve(overview({ proposal: proposal() }));
    wrap(<RunStepsCard projectId={PROJECT} canEdit />);
    expect(await screen.findByTestId('proposal-waiting')).toHaveTextContent(
      '2 steps found, 1 question for you.',
    );
  });

  it('shows found, guessed and unknown; an unknown blocks Use until it is answered by editing the part', async () => {
    const user = userEvent.setup();
    await open(user);
    expect(screen.getByTestId('proposal-notes')).toHaveTextContent('Read package.json and vite.config.ts.');
    expect(screen.getByTestId('proposal-questions')).toHaveTextContent('1 question before you can use this');
    expect(screen.getByTestId('proposal-questions')).toHaveTextContent('Which page shows the app is ready?');
    expect(screen.getByTestId('proposal-questions')).toHaveTextContent('Usually /');
    const install = screen.getByTestId('run-entry-Install packages');
    expect(within(install).getByTestId('entry-confidence')).toHaveTextContent('Found');
    expect(install).toHaveTextContent('from package.json:7');
    const site = screen.getByTestId('run-entry-The website');
    expect(within(site).getByTestId('entry-confidence')).toHaveTextContent('Needs your answer');
    // blocked
    expect(screen.getByTestId('proposal-use')).toBeDisabled();
    expect(screen.getByTestId('proposal-blocking')).toHaveTextContent('Answer the open question first.');
    // answer: opens the part, with the question above the form
    await user.click(
      within(screen.getByTestId('proposal-questions')).getByRole('button', { name: 'Answer' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('step-banner')).toHaveTextContent(
      'Which page shows the app is ready? (usually /)',
    );
    await user.click(within(dialog).getByTestId('step-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('proposal-use')).toBeEnabled();
    expect(
      within(screen.getByTestId('run-entry-The website')).getByTestId('entry-confidence'),
    ).toHaveTextContent('Checked');
    expect(screen.getByTestId('proposal-questions')).toHaveTextContent('Your answers');
  });

  it('Use these steps saves the project plan as a scan plan with the proposal id', async () => {
    const user = userEvent.setup();
    routes[`PUT /api/projects/${PROJECT}/run-plan`] = () =>
      json(overview({ projectPlan: version({ source: 'scan' }) }));
    await open(user);
    await user.click(
      within(screen.getByTestId('proposal-questions')).getByRole('button', { name: 'Answer' }),
    );
    await user.click(within(screen.getByRole('dialog')).getByTestId('step-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByTestId('proposal-use'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-plan'))).toBeTruthy(),
    );
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/run-plan'));
    expect(put?.body).toMatchObject({ scope: 'project', source: 'scan', proposalId: ID(40) });
    expect(put?.body.plan.notes).toBe('Looks like a Vite app.');
  });

  it('a guessed part can be accepted with "Looks right"; Dismiss puts the suggestion away', async () => {
    const user = userEvent.setup();
    const p = proposal();
    p.proposal.items = [
      { path: '/setup/0', confidence: 'guessed' },
      { path: '/services/0', confidence: 'found' },
    ] as never;
    p.proposal.questions = [];
    routes[`POST /api/setup-proposals/${ID(40)}/resolve`] = () => json({ ok: true });
    await open(user, { proposal: p });
    // nothing blocks: guesses need a look but do not stop the user
    expect(screen.getByTestId('proposal-use')).toBeEnabled();
    const install = screen.getByTestId('run-entry-Install packages');
    expect(within(install).getByTestId('entry-confidence')).toHaveTextContent('Guessed, please check');
    await user.click(within(install).getByRole('button', { name: 'Install packages looks right' }));
    expect(within(install).getByTestId('entry-confidence')).toHaveTextContent('Checked');
    await user.click(screen.getByTestId('proposal-dismiss'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/resolve'))?.body).toEqual({ outcome: 'dismissed' }),
    );
  });

  it('warns that using the suggestion replaces the saved steps', async () => {
    const user = userEvent.setup();
    await open(user, { projectPlan: version() });
    expect(screen.getByText('Using these steps replaces the steps that are saved now.')).toBeInTheDocument();
  });
});

describe('query invalidation', () => {
  it('a run plan or proposal event refetches the guided steps', () => {
    const has = (e: { type: string; streamId: string; projectId?: string }) =>
      keysForEvent(e as never).some((k) => k[0] === 'run-plan');
    expect(has({ type: 'RunPlanSaved', streamId: `project-${PROJECT}`, projectId: PROJECT })).toBe(true);
    expect(has({ type: 'SetupProposalSubmitted', streamId: `project-${PROJECT}`, projectId: PROJECT })).toBe(
      true,
    );
    expect(has({ type: 'DevOpsRequested', streamId: `thread-${ID(41)}` })).toBe(true);
    expect(has({ type: 'RunEnvironmentEnded', streamId: `run-${ID(50)}` })).toBe(true);
  });
});
