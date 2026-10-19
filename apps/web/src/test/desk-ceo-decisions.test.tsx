import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Desk } from '../pages/Desk.tsx';
import { deskItem, stubApi, U } from './ceo-fixtures.tsx';

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

const decision = (n: number, over: Partial<DeskItemDto> = {}): DeskItemDto =>
  deskItem({
    id: U(60 + n),
    kind: 'alert',
    subkind: 'ceo_decision',
    title: `CEO decision: Keep dev as the working branch (${n})?`,
    body: 'Keep main\n\nReason: the default.',
    blocking: false,
    pinned: false,
    urgent: false,
    card: { id: U(70), ref: 'P4-12', title: 'Intake', stage: 'build', status: 'queued', projectKey: 'P4' },
    ceoDecision: {
      question: `Keep dev as the working branch (${n})?`,
      decision: 'Keep main',
      reason: 'The ledger says main is the working branch',
      confidence: 0.9,
      ceoName: 'Johnny',
      class: 'desk.answer_question',
      source: 'act',
      questionItemId: U(80 + n),
      correction: null,
      acknowledgedAt: null,
    },
    ...over,
  });

const list = (items: DeskItemDto[], extra: Partial<{ open: number }> = {}) => ({
  items,
  counts: {
    open: items.filter((i) => i.subkind !== 'ceo_decision').length,
    blocking: 0,
    urgent: 0,
    ceoDecisions: items.filter((i) => i.subkind === 'ceo_decision').length,
    ...extra,
  },
});

function show(
  role: 'owner' | 'admin' | 'member',
  items: DeskItemDto[],
  more: Parameters<typeof stubApi>[1] = [],
) {
  const calls = stubApi(role, [
    ['GET /api/desk?', (c) => (c.url.includes('status=closed') ? list([]) : list(items))],
    ...more,
  ]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Desk />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the desk: CEO decisions', () => {
  it('lists them in their own section with the question, the decision, the reason and "CEO decision · name"', async () => {
    show('owner', [decision(1), decision(2), deskItem({ id: U(5), title: 'Tabs or spaces?' })]);
    const section = await screen.findByTestId('ceo-decisions');
    expect(within(section).getByRole('heading', { name: /CEO decisions/ })).toBeInTheDocument();
    const first = within(section).getByTestId(`desk-item-${U(61)}`);
    expect(within(first).getByTestId('ceo-decision-badge')).toHaveTextContent('CEO decision · Johnny');
    expect(within(first).getByTestId('ceo-decision-asked')).toHaveTextContent(
      'Keep dev as the working branch (1)?',
    );
    expect(within(first).getByTestId('ceo-decision-decided')).toHaveTextContent('Keep main');
    expect(within(first).getByTestId('ceo-decision-reason')).toHaveTextContent('main is the working branch');
    expect(within(first).getByTestId('item-card')).toHaveTextContent('P4-12');
    // the normal item is not mixed into the section, and the decisions are not counted as waiting
    expect(within(section).queryByText('Tabs or spaces?')).toBeNull();
    expect(screen.getByTestId('desk-counts')).toHaveTextContent('1 open');
  });

  it('shows an all clear when only CEO decisions are left, and they are not "waiting on you"', async () => {
    show('owner', [decision(1)]);
    expect(await screen.findByTestId('ceo-decisions')).toBeInTheDocument();
    expect(screen.queryByTestId('desk-empty')).toBeNull();
    expect(screen.getByTestId('desk-counts')).toHaveTextContent('0 open');
  });

  it('acknowledges one decision', async () => {
    const calls = show('owner', [decision(1)]);
    const item = await screen.findByTestId(`desk-item-${U(61)}`);
    await userEvent.click(await within(item).findByTestId('ceo-decision-ack'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/ceo-decision/acknowledge'))?.url).toBe(
        `/api/desk/${U(61)}/ceo-decision/acknowledge`,
      ),
    );
  });

  it('Acknowledge all marks them all read in one request', async () => {
    const calls = show(
      'owner',
      [decision(1), decision(2), decision(3)],
      [['POST /api/desk/ceo-decisions/acknowledge-all', () => ({ acknowledged: 3 })]],
    );
    await userEvent.click(await screen.findByTestId('ceo-decisions-ack-all'));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/desk/ceo-decisions/acknowledge-all')).toHaveLength(1),
    );
    expect(await screen.findByText('3 CEO decisions marked as read')).toBeInTheDocument();
  });

  it('Correct asks what the right decision is and posts it, with apply-now for the Owner', async () => {
    const calls = show(
      'owner',
      [decision(1)],
      [['POST /api/desk/', () => ({ item: decision(1), applied: 'The question is open again' })]],
    );
    const item = await screen.findByTestId(`desk-item-${U(61)}`);
    await userEvent.click(await within(item).findByTestId('ceo-decision-correct'));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByTestId('ceo-correct-submit');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('ceo-correct-text'), 'Use develop');
    await userEvent.click(within(dialog).getByTestId('ceo-correct-apply'));
    await userEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/ceo-decision/correct'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/ceo-decision/correct'))?.body).toEqual({
      correction: 'Use develop',
      applyNow: true,
    });
  });

  it('an Admin can correct but has no apply-now (only the Owner can undo)', async () => {
    show('admin', [decision(1)]);
    const item = await screen.findByTestId(`desk-item-${U(61)}`);
    await userEvent.click(await within(item).findByTestId('ceo-decision-correct'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('ceo-correct-apply')).toBeNull();
  });

  it('a plain member sees the decisions but no buttons', async () => {
    show('member', [decision(1)]);
    const item = await screen.findByTestId(`desk-item-${U(61)}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(within(item).queryByTestId('ceo-decision-ack')).toBeNull();
    expect(within(item).queryByTestId('ceo-decision-correct')).toBeNull();
    expect(screen.queryByTestId('ceo-decisions-ack-all')).toBeNull();
  });

  it('a corrected decision shows the lesson once the CEO recorded it', async () => {
    const corrected = decision(1, {
      status: 'answered',
      ceoDecision: {
        ...(decision(1).ceoDecision as NonNullable<DeskItemDto['ceoDecision']>),
        correction: {
          text: 'Use develop',
          at: '2026-10-19T10:00:00.000Z',
          applied: null,
          review: 'done',
          analysis: 'It missed that dev is personal.',
          lesson: 'Lesson (owner correction reviewed with the BA): never keep a personal branch.',
        },
      },
    });
    stubApi('owner', [
      ['GET /api/desk?', (c) => (c.url.includes('status=closed') ? list([corrected]) : list([]))],
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <Desk />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText(/Answered and closed/));
    expect(await screen.findByTestId('ceo-lesson')).toHaveTextContent(
      'Lesson recorded: never keep a personal branch.',
    );
  });

  it('works on a phone: a card per decision that opens full screen with the actions', async () => {
    setMobile(true);
    show('owner', [decision(1), decision(2)]);
    const card = await screen.findByTestId(`desk-card-${U(61)}`);
    expect(card).toHaveTextContent('CEO decision · Johnny');
    expect(await screen.findByTestId('ceo-decisions-ack-all')).toBeInTheDocument();
    await userEvent.click(card);
    const sheet = await screen.findByTestId('desk-sheet');
    expect(within(sheet).getByTestId('ceo-decision-decided')).toHaveTextContent('Keep main');
    expect(within(sheet).getByTestId('ceo-decision-ack')).toBeInTheDocument();
    expect(within(sheet).getByTestId('ceo-decision-correct')).toBeInTheDocument();
  });
  const corrected = (n: number, correction: Record<string, unknown>) =>
    decision(n, {
      status: 'answered',
      ceoDecision: {
        ...(decision(n).ceoDecision as NonNullable<DeskItemDto['ceoDecision']>),
        correction: {
          text: 'Use develop',
          at: '2026-10-19T10:00:00.000Z',
          applied: null,
          review: 'done',
          analysis: 'It missed that dev is personal.',
          lesson: 'Lesson (owner correction, discussed with the BA): never keep a personal branch.',
          consequences: 'Two cards were built on dev.',
          proposedCards: [
            {
              title: 'Move the cards to develop',
              project: 'P4',
              change: 'Re-point',
              acceptanceCriteria: ['A'],
            },
          ],
          ceoReply: {
            stance: 'agree',
            reflection: 'I trusted the intake default.',
            cardChanges: null,
            withoutCeo: false,
            at: '2026-10-19T10:30:00.000Z',
          },
          final: {
            summary: 'Created 1 fix card: P4-30.',
            cards: [{ cardId: U(90), ref: 'P4-30', title: 'Move the cards to develop', projectKey: 'P4' }],
            skipped: [],
            fallback: false,
            at: '2026-10-19T11:00:00.000Z',
          },
          ...correction,
        } as never,
      },
    });

  async function openClosed(item: DeskItemDto) {
    stubApi('owner', [
      ['GET /api/desk?', (c) => (c.url.includes('status=closed') ? list([item]) : list([]))],
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <Desk />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText(/Answered and closed/));
  }

  it('shows the whole discussion as a timeline with the fix cards and the final chip', async () => {
    await openClosed(corrected(1, {}));
    const tl = await screen.findByTestId('ceo-review-timeline');
    expect(screen.getByTestId('ceo-review-chip')).toHaveTextContent('Lesson recorded · 1 fix card');
    expect(within(tl).getByTestId('ceo-review-step-owner')).toHaveTextContent('Use develop');
    const ba = within(tl).getByTestId('ceo-review-step-ba');
    expect(ba).toHaveTextContent('It missed that dev is personal.');
    expect(within(ba).getByTestId('ceo-review-consequences')).toHaveTextContent(
      'Two cards were built on dev.',
    );
    expect(within(ba).getByTestId('ceo-review-proposed')).toHaveTextContent('Move the cards to develop');
    const ceo = within(tl).getByTestId('ceo-review-step-ceo');
    expect(within(ceo).getByTestId('ceo-review-stance')).toHaveTextContent('Agrees with your correction');
    expect(ceo).toHaveTextContent('I trusted the intake default.');
    expect(within(ceo).getByTestId('ceo-lesson')).toHaveTextContent(
      'Lesson recorded: never keep a personal branch.',
    );
    const fin = within(tl).getByTestId('ceo-review-step-final');
    expect(within(within(fin).getByTestId('ceo-review-cards')).getByRole('link')).toHaveAttribute(
      'href',
      '/cards/P4-30',
    );
  });

  it('a disagreeing CEO says so, and your correction stands', async () => {
    await openClosed(
      corrected(1, {
        ceoReply: {
          stance: 'disagree',
          reflection: 'The ledger said otherwise.',
          cardChanges: 'Drop the second card',
          withoutCeo: false,
          at: null,
        },
      }),
    );
    expect(await screen.findByTestId('ceo-review-stance')).toHaveTextContent(
      'Disagrees, your correction stands',
    );
    expect(screen.getByTestId('ceo-review-step-ceo')).toHaveTextContent('Drop the second card');
  });

  it('is "Under review" with waiting steps while the discussion runs, and says when no fix work is needed', async () => {
    await openClosed(
      corrected(1, {
        review: 'analysed',
        lesson: null,
        ceoReply: null,
        final: null,
        proposedCards: undefined,
        noFixReason: 'Nothing was built on it',
      }),
    );
    expect(await screen.findByTestId('ceo-review-chip')).toHaveTextContent('Under review');
    expect(screen.getByTestId('ceo-review-nofix')).toHaveTextContent('Nothing was built on it');
    expect(screen.getByTestId('ceo-review-step-ceo')).toHaveTextContent('Waiting for the CEO');
    expect(screen.queryByTestId('ceo-review-step-final')).toBeNull();
  });

  it('marks a lesson recorded without the CEO, and "no fix cards" in the chip', async () => {
    await openClosed(
      corrected(1, {
        proposedCards: undefined,
        ceoReply: { stance: null, reflection: null, cardChanges: null, withoutCeo: true, at: null },
        final: { summary: 'No fix cards were created.', cards: [], skipped: [], fallback: true, at: null },
        lesson: 'Lesson (owner correction, recorded without the CEO): use develop.',
      }),
    );
    expect(await screen.findByTestId('ceo-review-without')).toHaveTextContent('Recorded without the CEO');
    expect(screen.getByTestId('ceo-review-chip')).toHaveTextContent('Lesson recorded · no fix cards');
  });

  it('the timeline is also in the full-screen sheet on a phone', async () => {
    setMobile(true);
    show('owner', [{ ...corrected(1, { review: 'lesson', final: null }), status: 'open' }]);
    await userEvent.click(await screen.findByTestId(`desk-card-${U(61)}`));
    const sheet = await screen.findByTestId('desk-sheet');
    expect(within(sheet).getByTestId('ceo-review-chip')).toHaveTextContent('Under review');
    expect(within(sheet).getByTestId('ceo-review-step-ceo')).toHaveTextContent(
      'I trusted the intake default.',
    );
    expect(within(sheet).getByTestId('ceo-review-step-final')).toHaveTextContent('The BA is finalising');
  });
});
