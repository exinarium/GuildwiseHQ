import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ceoStatus, renderCeoPage, stubApi } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('the CEO page: overview', () => {
  it('shows the CEO, its state and the spend, and no training block, appoint or disable', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-name')).toHaveTextContent('Cora');
    expect(screen.getByTestId('ceo-state')).toHaveTextContent('Active');
    expect(screen.getByTestId('ceo-spend-today')).toHaveTextContent('$1.20');
    expect(screen.getByTestId('ceo-spend-month')).toHaveTextContent('20% of the organization');
    expect(screen.queryByTestId('ceo-training')).toBeNull();
    expect(screen.queryByTestId('ceo-graduate')).toBeNull();
    expect(screen.queryByTestId('ceo-disable')).toBeNull();
    expect(screen.queryByText(/appoint/i)).toBeNull();
    expect(screen.queryByTestId('ceo-undo-hint')).toBeNull();
    expect(screen.queryByTestId('ceo-pair-workstation')).toBeNull();
  });

  it('always shows the CEO tabs, and asks the Owner to pair a workstation when the CEO has none', async () => {
    stubApi('owner', [
      [
        'GET /api/ceo/status',
        () =>
          ceoStatus({
            state: 'offline',
            offlineReason: 'the CEO has no workstation',
            agent: { ...ceoStatus().agent!, workstationId: null, workstationName: null },
          }),
      ],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-pair-workstation')).toHaveTextContent(
      'Add a workstation to talk to Cora',
    );
    expect(screen.getByRole('tab', { name: 'Authority' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Workstations' })).toBeInTheDocument();
    expect(screen.getByTestId('ceo-pause')).toBeInTheDocument();
  });

  it('tells an Admin that the Owner adds the workstation', async () => {
    stubApi('admin', [
      [
        'GET /api/ceo/status',
        () =>
          ceoStatus({
            isOwner: false,
            state: 'offline',
            agent: { ...ceoStatus().agent!, workstationId: null, workstationName: null },
          }),
      ],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-pair-workstation')).toHaveTextContent(
      'the Owner adds a workstation',
    );
  });

  it('an Admin can pause the CEO (the emergency stop) and nothing else', async () => {
    const calls = stubApi('admin', [['GET /api/ceo/status', () => ceoStatus({ isOwner: false })]]);
    renderCeoPage();
    await screen.findByTestId('ceo-name');
    expect(screen.queryByRole('tab', { name: 'Tasks' })).toBeNull();
    await userEvent.click(screen.getByTestId('ceo-pause'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ceo/pause')).toBe(true));
  });

  it('hints at tightening the policy when more than a fifth of the decisions were undone', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus({ undone7d: { undone: 5, decided: 20 } })]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-undo-hint')).toHaveTextContent('tightening');
  });

  it('says why an active CEO with wakes waiting starts no shift', async () => {
    stubApi('owner', [
      [
        'GET /api/ceo/status',
        () =>
          ceoStatus({
            pendingWakes: 48,
            waiting: {
              text: 'waiting: hourly limit reached (12 of 12 shifts in the last hour), next shift at 23:57 UTC',
              until: '2026-10-15T23:57:30.000Z',
            },
          }),
      ],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-waiting')).toHaveTextContent('48 wakes pending');
    expect(screen.getByTestId('ceo-waiting')).toHaveTextContent('hourly limit reached (12 of 12');
  });

  it('shows why the CEO could not run its last shifts', async () => {
    stubApi('owner', [
      [
        'GET /api/ceo/status',
        () =>
          ceoStatus({
            lastError: {
              at: '2026-10-15T19:58:00.000Z',
              outcome: 'rejected',
              message: 'busy: 4 shifts already running',
              failures: 21,
            },
          }),
      ],
    ]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-last-error')).toHaveTextContent('busy: 4 shifts already running');
    expect(screen.getByTestId('ceo-last-error')).toHaveTextContent('21 shifts');
  });

  it('shows a paused and an offline CEO in words', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus({ state: 'paused' })]]);
    renderCeoPage();
    expect(await screen.findByTestId('ceo-state')).toHaveTextContent('Paused');
    expect(screen.getByTestId('ceo-resume')).toBeInTheDocument();
  });
});

describe('the CEO page: members', () => {
  it('a Member has no page', async () => {
    stubApi('member', []);
    renderCeoPage();
    expect(await screen.findByText('The CEO page is for Owners and Admins')).toBeInTheDocument();
  });
});
