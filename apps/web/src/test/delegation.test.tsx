/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CardDetailResponse, DelegateGrantsDto, DelegationStepDto } from '@aom/shared';
import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateGrants } from '../components/delegation/DelegateGrants.tsx';
import { DelegationSteps } from '../components/delegation/DelegationSteps.tsx';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-13T10:00:00.000Z';
afterEach(() => vi.unstubAllGlobals());

const grant = (
  over: Partial<DelegateGrantsDto['grants'][number]> = {},
): DelegateGrantsDto['grants'][number] => ({
  targetKind: 'agent',
  targetKey: ID(7),
  targetName: 'Rex',
  handle: 'agent:rex',
  maxCalls: 2,
  timeoutSec: 90,
  maxProfile: null,
  profile: 'read_only',
  model: 'claude-code:haiku',
  problem: null,
  grantedAt: NOW,
  grantedBy: ID(1),
  modelOverride: null,
  inherited: false,
  ...over,
});

function stub(initial: DelegateGrantsDto) {
  let state = initial;
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith('/delegate-targets'))
        return new Response(
          JSON.stringify({
            items: [
              {
                targetKind: 'persona',
                targetKey: 'devils-advocate',
                name: "Devil's Advocate",
                description: 'Attacks',
                model: null,
                profile: null,
                granted: false,
              },
              {
                targetKind: 'agent',
                targetKey: ID(7),
                name: 'Rex',
                description: '',
                model: 'claude-code:haiku',
                profile: 'read_only',
                granted: true,
              },
              {
                targetKind: 'agent',
                targetKey: ID(8),
                name: 'Dee',
                description: '',
                model: 'claude-code:opus',
                profile: 'shell',
                granted: false,
              },
            ],
          }),
        );
      if (url.endsWith('/delegate-grants') && method === 'PUT') {
        const b = JSON.parse(String(init.body));
        state = {
          ...state,
          grants: b.grant
            ? [
                ...state.grants,
                grant({
                  targetKind: b.targetKind,
                  targetKey: b.targetKey,
                  targetName: b.targetKey,
                  maxCalls: b.grant.maxCalls,
                  timeoutSec: b.grant.timeoutSec,
                  maxProfile: b.grant.maxProfile,
                }),
              ]
            : state.grants.filter((g) => g.targetKey !== b.targetKey),
        };
        return new Response(JSON.stringify(state));
      }
      if (url.endsWith('/delegate-grants')) return new Response(JSON.stringify(state));
      return new Response('{}');
    }),
  );
  return calls;
}

function view(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the delegation grants of an agent', () => {
  it('say it is off when nobody granted anything, and offer the form to those who manage the agent', async () => {
    stub({ ownerKind: 'agent', ownerId: ID(1), canManage: true, roleKey: null, grants: [] });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    // nothing is fetched until it is opened
    expect(screen.queryByTestId('delegate-grants')).toBeNull();
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    expect(await screen.findByTestId('delegate-grants-none')).toHaveTextContent('This agent cannot delegate');
    expect(screen.getByText(/Off by default/)).toBeInTheDocument();
    expect(screen.getByText(/runs on the model configured for it/)).toBeInTheDocument();
    expect(screen.getByLabelText('Delegation target')).toBeInTheDocument();
  });

  it('list each target with its model, tools and limits, and let a manager remove one', async () => {
    const calls = stub({
      ownerKind: 'agent',
      ownerId: ID(1),
      canManage: true,
      roleKey: null,
      grants: [
        grant(),
        grant({
          targetKind: 'persona',
          targetKey: 'security',
          targetName: 'Security',
          handle: 'security',
          model: null,
          profile: null,
          maxProfile: 'edit',
        }),
      ],
    });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    const rex = await screen.findByTestId(`delegate-grant-${ID(7)}`);
    expect(rex).toHaveTextContent('Rex');
    expect(rex).toHaveTextContent('Agent');
    expect(rex).toHaveTextContent('runs on claude-code:haiku');
    expect(rex).toHaveTextContent('reads only');
    expect(rex).toHaveTextContent('up to 2 calls a turn, 90 s each');
    const sec = screen.getByTestId('delegate-grant-security');
    expect(sec).toHaveTextContent('runs on its own model');
    expect(sec).toHaveTextContent('can edit files');
    await user.click(within(rex).getByRole('button', { name: 'Remove Rex' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        targetKind: 'agent',
        targetKey: ID(7),
        grant: null,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId(`delegate-grant-${ID(7)}`)).toBeNull());
  });

  it('grant a target with the calls, the time and a tool ceiling the manager chose', async () => {
    const calls = stub({ ownerKind: 'agent', ownerId: ID(1), canManage: true, roleKey: null, grants: [] });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    await screen.findByTestId('delegate-grant-form');
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('option', { name: /Dee/ })).toBeInTheDocument());
    await user.selectOptions(
      screen.getByLabelText('Delegation target'),
      screen.getByRole('option', { name: /Dee/ }),
    );
    const n = screen.getByLabelText('Calls per turn');
    await user.clear(n);
    await user.type(n, '3');
    const t = screen.getByLabelText('Seconds per call');
    await user.clear(t);
    await user.type(t, '120');
    await user.selectOptions(screen.getByLabelText('Tool ceiling'), 'read_only');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        url: `/api/agents/${ID(1)}/delegate-grants`,
        body: {
          targetKind: 'agent',
          targetKey: ID(8),
          grant: { maxCalls: 3, timeoutSec: 120, maxProfile: 'read_only' },
        },
      }),
    );
    // a target already granted is not offered again
    expect(screen.queryByRole('option', { name: /Rex/ })).toBeNull();
  });

  it('show everyone the list but only a manager the controls', async () => {
    stub({
      ownerKind: 'agent',
      ownerId: ID(1),
      canManage: false,
      roleKey: null,
      grants: [grant({ problem: 'this agent is retired' })],
    });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    const row = await screen.findByTestId(`delegate-grant-${ID(7)}`);
    expect(row).toHaveTextContent('this agent is retired');
    expect(screen.queryByRole('button', { name: 'Remove Rex' })).toBeNull();
    expect(screen.queryByTestId('delegate-grant-form')).toBeNull();
    expect(
      screen.getByText(/Only an Owner, an Admin or the agent’s manager changes this list/),
    ).toBeInTheDocument();
  });
});

describe('the delegation grants of a session', () => {
  it('use the session endpoint and say who changes them', async () => {
    const calls = stub({ ownerKind: 'session', ownerId: ID(2), canManage: false, roleKey: null, grants: [] });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="session" ownerId={ID(2)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    expect(await screen.findByTestId('delegate-grants-none')).toHaveTextContent(
      'This session cannot delegate',
    );
    expect(calls[0]?.url).toBe(`/api/sessions/${ID(2)}/delegate-grants`);
    expect(screen.getByText(/Only the creator of the session, an Owner or an Admin/)).toBeInTheDocument();
    expect(screen.getByText(/facilitator and the Chair/)).toBeInTheDocument();
  });
});

const step = (over: Partial<DelegationStepDto> = {}): DelegationStepDto => ({
  delegateId: ID(50),
  callerId: ID(51),
  target: 'agent:rex',
  targetName: 'Rex',
  targetKind: 'agent',
  model: 'claude-haiku-4-5',
  profile: 'read_only',
  outcome: 'ok',
  durationMs: 4200,
  costUsd: 0.0123,
  costUnknown: false,
  summary: 'Looks fine to me.',
  native: false,
  at: NOW,
  ...over,
});

describe('delegations shown as sub-steps', () => {
  it('say who did it, on which model, with which tools, how long, what it cost and what came back', () => {
    view(
      <DelegationSteps
        steps={[
          step(),
          step({
            delegateId: ID(52),
            targetName: 'Security',
            targetKind: 'persona',
            outcome: 'timeout',
            summary: 'the delegate did not finish',
            costUsd: null,
            costUnknown: true,
            native: true,
            durationMs: 110_000,
            profile: 'shell',
          }),
        ]}
      />,
    );
    const [ok, bad] = screen.getAllByTestId('delegation-step');
    expect(ok).toHaveTextContent('Delegated to Rex');
    expect(within(ok as HTMLElement).getByTestId('delegation-meta')).toHaveTextContent(
      'claude-haiku-4-5 · reads only · 4.2 s · $0.01',
    );
    expect(within(ok as HTMLElement).getByTestId('delegation-summary')).toHaveTextContent(
      'Looks fine to me.',
    );
    expect(bad).toHaveAttribute('data-outcome', 'timeout');
    expect(bad).toHaveTextContent('Claude Code subagent');
    expect(within(bad as HTMLElement).getByTestId('delegation-meta')).toHaveTextContent(
      'can edit files and run commands · 2 min · cost unknown',
    );
  });

  it('are not shown at all when nothing was delegated', () => {
    view(<DelegationSteps steps={[]} />);
    view(<DelegationSteps steps={undefined} />);
    expect(screen.queryByTestId('delegation-steps')).toBeNull();
  });

  it('appear in the timeline of the card between its other entries', () => {
    const d = {
      card: {
        id: ID(10),
        ref: 'TEST01-4',
        title: 'Ship it',
        cardType: 'feature',
        stage: 'build',
        status: 'queued',
        projectId: ID(2),
        number: 4,
        workflowKey: 'code',
        workflowVersion: 1,
        column: 'Build',
        fields: {},
        ownerUserId: ID(1),
        decisionPolicy: 'owner_only',
        riskTierOverridden: false,
        docsNeeded: false,
        completionAction: 'pr',
        repoId: null,
        baseBranch: 'main',
        branchName: 'x',
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
        finalizedAt: null,
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
          kind: 'edited',
          summary: 'Edited',
          reason: null,
          userId: ID(1),
          agentId: null,
          actorName: 'Pieter',
          at: '2026-10-13T09:00:00.000Z',
        },
      ],
      delegations: [step()],
      threadId: ID(10),
      thread: [],
      currentShift: null,
      permissions: {
        canEdit: false,
        canSpecify: false,
        canMove: false,
        canRelease: false,
        canCancel: false,
        canReopen: false,
        canComment: true,
        canSetRisk: false,
      },
      blockers: [],
    } as unknown as CardDetailResponse;
    view(<CardDetailView data={d} workflow={codeWorkflowV1} />);
    const items = within(screen.getByTestId('timeline')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-testid', 'timeline-activity');
    expect(items[1]).toHaveAttribute('data-testid', 'timeline-delegation');
    expect(items[1]).toHaveTextContent('Delegated to Rex');
    expect(items[1]).toHaveTextContent('Looks fine to me.');
  });
});

describe('role-level delegation grants and a model per grant (R3c)', () => {
  it('shows what an agent has through its role as "from the role" with no remove button, and its own grants removable', async () => {
    stub({
      ownerKind: 'agent',
      ownerId: ID(1),
      canManage: true,
      roleKey: 'builder',
      grants: [
        grant({
          targetKey: 'optimist',
          targetKind: 'persona',
          targetName: 'Optimist',
          handle: 'optimist',
          inherited: true,
          model: null,
        }),
        grant({
          targetKey: 'cost-hawk',
          targetKind: 'persona',
          targetName: 'Cost Hawk',
          handle: 'cost-hawk',
          model: null,
        }),
      ],
    });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    const inherited = await screen.findByTestId('delegate-grant-optimist');
    expect(within(inherited).getByTestId('delegate-grant-inherited')).toHaveTextContent('from the role');
    expect(within(inherited).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(
      within(screen.getByTestId('delegate-grant-cost-hawk')).getByRole('button', {
        name: 'Remove Cost Hawk',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/come from the role builder/)).toBeInTheDocument();
  });

  it('lists and edits a role’s grants at /api/roles/<key>/..., with the role wording', async () => {
    const calls = stub({
      ownerKind: 'role',
      ownerId: ID(2),
      canManage: true,
      roleKey: 'builder',
      grants: [],
    });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="role" ownerId="builder" />);
    expect(screen.getByTestId('delegate-grants-toggle')).toHaveTextContent(
      'Who agents of this role may delegate to',
    );
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    expect(await screen.findByTestId('delegate-grants-none')).toHaveTextContent(
      'Agents of this role cannot delegate',
    );
    expect(screen.getByText(/the ones hired later too/)).toBeInTheDocument();
    expect(calls[0]?.url).toBe('/api/roles/builder/delegate-grants');
    await user.selectOptions(screen.getByLabelText('Delegation target'), 'persona:devils-advocate');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.url).toBe('/api/roles/builder/delegate-grants'),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      targetKind: 'persona',
      targetKey: 'devils-advocate',
      grant: { maxCalls: 4, timeoutSec: 110, maxProfile: null, model: null },
    });
  });

  it('shows the model a grant sets for the caller, and sends the one picked', async () => {
    const calls = stub({
      ownerKind: 'agent',
      ownerId: ID(1),
      canManage: true,
      roleKey: null,
      grants: [grant({ modelOverride: 'claude-code:haiku', model: 'claude-code:opus' })],
    });
    const user = userEvent.setup();
    view(<DelegateGrants ownerKind="agent" ownerId={ID(1)} />);
    await user.click(screen.getByTestId('delegate-grants-toggle'));
    expect(await screen.findByTestId('delegate-grant-model')).toHaveTextContent(
      'runs on claude-code:haiku for this caller',
    );
    await user.selectOptions(screen.getByLabelText('Delegation target'), 'persona:devils-advocate');
    const picker = screen.getByLabelText('Model for this caller') as HTMLSelectElement;
    const haiku = [...picker.options].find((o) => o.value === 'claude-code/haiku');
    expect(haiku).toBeTruthy();
    await user.selectOptions(picker, 'claude-code/haiku');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body.grant.model).toEqual({
      runtime: 'claude-code',
      model: 'haiku',
    });
  });
});
