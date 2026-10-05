import type { BoardCard, CardDetailResponse } from '@aom/shared';
import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardTile } from '../components/BoardView.tsx';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-05-01T10:00:00.000Z';
const until = new Date(Date.now() + 4 * 60_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

const tile = (backoff: BoardCard['backoff']): BoardCard => ({
  id: ID(10),
  ref: 'TEST01-4',
  title: 'Run the suite',
  cardType: 'feature',
  stage: 'test',
  status: 'queued',
  assignee: null,
  updatedAt: NOW,
  queuedAt: null,
  riskTier: null,
  blocked: false,
  reworkRound: 0,
  priority: 3,
  backoff,
});

describe('loop breaker back-off', () => {
  it('shows the badge on the board tile while the back-off is in force', () => {
    render(
      <MemoryRouter>
        <ul>
          <CardTile card={tile({ until, failures: 4 })} projectId={ID(2)} />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('backoff-badge')).toHaveTextContent(
      /backing off until \d{2}:\d{2} \(4 failures\)/,
    );
  });

  it('shows no badge without a back-off or after it expired', () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    for (const b of [null, undefined, { until: expired, failures: 3 }]) {
      const { unmount } = render(
        <MemoryRouter>
          <ul>
            <CardTile card={tile(b)} projectId={ID(2)} />
          </ul>
        </MemoryRouter>,
      );
      expect(screen.queryByTestId('backoff-badge')).toBeNull();
      unmount();
    }
  });

  it('card page: badge and a Release back-off button that posts to the release route', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') calls.push(url);
        if (url === '/api/auth/me')
          return new Response(JSON.stringify({ user: { id: ID(1) }, features: { mockUi: false } }));
        return new Response('{}', { status: 200 });
      }),
    );
    const d = {
      card: {
        ...tile({ until, failures: 3 }),
        projectId: ID(2),
        number: 4,
        workflowKey: 'code',
        workflowVersion: 1,
        column: 'Test',
        fields: {},
        ownerUserId: ID(1),
        decisionPolicy: 'owner_only',
        riskTierOverridden: false,
        docsNeeded: false,
        completionAction: null,
        repoId: null,
        baseBranch: null,
        branchName: null,
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
        finalizedAt: null,
        riskTier: null,
      },
      handoffs: [],
      transitions: [],
      activity: [],
      threadId: ID(10),
      thread: [],
      currentShift: null,
      permissions: {
        canEdit: false,
        canSpecify: false,
        canMove: true,
        canRelease: false,
        canReleaseBackoff: true,
        canCancel: true,
        canComment: true,
        canSetRisk: false,
      },
      blockers: [],
    } as unknown as CardDetailResponse;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CardDetailView data={d} workflow={codeWorkflowV1} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('backoff-badge')).toHaveTextContent('(3 failures)');
    await userEvent.setup().click(screen.getByTestId('release-backoff'));
    await waitFor(() => expect(calls).toContain(`/api/cards/${ID(10)}/release-backoff`));
  });
});
