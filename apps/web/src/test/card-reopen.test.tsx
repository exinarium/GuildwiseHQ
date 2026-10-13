import type { CardDetailResponse } from '@aom/shared';
import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-13T10:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

const detail = (status: 'done' | 'cancelled' | 'queued', canReopen: boolean) =>
  ({
    card: {
      id: ID(10),
      ref: 'TEST01-4',
      title: 'Ship it',
      cardType: 'feature',
      stage: status === 'queued' ? 'build' : 'done',
      status,
      projectId: ID(2),
      number: 4,
      workflowKey: 'code',
      workflowVersion: 1,
      column: 'Done',
      fields: {},
      ownerUserId: ID(1),
      decisionPolicy: 'owner_only',
      riskTierOverridden: false,
      docsNeeded: false,
      completionAction: 'pr',
      repoId: null,
      baseBranch: 'main',
      branchName: 'aom/test01-4-ship-it',
      homeWorkstationId: null,
      parentCardId: null,
      origin: 'manual',
      scheduled: false,
      claimedByAgentId: null,
      claimedByAgentName: null,
      claimedAt: null,
      blockedSince: null,
      dependencies: [],
      createdAt: NOW,
      updatedAt: NOW,
      queuedAt: null,
      finalizedAt: NOW,
      riskTier: null,
      assignee: null,
      blocked: false,
      reworkRound: 0,
      priority: 3,
    },
    handoffs: [],
    transitions: [],
    activity: [
      {
        id: 1,
        kind: 'reopened',
        summary: 'Reopened by Pieter into Build (was done)',
        reason: 'review found a bug',
        userId: ID(1),
        agentId: null,
        actorName: 'Pieter',
        at: NOW,
      },
    ],
    threadId: ID(10),
    thread: [],
    currentShift: null,
    permissions: {
      canEdit: false,
      canSpecify: false,
      canMove: status === 'queued',
      canRelease: false,
      canCancel: status === 'queued',
      canReopen,
      canComment: true,
      canSetRisk: false,
    },
    blockers: [],
  }) as unknown as CardDetailResponse;

function view(d: CardDetailResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardDetailView data={d} workflow={codeWorkflowV1} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('reopen a done or cancelled card', () => {
  it('shows the button on a closed card only for those who may reopen it', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const { unmount } = view(detail(status, true));
      expect(screen.getByTestId('reopen-card')).toBeInTheDocument();
      unmount();
    }
    const denied = view(detail('done', false));
    expect(screen.queryByTestId('reopen-card')).toBeNull();
    denied.unmount();
    view(detail('queued', false));
    expect(screen.queryByTestId('reopen-card')).toBeNull();
  });

  it('the dialog explains the kept branch, asks for a reason and posts the default Build stage', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url === '/api/auth/me')
          return new Response(JSON.stringify({ user: { id: ID(1) }, features: { mockUi: false } }));
        return new Response('{}', { status: 200 });
      }),
    );
    const user = userEvent.setup();
    view(detail('done', true));
    await user.click(screen.getByTestId('reopen-card'));
    expect(screen.getByText(/Its branch \(aom\/test01-4-ship-it\) is kept/)).toBeInTheDocument();
    expect(screen.getByText(/open pull request is kept/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reopen into')).toHaveValue('build');
    // terminal stages are not offered
    expect(screen.queryByRole('option', { name: 'Done' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reopen card' }));
    expect(screen.getByText('A reason is required')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.type(screen.getByLabelText('Reason'), 'review found a bug');
    await user.click(screen.getByRole('button', { name: 'Reopen card' }));
    await waitFor(() =>
      expect(calls).toEqual([
        { url: `/api/cards/${ID(10)}/reopen`, body: { toStage: 'build', reason: 'review found a bug' } },
      ]),
    );
  });

  it('shows the reopen entry in the timeline', () => {
    view(detail('queued', false));
    const row = screen.getByTestId('timeline-activity');
    expect(row).toHaveAttribute('data-kind', 'reopened');
    expect(row).toHaveTextContent('Reopened by Pieter into Build (was done)');
    expect(row).toHaveTextContent('Reason: review found a bug');
  });
});
