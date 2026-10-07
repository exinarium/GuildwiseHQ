import type { DeskItemDto, ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergePolicyPanel } from '../components/MergePolicyPanel.tsx';
import { DeskItem } from '../pages/Desk.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
type Project = ProjectDetailResponse['project'];
const project = (over: Partial<Project> = {}): Project => ({
  id: PROJECT,
  orgId: '0192f3a0-0000-7000-8000-0000000000a1',
  key: 'TOY',
  name: 'Toy',
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  mergeLargeWithoutApproval: false,
  mergeLargeChanged: null,
  ...over,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderPanel(p: Project, history: ProjectDetailResponse['mergePolicyHistory'] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MergePolicyPanel projectId={PROJECT} project={p} history={history} />
    </QueryClientProvider>,
  );
}

describe('merge policy panel (project settings)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default and explains the risk', () => {
    renderPanel(project());
    expect(screen.getByTestId('merge-policy-state')).toHaveTextContent('Approval required');
    expect(screen.getByTestId('merge-policy-warning')).toHaveTextContent(
      'merged into the working branch as soon as they are finalized, without asking anyone',
    );
  });

  it('turning it on asks for a confirmation first, then calls the owner-only endpoint', async () => {
    const user = userEvent.setup();
    renderPanel(project());
    await user.click(screen.getByRole('button', { name: 'Merge large changes without my approval' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Large changes will merge without asking you');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Merge large changes without my approval' }));
    await user.click(screen.getByRole('button', { name: 'Yes, merge without my approval' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/merge-policy`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ mergeLargeWithoutApproval: true });
  });

  it('when on: shows who turned it on and when, history, and turns it off in one click', async () => {
    const user = userEvent.setup();
    renderPanel(
      project({
        mergeLargeWithoutApproval: true,
        mergeLargeChanged: { byName: 'Olga', at: '2026-10-04T09:30:00.000Z' },
      }),
      [{ enabled: true, byName: 'Olga', at: '2026-10-04T09:30:00.000Z' }],
    );
    expect(screen.getByTestId('merge-policy-state')).toHaveTextContent('Merge without approval');
    expect(screen.getByTestId('merge-policy-changed')).toHaveTextContent('Turned on by Olga');
    expect(screen.getByTestId('merge-policy-history')).toHaveTextContent(
      'Olga turned merging without approval on',
    );
    await user.click(screen.getByTestId('merge-policy-disable'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      mergeLargeWithoutApproval: false,
    });
  });

  it('an additional manager sees the state but cannot change it', () => {
    renderPanel(project({ myRole: 'manager', mergeLargeWithoutApproval: true }));
    expect(screen.getByTestId('merge-policy-readonly')).toHaveTextContent('Only the project owner');
    expect(screen.queryByTestId('merge-policy-disable')).toBeNull();
    expect(screen.queryByTestId('merge-policy-enable')).toBeNull();
  });
});

describe('desk: a waiting large-merge approval the setting now allows', () => {
  const approval = {
    id: '0192f3a0-0000-7000-8000-000000000002',
    kind: 'approval',
    subkind: 'large_merge',
    status: 'open',
    routedTo: 'manager',
    title: 'Approve merge of TOY-6: A large change',
    body: 'TOY-6 is a large change.',
    doing: '',
    options: [],
    recommendation: null,
    blocking: false,
    pinned: true,
    urgent: true,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system', agentId: null, agentName: null, role: null },
    card: null,
    projectId: PROJECT,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: null,
    canAnswer: true,
    createdAt: '2026-10-03T10:00:00.000Z',
  } as unknown as DeskItemDto;
  const show = (i: DeskItemDto) => {
    const qc = new QueryClient();
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <DeskItem item={i} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('shows the hint and keeps the one-click Approve merge', () => {
    show({
      ...approval,
      hint: "The project setting 'Merge large changes without my approval' is now on, so this merge would no longer need your approval. You can still approve it here.",
    });
    expect(screen.getByTestId('desk-hint')).toHaveTextContent('now on');
    expect(screen.getByRole('button', { name: 'Approve merge' })).toBeEnabled();
  });

  it('shows no hint otherwise', () => {
    show(approval);
    expect(screen.queryByTestId('desk-hint')).toBeNull();
  });
});
