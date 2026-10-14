import type { BatchDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntakeNew } from '../pages/Intake.tsx';
import { BatchView, countsText } from '../pages/IntakeBatch.tsx';
import { initSocket } from '../ws/socket.ts';

const ID = '0192f3a0-0000-7000-8000-0000000000b1';
const U = (n: number) => `0192f3a0-0000-7000-8000-00000000${String(n).padStart(4, '0')}`;
const counts = (over: Partial<BatchDto['counts']> = {}): BatchDto['counts'] => ({
  queued: 0,
  reading: 0,
  waiting: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  cancelled: 0,
  ...over,
});
const item = (n: number, over: Partial<BatchDto['items'][number]> = {}): BatchDto['items'][number] => ({
  id: U(100 + n),
  position: n,
  externalSystem: 'jira',
  externalKey: `ABC-${n}`,
  url: null,
  status: 'queued',
  reason: null,
  summary: null,
  cards: [],
  deskItemId: null,
  question: null,
  intakeId: null,
  threadId: null,
  attempts: 0,
  ...over,
});
const batch = (over: Partial<BatchDto> = {}): BatchDto => ({
  id: ID,
  status: 'running',
  projectKey: null,
  note: null,
  createdById: U(1),
  createdByName: 'Olive',
  total: 4,
  counts: counts({ done: 1, waiting: 1, failed: 1, skipped: 1 }),
  createdAt: '2026-10-14T10:00:00.000Z',
  cancelledAt: null,
  items: [
    item(1, {
      status: 'done',
      cards: [{ ref: 'TOY-7', title: 'Fix login', projectKey: 'TOY' }],
      summary: 'one card',
    }),
    item(2, { status: 'waiting', question: 'Web or API?', deskItemId: U(500) }),
    item(3, { status: 'failed', reason: 'no access' }),
    item(4, { status: 'skipped', reason: 'skipped: already TOY-3' }),
  ],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const sock = initSocket(new QueryClient());
  sock.enableMockTransport();
  sock.start();
});

function stub(handlers: Record<string, (init: RequestInit) => unknown>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers).find((k) => `${method} ${url}`.startsWith(k));
      const body = key ? handlers[key]?.(init) : {};
      return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
    }),
  );
  return calls;
}

const mount = (path: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/intake" element={<IntakeNew />} />
          <Route path="/intake/batches/:id" element={<BatchView />} />
          <Route path="/desk" element={<p>the desk</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const summary = (b: BatchDto) => {
  const { items: _items, ...rest } = b;
  return rest;
};

describe('batch form', () => {
  it('shows what it understood and posts the keys with the project and the note', async () => {
    const calls = stub({
      'GET /api/intake/batches/': () => ({ batch: batch() }),
      'GET /api/intake/batches': () => ({ batches: [] }),
      'GET /api/intakes': () => ({ intakes: [] }),
      'GET /api/projects': () => ({ projects: [{ id: U(9), key: 'TOY', name: 'Toy' }] }),
      'POST /api/intake/batches': () => ({ batch: batch() }),
    });
    const user = userEvent.setup();
    mount('/intake');
    await user.click(screen.getByRole('tab', { name: 'Batch' }));
    const start = screen.getByRole('button', { name: 'Start batch' });
    expect(start).toBeDisabled();
    await user.type(
      screen.getByLabelText(/Tickets, one per line/),
      'abc-1\nABC-2\nABC-1\nhttps://acme.atlassian.net/browse/ABC-3',
    );
    expect(screen.getByTestId('batch-summary')).toHaveTextContent('3 ticket(s), 1 repeated line(s) ignored');
    await user.type(screen.getByLabelText(/Note for all tickets/), 'Q4 release');
    await user.selectOptions(await screen.findByLabelText(/Project \(optional\)/), U(9));
    await user.click(start);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      tickets: ['ABC-1', 'ABC-2', 'ABC-3'],
      projectId: U(9),
      note: 'Q4 release',
    });
    expect(await screen.findByRole('heading', { name: 'Batch intake' })).toBeInTheDocument();
  });

  it('refuses lines that are no ticket', async () => {
    stub({ 'GET /api/intake/batches': () => ({ batches: [] }), 'GET /api/intakes': () => ({ intakes: [] }) });
    const user = userEvent.setup();
    mount('/intake');
    await user.click(screen.getByRole('tab', { name: 'Batch' }));
    await user.type(screen.getByLabelText(/Tickets, one per line/), 'ABC-1\nplease fix the login');
    expect(screen.getByRole('alert')).toHaveTextContent('Not a ticket: please fix the login');
    expect(screen.getByRole('button', { name: 'Start batch' })).toBeDisabled();
  });
});

describe('batch list', () => {
  it('lists earlier batches with their counts', async () => {
    stub({
      'GET /api/intake/batches': () => ({ batches: [summary(batch())] }),
      'GET /api/intakes': () => ({ intakes: [] }),
    });
    mount('/intake');
    const list = await screen.findByTestId('batch-list');
    expect(within(list).getByText('4 ticket(s)')).toBeInTheDocument();
    expect(list).toHaveTextContent('1 waiting, 1 done, 1 skipped, 1 failed');
    expect(countsText(counts())).toBe('');
  });
});

describe('batch detail', () => {
  it('shows each item with its cards, the question linked to the desk and Retry for failures', async () => {
    const calls = stub({
      'GET /api/intake/batches/': () => ({ batch: batch() }),
      'POST /api/intake/batches/': () => ({ batch: batch() }),
    });
    const user = userEvent.setup();
    mount(`/intake/batches/${ID}`);
    const first = await screen.findByTestId('batch-item-ABC-1');
    expect(within(first).getByText('Done')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: /TOY-7 Fix login/ })).toHaveAttribute(
      'href',
      '/cards/TOY-7',
    );
    const waiting = screen.getByTestId('batch-item-ABC-2');
    expect(waiting).toHaveTextContent('Web or API?');
    expect(within(waiting).getByRole('link', { name: 'Answer on the desk' })).toHaveAttribute(
      'href',
      `/desk#desk-item-${U(500)}`,
    );
    expect(screen.getByTestId('batch-item-ABC-4')).toHaveTextContent('skipped: already TOY-3');
    expect(screen.getByRole('status')).toHaveTextContent('1 ticket(s) wait for your answer on the desk');

    await user.click(within(screen.getByTestId('batch-item-ABC-3')).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/items/${U(103)}/retry`))).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel batch' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cancel'))).toBe(true),
    );
  });

  it('offers no Cancel once the batch is over', async () => {
    stub({
      'GET /api/intake/batches/': () => ({
        batch: batch({ status: 'cancelled', counts: counts({ cancelled: 4 }) }),
      }),
    });
    mount(`/intake/batches/${ID}`);
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('Cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel batch' })).toBeNull();
  });
});
