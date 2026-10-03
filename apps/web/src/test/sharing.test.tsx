import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembersPanel } from '../components/MembersPanel.tsx';
import { ProjectInvitations } from '../components/ProjectInvitations.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const U1 = '0192f3a0-0000-7000-8000-0000000000a1';
const U2 = '0192f3a0-0000-7000-8000-0000000000a2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('project invitations inbox', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing without pending shares', async () => {
    fetchMock.mockResolvedValue(json({ invitations: [] }));
    const { container } = wrap(<ProjectInvitations />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a pending share and accepts it', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/project-invitations')
        return json({
          invitations: [
            {
              projectId: PROJECT,
              projectKey: 'TOY',
              projectName: 'Toy',
              invitedByName: 'Olga',
              invitedAt: null,
            },
          ],
        });
      if (url === `/api/projects/${PROJECT}/members/accept` && init?.method === 'POST') return json({});
      return json({}, 404);
    });
    const user = userEvent.setup();
    wrap(<ProjectInvitations />);
    const row = await screen.findByTestId('invitation-TOY');
    expect(row).toHaveTextContent('Olga invited you to manage TOY Toy');
    await user.click(within(row).getByRole('button', { name: 'Accept invitation to TOY' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT}/members/accept`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

describe('members panel', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const members = [
    {
      userId: U1,
      displayName: 'Olga',
      email: 'olga@example.test',
      role: 'owner' as const,
      status: 'active' as const,
    },
    {
      userId: U2,
      displayName: 'Max',
      email: 'max@example.test',
      role: 'manager' as const,
      status: 'invited' as const,
    },
  ];

  it('members cannot invite or remove', () => {
    wrap(<MembersPanel projectId={PROJECT} members={members} isOwner={false} />);
    expect(screen.queryByRole('form', { name: 'Invite member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove|Cancel invitation/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('member-max@example.test')).toHaveTextContent('pending');
  });

  it('validates the email before calling the API, then invites', async () => {
    fetchMock.mockResolvedValue(json({}, 201));
    const user = userEvent.setup();
    wrap(<MembersPanel projectId={PROJECT} members={members} isOwner />);
    await user.type(screen.getByLabelText('Invite by email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Enter the email of an existing user')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Invite by email'));
    await user.type(screen.getByLabelText('Invite by email'), 'new@example.test');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT}/members`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'new@example.test' }) }),
      ),
    );
  });

  it('removal shows what the owner inherits before confirming', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/projects/${PROJECT}/members/${U2}/removal-preview`)
        return json({
          userId: U2,
          displayName: 'Max',
          status: 'active',
          agents: [
            { id: U1, name: 'Mia', roleKey: 'builder', workstationName: 'laptop', claimedCardRef: 'TOY-2' },
          ],
          releasedCards: [{ ref: 'TOY-2', title: 'Rework card' }],
          transferredCards: [{ ref: 'TOY-5', title: 'Max card', status: 'queued' }],
        });
      if (url === `/api/projects/${PROJECT}/members/${U2}` && init?.method === 'DELETE')
        return json({ ok: true });
      return json({}, 404);
    });
    const user = userEvent.setup();
    wrap(<MembersPanel projectId={PROJECT} members={members} isOwner />);
    await user.click(screen.getByRole('button', { name: 'Cancel invitation for Max' }));
    const preview = await screen.findByTestId('removal-preview');
    expect(preview).toHaveTextContent('Agents you inherit (1)');
    expect(preview).toHaveTextContent('Mia');
    expect(preview).toHaveTextContent('holds TOY-2');
    expect(preview).toHaveTextContent('Cards released to the queue (1)');
    expect(preview).toHaveTextContent('Cards that become yours (1)');
    expect(preview).toHaveTextContent('TOY-5 Max card');
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${PROJECT}/members/${U2}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});

describe('live updates for M3 events', () => {
  it('maps vault, devops thread and project membership events to query keys', () => {
    expect(keysForEvent({ type: 'VaultSyncConflict', streamId: 'vault-1', projectId: null })).toContainEqual([
      'vaults',
    ]);
    expect(keysForEvent({ type: 'DevOpsRequested', streamId: 'thread-1', projectId: null })).toContainEqual([
      'devops',
    ]);
    const share = keysForEvent({ type: 'ProjectShareAccepted', streamId: 'project-1', projectId: 'p' });
    expect(share).toContainEqual(['project']);
    expect(share).toContainEqual(['project-invitations']);
  });
});
