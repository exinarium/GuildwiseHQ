import {
  BUSINESS_CARD_FIELDS,
  BUSINESS_CARD_TYPE_LABELS,
  BUSINESS_CARD_TYPES,
  businessWorkflow,
  type CardDetailResponse,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { CardDetailView } from '../pages/CardDetail.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-01T10:00:00.000Z';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let mode: 'dev' | 'business' = 'business';
beforeEach(() => {
  mode = 'business';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/api/auth/me' || path === '/api/me')
        return json({
          user: { id: ID(1), email: 'o@x.test', displayName: 'Olga', kind: 'user', status: 'active' },
          account: { kind: 'user' },
          isAdmin: true,
          orgs: [{ id: ID(1), name: 'Org', role: 'owner', status: 'active' }],
          activeOrg: {
            id: ID(1),
            name: 'Org',
            role: 'owner',
            status: 'active',
            features: {},
            mode,
            banners: [],
          },
          guestIn: [],
          guestProjectIds: [],
          visibleProjectIds: [],
          pendingInvitations: 0,
          twoFactor: { enabled: false, required: false, setupRequired: false },
          features: { mockUi: false },
        });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function open(type: (typeof BUSINESS_CARD_TYPES)[number]) {
  const wf = businessWorkflow(type);
  const fields = Object.fromEntries(
    BUSINESS_CARD_FIELDS[type].map((f) => [
      f.key,
      f.type === 'number' ? 1200 : f.format === 'date' ? '2026-12-15' : `${f.key} value`,
    ]),
  );
  const data = {
    card: {
      id: ID(10),
      ref: 'OFFICE-4',
      title: `A ${type}`,
      cardType: type,
      stage: 'request',
      status: 'draft',
      assignee: null,
      updatedAt: NOW,
      queuedAt: null,
      riskTier: null,
      blocked: false,
      reworkRound: 0,
      priority: 3,
      projectId: ID(70),
      number: 4,
      workflowKey: wf.key,
      workflowVersion: 1,
      column: 'Request',
      fields,
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
    },
    handoffs: [],
    transitions: [],
    activity: [],
    threadId: ID(11),
    thread: [],
    currentShift: null,
    permissions: {
      canEdit: false,
      canSpecify: false,
      canMove: true,
      canRelease: false,
      canCancel: true,
      canComment: true,
    },
    blockers: [],
  } as unknown as CardDetailResponse;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <CardDetailView data={data} workflow={wf} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return fields;
}

describe('the fields of a business card on the card page', () => {
  it.each(BUSINESS_CARD_TYPES)('%s shows every field with its label and value', async (type) => {
    const fields = open(type);
    const spec = await screen.findByTestId('card-spec');
    for (const f of BUSINESS_CARD_FIELDS[type]) {
      expect(within(spec).getByText(f.label)).toBeInTheDocument();
      expect(within(spec).getByText(String(fields[f.key]))).toBeInTheDocument();
    }
    expect(screen.getAllByText(BUSINESS_CARD_TYPE_LABELS[type]).length).toBeGreaterThan(0);
  });

  it('calls the panel Details in a business organization', async () => {
    open('quote');
    await screen.findByTestId('card-spec');
    await waitFor(() => expect(screen.queryByText('What to build')).toBeNull());
    expect(
      within(screen.getByTestId('card-spec')).getByRole('heading', { name: 'Details' }),
    ).toBeInTheDocument();
  });
});
