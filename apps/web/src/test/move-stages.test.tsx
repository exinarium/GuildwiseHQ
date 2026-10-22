import type { WorkflowDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoveToSheet } from '../components/cards/MoveToSheet.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { moveStageOptions } from '../lib/moveStages.ts';
import { MoveDialog } from '../pages/CardDetail.tsx';

const wf = {
  key: 'bug',
  version: 1,
  name: 'Bug',
  stages: [
    { id: 'build', label: 'Build', column: 'in_progress', kind: 'agent', outcomes: [] },
    { id: 'review', label: 'Review', column: 'review', kind: 'agent', outcomes: [] },
    { id: 'approval', label: 'Approval', column: 'review', kind: 'human', outcomes: [] },
    { id: 'deploy', label: 'Deploy', column: 'review', kind: 'server', outcomes: [] },
    { id: 'done', label: 'Done', column: 'done', kind: 'terminal', outcomes: [] },
  ],
} as unknown as WorkflowDefinition;

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('moveStageOptions', () => {
  it('leaves out the current, closing, person and server stages', () => {
    expect(moveStageOptions(wf, 'build').map((s) => s.id)).toEqual(['review']);
    expect(moveStageOptions(wf, 'review').map((s) => s.id)).toEqual(['build']);
  });
  it('follows the server list when there is one', () => {
    expect(moveStageOptions(wf, 'build', ['review', 'build']).map((s) => s.id)).toEqual(['review']);
  });
});

describe('the Move dialog', () => {
  it('offers only valid stages and shows the server text when a move still fails', async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: { code: 'missing_fields', message: 'missing required fields: testPlan' } }, 422),
    );
    vi.stubGlobal('fetch', fetchMock);
    wrap(<MoveDialog open onOpenChange={() => undefined} cardId="c1" workflow={wf} current="build" />);
    const select = screen.getByLabelText('Target stage');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Review']);
    await userEvent.type(screen.getByLabelText('Reason'), 'try it');
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    expect(await screen.findByText('missing required fields: testPlan')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ toStage: 'review', reason: 'try it' });
  });

  it('says nothing will run when the move was accepted with unlanded dependencies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ moveNotice: 'The card moved, but nothing will run in Review until TOY-1 has landed.' }),
      ),
    );
    const onOpenChange = vi.fn();
    wrap(<MoveDialog open onOpenChange={onOpenChange} cardId="c1" workflow={wf} current="build" />);
    await userEvent.type(screen.getByLabelText('Reason'), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    expect(await screen.findByText(/nothing will run in Review until TOY-1/)).toBeInTheDocument();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('uses the stages the server listed', () => {
    wrap(
      <MoveDialog
        open
        onOpenChange={() => undefined}
        cardId="c1"
        workflow={wf}
        current="review"
        targetIds={['build']}
      />,
    );
    expect(
      within(screen.getByLabelText('Target stage'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Build']);
  });
});

describe('the Move to... sheet', () => {
  it('lists only valid stages, shows the server error and the dependency notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: { code: 'invalid_stage', message: 'no such place' } }, 400))
        .mockResolvedValueOnce(json({ moveNotice: 'nothing will run in Review until TOY-1 has landed' })),
    );
    wrap(
      <MoveToSheet
        open
        onClose={() => undefined}
        workflow={wf}
        card={{ id: 'c1', ref: 'TOY-2', stage: 'build' }}
      />,
    );
    expect(screen.queryByTestId('move-to-build')).toBeNull();
    expect(screen.queryByTestId('move-to-approval')).toBeNull();
    expect(screen.queryByTestId('move-to-deploy')).toBeNull();
    expect(screen.queryByTestId('move-to-done')).toBeNull();
    await userEvent.click(screen.getByTestId('move-to-review'));
    await userEvent.type(screen.getByLabelText('Reason'), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    expect(await screen.findByText('no such place')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    expect(await screen.findByText(/nothing will run in Review until TOY-1/)).toBeInTheDocument();
  });
});
