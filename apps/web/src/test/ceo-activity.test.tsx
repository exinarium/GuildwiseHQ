import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { action, ceoStatus, Fail, renderCeoPage, stubApi, U } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

const rows = () => screen.getAllByTestId('ceo-action');

describe('the CEO activity log', () => {
  it('lists the actions with class, outcome in words, subject, reason, confidence, policy version and response', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      [
        'GET /api/ceo/actions',
        () => ({
          actions: [
            action(1),
            action(2, {
              mode: 'recommended',
              status: 'recommended',
              response: 'accepted_changed',
              responseNote: 'use spaces',
              undo: { available: false, kind: null, label: null, reason: null },
            }),
            action(3, {
              mode: 'refused',
              status: 'refused',
              undo: { available: false, kind: null, label: null, reason: 'nothing was done' },
            }),
          ],
          next: null,
        }),
      ],
    ]);
    renderCeoPage('?tab=activity');
    await screen.findAllByTestId('ceo-action');
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toHaveTextContent('Release or re-queue a card');
    expect(rows()[0]).toHaveTextContent('Decided');
    expect(rows()[0]).toHaveTextContent('TOY-1');
    expect(rows()[0]).toHaveTextContent('reason 1');
    expect(rows()[0]).toHaveTextContent('90%');
    expect(rows()[0]).toHaveTextContent('v3');
    expect(rows()[0]).toHaveTextContent('1 cited');
    expect(rows()[1]).toHaveTextContent('Recommended');
    expect(rows()[1]).toHaveTextContent('You accepted it with a change: use spaces');
    expect(rows()[2]).toHaveTextContent('Refused');
    expect(within(rows()[2] as HTMLElement).getByTestId('ceo-undo-reason')).toHaveTextContent(
      'nothing was done',
    );
    // only the first one can be undone
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('undoes after a confirmation and shows what the server says happened', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/actions', () => ({ actions: [action(1)], next: null })],
      ['POST /api/ceo/actions/', () => ({ kind: 'inverse', message: 'TOY-1 is back in the queue' })],
    ]);
    renderCeoPage('?tab=activity');
    await userEvent.click(await screen.findByTestId(`undo-${U(41)}`));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Release TOY-1');
    expect(calls.some((c) => c.url.endsWith('/undo'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByTestId(`undo-result-${U(41)}`)).toHaveTextContent('TOY-1 is back in the queue');
    expect(calls.find((c) => c.url.endsWith('/undo'))?.url).toBe(`/api/ceo/actions/${U(41)}/undo`);
  });

  it('shows the server message on a 409 and keeps the dialog open', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/actions', () => ({ actions: [action(1)], next: null })],
      ['POST /api/ceo/actions/', () => new Fail(409, 'The card has moved on since: it cannot be undone')],
    ]);
    renderCeoPage('?tab=activity');
    await userEvent.click(await screen.findByTestId(`undo-${U(41)}`));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(await within(dialog).findByTestId('undo-error')).toHaveTextContent(
      'The card has moved on since: it cannot be undone',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows undone actions as undone, and no Undo button to an Admin', async () => {
    stubApi('admin', [
      ['GET /api/ceo/status', () => ceoStatus({ isOwner: false })],
      [
        'GET /api/ceo/actions',
        () => ({
          actions: [action(1), action(2, { status: 'undone', undoneAt: '2026-10-13T12:00:00.000Z' })],
          next: null,
        }),
      ],
    ]);
    renderCeoPage('?tab=activity');
    await screen.findAllByTestId('ceo-action');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(rows()[1]).toHaveTextContent('Undone');
    expect(screen.getByText('Only the Owner can undo an action.')).toBeInTheDocument();
  });

  it('filters by outcome, class and subject through the query string', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/actions', () => ({ actions: [action(1)], next: null })],
    ]);
    renderCeoPage('?tab=activity');
    await screen.findAllByTestId('ceo-action');
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'recommended');
    await waitFor(() => expect(calls.some((c) => c.url.includes('mode=recommended'))).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText('Kind of action'), 'Cancel a card');
    await waitFor(() => expect(calls.some((c) => c.url.includes('class=card.cancel'))).toBe(true));
    await userEvent.type(screen.getByLabelText('Subject'), 'TOY-9');
    await waitFor(() => expect(calls.some((c) => c.url.includes('subject=TOY-9'))).toBe(true));
    // the CSV export carries the same filters
    expect(screen.getByTestId('ceo-csv').getAttribute('href')).toContain('/api/ceo/actions/export.csv');
    expect(screen.getByTestId('ceo-csv').getAttribute('href')).toContain('subject=TOY-9');
  });

  it('loads older actions with the next cursor as before', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      [
        'GET /api/ceo/actions',
        (c) =>
          c.url.includes('before=cursor-1')
            ? { actions: [action(2)], next: null }
            : { actions: [action(1)], next: 'cursor-1' },
      ],
    ]);
    renderCeoPage('?tab=activity');
    await userEvent.click(await screen.findByTestId('ceo-actions-more'));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(calls.some((c) => c.url.includes('before=cursor-1'))).toBe(true);
    expect(screen.queryByTestId('ceo-actions-more')).toBeNull();
  });

  it('says when nothing matches', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['GET /api/ceo/actions', () => ({ actions: [], next: null })],
    ]);
    renderCeoPage('?tab=activity');
    expect(await screen.findByTestId('ceo-actions-empty')).toBeInTheDocument();
  });
});
