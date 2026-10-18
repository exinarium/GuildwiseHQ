import {
  type BoardCard,
  type BoardResponse,
  boardColumns,
  codeWorkflowV1,
  columnFor,
  getStage,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from '../components/BoardView.tsx';
import { Board } from '../pages/Board.tsx';
import { Projects } from '../pages/Projects.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ENTRY = '0192f3a0-0000-7000-8000-0000000000b1';
const ME = '0192f3a0-0000-7000-8000-0000000000c1';

/** A phone: nothing at 768px and up matches, the max-width query does. */
function phone() {
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*767/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

type Seed = Pick<BoardCard, 'stage' | 'status' | 'reworkRound' | 'title'> & Partial<BoardCard>;
function boardFrom(seeds: Seed[]): BoardResponse {
  const names = boardColumns(codeWorkflowV1);
  const columns = names.map((name) => ({ name, cards: [] as BoardCard[] }));
  seeds.forEach((s, i) => {
    const stage = getStage(codeWorkflowV1, s.stage) ?? codeWorkflowV1.stages[0];
    if (!stage) throw new Error('no stage');
    const col = columnFor(
      { status: s.status, stage: s.stage, reworkRound: s.reworkRound, cardType: s.cardType },
      stage,
    );
    columns
      .find((c) => c.name === col)
      ?.cards.push({
        id: `0192f3a0-0000-7000-8000-00000000010${i}`,
        ref: `TOY-${i + 1}`,
        cardType: 'feature',
        assignee: null,
        updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        queuedAt: null,
        riskTier: null,
        blocked: s.status === 'blocked',
        priority: 5,
        ...s,
      });
  });
  return { projectId: PROJECT, workflowKey: 'code', columns };
}

const SEEDS: Seed[] = [
  { title: 'Fresh work', stage: 'build', status: 'queued', reworkRound: 0 },
  { title: 'Stuck work', stage: 'build', status: 'blocked', reworkRound: 0 },
  { title: 'Another stuck', stage: 'build', status: 'blocked', reworkRound: 0 },
];

beforeEach(() => {
  phone();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const inCol = (name: string) => within(screen.getByRole('region', { name }));
const renderView = (board = boardFrom(SEEDS)) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BoardView board={board} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('the phone board is an accordion', () => {
  it('has one section per column with the card count and the blocked count in its header', () => {
    renderView();
    const names = boardColumns(codeWorkflowV1);
    for (const n of names) expect(screen.getByRole('region', { name: n })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Choose a column' })).toBeNull();
    const blocked = screen.getByRole('button', { name: /Blocked/ });
    expect(blocked).toHaveTextContent('2 blocked');
    expect(blocked).toHaveTextContent('2 cards');
  });

  it('opens the sections that need attention, closes the empty ones and the quiet ones', () => {
    renderView();
    expect(screen.getByRole('button', { name: /^Blocked/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^To do/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^Done/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Stuck work')).toBeVisible();
    expect(screen.getByText('Fresh work')).not.toBeVisible();
  });

  it('opens the first filled section when nothing needs attention', () => {
    renderView(boardFrom([SEEDS[0] as Seed]));
    expect(screen.getByRole('button', { name: /^To do/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles on tap and remembers it per project', async () => {
    const { unmount } = renderView();
    await userEvent.click(screen.getByRole('button', { name: /^To do/ }));
    expect(screen.getByText('Fresh work')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Blocked/ }));
    expect(screen.getByText('Stuck work')).not.toBeVisible();
    expect(JSON.parse(localStorage.getItem(`guildwise-board-accordion-${PROJECT}`) ?? '{}')).toMatchObject({
      'To do': true,
      Blocked: false,
    });
    unmount();
    renderView();
    expect(screen.getByRole('button', { name: /^To do/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Blocked/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('still renders when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderView();
    await userEvent.click(screen.getByRole('button', { name: /^To do/ }));
    expect(screen.getByText('Fresh work')).toBeVisible();
    vi.restoreAllMocks();
  });

  it('shows a card row with ref, title, chips and a link to the card', () => {
    renderView();
    const row = inCol('Blocked').getByTestId('card-tile-TOY-2');
    expect(row).toHaveAttribute('href', expect.stringContaining('/cards/'));
    expect(row).toHaveTextContent('TOY-2');
    expect(row).toHaveTextContent('Stuck work');
    expect(row).toHaveTextContent('Blocked');
  });
});

const dto = (role = 'owner') => ({
  id: PROJECT,
  orgId: ORG,
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
  myRole: role,
  cardCounts: { open: 3, blocked: 2 },
});

function stub(role: 'owner' | 'admin' | 'member') {
  const moves: Array<{ url: string; body: unknown }> = [];
  const board = boardFrom(SEEDS);
  const body = (url: string, init?: RequestInit): unknown => {
    if (init?.method === 'POST') {
      moves.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return {};
    }
    if (url.startsWith('/api/auth/me'))
      return {
        user: { id: ME, email: 'p@x.test', displayName: 'Pia', role: 'member' },
        orgs: [{ id: ORG, name: 'Org', status: 'active', role }],
        activeOrg: { id: ORG, name: 'Org', status: 'active', role },
      };
    if (url.startsWith('/api/workflows'))
      return { workflows: [{ id: ENTRY, orgId: null, status: 'active', definition: codeWorkflowV1 }] };
    if (url === '/api/projects') return { projects: [dto()] };
    if (url.startsWith('/api/board')) return board;
    return {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string, init?: RequestInit) =>
        new Response(JSON.stringify(body(url, init)), { status: 200 }),
    ),
  );
  return { moves };
}

function renderAt(path: string, route: string, el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={el} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const boardPage = () => renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);

describe('the phone board page', () => {
  it('shows a one-line stage strip of the filled stages and a New card button above the tab bar', async () => {
    stub('owner');
    boardPage();
    const strip = await screen.findByTestId('stage-strip');
    expect(within(strip).getByText('Blocked').closest('li')).toHaveTextContent('2');
    expect(within(strip).queryByText('Done')).toBeNull();
    expect(screen.getByTestId('new-card-fab')).toHaveClass('bottom-[calc(var(--app-bottom-inset,0px)+1rem)]');
  });

  it('puts search and a Filters button in one row; the chips live in a sheet and active ones can be removed', async () => {
    stub('owner');
    boardPage();
    await screen.findByTestId('stage-strip');
    expect(screen.getByRole('searchbox', { name: 'Search cards' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
    expect(screen.queryByTestId('filters-count')).toBeNull();
    await userEvent.click(screen.getByTestId('filters-open'));
    const sheet = await screen.findByTestId('filters-sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Blocked' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Rework' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('filters-sheet')).toBeNull());
    expect(screen.getByTestId('filters-count')).toHaveTextContent('2');
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Rework' }));
    expect(screen.getByTestId('filters-count')).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: 'Remove filter Rework' })).toBeNull();
  });

  it.each(['owner', 'admin'] as const)(
    'an %s finds Pause project in the project actions sheet',
    async (role) => {
      stub(role);
      boardPage();
      expect(screen.queryByTestId('pause-project-open')).toBeNull();
      await userEvent.click(await screen.findByTestId('project-actions-open'));
      const sheet = await screen.findByTestId('project-actions-sheet');
      expect(within(sheet).getByTestId('pause-project-open')).toBeInTheDocument();
      expect(within(sheet).getByRole('link', { name: /Archive/ })).toBeInTheDocument();
      expect(within(sheet).getByRole('link', { name: /Settings for TOY/ })).toBeInTheDocument();
    },
  );

  it('a Member does not get Pause project in the sheet', async () => {
    stub('member');
    boardPage();
    await userEvent.click(await screen.findByTestId('project-actions-open'));
    const sheet = await screen.findByTestId('project-actions-sheet');
    expect(within(sheet).queryByTestId('pause-project-open')).toBeNull();
    expect(within(sheet).getByRole('link', { name: /Archive/ })).toBeInTheDocument();
  });

  it('moves a card with Move to... through the same move call as the desktop dialog', async () => {
    const { moves } = stub('owner');
    boardPage();
    await userEvent.click(await screen.findByTestId('card-actions-TOY-2'));
    const sheet = await screen.findByTestId('move-to-sheet');
    const target = await within(sheet).findByTestId('move-to-review');
    await userEvent.click(target);
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'checked by hand');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move card' }));
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]).toEqual({
      url: '/api/cards/0192f3a0-0000-7000-8000-000000000101/move',
      body: { toStage: 'review', reason: 'checked by hand' },
    });
  });
});

describe('projects list on a phone', () => {
  it('shows the open and blocked counts on each project', async () => {
    stub('owner');
    renderAt('/projects', '/projects', <Projects />);
    const counts = await screen.findByTestId('project-counts-TOY');
    expect(counts).toHaveTextContent('3 open');
    expect(counts).toHaveTextContent('2 blocked');
  });
});
