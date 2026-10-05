import type { DeskItemDto, ProjectRepoDto, WorkstationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevOpsPanel } from '../components/DevOpsPanel.tsx';
import { WorkingBranchControl } from '../components/WorkingBranchControl.tsx';
import { DeskItem } from '../pages/Desk.tsx';

const U = '0192f3a0-0000-7000-8000-000000000001';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

const question = (over: Partial<DeskItemDto> = {}): DeskItemDto => ({
  id: U,
  kind: 'question',
  subkind: 'working_branch',
  status: 'open',
  routedTo: 'manager',
  title: 'Which branch is the working branch of notes-app (TEST01)?',
  body: '',
  doing: 'Repository hygiene found no confirmed working branch.',
  options: [
    { id: 'branch:develop', label: 'develop' },
    { id: 'branch:main', label: 'main' },
    { id: 'other', label: 'Another branch', description: 'Type the branch name in the answer.' },
  ],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: U, agentName: 'Atlas', role: 'devops' },
  card: null,
  projectId: U,
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: null,
  canAnswer: true,
  createdAt: '2026-10-05T10:00:00.000Z',
  ...over,
});

describe('the working-branch question on the desk', () => {
  const renderQ = (i: DeskItemDto) =>
    wrap(<DeskItem item={i} now={Date.parse('2026-10-05T12:00:00.000Z')} />);

  it('is labelled, shows the branches and the DevOps engineer, and answers with the chosen branch', async () => {
    const user = userEvent.setup();
    renderQ(question());
    expect(screen.getByText('Working branch', { selector: 'span,div,p,h3' })).toBeInTheDocument();
    expect(screen.getByText(/Which branch is the working branch of notes-app/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /develop/ }));
    await user.click(screen.getByRole('button', { name: 'Set working branch' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/desk/${U}/answer`,
      method: 'POST',
      body: { answer: 'develop', optionId: 'branch:develop', ledger: { scope: 'decision' } },
    });
  });

  it('"another branch" asks for the name and sends it as the answer', async () => {
    const user = userEvent.setup();
    renderQ(question());
    await user.click(screen.getByRole('radio', { name: /Another branch/ }));
    await user.click(screen.getByRole('button', { name: 'Set working branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type the name of the branch');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Branch name'), 'release/2026');
    await user.click(screen.getByRole('button', { name: 'Set working branch' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall().body).toEqual({
      answer: 'release/2026',
      optionId: 'other',
      ledger: { scope: 'decision' },
    });
  });

  it('nothing is sent until an option is chosen', async () => {
    const user = userEvent.setup();
    renderQ(question());
    await user.click(screen.getByRole('button', { name: 'Set working branch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a branch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a re-confirmation preselects "keep" as the recommendation', () => {
    renderQ(
      question({
        title: 'Keep main as the working branch of notes-app (TEST01), or use another branch?',
        options: [
          { id: 'keep', label: 'Keep main' },
          { id: 'other', label: 'Another branch' },
        ],
        recommendation: 'keep',
      }),
    );
    expect(screen.getByRole('radio', { name: /Keep main/ })).toBeChecked();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });
});

const repo = (over: Partial<ProjectRepoDto> = {}): ProjectRepoDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000e1',
  projectId: U,
  name: 'notes-app',
  remoteUrl: 'https://github.com/acme/notes-app.git',
  remoteUrlNormalized: 'github.com/acme/notes-app',
  workingBranch: null,
  removedAt: null,
  knownBranches: ['develop', 'main'],
  ...over,
});

describe('the repository row in the project settings', () => {
  it('says the branch is not confirmed and links to the desk question', () => {
    wrap(<WorkingBranchControl projectId={U} repo={repo({ branchQuestionId: 'abc' })} isOwner />);
    expect(screen.getByText('not confirmed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Answer on the desk' })).toHaveAttribute(
      'href',
      '/desk#desk-item-abc',
    );
    expect(screen.getByRole('button', { name: 'Set working branch of notes-app' })).toBeInTheDocument();
  });

  it('shows the confirmed branch and changes it to another known branch', async () => {
    const user = userEvent.setup();
    wrap(<WorkingBranchControl projectId={U} repo={repo({ workingBranch: 'main' })} isOwner />);
    expect(screen.getByText('main')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change working branch of notes-app' }));
    await user.selectOptions(screen.getByLabelText('Branch'), 'develop');
    await user.click(screen.getByRole('button', { name: 'Save branch' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/projects/${U}/repos/0192f3a0-0000-7000-8000-0000000000e1/working-branch`,
      method: 'PUT',
      body: { branch: 'develop' },
    });
  });

  it('names a branch that is not in the list', async () => {
    const user = userEvent.setup();
    wrap(<WorkingBranchControl projectId={U} repo={repo()} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Set working branch of notes-app' }));
    await user.selectOptions(screen.getByLabelText('Branch'), 'Another branch…');
    await user.click(screen.getByRole('button', { name: 'Save branch' }));
    expect(screen.getByText('Type the name of the branch')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Branch name'), 'trunk');
    await user.click(screen.getByRole('button', { name: 'Save branch' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall().body).toEqual({ branch: 'trunk' });
  });

  it('is read-only for members who do not own the project', () => {
    wrap(<WorkingBranchControl projectId={U} repo={repo({ workingBranch: 'main' })} isOwner={false} />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /working branch of notes-app/ })).toBeNull();
  });
});

const ws = (over: Partial<WorkstationDto> = {}): WorkstationDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000f1',
  userId: U,
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk',
  runnerVersion: '1',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-05T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  hygiene: {
    intervalHours: 24,
    lastRunAt: '2026-10-05T08:00:00.000Z',
    nextRunAt: '2026-10-06T08:00:00.000Z',
    lastRequestId: U,
    lastStatus: 'done',
    openFindings: 2,
  },
  ...over,
});

describe('workstation settings: repository hygiene', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith('/api/devops/requests')
        ? json({ requests: [] })
        : json({ requestId: U, alreadyRunning: false }),
    );
  });

  it('shows the cadence (daily by default), the last and next run and the open findings', () => {
    wrap(<DevOpsPanel w={ws()} />);
    expect(screen.getByLabelText('Run')).toHaveValue('24');
    expect(screen.getByRole('option', { name: 'Daily' })).toBeInTheDocument();
    const status = screen.getByTestId('hygiene-status');
    expect(status).toHaveTextContent('Last run');
    expect(status).toHaveTextContent('next');
    expect(status).toHaveTextContent('2 open findings');
  });

  it('changes the cadence per workstation', async () => {
    const user = userEvent.setup();
    wrap(<DevOpsPanel w={ws()} />);
    await user.selectOptions(screen.getByLabelText('Run'), 'Every 6 hours');
    await waitFor(() => expect(lastCall().method).toBe('PUT'));
    expect(lastCall()).toEqual({
      url: '/api/workstations/0192f3a0-0000-7000-8000-0000000000f1/hygiene',
      method: 'PUT',
      body: { intervalHours: 6 },
    });
  });

  it('"Run hygiene now" starts a run and confirms it', async () => {
    const user = userEvent.setup();
    wrap(<DevOpsPanel w={ws()} />);
    await user.click(screen.getByRole('button', { name: 'Run hygiene now' }));
    expect(await screen.findByText('Hygiene run requested.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
      '/api/workstations/0192f3a0-0000-7000-8000-0000000000f1/hygiene/run',
    );
  });

  it('says so when the schedule is off', () => {
    wrap(
      <DevOpsPanel
        w={ws({
          hygiene: {
            intervalHours: 0,
            lastRunAt: null,
            nextRunAt: null,
            lastRequestId: null,
            lastStatus: null,
            openFindings: 0,
          },
        })}
      />,
    );
    expect(screen.getByTestId('hygiene-status')).toHaveTextContent('Not run yet; the schedule is off');
  });
});
