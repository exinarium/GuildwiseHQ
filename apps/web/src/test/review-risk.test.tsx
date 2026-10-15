import { type CardDetailResponse, codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinalizePanel } from '../components/FinalizePanel.tsx';
import { ReviewRiskPanel, RiskBadge } from '../components/ReviewRiskPanel.tsx';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-05-01T10:00:00.000Z';
const USER = ID(1);

afterEach(() => vi.unstubAllGlobals());

const HIGH = {
  level: 'high' as const,
  analysis: '## Failure scenarios\n- retries double-charge',
  qaFocus: 'Pay twice in quick succession',
  mergeApprovalReason: 'the reviewer rated the change HIGH risk',
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('risk badge and panel', () => {
  it('shows the level in words for each risk', () => {
    const { unmount } = wrap(<RiskBadge level="low" />);
    expect(screen.getByTestId('risk-badge').textContent).toBe('Low risk');
    unmount();
    wrap(<RiskBadge level="high" />);
    expect(screen.getByTestId('risk-badge').textContent).toBe('High risk');
  });

  it('renders the badge, the QA focus, the merge reason and the analysis for a high risk', () => {
    wrap(<ReviewRiskPanel risk={HIGH} />);
    const panel = screen.getByTestId('review-risk-panel');
    expect(panel.dataset.level).toBe('high');
    expect(within(panel).getByTestId('risk-badge').textContent).toBe('High risk');
    expect(within(panel).getByTestId('risk-qa-focus').textContent).toContain('Pay twice in quick succession');
    expect(within(panel).getByTestId('risk-merge-reason').textContent).toContain("manager's approval");
    expect(within(panel).getByTestId('risk-analysis').textContent).toContain('retries double-charge');
    expect((within(panel).getByTestId('risk-analysis') as HTMLDetailsElement).open).toBe(true);
  });

  it('a medium risk shows the focus without a merge reason, analysis collapsed', () => {
    wrap(
      <ReviewRiskPanel
        risk={{
          level: 'medium',
          analysis: 'thin coverage',
          qaFocus: 'Check export',
          mergeApprovalReason: null,
        }}
      />,
    );
    expect(screen.getByTestId('risk-qa-focus').textContent).toContain('Check export');
    expect(screen.queryByTestId('risk-merge-reason')).toBeNull();
    expect((screen.getByTestId('risk-analysis') as HTMLDetailsElement).open).toBe(false);
  });

  it('renders nothing without a risk call', () => {
    wrap(<ReviewRiskPanel risk={null} />);
    expect(screen.queryByTestId('review-risk-panel')).toBeNull();
    wrap(<ReviewRiskPanel risk={{ level: 'unknown', analysis: '', qaFocus: '' }} />);
    expect(screen.queryByTestId('review-risk-panel')).toBeNull();
  });
});

describe('finalize panel with a high risk', () => {
  const finalize = {
    available: true,
    action: 'merge' as const,
    requiresApproval: true,
    approvalReason: 'the reviewer rated the change HIGH risk',
    state: 'idle' as const,
    deskItemId: null,
    lastError: null,
  };

  it('says the reviewer rated it high risk instead of "large change"', () => {
    wrap(<FinalizePanel cardId={ID(10)} finalize={finalize} completionAction="merge" canAct />);
    const note = screen.getByTestId('finalize-approval-note').textContent ?? '';
    expect(note).toContain('rated this change high risk');
    expect(note).not.toContain('Large change');
  });
});

describe('card page review section', () => {
  const card = {
    id: ID(10),
    projectId: ID(2),
    number: 7,
    ref: 'TOY-7',
    title: 'Add greeting',
    cardType: 'feature',
    workflowKey: 'code',
    workflowVersion: 1,
    stage: 'test',
    status: 'queued',
    column: 'Test',
    fields: { context: 'Say hello', requirements: 'A greeting', acceptanceCriteria: ['It greets', 'x'] },
    ownerUserId: USER,
    decisionPolicy: 'owner_only',
    riskTier: 'small',
    riskTierOverridden: false,
    reviewRisk: HIGH,
    docsNeeded: false,
    completionAction: 'merge',
    effectiveCompletionAction: 'merge',
    completionActionSource: 'card',
    repoId: ID(3),
    baseBranch: null,
    branchName: null,
    homeWorkstationId: null,
    parentCardId: null,
    origin: 'manual',
    scheduled: false,
    priority: 3,
    reworkRound: 0,
    claimedByAgentId: null,
    claimedByAgentName: null,
    claimedAt: null,
    queuedAt: null,
    blockedSince: null,
    dependencies: [],
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: null,
  } as unknown as CardDetailResponse['card'];

  const data = {
    card,
    handoffs: [
      {
        id: ID(20),
        cardId: card.id,
        shiftId: null,
        agentId: null,
        agentName: 'Rex',
        stage: 'review',
        outcome: 'approve',
        note: 'Looks fine',
        data: { score: 4, risk: 'high', riskAnalysis: 'retries double-charge', qaFocus: 'Pay twice' },
        createdAt: NOW,
      },
    ],
    transitions: [],
    activity: [],
    threadId: card.id,
    thread: [],
    currentShift: null,
    permissions: {
      canEdit: false,
      canSpecify: false,
      canMove: false,
      canRelease: false,
      canCancel: false,
      canComment: false,
      canSetRisk: false,
    },
    blockers: [],
  } as unknown as CardDetailResponse;

  it('shows the risk panel and the badge on the review handoff', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    wrap(<CardDetailView data={data} workflow={codeWorkflowV1} />);
    expect(screen.getByTestId('review-risk-panel').dataset.level).toBe('high');
    const handoff = screen.getByTestId('handoff-review');
    expect(within(handoff).getByTestId('risk-badge').textContent).toBe('High risk');
    expect(handoff.textContent).toContain('QA focus: Pay twice');
    expect(within(handoff).getByTestId('handoff-risk-analysis').textContent).toContain(
      'retries double-charge',
    );
  });
});
