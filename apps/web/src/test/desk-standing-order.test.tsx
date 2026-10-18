import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem } from '../pages/Desk.tsx';

// Owner report: HR standing-order proposals could not be dismissed (phone) and did not reach the ledger. The proposal
// offers Approve, Reject and Dismiss on both layouts, Dismiss closes it, and a refused approval says why.

const realMatchMedia = window.matchMedia;
function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile ? /max-width:\s*767/.test(query) : /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
});

const proposal = (over: Partial<DeskItemDto> = {}): DeskItemDto =>
  ({
    id: '0192f3a0-0000-7000-8000-000000000042',
    kind: 'approval',
    subkind: 'standing_order',
    status: 'open',
    routedTo: 'manager',
    title: 'Add a standing order: No or weak tests',
    body: 'Every change ships with a test that fails without it.',
    doing: null,
    options: [],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system' },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-10-03T10:00:00.000Z',
    ...over,
  }) as DeskItemDto;

function renderItem(i: DeskItemDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <DeskItem item={i} bare />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function stubApi(respond: (url: string, body: any) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const r = respond(url, body);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

describe.each([
  ['desktop', false],
  ['mobile', true],
])('a standing-order proposal on %s', (_name, mobile) => {
  beforeEach(() => setMobile(mobile));

  it('offers Approve, Reject and Dismiss, with the text editable', () => {
    renderItem(proposal());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByLabelText('Standing order (editable)')).toHaveValue(
      'Every change ships with a test that fails without it.',
    );
  });

  it('Dismiss asks, then closes the item without adding anything', async () => {
    const calls = stubApi(() => ({ status: 200, body: { ok: true } }));
    renderItem(proposal());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe('/api/desk/0192f3a0-0000-7000-8000-000000000042/dismiss');
  });

  it('Approve sends the edited wording', async () => {
    const calls = stubApi(() => ({ status: 200, body: { ok: true } }));
    renderItem(proposal());
    const user = userEvent.setup();
    const box = screen.getByLabelText('Standing order (editable)');
    await user.clear(box);
    await user.type(box, 'Tests first.');
    await user.click(screen.getByTestId('desk-approve'));
    if (mobile)
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: '/api/desk/0192f3a0-0000-7000-8000-000000000042/resolve',
      body: { resolution: 'approved', editedBody: 'Tests first.' },
    });
  });

  it('a refused approval (duplicate) is explained, with Merge and Dismiss to go on', async () => {
    const calls = stubApi((_url, body) =>
      body?.onDuplicate === 'merge'
        ? { status: 200, body: { ok: true } }
        : {
            status: 409,
            body: {
              error: {
                code: 'duplicate_order',
                message: 'a standing order that says the same already exists: "Tests first"',
              },
            },
          },
    );
    renderItem(proposal());
    const user = userEvent.setup();
    await user.click(screen.getByTestId('desk-approve'));
    if (mobile)
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    const box = await screen.findByTestId('desk-duplicate');
    expect(box).toHaveTextContent('already exists');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    await user.click(screen.getByTestId('desk-merge'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ resolution: 'approved', onDuplicate: 'merge' });
  });

  it('any other failure of Approve is shown too', async () => {
    stubApi(() => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'only the Owner can do this' } },
    }));
    renderItem(proposal());
    const user = userEvent.setup();
    await user.click(screen.getByTestId('desk-approve'));
    if (mobile)
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect((await screen.findAllByText(/only the Owner can do this/)).length).toBeGreaterThan(0);
  });
});

describe('a CEO recommendation', () => {
  beforeEach(() => setMobile(true));
  it('offers Do it, Not now and Dismiss on a phone', () => {
    renderItem(proposal({ subkind: 'ceo_recommendation', title: 'Hire a tester' }));
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});
