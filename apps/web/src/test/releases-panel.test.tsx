import type { ReleaseRow, SocialPost } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleasesPanel } from '../components/blog/ReleasesPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ext } from '../extension/index.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const post = (over: Partial<SocialPost> = {}): SocialPost => ({
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'release',
  ref: '1.1.0',
  status: 'in_review',
  title: 'Guildwise HQ 1.1.0: a thing',
  content: {
    version: '1.1.0',
    releasedOn: '2026-10-27',
    title: 'Guildwise HQ 1.1.0: a thing',
    summary: 'Guildwise HQ 1.1.0 is out. A thing you will like a lot, honestly.',
    coverKey: 'release',
    captions: { xText: 'Hello X', hashtags: { x: ['GuildwiseHQ'] } },
  },
  rejectionReason: null,
  origin: 'Blog writer',
  reviewSince: '2026-10-27T10:00:00.000Z',
  approvedAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  shares: [],
  ...over,
});
const release = (version: string, p: SocialPost | null): ReleaseRow => ({
  version,
  date: '2026-10-27',
  intro: '',
  sections: { added: ['A thing'], changed: [], fixed: [] },
  whatsNew: [],
  post: p,
});

let calls: Array<{ url: string; method: string; body?: string }> = [];
let releases: ReleaseRow[] = [];

beforeEach(() => {
  calls = [];
  releases = [release('1.2.0', null), release('1.1.0', post())];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.startsWith('/api/platform/social/releases'))
        return json({ releases, pending: releases.filter((r) => r.post?.status === 'in_review').length });
      if (url === '/api/platform/social/posts' && init?.method === 'POST')
        return json(post({ ref: '1.2.0', status: 'draft' }), 201);
      if (url.endsWith('/approve')) return json(post({ status: 'approved' }));
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete ext.ReleaseDrafter;
});

describe('Releases panel', () => {
  it('lists each release with its post status and the number waiting', async () => {
    wrap(<ReleasesPanel />);
    const panel = await screen.findByTestId('releases-panel');
    expect(within(screen.getByTestId('release-1.2.0')).getByText('No post yet')).toBeTruthy();
    expect(within(screen.getByTestId('release-1.1.0')).getByText('In review')).toBeTruthy();
    expect(panel.textContent).toContain('1 waiting for your approval');
  });

  it('offers "Draft release post" (write by hand) when no drafter is plugged in, and starts a draft', async () => {
    wrap(<ReleasesPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('release-write-1.2.0'));
    expect(screen.getByTestId('release-write-1.2.0').textContent).toBe('Draft release post');
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/platform/social/posts')).toBe(true),
    );
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({
      kind: 'release',
      ref: '1.2.0',
    });
  });

  it('renders the extension\'s ReleaseDrafter slot next to "Write by hand" when present', async () => {
    ext.ReleaseDrafter = ({ version }) => (
      <button type="button" data-testid="drafter">{`AI draft ${version}`}</button>
    );
    wrap(<ReleasesPanel />);
    expect((await screen.findByTestId('drafter')).textContent).toBe('AI draft 1.2.0');
    expect(screen.getByTestId('release-write-1.2.0').textContent).toBe('Write by hand');
    expect(within(screen.getByTestId('release-1.1.0')).queryByTestId('drafter')).toBeNull();
  });

  it('reviews a post with the captions editor and approves it', async () => {
    wrap(<ReleasesPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('release-open-1.1.0'));
    const editor = screen.getByTestId('release-post-1.1.0');
    expect(within(editor).getByTestId('preview-x').textContent).toBe(
      'Hello X #GuildwiseHQ https://example.com/abc',
    );
    await user.click(within(editor).getByTestId('release-approve'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true));
  });
});
