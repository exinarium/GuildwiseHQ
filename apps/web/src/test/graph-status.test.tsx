import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphStatusPanel } from '../components/GraphStatusPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const repo = (over: Record<string, unknown> = {}) => ({
  repoId: '0192f3a0-0000-7000-8000-0000000000a1',
  repoName: 'web',
  status: 'indexed',
  commit: 'abcdef0123456789',
  files: 10,
  nodes: 1234,
  edges: 5678,
  modules: 4,
  indexerVersion: '0.1.32',
  durationMs: 900,
  indexedAt: '2026-10-19T10:00:00.000Z',
  failReason: null,
  ...over,
});

let status: Record<string, unknown>;
let posts: string[];
beforeEach(() => {
  posts = [];
  status = { enabled: true, vault: { storage: 'local', kind: 'project' }, repos: [repo()] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/projects/p1/graph') return json(status);
      if (url === '/api/projects/p1/graph/index' && init.method === 'POST') {
        posts.push(url);
        return json({ queued: 1 }, 202);
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = (canChange = true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <GraphStatusPanel projectId="p1" canChange={canChange} />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('GraphStatusPanel (status only, nothing derived from code)', () => {
  it('shows the counts and the indexed commit, and says the code stays on the workstation', async () => {
    mount();
    expect(await screen.findByText('indexed')).toBeTruthy();
    expect(screen.getByText(/1,234 nodes, 5,678 links, 4 modules/)).toBeTruthy();
    expect(screen.getByText('abcdef01')).toBeTruthy();
    expect(screen.getByText(/Nothing from your code is sent to Guildwise HQ/)).toBeTruthy();
    expect(screen.getByText(/back it up yourself/)).toBeTruthy();
  });

  it('the owner can index again; a member only sees the status', async () => {
    mount(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Index again' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('a member has no button', async () => {
    mount(false);
    await screen.findByText('indexed');
    expect(screen.queryByRole('button', { name: 'Index again' })).toBeNull();
  });

  it('a failure shows a sentence for its fixed code', async () => {
    status = {
      enabled: true,
      vault: null,
      repos: [repo({ status: 'failed', failReason: 'no_clone', commit: null })],
    };
    mount();
    expect(await screen.findByText('could not index')).toBeTruthy();
    expect(screen.getByText(/holds a clone of this repository/)).toBeTruthy();
  });

  it('is not there when project graphs are switched off', async () => {
    status = { enabled: false, vault: null, repos: [] };
    const { container } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});
