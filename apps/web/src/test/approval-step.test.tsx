import type { CardApproval, DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDeskItem } from '../components/ApprovalDeskItem.tsx';
import { ApprovalPanel } from '../components/ApprovalPanel.tsx';
import {
  type BuilderModel,
  fromDefinition,
  humanPurposeOf,
  setApprover,
  setHumanPurpose,
  setStepKind,
  toDefinition,
  validateBuilder,
} from '../lib/builder.ts';

const CARD = '0192f3a0-0000-7000-8000-0000000000c1';
const ME = '0192f3a0-0000-7000-8000-0000000000a1';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const approval = (over: Partial<CardApproval> = {}): CardApproval => ({
  state: 'open',
  stageId: 'approval',
  stageLabel: 'Owner approves',
  approver: { userId: ME, name: 'Pieter' },
  approverKind: 'org_owner',
  fellBack: false,
  openedAt: '2026-10-14T10:00:00.000Z',
  approveTo: 'Done',
  sendBackTo: 'Work',
  decision: null,
  sentBackCount: 0,
  canAct: true,
  deskItemId: null,
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

describe('approval panel and desk item', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(String(init.body)) };
  };

  it('says who approves and where each decision leads, and approves with a note', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalPanel cardId={CARD} approval={approval()} />);
    expect(screen.getByTestId('approval-state')).toHaveTextContent('Waiting for approval');
    expect(screen.getByTestId('approval-approver')).toHaveTextContent('Pieter approves this card');
    expect(screen.getByTestId('approval-approver')).toHaveTextContent('goes on to "Done"');
    expect(screen.getByTestId('approval-approver')).toHaveTextContent('returns to "Work"');
    await user.type(screen.getByTestId('approval-note'), 'Looks right');
    await user.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining(`/cards/${CARD}/approval/approve`),
      method: 'POST',
      body: { note: 'Looks right' },
    });
  });

  it('a send back needs a comment', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalPanel cardId={CARD} approval={approval()} />);
    await user.click(screen.getByTestId('approval-fail'));
    const send = screen.getByTestId('approval-send-back');
    expect(send).toBeDisabled();
    await user.type(screen.getByTestId('approval-note'), 'No empty state');
    await user.click(send);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toMatchObject({
      url: expect.stringContaining('/approval/send-back'),
      body: { comment: 'No empty state' },
    });
  });

  it('is read only for someone who cannot decide, and shows a decision afterwards', () => {
    const { unmount } = wrap(<ApprovalPanel cardId={CARD} approval={approval({ canAct: false })} />);
    expect(screen.queryByTestId('approval-approve')).toBeNull();
    expect(screen.getByTestId('approval-readonly')).toBeInTheDocument();
    unmount();
    wrap(
      <ApprovalPanel
        cardId={CARD}
        approval={approval({
          state: 'sent_back',
          canAct: false,
          sentBackCount: 1,
          decision: {
            kind: 'sent_back',
            byName: 'Pieter',
            note: 'Missing X',
            at: '2026-10-14T11:00:00.000Z',
          },
        })}
      />,
    );
    expect(screen.getByTestId('approval-decision')).toHaveTextContent('Sent back by Pieter');
    expect(screen.getByTestId('approval-decision')).toHaveTextContent('Missing X');
  });

  it('the desk item decides through the same endpoints', async () => {
    const user = userEvent.setup();
    const item = { id: 'd1', card: { id: CARD, ref: 'WEB-1' } } as unknown as DeskItemDto;
    wrap(<ApprovalDeskItem item={item} />);
    await user.click(screen.getByTestId('approval-desk-approve'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last().url).toContain(`/cards/${CARD}/approval/approve`);
  });
});

describe('the workflow builder', () => {
  const model = (): BuilderModel =>
    fromDefinition({
      key: 'flow',
      name: 'Flow',
      fieldSet: 'custom',
      customFields: [],
      cardTypes: ['feature'],
      initialStage: 'work',
      stages: [
        {
          id: 'work',
          label: 'Work',
          column: 'Work',
          kind: 'agent',
          claimRole: 'worker',
          doneCriteria: 'done',
          outcomes: [{ id: 'done', label: 'Done', kind: 'success', to: 'check', event: 'StageCompleted' }],
        },
        {
          id: 'check',
          label: 'Check',
          column: 'Check',
          kind: 'agent',
          claimRole: 'worker',
          doneCriteria: 'checked',
          outcomes: [{ id: 'done', label: 'Done', kind: 'success', to: 'end', event: 'StageCompleted' }],
        },
        { id: 'end', label: 'End', column: 'End', kind: 'terminal', claimRole: null, doneCriteria: '' },
      ],
    } as never);

  it('turns a step into an approval step with approve and send_back routes, defaulting to the earlier agent step', () => {
    const m0 = model();
    const uid = m0.steps[1]?.uid as string;
    const m = setHumanPurpose(m0, uid, 'approval');
    const def = toDefinition(m);
    const step = def.stages.find((s) => s.id === 'check');
    expect(step).toMatchObject({
      kind: 'human',
      claimRole: null,
      human: { purpose: 'approval', approver: { kind: 'org_owner' } },
    });
    expect(step?.outcomes?.map((o) => [o.id, o.kind, o.to, o.rework])).toEqual([
      ['approve', 'success', 'end', false],
      ['send_back', 'failure', 'work', true],
    ]);
    expect(humanPurposeOf(m.steps[1] as never)).toBe('approval');
  });

  it('changes the approver, and back to an agent step clears the person settings', () => {
    const m0 = model();
    const uid = m0.steps[1]?.uid as string;
    let m = setHumanPurpose(m0, uid, 'approval');
    m = setApprover(m, uid, { kind: 'project_owner' });
    expect(toDefinition(m).stages[1]?.human?.approver).toEqual({ kind: 'project_owner' });
    m = setStepKind(m, uid, 'agent');
    expect(toDefinition(m).stages[1]?.human).toBeUndefined();
  });

  it('QA steps get pass, skip and send_back', () => {
    const m0 = model();
    const m = setHumanPurpose(m0, m0.steps[1]?.uid as string, 'qa');
    expect(toDefinition(m).stages[1]?.outcomes?.map((o) => o.id)).toEqual(['pass', 'skip', 'send_back']);
  });

  it('is valid for a custom workflow, and a named member must be chosen', () => {
    const ROLE = {
      key: 'worker',
      version: 1,
      name: 'Worker',
      purpose: 'p',
      department: 'support',
      builtIn: false,
      instructions: 'x',
      coreRules: [],
      seniorityLevels: ['junior'],
      defaultModel: { runtime: 'claude-code', model: 'sonnet' },
      permissions: {
        allowedTools: ['read'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        browser: false,
        readOrgRepos: false,
        riskTiers: ['small', 'large'],
        repoIds: null,
      },
      skills: [],
      claimableStages: [{ workflowKey: '*', stageId: '*' }],
    };
    const m0 = model();
    const uid = m0.steps[1]?.uid as string;
    const m = setHumanPurpose(m0, uid, 'approval');
    const ok = validateBuilder(m, { roles: [ROLE as never], departments: [] }, undefined);
    expect(ok.errors, JSON.stringify(ok)).toBe(0);
    const bad = validateBuilder(
      setApprover(m, uid, { kind: 'member', userId: '' }),
      { roles: [ROLE as never], departments: [] },
      undefined,
    );
    expect(bad.errors).toBeGreaterThan(0);
  });
});
