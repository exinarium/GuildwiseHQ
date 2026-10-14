import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agreementText } from '../lib/ceo.ts';
import { ceoStatus, renderCeoPage, stubApi } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('the CEO page: overview', () => {
  it('shows the CEO, its state, the spend and the training block with the scores', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-name')).toHaveTextContent('Cora');
    expect(screen.getByTestId('ceo-state')).toHaveTextContent('Active');
    expect(screen.getByTestId('ceo-spend-today')).toHaveTextContent('$1.20');
    expect(screen.getByTestId('ceo-spend-month')).toHaveTextContent('20% of the organization');
    expect(screen.getByTestId('ceo-training-left')).toHaveTextContent('Training period: 9 days left');
    expect(screen.getByTestId('ceo-training')).toHaveTextContent('only recommendations');
    expect(screen.getByTestId('ceo-score-total')).toHaveTextContent('agreed 18 of 23 recommendations');
    const rows = screen.getAllByTestId('ceo-score-row');
    expect(rows[0]).toHaveTextContent('Answer agent questions');
    expect(rows[0]).toHaveTextContent('12 of 15');
    expect(screen.queryByTestId('ceo-undo-hint')).toBeNull();
  });

  it('says training can be ended any time once the days are used up', async () => {
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus({ training: { ...ceoStatus().training, daysLeft: 0 } })],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-training-left')).toHaveTextContent('You can end it any time');
  });

  it('Graduate opens a dialog with the scores and what it unlocks, then posts graduate', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['POST /api/ceo/training', () => ({ training: {} })],
    ]);
    renderCeoPage();
    await userEvent.click(await screen.findByTestId('ceo-graduate'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ceo-graduate-dialog')).toHaveTextContent(agreementText(18, 23));
    expect(within(dialog).getByText(/Graduating unlocks the policy table/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ceo/training')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Graduate' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/training')?.body).toEqual({ action: 'graduate' }),
    );
  });

  it('extends training by 7 days', async () => {
    const calls = stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()]]);
    renderCeoPage();
    await userEvent.click(await screen.findByTestId('ceo-extend'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/training')?.body).toEqual({ action: 'extend' }),
    );
  });

  it('after graduation shows the date and the scores, and offers Restart training', async () => {
    const calls = stubApi('owner', [
      [
        'GET /api/ceo/status',
        () =>
          ceoStatus({
            training: {
              on: false,
              startedAt: '2026-10-01T00:00:00.000Z',
              until: '2026-10-15T00:00:00.000Z',
              graduatedAt: '2026-10-12T12:00:00.000Z',
              extensions: 0,
              daysLeft: 0,
            },
          }),
      ],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-graduated')).toHaveTextContent(/Graduated on .*2026/);
    expect(screen.getByTestId('ceo-scores')).toHaveTextContent('agreed 18 of 23');
    expect(screen.queryByTestId('ceo-graduate')).toBeNull();
    await userEvent.click(screen.getByTestId('ceo-restart-training'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/training')?.body).toEqual({ action: 'restart' }),
    );
  });

  it('an Admin can pause but not graduate, extend, restart or disable', async () => {
    const calls = stubApi('admin', [['GET /api/ceo/status', () => ceoStatus({ isOwner: false })]]);
    renderCeoPage();
    await screen.findByTestId('ceo-name');
    expect(screen.queryByTestId('ceo-graduate')).toBeNull();
    expect(screen.queryByTestId('ceo-extend')).toBeNull();
    expect(screen.queryByTestId('ceo-disable')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Tasks' })).toBeNull();
    await userEvent.click(screen.getByTestId('ceo-pause'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ceo/pause')).toBe(true));
  });

  it('disabling asks first', async () => {
    const calls = stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()]]);
    renderCeoPage();
    await userEvent.click(await screen.findByTestId('ceo-disable'));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.url === '/api/ceo/disable')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ceo/disable')).toBe(true));
  });

  it('hints at tightening the policy when more than a fifth of the decisions were undone', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus({ undone7d: { undone: 5, decided: 20 } })]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-undo-hint')).toHaveTextContent('tightening');
  });

  it('shows a paused and an offline CEO in words', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus({ state: 'paused' })]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-state')).toHaveTextContent('Paused');
    expect(screen.getByTestId('ceo-resume')).toBeInTheDocument();
  });
});

describe('the CEO page: appointing', () => {
  const none = () =>
    ceoStatus({ hired: false, state: 'none', agent: null, scores: [], totals: { agreed: 0, total: 0 } });

  it('explains the CEO and opens the form with ?appoint=1, listing only capable workstations', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', none],
      ['POST /api/ceo/appoint', () => ({ agentId: 'x' })],
    ]);
    renderCeoPage('?appoint=1');
    const form = await screen.findByRole('form', { name: 'Appoint CEO' });
    const select = within(form).getByLabelText('Home workstation');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pieter laptop', 'Studio PC']);
    await userEvent.selectOptions(select, 'Studio PC');
    await userEvent.type(within(form).getByLabelText('Name (optional)'), 'Cora');
    await userEvent.click(within(form).getByRole('button', { name: 'Appoint CEO' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/appoint')?.body).toEqual({
        workstationId: '0192f3a0-0000-7000-8000-000000000091',
        name: 'Cora',
      }),
    );
  });

  it('shows a button first when not asked to open it, and nothing to an Admin', async () => {
    stubApi('owner', [['GET /api/ceo/status', none]]);
    renderCeoPage();
    await userEvent.click(await screen.findByTestId('ceo-appoint-open'));
    expect(await screen.findByRole('form', { name: 'Appoint CEO' })).toBeInTheDocument();
  });

  it('tells an Admin that only the Owner can appoint', async () => {
    stubApi('admin', [['GET /api/ceo/status', none]]);
    renderCeoPage();
    expect(await screen.findByText('Only the Owner can appoint a CEO.')).toBeInTheDocument();
    expect(screen.queryByTestId('ceo-appoint-open')).toBeNull();
  });

  it('a Member has no page', async () => {
    stubApi('member', []);
    renderCeoPage();
    expect(await screen.findByText('The CEO page is for Owners and Admins')).toBeInTheDocument();
  });
});
