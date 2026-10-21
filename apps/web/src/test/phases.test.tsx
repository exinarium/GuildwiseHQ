import type {
  BoardResponse,
  DeployTargetDto,
  DeskItemDto,
  FollowupSpec,
  PhaseDeskBlock,
  PhaseFollowupDto,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardTile } from '../components/BoardView.tsx';
import { CardPhase } from '../components/CardPhase.tsx';
import { FollowupEditor, followupProblems } from '../components/FollowupEditor.tsx';
import { PhaseDeskItem } from '../components/PhaseDeskItem.tsx';
import { PhaseFilter } from '../components/PhaseFilter.tsx';
import { PHASE_STATUS_LABEL, phasePath, specOf } from '../lib/phases.ts';
import { Phase } from '../pages/Phase.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const targets: DeployTargetDto[] = [
  {
    id: U(1),
    projectId: U(9),
    name: 'local',
    kind: 'local_docker',
    workstationId: null,
    workstationName: null,
    host: null,
    appUrl: 'http://localhost:4601',
    notes: '',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  {
    id: U(2),
    projectId: U(9),
    name: 'staging',
    kind: 'remote_ssh',
    workstationId: U(5),
    workstationName: 'Box',
    host: 'stg',
    appUrl: null,
    notes: '',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const calls = () =>
  fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`);
const bodyOf = (method: string, urlPart: string) => {
  const c = fetchMock.mock.calls.find(
    ([u, i]) => String(u).includes(urlPart) && (i as RequestInit | undefined)?.method === method,
  );
  return c ? JSON.parse(String((c[1] as RequestInit).body)) : undefined;
};

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function Harness({
  initial,
  readOnly = false,
  details,
}: {
  initial: FollowupSpec[];
  readOnly?: boolean;
  details?: PhaseFollowupDto[];
}) {
  const [list, setList] = useState<FollowupSpec[]>(initial);
  return (
    <>
      <FollowupEditor
        value={list}
        onChange={setList}
        targets={targets}
        readOnly={readOnly}
        {...(details ? { details } : {})}
      />
      <output data-testid="state">{JSON.stringify(list.map((f) => f.kind))}</output>
    </>
  );
}

describe('FollowupEditor', () => {
  it('adds each kind, reorders with the up and down buttons and removes', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={[]} />);
    expect(screen.getByTestId('followups-empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('add-deploy'));
    await user.click(screen.getByTestId('add-regression'));
    await user.click(screen.getByTestId('add-custom'));
    expect(screen.getByTestId('state')).toHaveTextContent('["deploy","regression","custom"]');
    // a new deploy starts on the first target
    expect(within(screen.getByTestId('followup-1')).getByLabelText('Deploy target')).toHaveValue(U(1));

    await user.click(screen.getByRole('button', { name: 'Move follow-up 3 up' }));
    expect(screen.getByTestId('state')).toHaveTextContent('["deploy","custom","regression"]');
    await user.click(screen.getByRole('button', { name: 'Move follow-up 1 down' }));
    expect(screen.getByTestId('state')).toHaveTextContent('["custom","deploy","regression"]');
    expect(screen.getByRole('button', { name: 'Move follow-up 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move follow-up 3 down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 2' }));
    expect(screen.getByTestId('state')).toHaveTextContent('["custom","regression"]');
  });

  it('validates: a deploy needs a target, a custom item needs its instruction', async () => {
    const user = userEvent.setup();
    expect(followupProblems([{ kind: 'deploy', targetId: '', note: '' }], targets)).toEqual([
      'Follow-up 1: choose a deploy target',
    ]);
    expect(followupProblems([{ kind: 'deploy', targetId: U(7), note: '' }], targets)).toEqual([
      'Follow-up 1: the deploy target no longer exists',
    ]);
    expect(followupProblems([{ kind: 'custom', instruction: '  ', note: '' }], targets)).toEqual(
      ['Follow-up 2: write the instruction'].map((s) => s.replace('2', '1')),
    );
    expect(followupProblems([{ kind: 'regression', platform: 'web', note: '' }], targets)).toEqual([]);
    renderWith(<Harness initial={[{ kind: 'custom', instruction: '', note: '' }]} />);
    expect(screen.getByTestId('followup-problems')).toHaveTextContent('Follow-up 1: write the instruction');
    await user.type(screen.getByLabelText('Instruction'), 'Tell the team');
    expect(screen.queryByTestId('followup-problems')).not.toBeInTheDocument();
  });

  it('edits the target, platform and note of an item', async () => {
    const user = userEvent.setup();
    let latest: FollowupSpec[] = [];
    function Spy() {
      const [list, setList] = useState<FollowupSpec[]>([{ kind: 'regression', platform: 'web', note: '' }]);
      latest = list;
      return <FollowupEditor value={list} onChange={setList} targets={targets} />;
    }
    renderWith(<Spy />);
    await user.selectOptions(screen.getByLabelText('Platform'), 'both');
    await user.selectOptions(screen.getByLabelText('Run against (optional)'), U(1));
    await user.type(screen.getByLabelText('Note for whoever does it (optional)'), 'after the deploy');
    expect(latest[0]).toMatchObject({
      kind: 'regression',
      platform: 'both',
      targetId: U(1),
      note: 'after the deploy',
    });
    await user.selectOptions(screen.getByLabelText('Run against (optional)'), '');
    expect((latest[0] as { targetId?: string }).targetId).toBeUndefined();
  });

  it('the frozen view is read only and shows the live status and evidence', () => {
    const details: PhaseFollowupDto[] = [
      {
        id: U(20),
        position: 1,
        kind: 'deploy',
        label: 'Deploy to local',
        targetId: U(1),
        targetName: 'local',
        platform: null,
        instruction: '',
        note: '',
        status: 'succeeded',
        delegate: 'devops',
        brief: 'b',
        devopsRequests: [
          { id: U(30), workstationName: 'Desk', status: 'done', threadId: U(30), summary: 'ok' },
          { id: U(31), workstationName: 'Box', status: 'done', threadId: U(31), summary: 'ok' },
        ],
        regressionCards: [],
        resultSummary: 'deployed abc123 on Desk',
        evidence: {},
        startedAt: null,
        finishedAt: null,
      },
      {
        id: U(21),
        position: 2,
        kind: 'regression',
        label: 'Regression run (web)',
        targetId: null,
        targetName: null,
        platform: 'web',
        instruction: '',
        note: '',
        status: 'failed',
        delegate: 'tester',
        brief: 'b',
        devopsRequests: [],
        regressionCards: [{ id: U(40), ref: 'TOY-7', status: 'done' }],
        resultSummary: 'Regression run failed',
        evidence: { bugRefs: ['TOY-8'] },
        startedAt: null,
        finishedAt: null,
      },
    ];
    renderWith(<Harness initial={details.map(specOf)} readOnly details={details} />);
    expect(screen.queryByTestId('add-deploy')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove follow-up/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('followup-status-1')).toHaveTextContent('succeeded');
    expect(screen.getByTestId('followup-status-2')).toHaveTextContent('failed');
    expect(screen.getByTestId('followup-result-1')).toHaveTextContent('DevOps on Box: done');
    expect(screen.getByRole('link', { name: 'bug TOY-8' })).toHaveAttribute('href', '/cards/TOY-8');
    expect(screen.getByRole('link', { name: 'TOY-7' })).toBeInTheDocument();
    expect(screen.getByTestId('followup-1')).toHaveTextContent('Release to local');
  });
});

describe('phase helpers', () => {
  it('labels, links and the spec of a follow-up row', () => {
    expect(PHASE_STATUS_LABEL.awaiting_approval).toBe('Waiting for your approval');
    expect(phasePath('WEB-P12')).toBe('/p/WEB/phases/12');
  });
});

describe('board: the phase chip', () => {
  it('shows the phase ref on a card, marked when only proposed', () => {
    const base = {
      id: U(50),
      ref: 'TOY-5',
      title: 'A card',
      cardType: 'feature',
      stage: 'build',
      status: 'queued',
      assignee: null,
      updatedAt: new Date().toISOString(),
      queuedAt: null,
      riskTier: null,
      blocked: false,
      reworkRound: 0,
      priority: 2,
    } as const;
    renderWith(
      <ul>
        <CardTile card={{ ...base, phase: { id: U(60), ref: 'TOY-P2', assignment: 'confirmed' } }} />
        <CardTile
          card={{
            ...base,
            id: U(51),
            ref: 'TOY-6',
            phase: { id: U(60), ref: 'TOY-P2', assignment: 'proposed' },
          }}
        />
        <CardTile card={{ ...base, id: U(52), ref: 'TOY-7' }} />
      </ul>,
    );
    const chips = screen.getAllByTestId('phase-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('TOY-P2');
    expect(chips[1]).toHaveTextContent('TOY-P2 (proposed)');
  });
});

const phaseOpen = (over: Partial<NonNullable<React.ComponentProps<typeof CardPhase>['phase']>> = {}) => ({
  id: U(60),
  ref: 'TOY-P2',
  name: 'Autosave',
  status: 'open',
  assignment: 'confirmed' as const,
  ...over,
});
const phasesPayload = {
  phases: [
    {
      id: U(60),
      projectId: U(9),
      number: 2,
      ref: 'TOY-P2',
      name: 'Autosave',
      description: '',
      status: 'open',
      workingBranch: null,
      createdBy: { kind: 'user', name: 'Me' },
      memberCount: 1,
      resolvedCount: 0,
      proposedCount: 0,
      followups: [],
      createdAt: '2026-10-01T10:00:00.000Z',
      completedAt: null,
    },
    {
      id: U(61),
      projectId: U(9),
      number: 3,
      ref: 'TOY-P3',
      name: 'Later',
      description: '',
      status: 'open',
      workingBranch: null,
      createdBy: { kind: 'user', name: 'Me' },
      memberCount: 0,
      resolvedCount: 0,
      proposedCount: 0,
      followups: [],
      createdAt: '2026-10-01T10:00:00.000Z',
      completedAt: null,
    },
    {
      id: U(62),
      projectId: U(9),
      number: 1,
      ref: 'TOY-P1',
      name: 'Old',
      description: '',
      status: 'done',
      workingBranch: null,
      createdBy: { kind: 'user', name: 'Me' },
      memberCount: 1,
      resolvedCount: 1,
      proposedCount: 0,
      followups: [],
      createdAt: '2026-10-01T10:00:00.000Z',
      completedAt: null,
    },
  ],
};

describe('card page: the phase select', () => {
  it('lists the open phases, moves the card and takes it out', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/phases') ? json(phasesPayload) : json({}),
    );
    renderWith(<CardPhase cardId={U(50)} projectId={U(9)} phase={phaseOpen()} canSet status="queued" />);
    const select = await screen.findByTestId('card-phase-select');
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['No phase', 'TOY-P2 Autosave', 'TOY-P3 Later']),
    );
    expect(screen.getByTestId('card-phase-link')).toHaveAttribute('href', '/p/TOY/phases/2');
    await user.selectOptions(select, U(61));
    await waitFor(() => expect(calls()).toContain(`PUT /api/cards/${U(50)}/phase`));
    expect(bodyOf('PUT', '/phase')).toEqual({ phaseId: U(61) });
    await user.selectOptions(select, '');
    const puts = () =>
      fetchMock.mock.calls
        .filter(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')
        .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).toEqual({ phaseId: null });
  });

  it('is disabled with a reason for a closed card, a phase that no longer takes changes and a suite card', async () => {
    fetchMock.mockImplementation(async () => json(phasesPayload));
    const { unmount } = renderWith(
      <CardPhase cardId={U(50)} projectId={U(9)} phase={phaseOpen()} canSet status="done" />,
    );
    expect(await screen.findByTestId('card-phase-select')).toBeDisabled();
    expect(screen.getByTestId('card-phase-reason')).toHaveTextContent('closed');
    unmount();
    const b = renderWith(
      <CardPhase
        cardId={U(50)}
        projectId={U(9)}
        phase={phaseOpen({ status: 'awaiting_approval' })}
        canSet
        status="queued"
      />,
    );
    expect(await screen.findByTestId('card-phase-select')).toBeDisabled();
    expect(screen.getByTestId('card-phase-reason')).toHaveTextContent('awaiting approval');
    b.unmount();
    renderWith(<CardPhase cardId={U(50)} projectId={U(9)} phase={null} canSet={false} status="queued" />);
    expect(await screen.findByTestId('card-phase-select')).toBeDisabled();
    expect(screen.getByTestId('card-phase-reason')).toHaveTextContent('rides on');
  });

  it('marks a phase the BA only proposed', async () => {
    fetchMock.mockImplementation(async () => json(phasesPayload));
    renderWith(
      <CardPhase
        cardId={U(50)}
        projectId={U(9)}
        phase={phaseOpen({ assignment: 'proposed', status: 'proposed' })}
        canSet
        status="draft"
      />,
    );
    expect(await screen.findByTestId('card-phase-proposed')).toHaveTextContent('proposed');
  });
});

const block = (over: Partial<PhaseDeskBlock> = {}): PhaseDeskBlock => ({
  phaseId: U(60),
  ref: 'TOY-P2',
  name: 'Autosave',
  status: 'awaiting_approval',
  projectKey: 'TOY',
  members: [
    {
      cardId: U(50),
      ref: 'TOY-5',
      title: 'Autosave drafts',
      stage: 'done',
      status: 'done',
      assignment: 'confirmed',
      outcome: 'finalized',
      action: 'merge',
      resultRef: { mergeCommit: 'abcdef1234567' },
      merged: true,
      branchName: null,
      canConfirmMerge: false,
    },
  ],
  followups: [
    {
      id: U(20),
      position: 1,
      kind: 'deploy',
      label: 'Deploy to local',
      targetId: U(1),
      targetName: 'local',
      platform: null,
      instruction: '',
      note: '',
      status: 'pending',
      delegate: null,
      brief: null,
      devopsRequests: [],
      regressionCards: [],
      resultSummary: null,
      evidence: {},
      startedAt: null,
      finishedAt: null,
    },
    {
      id: U(21),
      position: 2,
      kind: 'regression',
      label: 'Regression run (web)',
      targetId: null,
      targetName: null,
      platform: 'web',
      instruction: '',
      note: '',
      status: 'pending',
      delegate: null,
      brief: null,
      devopsRequests: [],
      regressionCards: [],
      resultSummary: null,
      evidence: {},
      startedAt: null,
      finishedAt: null,
    },
  ],
  cardOutcomes: [],
  outstanding: [{ kind: 'suite_failed', text: 'The full E2E suite TOY-9 after TOY-5 failed' }],
  report: 'All good',
  resultsReport: null,
  canEditFollowups: true,
  ...over,
});
const deskItem = (over: Partial<DeskItemDto>): DeskItemDto => ({
  id: U(70),
  kind: 'approval',
  subkind: 'phase_done',
  status: 'open',
  routedTo: 'manager',
  title: 'TOY-P2 Autosave is done: approve 2 follow-ups?',
  body: 'All good',
  doing: '',
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: U(3), agentName: 'Ben', role: 'ba' },
  card: null,
  projectId: U(9),
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: null,
  canAnswer: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  phase: block(),
  ...over,
});

describe('PhaseDeskItem', () => {
  const setup = (item: DeskItemDto) => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/deploy-targets') ? json({ targets }) : json({}),
    );
    return renderWith(<PhaseDeskItem item={item} />);
  };

  it('phase done: shows the cards with their merge commits, what is outstanding and the follow-ups; approves all', async () => {
    const user = userEvent.setup();
    setup(deskItem({}));
    expect(screen.getByTestId('phase-link')).toHaveAttribute('href', '/p/TOY/phases/2');
    expect(screen.getByTestId('phase-cards')).toHaveTextContent('TOY-5 Autosave drafts');
    expect(screen.getByTestId('phase-cards')).toHaveTextContent('abcdef1234');
    expect(screen.getByTestId('phase-outstanding')).toHaveTextContent('TOY-9');
    expect(screen.getByTestId('followup-1')).toHaveTextContent('Release to local');
    expect(screen.getByTestId('phase-approve')).toHaveTextContent('Approve all 2');
    await user.click(screen.getByTestId('phase-approve'));
    await waitFor(() => expect(calls()).toContain(`POST /api/desk/${U(70)}/resolve`));
    expect(bodyOf('POST', '/resolve')).toEqual({ resolution: 'approved' });
  });

  it('rejects, and reopens with a reason', async () => {
    const user = userEvent.setup();
    setup(deskItem({}));
    await user.click(screen.getByTestId('phase-reject'));
    await waitFor(() => expect(bodyOf('POST', '/resolve')).toEqual({ resolution: 'rejected' }));
    await user.click(screen.getByTestId('phase-reopen'));
    const confirm = await screen.findByTestId('phase-reopen-confirm');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Why'), 'one more card');
    await user.click(confirm);
    await waitFor(() => expect(calls()).toContain(`POST /api/phases/${U(60)}/reopen`));
    expect(bodyOf('POST', '/reopen')).toEqual({ reason: 'one more card' });
  });

  it('edits the follow-ups in a dialog and saves them before approving is possible again', async () => {
    const user = userEvent.setup();
    setup(deskItem({}));
    await user.click(screen.getByTestId('phase-edit-followups'));
    const dialog = await screen.findByTestId('edit-followups-dialog');
    expect(screen.getByTestId('phase-approve')).toBeDisabled();
    expect(within(dialog).getByTestId('save-followups')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove follow-up 2' }));
    await user.click(within(dialog).getByTestId('save-followups'));
    await waitFor(() => expect(calls()).toContain(`PUT /api/phases/${U(60)}/followups`));
    expect(bodyOf('PUT', '/followups').followups).toHaveLength(1);
    expect(bodyOf('PUT', '/followups').followups[0]).toMatchObject({
      id: U(20),
      kind: 'deploy',
      targetId: U(1),
    });
    await waitFor(() => expect(screen.queryByTestId('edit-followups-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('phase-approve')).toBeEnabled();
  });

  it('a phase done with no follow-ups is an acknowledgement; a frozen phase cannot be edited', async () => {
    const user = userEvent.setup();
    setup(deskItem({ kind: 'alert', phase: block({ followups: [], canEditFollowups: false }) }));
    expect(screen.queryByTestId('phase-reject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phase-edit-followups')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('phase-approve'));
    await waitFor(() => expect(bodyOf('POST', '/resolve')).toEqual({ resolution: 'acknowledged' }));
  });

  it('proposal: confirm or reject', async () => {
    const user = userEvent.setup();
    setup(
      deskItem({ subkind: 'phase_proposal', title: 'Confirm phase', phase: block({ status: 'proposed' }) }),
    );
    await user.click(screen.getByTestId('phase-confirm'));
    await waitFor(() => expect(bodyOf('POST', '/resolve')).toEqual({ resolution: 'approved' }));
    expect(screen.getByRole('link', { name: 'Edit the phase first' })).toHaveAttribute(
      'href',
      '/p/TOY/phases/2',
    );
  });

  it('results: acknowledge', async () => {
    const user = userEvent.setup();
    setup(
      deskItem({
        kind: 'alert',
        subkind: 'phase_results',
        phase: block({ status: 'done_with_failures', canEditFollowups: false }),
      }),
    );
    await user.click(screen.getByTestId('phase-ack'));
    await waitFor(() => expect(bodyOf('POST', '/resolve')).toEqual({ resolution: 'acknowledged' }));
  });
});

describe('board: the phase filter', () => {
  it('offers all, no phase and each live phase; reports the choice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWith(<PhaseFilter phases={phasesPayload.phases as never} value="" onChange={onChange} />);
    const select = screen.getByTestId('phase-filter');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All phases', 'No phase', 'TOY-P2 Autosave', 'TOY-P3 Later', 'TOY-P1 Old']);
    await user.selectOptions(select, 'none');
    await user.selectOptions(select, U(60));
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['none', U(60)]);
  });

  it('is hidden when the project has no phases', () => {
    renderWith(<PhaseFilter phases={[]} value="" onChange={() => {}} />);
    expect(screen.queryByTestId('phase-filter')).not.toBeInTheDocument();
  });
});

describe('board response with phases', () => {
  it('carries the phase on a card', () => {
    const b: BoardResponse = {
      projectId: U(9),
      workflowKey: 'code',
      columns: [
        {
          name: 'Build',
          cards: [
            {
              id: U(50),
              ref: 'TOY-5',
              title: 'x',
              cardType: 'feature',
              stage: 'build',
              status: 'queued',
              assignee: null,
              updatedAt: '2026-10-01T10:00:00.000Z',
              queuedAt: null,
              riskTier: null,
              blocked: false,
              reworkRound: 0,
              priority: 2,
              phase: { id: U(60), ref: 'TOY-P2', assignment: 'confirmed' },
            },
          ],
        },
      ],
    };
    expect(b.columns[0]?.cards[0]?.phase?.ref).toBe('TOY-P2');
  });
});

describe('Phase page', () => {
  const detail = {
    ...phasesPayload.phases[0],
    status: 'open',
    members: [
      {
        cardId: U(50),
        ref: 'TOY-5',
        title: 'Merged card',
        stage: 'done',
        status: 'done',
        assignment: 'confirmed',
        outcome: 'finalized',
        action: 'merge',
        resultRef: { mergeCommit: 'abcdef1234567' },
        merged: true,
        branchName: null,
        canConfirmMerge: false,
      },
      {
        cardId: U(51),
        ref: 'TOY-6',
        title: 'PR card',
        stage: 'done',
        status: 'done',
        assignment: 'confirmed',
        outcome: 'waiting_merge',
        action: 'pr',
        resultRef: { prUrl: 'https://example.test/pr/1' },
        merged: false,
        branchName: 'aom/toy-6',
        canConfirmMerge: true,
      },
      {
        cardId: U(52),
        ref: 'TOY-7',
        title: 'Proposed card',
        stage: 'spec',
        status: 'draft',
        assignment: 'proposed',
        outcome: null,
        action: null,
        resultRef: null,
        merged: false,
        branchName: null,
        canConfirmMerge: false,
      },
    ],
    memberCount: 2,
    resolvedCount: 1,
    proposedCount: 1,
    followupDetails: [],
    cardOutcomes: [],
    report: null,
    outstanding: [],
    resultsReport: null,
    proposalDeskItemId: null,
    reportDeskItemId: null,
    resultsDeskItemId: null,
    threadId: U(60),
    approvedAt: null,
    finishedAt: null,
    canEditFollowups: true,
    canAssign: true,
    canReopen: false,
    tasks: [],
    projectKey: 'TOY',
  };

  it('lists the cards with their outcome, lets a member mark a waiting pull request merged and take a card out', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/phases/by-number/')) return json(detail);
      if (u.includes('/deploy-targets')) return json({ targets });
      if (u.includes('/board'))
        return json({
          projectId: U(9),
          workflowKey: 'code',
          columns: [
            {
              name: 'Build',
              cards: [
                {
                  id: U(70),
                  ref: 'TOY-8',
                  title: 'Free card',
                  cardType: 'feature',
                  stage: 'build',
                  status: 'queued',
                  assignee: null,
                  updatedAt: '2026-10-01T10:00:00.000Z',
                  queuedAt: null,
                  riskTier: null,
                  blocked: false,
                  reworkRound: 0,
                  priority: 2,
                  phase: null,
                },
                {
                  id: U(71),
                  ref: 'TOY-9',
                  title: 'Has a phase',
                  cardType: 'feature',
                  stage: 'build',
                  status: 'queued',
                  assignee: null,
                  updatedAt: '2026-10-01T10:00:00.000Z',
                  queuedAt: null,
                  riskTier: null,
                  blocked: false,
                  reworkRound: 0,
                  priority: 2,
                  phase: { id: U(61), ref: 'TOY-P3', assignment: 'confirmed' },
                },
              ],
            },
          ],
        });
      if (u.includes('/threads/'))
        return json({
          threadId: U(60),
          kind: 'phase',
          hasMore: false,
          messages: [
            {
              id: U(80),
              threadId: U(60),
              authorKind: 'system',
              authorUserId: null,
              authorAgentId: null,
              authorName: null,
              kind: 'system',
              body: 'Follow-up 1 of 2 started',
              data: {},
              createdAt: '2026-10-03T10:00:00.000Z',
            },
          ],
        });
      if (u.endsWith('/projects'))
        return json({
          projects: [
            {
              id: U(9),
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
              orgId: U(8),
            },
          ],
        });
      return json({});
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // this test covers the expert view (commit hashes, Mark merged); the plain view is tested in expert-mode.test.tsx
    qc.setQueryData(['me'], { user: { gitExpert: true } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/p/TOY/phases/2']}>
          <Routes>
            <Route path="/p/:projectKey/phases/:number" element={<Phase />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('TOY-P2 Autosave')).toBeInTheDocument();
    expect(screen.getByTestId('phase-status')).toHaveTextContent('Open');
    const merged = screen.getByTestId('member-TOY-5');
    expect(merged).toHaveTextContent('finalized');
    expect(merged).toHaveTextContent('abcdef1234');
    const pr = screen.getByTestId('member-TOY-6');
    expect(pr).toHaveTextContent('waiting to be merged');
    expect(screen.getByTestId('member-TOY-7')).toHaveTextContent('proposed');
    // the progress notes of the phase thread
    expect(await screen.findByTestId('phase-thread')).toHaveTextContent('Follow-up 1 of 2 started');

    await user.click(screen.getByTestId('confirm-merged-TOY-6'));
    await waitFor(() => expect(calls()).toContain(`POST /api/cards/${U(51)}/confirm-merged`));
    await user.click(screen.getByRole('button', { name: 'Take TOY-7 out of the phase' }));
    await waitFor(() => expect(calls()).toContain(`PUT /api/cards/${U(52)}/phase`));
    expect(bodyOf('PUT', `/cards/${U(52)}/phase`)).toEqual({ phaseId: null });

    // adding a card: only cards without a phase are offered
    const addSelect = await screen.findByLabelText('Add a card');
    await waitFor(() =>
      expect(
        within(addSelect)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Choose a card', 'TOY-8 Free card']),
    );
    await user.selectOptions(addSelect, U(70));
    await user.click(screen.getByTestId('add-card'));
    await waitFor(() => expect(calls()).toContain(`PUT /api/cards/${U(70)}/phase`));
    expect(bodyOf('PUT', `/cards/${U(70)}/phase`)).toEqual({ phaseId: U(60) });
  });
});
