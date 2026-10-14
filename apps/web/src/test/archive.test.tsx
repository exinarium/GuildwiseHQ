import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Archive } from '../pages/Archive.tsx';
import { Board } from '../pages/Board.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const CARD = (n: number) => `0192f3a0-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

const project = {
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
  myRole: 'owner',
};

const card = (n: number, over: Record<string, unknown> = {}) => ({
  id: CARD(n),
  ref: `TOY-${n}`,
  title: `Card ${n}`,
  cardType: 'feature',
  status: 'done',
  externalRef: null,
  priority: 5,
  finishedAt: '2026-10-10T10:00:00.000Z',
  completionAction: 'merge',
  lastAgent: 'Ada',
  ...over,
});

function stub() {
  const archiveUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      let body: unknown = {};
      if (url.startsWith('/api/archive')) {
        archiveUrls.push(url);
        const q = new URL(url, 'http://x').searchParams;
        const all = [card(1, { externalRef: 'ABC-1' }), card(2, { status: 'cancelled' })];
        const text = q.get('q')?.toLowerCase();
        const list = all.filter(
          (c) => !text || `${c.ref} ${c.title} ${c.externalRef}`.toLowerCase().includes(text),
        );
        body = { projectId: PROJECT, afterHours: 24, total: list.length, page: 1, pageSize: 25, cards: list };
      } else if (url === '/api/projects') body = { projects: [project] };
      else if (url.startsWith('/api/agents')) body = { agents: [] };
      else if (url.startsWith('/api/board')) body = { projectId: PROJECT, workflowKey: 'code', columns: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return archiveUrls;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:projectKey/archive" element={<Archive />} />
          <Route path="/p/:projectKey/board" element={<Board />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('the archive (#51)', () => {
  it('lists finished cards with links to their pages and searches', async () => {
    const urls = stub();
    const user = renderAt('/p/TOY/archive');
    const first = await screen.findByRole('link', { name: 'TOY-1' });
    expect(first).toHaveAttribute('href', '/cards/TOY-1');
    expect(screen.getByRole('link', { name: 'TOY-2' })).toBeInTheDocument();
    expect(screen.getByText('ABC-1')).toBeInTheDocument();
    expect(screen.getByTestId('archive-count')).toHaveTextContent('2 cards');
    await user.type(screen.getByLabelText('Search'), 'abc-1');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'TOY-2' })).toBeNull());
    expect(urls.some((u) => u.includes('q=abc-1'))).toBe(true);
    expect(screen.getByRole('link', { name: 'TOY-1' })).toBeInTheDocument();
  });

  it('sends the status filter', async () => {
    const urls = stub();
    const user = renderAt('/p/TOY/archive');
    await screen.findByRole('link', { name: 'TOY-1' });
    await user.selectOptions(screen.getByLabelText('Status'), 'cancelled');
    await waitFor(() => expect(urls.some((u) => u.includes('status=cancelled'))).toBe(true));
  });

  it('is reachable from the board', async () => {
    stub();
    renderAt('/p/TOY/board');
    expect(await screen.findByRole('link', { name: 'Archive' })).toHaveAttribute('href', '/p/TOY/archive');
  });
});
