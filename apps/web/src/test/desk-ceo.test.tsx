import type { DeskItemDto } from '@aom/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeskItem } from '../pages/Desk.tsx';
import { ceoStatus, deskItem, stubApi, U, wrap } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const show = (i: DeskItemDto) => wrap(<DeskItem item={i} now={NOW} />);
const ceoStatusRoute: [string, () => unknown] = ['GET /api/ceo/status', () => ceoStatus()];

const answered = deskItem({
  status: 'answered',
  answer: 'spaces',
  ceo: {
    actionId: U(41),
    agentName: 'Cora',
    reason: 'the ledger says spaces',
    confidence: 0.82,
    undoable: true,
    recommendation: null,
  },
});

describe('the desk: items the CEO answered', () => {
  it('says who answered, why and how sure, with an Undo for the Owner that posts and refreshes', async () => {
    const calls = stubApi('owner', [
      ceoStatusRoute,
      ['POST /api/ceo/actions/', () => ({ kind: 'inverse', message: 'The item is open again' })],
    ]);
    show(answered);
    const line = await screen.findByTestId('ceo-answered');
    expect(line).toHaveTextContent('Answered by Cora: the ledger says spaces (confidence 82%)');
    await userEvent.click(await within(line).findByRole('button', { name: 'Undo' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/undo'))?.url).toBe(`/api/ceo/actions/${U(41)}/undo`),
    );
    expect(await screen.findByText('The item is open again')).toBeInTheDocument();
  });

  it('has no Undo for someone who is not the Owner, or when it can no longer be undone', async () => {
    stubApi('admin', [ceoStatusRoute]);
    show(answered);
    const line = await screen.findByTestId('ceo-answered');
    await new Promise((r) => setTimeout(r, 30));
    expect(within(line).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows nothing for an item the CEO did not touch', () => {
    stubApi('owner', [ceoStatusRoute]);
    show(deskItem());
    expect(screen.queryByTestId('ceo-answered')).toBeNull();
    expect(screen.queryByTestId('ceo-recommendation')).toBeNull();
  });
});

const recommended = deskItem({
  ceo: {
    actionId: null,
    agentName: 'Cora',
    reason: null,
    confidence: null,
    undoable: false,
    recommendation: {
      actionId: U(42),
      option: 'o2',
      text: null,
      reason: 'the ledger prefers spaces',
      confidence: 0.7,
    },
  },
});

describe('the desk: a recommendation of the CEO', () => {
  it('shows what it recommends and why, preselects the option and accepts it in one click', async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    show(recommended);
    const block = await screen.findByTestId('ceo-recommendation');
    expect(block).toHaveTextContent('Cora recommends: spaces');
    expect(block).toHaveTextContent('the ledger prefers spaces');
    expect(block).toHaveTextContent('Confidence 70%');
    expect(screen.getByRole('radio', { name: /spaces/ })).toBeChecked();
    await userEvent.click(within(block).getByRole('button', { name: 'Accept recommendation' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/desk/${U(50)}/answer`)?.body).toEqual({
        answer: 'spaces',
        optionId: 'o2',
        ledger: { scope: 'decision' },
      }),
    );
  });

  it('can be overridden: choosing another option answers with that one', async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    show(recommended);
    await userEvent.click(await screen.findByRole('radio', { name: /tabs/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toMatchObject({ optionId: 'o1' }),
    );
  });

  it('offers a free-text recommendation too', async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    const r = recommended.ceo?.recommendation;
    show(
      deskItem({
        options: [],
        ceo: {
          ...(recommended.ceo as NonNullable<DeskItemDto['ceo']>),
          recommendation: { ...(r as NonNullable<typeof r>), option: null, text: 'Use the staging branch' },
        },
      }),
    );
    const block = await screen.findByTestId('ceo-recommendation');
    expect(block).toHaveTextContent('Cora recommends: Use the staging branch');
    await userEvent.click(within(block).getByRole('button', { name: 'Accept recommendation' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toEqual({
        answer: 'Use the staging branch',
        ledger: { scope: 'decision' },
      }),
    );
  });

  it("labels the approval of a CEO recommendation 'Do it' and 'Not now'", async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    show(
      deskItem({
        kind: 'approval',
        subkind: 'ceo_recommendation',
        title: 'Hire a second tester',
        options: [],
        ceo: recommended.ceo as NonNullable<DeskItemDto['ceo']>,
      }),
    );
    expect(await screen.findByTestId('desk-kind')).toHaveTextContent('CEO recommendation');
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/resolve'))?.body).toEqual({ resolution: 'approved' }),
    );
  });
});

describe('the desk: Remember this for the CEO', () => {
  it('sends remember: true when the Owner ticks it', async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    show(deskItem());
    await userEvent.click(await screen.findByTestId('ceo-remember'));
    await userEvent.click(screen.getByRole('radio', { name: /spaces/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/answer'))?.body).toEqual({
        answer: 'spaces',
        optionId: 'o2',
        ledger: { scope: 'decision' },
        remember: true,
      }),
    );
  });

  it('does not send remember when it is not ticked', async () => {
    const calls = stubApi('owner', [ceoStatusRoute]);
    show(deskItem());
    await screen.findByTestId('ceo-remember');
    await userEvent.click(screen.getByRole('radio', { name: /spaces/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/answer'))).toBeDefined());
    expect(calls.find((c) => c.url.endsWith('/answer'))?.body).not.toHaveProperty('remember');
  });

  it('is only there for the Owner, and not when the organization has no CEO', async () => {
    stubApi('admin', [ceoStatusRoute]);
    show(deskItem());
    await screen.findByRole('form', { name: 'Answer' });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('ceo-remember')).toBeNull();
  });

  it('is hidden when the organization has no CEO', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus({ hired: false, state: 'none', agent: null })],
    ]);
    show(deskItem());
    await screen.findByRole('form', { name: 'Answer' });
    await waitFor(() => expect(screen.queryByTestId('ceo-remember')).toBeNull());
  });
});

describe('the desk: the CEO daily report', () => {
  const report = deskItem({
    kind: 'alert',
    subkind: 'ceo_report',
    title: 'Daily report from Cora',
    body: 'Two cards moved. One hire is recommended.',
    options: [],
    chatThreadId: U(80),
    ceoReport: {
      fallback: false,
      scores: [{ class: 'card.release', agreed: 6, total: 8 }],
      actions: [
        {
          id: U(41),
          class: 'card.release',
          mode: 'decided',
          status: 'done',
          subject: 'TOY-1',
          undoable: true,
        },
        {
          id: U(42),
          class: 'card.cancel',
          mode: 'recommended',
          status: 'recommended',
          subject: 'TOY-2',
          undoable: false,
        },
        {
          id: U(43),
          class: 'card.release',
          mode: 'decided',
          status: 'undone',
          subject: 'TOY-3',
          undoable: false,
        },
      ],
    },
  });

  it('shows the body, the last 24 hours with Undo for decided ones, the training scores and the chat link', async () => {
    const calls = stubApi('owner', [
      ceoStatusRoute,
      ['POST /api/ceo/actions/', () => ({ kind: 'inverse', message: 'TOY-1 is back in the queue' })],
    ]);
    show(report);
    expect(screen.getByText('Two cards moved. One hire is recommended.')).toBeInTheDocument();
    expect(screen.getByTestId('desk-kind')).toHaveTextContent('CEO report');
    const block = screen.getByTestId('ceo-report');
    expect(within(block).getByTestId('ceo-report-scores')).toHaveTextContent('agreed 6 of 8');
    const rows = within(block).getAllByTestId('ceo-report-action');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Release or re-queue a card: TOY-1');
    expect(rows[2]).toHaveTextContent('Undone');
    expect(screen.getByTestId('ba-chat-link')).toHaveTextContent('Discuss this with your CEO');
    expect(screen.getByTestId('ba-chat-link')).toHaveAttribute('href', `/chat/${U(80)}`);
    const undo = await within(rows[0] as HTMLElement).findByRole('button', { name: 'Undo' });
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    await userEvent.click(undo);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ceo/actions/${U(41)}/undo`)).toBe(true));
  });

  it('treats a CEO notice as an ordinary heads-up', () => {
    stubApi('owner', [ceoStatusRoute]);
    show(deskItem({ kind: 'alert', subkind: 'ceo_notice', title: 'Budget at 80%', options: [] }));
    expect(screen.getByTestId('desk-kind')).toHaveTextContent('CEO notice');
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.queryByTestId('ceo-report')).toBeNull();
  });
});
