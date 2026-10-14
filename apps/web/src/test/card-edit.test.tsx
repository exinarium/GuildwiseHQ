import { type CardDetailResponse, codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPatchRequest, formValuesFromCard } from '../lib/cardForm.ts';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-05-01T10:00:00.000Z';
const USER = ID(1);

afterEach(() => vi.unstubAllGlobals());

const baseCard: CardDetailResponse['card'] = {
  id: ID(10),
  projectId: ID(2),
  number: 7,
  ref: 'TOY-7',
  title: 'Add greeting',
  cardType: 'feature',
  workflowKey: 'code',
  workflowVersion: 1,
  stage: 'spec',
  status: 'draft',
  column: 'Spec',
  fields: {
    context: 'Say hello',
    requirements: 'A greeting',
    acceptanceCriteria: ['It greets', 'It is polite'],
    mock: { build: ['ok'] },
    mockEnv: 'docker_missing',
  },
  ownerUserId: USER,
  decisionPolicy: 'owner_only',
  riskTier: null,
  riskTierOverridden: false,
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
};

const data = (over: Partial<CardDetailResponse> = {}): CardDetailResponse => ({
  card: baseCard,
  handoffs: [],
  transitions: [
    {
      id: 1,
      fromStage: null,
      toStage: 'spec',
      fromStatus: null,
      toStatus: 'draft',
      agentId: null,
      userId: USER,
      reason: 'CardCreated',
      at: '2026-05-01T09:00:00.000Z',
    },
  ],
  activity: [],
  threadId: baseCard.id,
  thread: [],
  currentShift: null,
  permissions: {
    canEdit: true,
    canSpecify: true,
    canMove: true,
    canRelease: false,
    canCancel: true,
    canComment: true,
    canSetRisk: true,
  },
  blockers: [],
  ...over,
});

const ME = {
  user: { id: USER, email: 'o@x.test', displayName: 'Owner', role: 'member', status: 'active' },
  isAdmin: false,
  visibleProjectIds: [],
};

/** Routes the few calls the card page makes; records PATCHes. */
function stubFetch(mockUi: boolean, patchReply: () => Response = () => new Response('{}', { status: 200 })) {
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return new Response(JSON.stringify({ ...ME, features: { mockUi } }));
      if (url.startsWith('/api/projects/'))
        return new Response(
          JSON.stringify({
            project: { id: ID(2) },
            repos: [{ id: ID(3), name: 'toy', removedAt: null }],
            members: [],
          }),
        );
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return patchReply();
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return patches;
}

function renderCard(d: CardDetailResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardDetailView data={d} workflow={codeWorkflowV1} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('card details and mock fields', () => {
  it('hides the mock JSON in the Details panel when mock mode is off', async () => {
    stubFetch(false);
    renderCard(data());
    expect(await screen.findByText('Say hello')).toBeInTheDocument();
    expect(screen.queryByText('Mock script')).toBeNull();
    expect(screen.queryByText('Mock test environment')).toBeNull();
    expect(screen.queryByText(/"build"/)).toBeNull();
  });

  it('shows it in mock mode', async () => {
    stubFetch(true);
    renderCard(data());
    expect(await screen.findByText('Mock script')).toBeInTheDocument();
    expect(screen.getByText('Mock test environment')).toBeInTheDocument();
  });
});

describe('editing a card', () => {
  it('offers Edit only when the server says the card can be edited', () => {
    stubFetch(false);
    renderCard(data({ permissions: { ...data().permissions, canEdit: false } }));
    expect(screen.queryByTestId('edit-card')).toBeNull();
  });

  it('opens the form prefilled, validates like New card, and saves a patch', async () => {
    const patches = stubFetch(false);
    const user = renderCard(data());
    await user.click(screen.getByTestId('edit-card'));
    const form = await screen.findByRole('form', { name: 'Edit card' });
    const title = within(form).getByLabelText('Title');
    expect(title).toHaveValue('Add greeting');
    expect(within(form).getByLabelText('Acceptance criteria')).toHaveValue('It greets\nIt is polite');
    expect(within(form).queryByLabelText('Mock script')).toBeNull();

    await user.clear(title);
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByText('Title is required')).toBeInTheDocument();
    expect(patches).toHaveLength(0);

    await user.type(title, 'Add a polite greeting');
    await user.clear(within(form).getByLabelText('Requirements'));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      title: 'Add a polite greeting',
      priority: 3,
      completionAction: 'merge',
      repoId: ID(3),
      fields: { context: 'Say hello', requirements: null, acceptanceCriteria: ['It greets', 'It is polite'] },
    });
    expect(patches[0]?.fields).not.toHaveProperty('mock');
  });

  it('says why when the server refuses (a claimed card)', async () => {
    stubFetch(
      false,
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'card_claimed', message: 'TOY-7 is being worked on right now: release it first' },
          }),
          { status: 409 },
        ),
    );
    const user = renderCard(data());
    await user.click(screen.getByTestId('edit-card'));
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('edit-refused')).toHaveTextContent('being worked on');
  });
});

describe('risk tier override', () => {
  it('asks for a reason, then sends the tier with it', async () => {
    const patches = stubFetch(false);
    const user = renderCard(data());
    await user.click(screen.getByTestId('set-risk'));
    const form = await screen.findByRole('form', { name: 'Risk tier' });
    await user.selectOptions(within(form).getByLabelText('Risk tier'), 'large');
    await user.click(within(form).getByRole('button', { name: 'Set risk tier' }));
    expect(within(form).getByText('A reason is required')).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.type(within(form).getByLabelText('Reason'), 'Touches payments');
    await user.click(within(form).getByRole('button', { name: 'Set risk tier' }));
    await waitFor(() => expect(patches).toEqual([{ riskTier: 'large', reason: 'Touches payments' }]));
  });

  it('shows the override and lets it go back to the computed tier', async () => {
    const patches = stubFetch(false);
    const d = data();
    const user = renderCard({ ...d, card: { ...d.card, riskTier: 'large', riskTierOverridden: true } });
    expect(screen.getByTestId('risk-tier')).toHaveTextContent('large');
    expect(screen.getByTestId('risk-tier')).toHaveTextContent('override');
    await user.click(screen.getByTestId('set-risk'));
    const form = await screen.findByRole('form', { name: 'Risk tier' });
    await user.selectOptions(within(form).getByLabelText('Risk tier'), 'computed');
    await user.type(within(form).getByLabelText('Reason'), 'Fine after all');
    await user.click(within(form).getByRole('button', { name: 'Set risk tier' }));
    await waitFor(() => expect(patches).toEqual([{ riskTier: null, reason: 'Fine after all' }]));
  });

  it('is not offered when the server says no', () => {
    stubFetch(false);
    renderCard(data({ permissions: { ...data().permissions, canSetRisk: false } }));
    expect(screen.queryByTestId('set-risk')).toBeNull();
  });
});

describe('timeline', () => {
  it('shows edits and overrides between the transitions, in time order', () => {
    stubFetch(false);
    renderCard(
      data({
        activity: [
          {
            id: 2,
            kind: 'risk_tier',
            summary: 'Risk tier set to large by override (was small)',
            reason: 'Touches payments',
            userId: USER,
            agentId: null,
            actorName: 'Owner',
            at: '2026-05-01T09:30:00.000Z',
          },
          {
            id: 1,
            kind: 'edited',
            summary: 'Edited title, requirements',
            reason: null,
            userId: USER,
            agentId: null,
            actorName: 'Owner',
            at: '2026-05-01T09:10:00.000Z',
          },
        ],
      }),
    );
    const rows = within(screen.getByTestId('timeline')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Edited title, requirements');
    expect(rows[2]).toHaveTextContent('Risk tier set to large by override (was small)');
    expect(rows[2]).toHaveTextContent('Reason: Touches payments');
    expect(rows[2]).toHaveTextContent('Owner');
  });
});

describe('edit form helpers', () => {
  it('round-trips list and json fields and nulls an emptied field', () => {
    const v = formValuesFromCard(codeWorkflowV1, baseCard, true);
    expect(v.fields.acceptanceCriteria).toBe('It greets\nIt is polite');
    expect(JSON.parse(v.fields.mock ?? '')).toEqual({ build: ['ok'] });
    const { patch, errors } = buildPatchRequest(
      codeWorkflowV1,
      { ...v, fields: { ...v.fields, context: '' } },
      baseCard,
      true,
    );
    expect(errors).toEqual({});
    expect(patch.fields).toMatchObject({ context: null, mock: { build: ['ok'] } });
  });

  it('a queued card must keep the fields its stage needs', () => {
    const v = formValuesFromCard(codeWorkflowV1, baseCard);
    const { errors } = buildPatchRequest(codeWorkflowV1, v, { ...baseCard, status: 'queued' });
    expect(Object.keys(errors)).toContain('affectedAreas');
  });
});

describe('priority and completion action in place (#54)', () => {
  const claimed = (over: Partial<CardDetailResponse['permissions']> = {}) =>
    data({
      card: { ...baseCard, status: 'claimed', stage: 'build', priority: 5 },
      permissions: {
        ...data().permissions,
        canEdit: false,
        canEditPriority: true,
        canEditCompletion: true,
        ...over,
      },
    });

  it('patch directly on a claimed card, with the hint, and no Edit button', async () => {
    const patches = stubFetch(false);
    const user = renderCard(claimed());
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.getByTestId('completion-hint')).toHaveTextContent('Applies to the next finalise');
    await user.selectOptions(screen.getByTestId('card-priority'), '1');
    await waitFor(() => expect(patches).toContainEqual({ priority: 1 }));
    await user.selectOptions(screen.getByTestId('card-completion'), 'pr');
    await waitFor(() => expect(patches).toContainEqual({ completionAction: 'pr' }));
    await user.selectOptions(screen.getByTestId('card-completion'), '');
    await waitFor(() => expect(patches).toContainEqual({ completionAction: null }));
  });

  it('shows plain text when the server says the completion action is locked', () => {
    stubFetch(false);
    renderCard(claimed({ canEditCompletion: false }));
    expect(screen.getByTestId('card-priority')).toBeInTheDocument();
    expect(screen.queryByTestId('card-completion')).toBeNull();
  });

  it('shows the server refusal next to the control', async () => {
    stubFetch(
      false,
      () =>
        new Response(JSON.stringify({ error: { code: 'finalize_pending', message: 'settle it first' } }), {
          status: 409,
        }),
    );
    const user = renderCard(claimed());
    await user.selectOptions(screen.getByTestId('card-completion'), 'pr');
    expect(await screen.findByText(/settle it first/)).toBeInTheDocument();
  });
});
