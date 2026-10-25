import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backlog } from '../pages/Backlog.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ITEM = (n: number) => `0192f3a0-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;

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

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: ITEM(n),
  projectId: PROJECT,
  projectKey: 'TOY',
  title: `Item ${n}`,
  description: '',
  priority: 'normal',
  tags: [],
  flagged: false,
  status: 'open',
  source: { kind: 'owner' },
  cardRef: null,
  cardId: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  ...over,
});

interface Calls {
  lists: string[];
  posts: Array<{ url: string; body: unknown }>;
  patches: Array<{ url: string; body: unknown }>;
}

function stub(opts: { role?: string; items?: unknown[]; sendResults?: unknown[] } = {}): Calls {
  const calls: Calls = { lists: [], posts: [], patches: [] };
  const items = opts.items ?? [item(1), item(2, { title: 'Starred', flagged: true })];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const json = init?.body ? JSON.parse(String(init.body)) : undefined;
      let body: unknown = {};
      if (url === '/api/auth/me')
        body = {
          user: { id: 'u1' },
          activeOrg: { id: ORG, role: opts.role ?? 'owner', features: {} },
          orgs: [],
        };
      else if (url === '/api/projects') body = { projects: [project] };
      else if (url.startsWith(`/api/projects/${PROJECT}/backlog`) && method === 'GET') {
        calls.lists.push(url);
        body = { items, tags: ['ui'] };
      } else if (url.startsWith(`/api/projects/${PROJECT}/backlog`) && method === 'POST') {
        calls.posts.push({ url, body: json });
        body = { item: item(9, { title: json.title }) };
      } else if (method === 'PATCH') {
        calls.patches.push({ url, body: json });
        body = { item: item(1) };
      } else if (url === '/api/backlog/send') {
        calls.posts.push({ url, body: json });
        body = { results: opts.sendResults ?? [] };
      } else if (method === 'POST') {
        calls.posts.push({ url, body: json });
        body = { item: item(1), result: { itemId: ITEM(1), title: 'Item 1', ok: true, cardRef: 'TOY-5' } };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/TOY/backlog']}>
        <Routes>
          <Route path="/p/:projectKey/backlog" element={<Backlog />} />
          <Route path="/p/:projectKey/board" element={<div>board page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('the project backlog', () => {
  it('lists the items and shows the Board and Backlog tabs', async () => {
    stub();
    renderPage();
    expect(await screen.findByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Starred')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Backlog' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Board' })).toBeInTheDocument();
  });

  it('asks for Open items only by default', async () => {
    const calls = stub();
    renderPage();
    await screen.findByText('Item 1');
    expect(calls.lists[0]).toContain('status=open');
    expect(calls.lists[0]).toContain('sort=priority');
  });

  it('quick add: Enter creates the item with just a title; a blank title does nothing', async () => {
    const calls = stub();
    const user = renderPage();
    const input = await screen.findByLabelText('Add to the backlog');
    await user.type(input, '   {Enter}');
    expect(calls.posts).toHaveLength(0);
    await user.type(input, 'Dark mode{Enter}');
    await waitFor(() => expect(calls.posts).toHaveLength(1));
    expect(calls.posts[0]?.body).toEqual({ title: 'Dark mode' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('quick add also works with the Add button (touch)', async () => {
    const calls = stub();
    const user = renderPage();
    const add = await screen.findByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Add to the backlog'), 'Offline mode');
    await user.click(add);
    await waitFor(() => expect(calls.posts[0]?.body).toEqual({ title: 'Offline mode' }));
  });

  it('the star calls PATCH with the flag', async () => {
    const calls = stub();
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Flag Item 1' }));
    await waitFor(() => expect(calls.patches).toHaveLength(1));
    expect(calls.patches[0]).toEqual({ url: `/api/backlog/${ITEM(1)}`, body: { flagged: true } });
  });

  it('filters and search go to the server as the query', async () => {
    const calls = stub();
    const user = renderPage();
    await screen.findByText('Item 1');
    await user.click(screen.getByRole('button', { name: 'Flagged' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(screen.getByLabelText('Search the backlog'), 'dark');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.selectOptions(screen.getByLabelText('Sort'), 'created');
    await waitFor(() => {
      const last = calls.lists.at(-1) ?? '';
      expect(last).toContain('flagged=true');
      expect(last).toContain('status=open%2Cdone');
      expect(last).toContain('q=dark');
      expect(last).toContain('priority=high');
      expect(last).toContain('sort=created');
    });
  });

  it('a Done row links to the card it became', async () => {
    stub({ items: [item(3, { status: 'done', cardRef: 'TOY-7', cardId: ITEM(70) })] });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Became TOY-7' });
    expect(link).toHaveAttribute('href', '/cards/TOY-7');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows an agent suggestion with its agent and card', async () => {
    stub({
      items: [
        item(4, {
          source: { kind: 'agent', agentId: ITEM(80), agentName: 'Ada', cardRef: 'TOY-3' },
        }),
      ],
    });
    renderPage();
    const src = await screen.findByTestId('backlog-source');
    expect(src).toHaveTextContent('Ada on TOY-3');
    expect(screen.getByRole('link', { name: 'TOY-3' })).toHaveAttribute('href', '/cards/TOY-3');
  });

  it('bulk send: reports the failed items and leaves them selected', async () => {
    const calls = stub({
      sendResults: [
        { itemId: ITEM(1), title: 'Item 1', ok: true, cardRef: 'TOY-5' },
        { itemId: ITEM(2), title: 'Starred', ok: false, error: 'The project is archived' },
      ],
    });
    const user = renderPage();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Item 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Starred' }));
    await user.click(screen.getByRole('button', { name: 'Send 2 to the BA' }));
    await waitFor(() => expect(calls.posts.some((p) => p.url === '/api/backlog/send')).toBe(true));
    expect(calls.posts.find((p) => p.url === '/api/backlog/send')?.body).toEqual({
      itemIds: [ITEM(1), ITEM(2)],
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 could not be sent');
    expect(alert).toHaveTextContent('Starred: The project is archived');
    expect(screen.getByRole('checkbox', { name: 'Select Starred' })).toBeChecked();
  });

  it('is read-only for a member who cannot manage the organization', async () => {
    stub({ role: 'member' });
    renderPage();
    await screen.findByText('Item 1');
    expect(screen.queryByLabelText('Add to the backlog')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Flag Item 1' })).toBeNull();
  });
});
