import { clonePolicy, DEFAULT_CEO_POLICY } from '@aom/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ceoStatus, renderCeoPage, stubApi } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

type PutBody = { policy: typeof DEFAULT_CEO_POLICY; confirmDelegation?: boolean };
const putBody = (calls: Array<{ method: string; url: string; body: unknown }>): PutBody | undefined =>
  calls.find((c) => c.method === 'PUT' && c.url === '/api/ceo/policy')?.body as PutBody | undefined;

const policyRoute = (canEdit = true): [string, () => unknown] => [
  'GET /api/ceo/policy',
  () => ({ policy: clonePolicy(DEFAULT_CEO_POLICY), defaults: DEFAULT_CEO_POLICY, canEdit }),
];

describe('the CEO authority tab', () => {
  it('shows a decide / recommend / never radio per class, with the current mode checked', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()], policyRoute()]);
    renderCeoPage('?tab=authority');
    const row = await screen.findByTestId('ceo-class-desk.answer_question');
    expect(within(row).getByRole('radio', { name: 'Answer agent questions: Decide' })).toBeChecked();
    expect(within(row).getByRole('radio', { name: 'Answer agent questions: Recommend' })).not.toBeChecked();
    expect(within(row).getByRole('radio', { name: 'Answer agent questions: Never' })).not.toBeChecked();
    const cancel = screen.getByTestId('ceo-class-card.cancel');
    expect(within(cancel).getByRole('radio', { name: 'Cancel a card: Recommend' })).toBeChecked();
    // hard-never matters are not listed at all
    expect(screen.queryByText(/billing/i)).toBeNull();
  });

  it('marks the staffing rows as always a recommendation while the CEO is in training', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()], policyRoute()]);
    renderCeoPage('?tab=authority');
    expect(await screen.findByTestId('ceo-lock-agent.hire')).toHaveTextContent(
      'Training: always a recommendation',
    );
    expect(screen.getByTestId('ceo-lock-agent.change_model')).toBeInTheDocument();
    expect(screen.queryByTestId('ceo-lock-card.release')).toBeNull();
    expect(screen.getByText(/Graduate on the Overview tab/)).toBeInTheDocument();
  });

  it('drops the lock hints and the training banner after graduation', async () => {
    const t = ceoStatus().training;
    stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus({ training: { ...t, on: false } })],
      policyRoute(),
    ]);
    renderCeoPage('?tab=authority');
    await screen.findByTestId('ceo-class-agent.hire');
    expect(screen.queryByTestId('ceo-lock-agent.hire')).toBeNull();
    expect(screen.queryByText(/Graduate on the Overview tab/)).toBeNull();
  });

  it('saves a changed mode and shows the new version', async () => {
    let version = 1;
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      [
        'PUT /api/ceo/policy',
        (c) => {
          version = 2;
          const body = c.body as { policy: typeof DEFAULT_CEO_POLICY };
          return { policy: { ...body.policy, version }, defaults: DEFAULT_CEO_POLICY, canEdit: true };
        },
      ],
      [
        'GET /api/ceo/policy',
        () => ({
          policy: { ...clonePolicy(DEFAULT_CEO_POLICY), version },
          defaults: DEFAULT_CEO_POLICY,
          canEdit: true,
        }),
      ],
    ]);
    renderCeoPage('?tab=authority');
    const save = await screen.findByTestId('ceo-policy-save');
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Cancel a card: Never' }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => {
      expect(putBody(calls)?.policy.classes['card.cancel']?.mode).toBe('never');
    });
    await waitFor(() => expect(screen.getByTestId('ceo-policy-version')).toHaveTextContent('version 2'));
  });

  it('delegating an owner-reserved matter names the risk and sends confirmDelegation', async () => {
    const calls = stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()], policyRoute()]);
    renderCeoPage('?tab=authority');
    await userEvent.click(await screen.findByRole('button', { name: 'Delegate: Production deploys' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('ceo-delegate-dialog')).toHaveTextContent('Production deploys');
    expect(within(dialog).getByTestId('ceo-delegate-dialog')).toHaveTextContent(/impossible to undo/);
    // nothing is sent before the confirmation
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    await waitFor(() => {
      expect(putBody(calls)?.confirmDelegation).toBe(true);
      expect(putBody(calls)?.policy.delegated).toEqual(['production_deploy']);
    });
  });

  it('lets the Owner map desk items, move the confidence slider and edit limits', async () => {
    const calls = stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()], policyRoute()]);
    renderCeoPage('?tab=authority');
    await userEvent.click(await screen.findByRole('radio', { name: 'Desk Any approval: Decide' }));
    const hires = screen.getByLabelText('Hires per day');
    await userEvent.clear(hires);
    await userEvent.type(hires, '4');
    await userEvent.click(screen.getByTestId('ceo-policy-save'));
    await waitFor(() => {
      expect(putBody(calls)?.policy.desk['approval:*']).toBe('decide');
      expect(putBody(calls)?.policy.limits.maxHiresPerDay).toBe(4);
    });
    expect(screen.getByTestId('ceo-min-confidence')).toHaveValue('0.75');
  });

  it('resets to the defaults after a confirmation', async () => {
    const calls = stubApi('owner', [['GET /api/ceo/status', () => ceoStatus()], policyRoute()]);
    renderCeoPage('?tab=authority');
    await userEvent.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.url === '/api/ceo/policy/reset')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ceo/policy/reset')).toBe(true));
  });

  it('is read only for an Admin: disabled radios, no Save, no Delegate', async () => {
    stubApi('admin', [['GET /api/ceo/status', () => ceoStatus({ isOwner: false })], policyRoute(false)]);
    renderCeoPage('?tab=authority');
    expect(await screen.findByTestId('ceo-authority-readonly')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Answer agent questions: Decide' })).toBeDisabled();
    expect(screen.queryByTestId('ceo-policy-save')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delegate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
    expect(screen.getByTestId('ceo-policy-version')).toHaveTextContent('Policy version 1');
  });
});
