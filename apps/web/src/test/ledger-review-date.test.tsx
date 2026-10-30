import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerForm } from '../components/LedgerForm.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { formatCalendarDate } from '../lib/time.ts';
import { Ledger } from '../pages/Ledger.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID(30),
  scope: 'decision',
  projectId: null,
  projectKey: null,
  cardId: null,
  cardRef: null,
  title: 'Use pnpm',
  body: 'We use pnpm.',
  tags: [],
  sourceDeskItemId: null,
  vaultPath: null,
  createdByKind: 'user',
  createdByName: 'Pieter',
  supersededBy: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  version: 1,
  editedAt: null,
  editedByName: null,
  canEdit: false,
  canRetire: true,
  retiredAt: null,
  retiredReason: null,
  conflictsWith: [],
  reviewDate: null,
  reviewDue: false,
  reviewedAt: null,
  ...over,
});

let list: Array<ReturnType<typeof entry>>;
let calls: Array<{ method: string; url: string; body?: unknown }>;
let failWith: { status: number; code: string; message: string } | null;
beforeEach(() => {
  calls = [];
  failWith = null;
  list = [
    entry({ reviewDate: '2026-10-01', reviewDue: true }),
    entry({ id: ID(31), title: 'Later', reviewDate: '2027-02-03' }),
    entry({ id: ID(32), title: 'No date' }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (url === '/api/projects') return json({ projects: [] });
      if (method !== 'GET') {
        calls.push({ method, url, body: JSON.parse(String(init.body)) });
        if (failWith)
          return json({ error: { code: failWith.code, message: failWith.message } }, failWith.status);
        if (url.endsWith('/review')) {
          list = list.map((e) => (e.id === ID(30) ? entry({ reviewDate: null, reviewDue: false }) : e));
          return json({ entry: list[0] });
        }
        return json({ entry: list[0] }, 201);
      }
      calls.push({ method, url });
      if (url.includes('due=true')) return json({ entries: list.filter((e) => e.reviewDue) });
      return json({ entries: list });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapLedger = () =>
  render(
    <QueryClientProvider client={client()}>
      <ToastProvider>
        <MemoryRouter>
          <Ledger />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('review dates on the Ledger page', () => {
  it('marks a due entry, shows a future date without the marker, and nothing for an undated entry', async () => {
    wrapLedger();
    const rows = await screen.findAllByTestId('ledger-entry');
    expect(within(rows[0] as HTMLElement).getByTestId('ledger-review-due')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByTestId('ledger-review-date')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByTestId('ledger-review-date')).toHaveTextContent(
      formatCalendarDate('2027-02-03'),
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('ledger-review-due')).toBeNull();
    expect(within(rows[2] as HTMLElement).queryByTestId('ledger-review-date')).toBeNull();
  });

  it('the Due for review filter asks the server for due entries only', async () => {
    const user = userEvent.setup();
    wrapLedger();
    await screen.findAllByTestId('ledger-entry');
    await user.click(screen.getByRole('button', { name: 'Due for review' }));
    await waitFor(() => expect(screen.getAllByTestId('ledger-entry')).toHaveLength(1));
    expect(calls.some((c) => c.url.includes('due=true'))).toBe(true);
  });

  it('confirms a due entry with no new date', async () => {
    const user = userEvent.setup();
    wrapLedger();
    await user.click(await screen.findByRole('button', { name: 'Confirm Use pnpm' }));
    const form = await screen.findByRole('form', { name: 'Confirm review' });
    await user.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST')).toEqual([
        { method: 'POST', url: `/api/ledger/${ID(30)}/review`, body: { reviewDate: null } },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('ledger-review-due')).toBeNull());
  });

  it('confirm is offered only on a due entry', async () => {
    wrapLedger();
    await screen.findAllByTestId('ledger-entry');
    expect(screen.getAllByRole('button', { name: /^Confirm / })).toHaveLength(1);
  });

  it('changes and clears the review date through PATCH', async () => {
    const user = userEvent.setup();
    wrapLedger();
    await user.click(await screen.findByRole('button', { name: 'Review date of Later' }));
    const form = await screen.findByRole('form', { name: 'Review date' });
    await user.click(within(form).getByRole('button', { name: 'Remove review date' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
        { method: 'PATCH', url: `/api/ledger/${ID(31)}`, body: { reviewDate: null } },
      ]),
    );
  });

  it('shows a past-date rejection under the date field', async () => {
    const user = userEvent.setup();
    wrapLedger();
    failWith = {
      status: 400,
      code: 'review_date_past',
      message: 'the review date is in the past; pick today',
    };
    await user.click(await screen.findByRole('button', { name: 'Review date of No date' }));
    const form = await screen.findByRole('form', { name: 'Review date' });
    await user.type(within(form).getByLabelText('Review date'), '2020-01-01');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/review date is in the past/)).toBeInTheDocument();
  });
});

describe('review date in the add form', () => {
  const wrapForm = () =>
    render(
      <QueryClientProvider client={client()}>
        <ToastProvider>
          <MemoryRouter>
            <LedgerForm defaultKind="standing_order" />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

  it('sends the review date, and omits it when empty', async () => {
    const user = userEvent.setup();
    wrapForm();
    await user.type(screen.getByLabelText('Title'), 'Rule');
    await user.type(screen.getByLabelText('Text'), 'Do it.');
    await user.click(screen.getByRole('button', { name: 'Add to ledger' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('reviewDate');

    await user.type(screen.getByLabelText('Title'), 'Rule 2');
    await user.type(screen.getByLabelText('Text'), 'Do it again.');
    await user.type(screen.getByLabelText('Review date (optional)'), '2027-05-06');
    await user.click(screen.getByRole('button', { name: 'Add to ledger' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]?.body).toMatchObject({ reviewDate: '2027-05-06' });
  });

  it('shows review_date_past under the field', async () => {
    const user = userEvent.setup();
    wrapForm();
    failWith = {
      status: 400,
      code: 'review_date_past',
      message: 'the review date is in the past; pick today',
    };
    await user.type(screen.getByLabelText('Title'), 'Rule');
    await user.type(screen.getByLabelText('Text'), 'Do it.');
    await user.type(screen.getByLabelText('Review date (optional)'), '2020-01-01');
    await user.click(screen.getByRole('button', { name: 'Add to ledger' }));
    expect(await screen.findByText(/review date is in the past/)).toBeInTheDocument();
    expect(screen.getByLabelText('Review date (optional)')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('formatCalendarDate', () => {
  it('keeps the calendar day (no zone shift)', () => {
    expect(formatCalendarDate('2026-10-30')).toContain('30');
    expect(formatCalendarDate(null)).toBe('');
  });
});
