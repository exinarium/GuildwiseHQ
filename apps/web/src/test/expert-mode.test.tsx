import type { CardDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalizePanel } from '../components/FinalizePanel.tsx';
import { useExpertMode } from '../lib/expert-mode.ts';
import { landingText } from '../lib/outcomes.ts';
import { plainOutcomeLabel } from '../lib/phases.ts';
import { Settings } from '../pages/Settings.tsx';

type Finalize = NonNullable<CardDetailResponse['testing']>['finalize'];
const finalize: Finalize = {
  available: true,
  action: 'pr',
  requiresApproval: false,
  state: 'idle',
  deskItemId: null,
  lastError: null,
};

function clientWith(expert?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (expert !== undefined) qc.setQueryData(['me'], { user: { gitExpert: expert } });
  return qc;
}
const renderWith = (ui: React.ReactNode, qc: QueryClient) =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

function Probe() {
  return <span data-testid="probe">{String(useExpertMode())}</span>;
}

describe('useExpertMode', () => {
  it('is off without a query client, before me is loaded and for a user who did not turn it on', () => {
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
    unmount();
    const a = renderWith(<Probe />, clientWith());
    expect(screen.getByTestId('probe').textContent).toBe('false');
    a.unmount();
    renderWith(<Probe />, clientWith(false));
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('is on once the user turned it on, and follows a change', async () => {
    const qc = clientWith(false);
    renderWith(<Probe />, qc);
    qc.setQueryData(['me'], { user: { gitExpert: true } });
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('true'));
  });
});

describe('plain outcomes', () => {
  it('says what happens to a change without naming branches', () => {
    const base = { status: 'waiting' as const, baseBranch: 'main', finalizedAt: null };
    expect(landingText({ ...base, effectiveCompletionAction: 'merge' })).toBe(
      'Goes into main after review and test',
    );
    expect(landingText({ ...base, status: 'done', effectiveCompletionAction: 'merge' })).toBe(
      'Your change is live on main',
    );
    expect(landingText({ ...base, status: 'done', effectiveCompletionAction: 'pr' })).toBe(
      'Waiting for you to merge the pull request',
    );
    expect(landingText({ ...base, effectiveCompletionAction: null })).toBe(
      'Goes into main after review and test',
    );
    expect(plainOutcomeLabel('finalized', 'https://x/pr/1', false)).toBe(
      'waiting for you to merge the pull request',
    );
    expect(plainOutcomeLabel('finalized', 'https://x/pr/1', true)).toBe('live on main');
    expect(plainOutcomeLabel('finalized')).toBe('live on main');
  });
});

describe('finalize panel in simple and expert mode', () => {
  it('simple mode says where the change goes and offers no completion choice', () => {
    renderWith(
      <FinalizePanel cardId="c1" finalize={finalize} completionAction="pr" canAct />,
      clientWith(false),
    );
    expect(screen.queryByTestId('finalize-action')).toBeNull();
    expect(screen.getByTestId('finalize-plain-action').textContent).toContain('pull request');
    expect(screen.getByTestId('finalize-button')).toBeInTheDocument();
  });

  it('expert mode keeps the completion select', () => {
    renderWith(
      <FinalizePanel cardId="c1" finalize={finalize} completionAction="pr" canAct />,
      clientWith(true),
    );
    expect(screen.getByTestId('finalize-action')).toBeInTheDocument();
    expect(screen.queryByTestId('finalize-plain-action')).toBeNull();
  });
});

describe('Settings: expert mode switch', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default and saves the user own choice', async () => {
    const meBody = (gitExpert: boolean) => ({
      user: {
        id: '0192f3a0-0000-7000-8000-000000000001',
        email: 'm@example.com',
        displayName: 'Mia',
        kind: 'user',
        twoFactorEnabled: false,
        status: 'active',
        createdAt: '2026-10-01T10:00:00.000Z',
        lastLoginAt: null,
        timezone: 'UTC',
        gitExpert,
      },
      account: { kind: 'user' },
      isAdmin: false,
      orgs: [],
      activeOrg: null,
      guestIn: [],
      guestProjectIds: [],
      pendingInvitations: 0,
      twoFactor: { enabled: false, required: false, setupRequired: false },
      visibleProjectIds: [],
      features: { mockUi: false },
    });
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/auth/git-expert')) {
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
        return json(meBody(true));
      }
      if (String(url).endsWith('/auth/me')) return json(meBody(false));
      if (String(url).endsWith('/reporting'))
        return json({
          dailyAt: '08:00',
          timezone: 'UTC',
          canEdit: true,
          quietHoursCap: null,
        });
      return json({});
    });
    renderWith(<Settings />, clientWith());
    const box = (await screen.findByTestId('git-expert')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    await waitFor(() => expect((screen.getByTestId('git-expert') as HTMLInputElement).checked).toBe(true));
  });
});
