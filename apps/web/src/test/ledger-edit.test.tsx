import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Ledger } from '../pages/Ledger.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID(20),
  scope: 'standing_order',
  projectId: null,
  projectKey: null,
  cardId: null,
  cardRef: null,
  title: 'Working Branch',
  body: 'Ask which branch to use.',
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
  canEdit: true,
  ...over,
});

let list: Array<ReturnType<typeof entry>>;
let patched: unknown[];
beforeEach(() => {
  patched = [];
  list = [
    entry(),
    entry({ id: ID(21), title: 'Read only rule', canEdit: false }),
    entry({ id: ID(22), scope: 'decision', title: 'Use pnpm', canEdit: false }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (url === '/api/projects') return json({ projects: [] });
      if (method === 'GET' && url.startsWith('/api/ledger/') && url.endsWith('/history'))
        return json({
          entry: list[0],
          versions: [
            {
              version: 2,
              title: 'Working Branch',
              body: 'Never ask which branch.',
              tags: [],
              savedAt: '2026-10-15T10:00:00.000Z',
              savedByName: 'Pieter',
              current: true,
            },
            {
              version: 1,
              title: 'Working Branch',
              body: 'Ask which branch to use.',
              tags: [],
              savedAt: '2026-10-13T10:00:00.000Z',
              savedByName: 'Pieter',
              current: false,
            },
          ],
        });
      if (method === 'PATCH' && url === `/api/ledger/${ID(20)}`) {
        const body = JSON.parse(String(init.body));
        patched.push(body);
        list = [
          entry({ ...body, version: 2, editedAt: '2026-10-15T10:00:00.000Z', editedByName: 'Pieter' }),
          ...list.slice(1),
        ];
        return json({ entry: list[0] });
      }
      if (url.startsWith('/api/ledger')) return json({ entries: list });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <Ledger />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('editing a standing order on the Ledger page', () => {
  it('shows Edit only on standing orders the person may manage', async () => {
    wrap();
    const rows = await screen.findAllByTestId('ledger-entry');
    expect(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Edit Working Branch' }),
    ).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(rows[2] as HTMLElement).queryByRole('button', { name: /^Edit/ })).toBeNull();
  });

  it('saves the new text, then shows it with an edited note and its history', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole('button', { name: 'Edit Working Branch' }));
    const form = await screen.findByRole('form', { name: 'Edit standing order' });
    const text = within(form).getByLabelText('Text');
    await user.clear(text);
    await user.type(text, 'Never ask which branch.');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(patched).toEqual([{ title: 'Working Branch', body: 'Never ask which branch.' }]),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit standing order' })).toBeNull());
    expect(await screen.findByText('Never ask which branch.')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-edited')).toHaveTextContent('edited');

    await user.click(screen.getByRole('button', { name: 'History of Working Branch' }));
    const hist = await screen.findByTestId('ledger-history');
    expect(hist).toHaveTextContent('Version 2 (current)');
    expect(hist).toHaveTextContent('Ask which branch to use.');
  });

  it('an unchanged form sends nothing', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole('button', { name: 'Edit Working Branch' }));
    const form = await screen.findByRole('form', { name: 'Edit standing order' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(patched).toEqual([]);
  });

  it('asks for text', async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole('button', { name: 'Edit Working Branch' }));
    const form = await screen.findByRole('form', { name: 'Edit standing order' });
    await user.clear(within(form).getByLabelText('Text'));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('A title and the text are required')).toBeInTheDocument();
    expect(patched).toEqual([]);
  });
});
