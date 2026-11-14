import type { CardApproval, DeskItemDto, ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDeskItem } from '../components/ApprovalDeskItem.tsx';
import { ApprovalPanel } from '../components/ApprovalPanel.tsx';
import { CardDesignGateSwitch, DesignGatePanel } from '../components/DesignGatePanel.tsx';
import { OwnerApprovalPanel } from '../components/OwnerApprovalPanel.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const project = (over: Record<string, unknown> = {}) =>
  ({
    id: '0192f3a0-0000-7000-8000-0000000000b1',
    workflowKey: 'code',
    leanTeam: true,
    ownerApprovalPolicy: 'large_or_high_risk',
    ...over,
  }) as unknown as ProjectDetailResponse['project'];

const CARD_ID = '0192f3a0-0000-7000-8000-0000000000c1';

const approval = (over: Partial<CardApproval> = {}): CardApproval => ({
  state: 'open',
  stageId: 'design_gate',
  stageLabel: 'Design gate',
  approver: { userId: '0192f3a0-0000-7000-8000-0000000000a1', name: 'Olive Owner' },
  approverKind: 'project_owner',
  fellBack: false,
  openedAt: '2026-11-12T10:00:00.000Z',
  approveTo: 'Build',
  sendBackTo: 'Investigate & design',
  decision: null,
  sentBackCount: 0,
  canAct: true,
  deskItemId: null,
  design: {
    reportPath: 'docs/investigations/TOY-1-design.md',
    location: 'repo',
    commit: '0123456789abcdef',
    summary: 'Add the greeting in the greeting module.',
    text: '# TOY-1\n\n## Design\n\nThe full design report.',
    cardBrief: 'Build the greeting.',
    reason: 'high_risk',
    reasonText: 'the design touches high-risk paths',
    highRiskPaths: ['apps/server/migrations/'],
  },
  ...over,
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('design gate (web)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  // AC1 (web): a project without the setting shows the gate off; Req 1: the owner switches it on
  it('the project panel shows the gate off by default and switches it on', async () => {
    const user = userEvent.setup();
    wrap(<DesignGatePanel projectId="p1" project={project()} canChange />);
    expect(screen.getByTestId('design-gate-state')).toHaveTextContent('Off');
    expect(screen.getByTestId('design-gate-on')).not.toBeChecked();
    expect(screen.getByText(/High-risk designs always stop here/)).toBeInTheDocument();
    await user.click(screen.getByTestId('design-gate-on'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining('/projects/p1/design-gate'),
      method: 'PUT',
      body: { on: true },
    });
  });

  it('the project panel shows "Every design" when on, and is read-only for a member', () => {
    wrap(<DesignGatePanel projectId="p1" project={project({ designGate: true })} canChange={false} />);
    expect(screen.getByTestId('design-gate-state')).toHaveTextContent('Every design');
    expect(screen.getByTestId('design-gate-on')).toBeDisabled();
    expect(screen.getByTestId('design-gate-readonly')).toBeInTheDocument();
  });

  it('the project panel is not shown for a project outside the lean team flow', () => {
    wrap(<DesignGatePanel projectId="p1" project={project({ leanTeam: false })} canChange />);
    expect(screen.queryByTestId('design-gate-on')).toBeNull();
  });

  it('the project refusal (workflow without the gate) is shown', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      json({ error: { code: 'design_gate_not_supported', message: 'this project has no design gate' } }, 409),
    );
    wrap(<DesignGatePanel projectId="p1" project={project()} canChange />);
    await user.click(screen.getByTestId('design-gate-on'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('this project has no design gate'),
    );
  });

  // AC2 (web): without a design report the switch is disabled and shows the server's reason
  it('the card switch is disabled with the reason when the card has no design report', () => {
    wrap(
      <CardDesignGateSwitch
        cardId={CARD_ID}
        gate={{
          on: false,
          required: false,
          reasonText: null,
          canChange: true,
          refusal: { code: 'no_design_report', message: 'TOY-1 has no design report yet.' },
        }}
      />,
    );
    expect(screen.getByTestId('card-design-gate-on')).toBeDisabled();
    expect(screen.getByTestId('card-design-gate-refusal')).toHaveTextContent(
      'TOY-1 has no design report yet.',
    );
  });

  it('the card switch turns the gate on for a card with a design report', async () => {
    const user = userEvent.setup();
    wrap(
      <CardDesignGateSwitch
        cardId={CARD_ID}
        gate={{ on: false, required: false, reasonText: null, canChange: true, refusal: null }}
      />,
    );
    await user.click(screen.getByTestId('card-design-gate-on'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining(`/cards/${CARD_ID}/design-gate`),
      method: 'PUT',
      body: { on: true },
    });
  });

  it('a refusal from the server on the card switch is shown', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      json({ error: { code: 'no_design_report', message: 'TOY-1 has no design report yet.' } }, 409),
    );
    wrap(
      <CardDesignGateSwitch
        cardId={CARD_ID}
        gate={{ on: false, required: false, reasonText: null, canChange: true, refusal: null }}
      />,
    );
    await user.click(screen.getByTestId('card-design-gate-on'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no design report'));
  });

  // AC3/AC4 (web): the approval panel shows the design report and approves or returns the design
  it('the approval panel shows the design report instead of a diff and approves the design without a commit', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalPanel cardId={CARD_ID} approval={approval()} />);
    expect(screen.getByTestId('approval-design-reason')).toHaveTextContent('high-risk paths');
    expect(screen.getByTestId('approval-design-paths')).toHaveTextContent('apps/server/migrations/');
    expect(screen.getByTestId('approval-design-summary')).toHaveTextContent('greeting module');
    expect(screen.getByTestId('approval-design-path')).toHaveTextContent(
      'docs/investigations/TOY-1-design.md @ 0123456789',
    );
    expect(screen.getByTestId('approval-design-text')).toHaveTextContent('The full design report.');
    expect(screen.queryByText('Show the diff')).toBeNull();
    await user.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = last();
    expect(call.url).toContain(`/cards/${CARD_ID}/approval/approve`);
    expect(call.body?.sha).toBeUndefined();
    expect(screen.getByTestId('approval-approve')).toHaveTextContent('Approve the design');
  });

  it('returning the design needs the owner note and sends it', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalPanel cardId={CARD_ID} approval={approval()} />);
    await user.click(screen.getByTestId('approval-fail'));
    expect(screen.getByTestId('approval-send-back')).toBeDisabled();
    await user.type(screen.getByTestId('approval-note'), 'Split the migration out.');
    await user.click(screen.getByTestId('approval-send-back'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining(`/cards/${CARD_ID}/approval/send-back`),
      body: { comment: 'Split the migration out.' },
    });
  });

  it('an older runner sent no text: the panel points at the report path', () => {
    const a = approval();
    wrap(<ApprovalPanel cardId={CARD_ID} approval={{ ...a, design: { ...a.design!, text: null } }} />);
    expect(screen.getByTestId('approval-design-no-text')).toBeInTheDocument();
  });

  it('the desk item at the design gate shows the design report and the design buttons', () => {
    const item = {
      id: '0192f3a0-0000-7000-8000-0000000000d1',
      card: { id: CARD_ID, ref: 'TOY-1' },
      data: {
        design: {
          reportPath: 'docs/investigations/TOY-1-design.md',
          commit: '0123456789abcdef',
          summary: 'Add the greeting in the greeting module.',
        },
      },
    } as unknown as DeskItemDto;
    wrap(<ApprovalDeskItem item={item} />);
    expect(screen.getByTestId('approval-desk-design')).toHaveTextContent('greeting module');
    expect(screen.getByTestId('approval-desk-design')).toHaveTextContent(
      'docs/investigations/TOY-1-design.md',
    );
    expect(screen.queryByTestId('approval-desk-diff-toggle')).toBeNull();
    expect(screen.getByTestId('approval-desk-approve')).toHaveTextContent('Approve the design');
  });

  // Regression: the owner approval (after the review) keeps its diff and plain labels
  it('the owner approval desk item and setting keep working as before', () => {
    const item = {
      id: '0192f3a0-0000-7000-8000-0000000000d2',
      card: { id: CARD_ID, ref: 'TOY-2' },
    } as unknown as DeskItemDto;
    wrap(
      <>
        <ApprovalDeskItem item={item} />
        <OwnerApprovalPanel projectId="p1" project={project()} canChange />
      </>,
    );
    expect(screen.getByTestId('approval-desk-diff-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('approval-desk-approve')).toHaveTextContent(/^Approve$/);
    expect(screen.getByTestId('owner-approval-state')).toHaveTextContent('Large and high-risk cards');
  });
});
