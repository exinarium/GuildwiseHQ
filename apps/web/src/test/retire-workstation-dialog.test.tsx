import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { RetireWorkstationDialog } from '../components/workstations/RetireWorkstationDialog.tsx';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const WS = ID(10);
const WS_Y = ID(11);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agent = (n: number, name: string) => ({ id: ID(100 + n), name, roleKey: 'builder' });
const runtimes = [{ id: 'mock', version: '1', available: true, capabilities: ['shell'] }];

let role = 'owner';
let previewBody: Record<string, unknown>;
let retireReply: { status: number; body: unknown };
let posted: any;
const fetchMock = vi.fn();

const basePreview = () => ({
  workstation: { id: WS, name: 'My workstation', status: 'unlinked', mine: true },
  agents: [
    { ...agent(1, 'Una'), status: 'active', otherOrg: false },
    { ...agent(2, 'Dora'), status: 'active', otherOrg: false },
  ],
  devops: [],
  working: [],
  homedCards: [],
  canUnpair: false,
});

beforeEach(() => {
  role = 'owner';
  posted = undefined;
  previewBody = basePreview();
  retireReply = {
    status: 200,
    body: {
      workstationId: WS,
      unlinked: false,
      handover: 'move',
      moved: [agent(1, 'Una')],
      needsRehome: [],
      retiredDevops: [],
      rehomedCardIds: [],
    },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0]!;
    if (path === `/api/workstations/${WS}/retire-preview`) return json(previewBody);
    if (path === `/api/workstations/${WS}/move-targets`)
      return json({
        current: { id: WS, name: 'My workstation', state: 'unpaired' },
        workstations: [
          {
            id: WS_Y,
            name: 'Desk',
            ownerUserId: USER,
            ownerName: 'Olga',
            mine: true,
            connected: true,
            runtimes,
          },
        ],
      });
    if (path === `/api/workstations/${WS}/retire` && init?.method === 'POST') {
      posted = JSON.parse(String(init.body));
      return json(retireReply.body, retireReply.status);
    }
    if (path === '/api/agents/workstations')
      return json({
        workstations: [
          {
            id: WS,
            name: 'My workstation',
            status: 'unlinked',
            connected: false,
            ownerName: 'Olga',
            mine: true,
            agentCount: 2,
            runningCount: 0,
          },
        ],
      });
    if (path === '/api/workstations') return json({ workstations: [] });
    if (path === '/api/auth/me')
      return json({
        user: {
          id: USER,
          email: 'o@x.test',
          displayName: 'Olga',
          kind: 'user',
          twoFactorEnabled: false,
          status: 'active',
          createdAt: '2026-10-01T10:00:00.000Z',
          lastLoginAt: null,
        },
        account: { kind: 'user' },
        isAdmin: true,
        orgs: [{ id: USER, name: 'Olga org', role, status: 'active' }],
        activeOrg: {
          id: USER,
          name: 'Olga org',
          role,
          status: 'active',
          plan: 'founding',
          planName: 'Founding',
          features: {},
          banners: [],
        },
        guestIn: [],
        guestProjectIds: [],
        visibleProjectIds: [],
        pendingInvitations: 0,
        twoFactor: { enabled: false, required: false, setupRequired: false },
        mustChangePassword: false,
        features: { mockUi: false },
      });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const open = () =>
  wrap(<RetireWorkstationDialog workstation={{ id: WS, name: 'My workstation' }} onClose={() => {}} />);

describe('retire workstation dialog', () => {
  it('lists the agents and offers both handovers; move posts the chosen target', async () => {
    open();
    expect(await screen.findByTestId('retire-agents')).toHaveTextContent('Una');
    expect(screen.getByRole('radio', { name: /Move its agents/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /needing a new home/ })).toBeVisible();
    expect(await screen.findByRole('option', { name: /Desk/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(posted).toEqual({ handover: 'move', targetWorkstationId: WS_Y }));
  });

  it('needs_rehome posts that choice without a target', async () => {
    open();
    await userEvent.click(await screen.findByRole('radio', { name: /needing a new home/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(posted).toEqual({ handover: 'needs_rehome' }));
  });

  it('a workstation with no agents is retired directly, without a choice', async () => {
    previewBody = { ...basePreview(), agents: [] };
    open();
    expect(await screen.findByTestId('retire-no-agents')).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(posted).toEqual({}));
  });

  it('agents in a running shift are listed and Retire is disabled', async () => {
    previewBody = { ...basePreview(), working: [{ ...agent(1, 'Una'), cardRef: 'GWP-12' }] };
    open();
    expect(await screen.findByTestId('retire-working')).toHaveTextContent('Una (GWP-12)');
    expect(screen.getByRole('button', { name: 'Retire' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  it('a refusal from the server is shown in the dialog with the agent names', async () => {
    retireReply = {
      status: 409,
      body: {
        error: {
          code: 'handover_incomplete',
          message: 'These agents cannot move to Desk',
          details: {
            failed: [
              { id: ID(101), name: 'Una', code: 'runtime_missing', message: 'Desk has no ghost runtime' },
            ],
          },
        },
      },
    };
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    expect(await screen.findByTestId('retire-failed')).toHaveTextContent('Una: Desk has no ghost runtime');
  });

  it('with no other workstation the move choice is disabled', async () => {
    const orig = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith(`/api/workstations/${WS}/move-targets`)
        ? json({ current: { id: WS, name: 'My workstation', state: 'unpaired' }, workstations: [] })
        : orig(url, init),
    );
    open();
    expect(await screen.findByTestId('retire-no-targets')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Move its agents/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /needing a new home/ })).toBeChecked();
  });
});

describe('removed workstations with agents (Workstations page)', () => {
  it.each(['owner', 'admin'])('%s sees the section and can open the dialog', async (r) => {
    role = r;
    wrap(<Workstations />);
    const section = await screen.findByTestId('stranded-workstations');
    expect(section).toHaveTextContent('My workstation (Olga), 2 agents');
    await userEvent.click(screen.getByRole('button', { name: 'Hand over agents of My workstation' }));
    expect(await screen.findByText('Retire My workstation?')).toBeVisible();
  });

  it('the move-all result stays visible after the refetch drops the emptied workstation', async () => {
    let moved = false;
    const orig = fetchMock.getMockImplementation()!;
    const ref = { agentId: ID(101), name: 'Una' };
    const body = (dryRun: boolean) => ({
      dryRun,
      scope: 'all',
      source: { id: WS, name: 'My workstation', status: 'unlinked', connected: false },
      target: { id: WS_Y, name: 'Desk' },
      moved: [{ ...ref, releasedClaims: [] }],
      blocked: [
        {
          agentId: ID(102),
          name: 'Devon',
          reason: 'one_devops',
          code: 'one_devops_per_workstation',
          message: 'Desk already has a DevOps engineer',
        },
      ],
      needsUnsandboxedAck: false,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      if (path === `/api/workstations/${WS}/move-agents/preview`) return json(body(true));
      if (path === `/api/workstations/${WS}/move-agents` && init?.method === 'POST') {
        moved = true;
        return json(body(false));
      }
      if (moved && path === '/api/agents/workstations') return json({ workstations: [] });
      return orig(url, init);
    });
    wrap(<Workstations />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move 1 agent' }));
    const result = await screen.findByTestId('move-all-result');
    expect(result).toHaveTextContent('1 moved to Desk, 1 not moved');
    expect(screen.getByTestId('move-all-not-moved')).toHaveTextContent('Devon');
    expect(screen.getByTestId('move-all-not-moved')).toHaveTextContent('DevOps engineer');
    // the homes list is refetched without the workstation; the result must remain
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/agents/workstations')).length,
      ).toBeGreaterThan(1),
    );
    expect(screen.getByTestId('move-all-result')).toBeVisible();
    expect(screen.queryByTestId('stranded-workstations')).not.toBeNull();
  });

  it('a member sees no section', async () => {
    role = 'member';
    wrap(<Workstations />);
    await screen.findByText('Workstations');
    await waitFor(() => expect(screen.queryByTestId('stranded-workstations')).toBeNull());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/agents/workstations'))).toBe(false);
  });
});
