import type { BoardResponse, CardDetailResponse, DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from '../components/BoardView.tsx';
import { EvidencePanel, TestingLinks } from '../components/EvidencePanel.tsx';
import { FinalizePanel } from '../components/FinalizePanel.tsx';
import { RegressionDialog } from '../components/RegressionDialog.tsx';
import { DeskItem } from '../pages/Desk.tsx';

type Testing = NonNullable<CardDetailResponse['testing']>;
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactNode, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubFetch(body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('board waiting state', () => {
  it('shows the waiting badge, bug link and suite badge', () => {
    const base = {
      assignee: null,
      updatedAt: new Date().toISOString(),
      queuedAt: null,
      riskTier: null,
      blocked: false,
      reworkRound: 0,
      priority: 5,
      cardType: 'feature' as const,
      stage: 'test',
    };
    const board: BoardResponse = {
      projectId: ID(1),
      workflowKey: 'code',
      columns: [
        {
          name: 'Test (waiting on bug)',
          cards: [
            {
              ...base,
              id: ID(2),
              ref: 'TOY-2',
              title: 'Greeting',
              status: 'waiting',
              waitingOn: { id: ID(3), ref: 'TOY-3' },
            },
            { ...base, id: ID(4), ref: 'TOY-4', title: 'Suite', status: 'queued', origin: 'regression' },
          ],
        },
      ],
    };
    wrap(<BoardView board={board} />);
    expect(screen.getByTestId('waiting-badge').textContent).toBe('waiting on bug');
    expect(screen.getByTestId('waiting-on-link-TOY-3').getAttribute('href')).toBe('/cards/TOY-3');
    expect(screen.getByTestId('suite-badge').textContent).toBe('regression');
  });
});

const testing = (over: Partial<Testing> = {}): Testing => ({
  testRuns: [],
  parent: null,
  children: [],
  waitingOn: null,
  parkedOn: null,
  finalize: {
    available: true,
    action: 'merge',
    requiresApproval: false,
    state: 'idle',
    deskItemId: null,
    lastError: null,
  },
  suiteKind: null,
  ...over,
});

describe('evidence panel', () => {
  it('lists runs with result, commands and output', () => {
    const t = testing({
      testRuns: [
        {
          id: ID(9),
          cardId: ID(2),
          shiftId: null,
          kind: 'feature',
          platform: 'web',
          result: 'failed',
          evidence: { commands: ['pnpm e2e'], summary: 'Login broken', outputExcerpt: 'Error: boom' },
          createdAt: '2026-10-03T10:00:00.000Z',
        },
      ],
      parent: { id: ID(5), ref: 'TOY-5', title: 'P', cardType: 'feature', stage: 'x', status: 'done' },
      children: [{ id: ID(3), ref: 'TOY-3', title: 'Bug', cardType: 'bug', stage: 'spec', status: 'draft' }],
      parkedOn: { requestId: ID(8), problem: 'docker_missing' },
    });
    wrap(
      <>
        <TestingLinks testing={t} status="waiting" />
        <EvidencePanel testing={t} handoffs={[]} />
      </>,
    );
    const panel = screen.getByTestId('evidence-panel');
    expect(panel.textContent).toContain('failed');
    expect(panel.textContent).toContain('Login broken');
    expect(panel.textContent).toContain('pnpm e2e');
    expect(panel.querySelector('pre')?.textContent).toBe('Error: boom');
    expect(screen.getByTestId('child-card-link-TOY-3')).toBeTruthy();
    expect(screen.getByTestId('parent-card-link').getAttribute('href')).toBe('/cards/TOY-5');
    expect(screen.getByTestId('waiting-line')).toBeTruthy();
    expect(screen.getByTestId('parked-notice').textContent).toContain('docker missing');
  });
});

describe('finalize panel', () => {
  const panel = (finalize: Testing['finalize']) =>
    wrap(<FinalizePanel cardId={ID(2)} finalize={finalize} completionAction="pr" canAct />);

  it('posts the chosen action and notes that a large merge needs approval', async () => {
    const fetchFn = stubFetch({
      cardId: ID(2),
      ref: 'TOY-2',
      state: 'running',
      action: 'merge',
      deskItemId: null,
    });
    panel(testing({ finalize: { ...testing().finalize, requiresApproval: true } }).finalize);
    expect(screen.getByTestId('finalize-approval-note').textContent).toContain('needs your approval');
    await userEvent.click(screen.getByTestId('finalize-button'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/cards/${ID(2)}/finalize`);
    expect(JSON.parse(String(init.body))).toEqual({ action: 'merge' });
  });

  it('shows running and failed states', () => {
    const { unmount } = panel({ ...testing().finalize, available: false, state: 'running' });
    expect(screen.getByTestId('finalize-state').textContent).toContain('running');
    expect(screen.queryByTestId('finalize-button')).toBeNull();
    unmount();
    panel({ ...testing().finalize, state: 'failed', lastError: 'push rejected' });
    expect(screen.getByTestId('finalize-state').textContent).toContain('push rejected');
  });
});

describe('regression dialog', () => {
  it('posts the platform and lists created cards', async () => {
    const fetchFn = stubFetch({ cards: [{ id: ID(7), ref: 'TOY-7', platform: 'mobile' }] });
    wrap(<RegressionDialog projectId={ID(1)} />);
    await userEvent.click(screen.getByTestId('regression-open'));
    await userEvent.selectOptions(screen.getByTestId('regression-platform'), 'mobile');
    await userEvent.click(screen.getByTestId('regression-run'));
    await screen.findByText('TOY-7');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/projects/${ID(1)}/regression`);
    expect(JSON.parse(String(init.body))).toEqual({ platform: 'mobile' });
  });
});

describe('desk tester bottleneck', () => {
  const alert = {
    id: ID(20),
    kind: 'alert',
    subkind: 'tester_bottleneck',
    status: 'open',
    routedTo: 'manager',
    title: 'Testing is the bottleneck',
    body: '',
    doing: null,
    options: [],
    recommendation: null,
    blocking: false,
    pinned: true,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system', agentId: null, agentName: null, role: null },
    card: null,
    projectId: ID(1),
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-10-03T10:00:00.000Z',
  } as unknown as DeskItemDto;

  function Where() {
    const l = useLocation();
    return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
  }

  it('navigates to the agents page with the hire form prefilled', async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<DeskItem item={alert} />} />
            <Route path="/agents" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId('hire-tester'));
    expect(screen.getByTestId('where').textContent).toBe(`/agents?hire=tester&projectId=${ID(1)}`);
  });

  it('labels a large merge approval', () => {
    wrap(<DeskItem item={{ ...alert, kind: 'approval', subkind: 'large_merge' }} />);
    expect(screen.getByRole('button', { name: 'Approve merge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});
