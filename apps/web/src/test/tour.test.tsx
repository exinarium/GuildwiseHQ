import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TourProvider } from '../components/tour/Tour.tsx';
import { useTour } from '../components/tour/TourContext.tsx';
import { type TourRole, tourSteps } from '../lib/tour.ts';

const ALL_NAV = [
  'board',
  'research',
  'desk',
  'intake',
  'schedules',
  'projects',
  'interests',
  'ledger',
  'vaults',
  'agents',
  'org-chart',
  'org',
  'workstations',
  'metrics',
  'costs',
  'settings',
  'organization',
  'help',
];
const MEMBER_NAV = ALL_NAV.filter((n) => !['intake', 'vaults', 'costs'].includes(n));
const ids = (role: TourRole, nav: string[]) => tourSteps(role, new Set(nav)).map((s) => s.id);

describe('the tour steps', () => {
  it('Owner and Admin see every sidebar area, from the board to settings, then the palette and Help', () => {
    const steps = ids('manager', ALL_NAV);
    expect(steps).toEqual([
      'welcome',
      'board',
      'desk',
      'intake',
      'projects',
      'interests',
      'schedules',
      'agents',
      'org-chart',
      'workstations',
      'costs',
      'ledger',
      'vaults',
      'settings',
      'palette',
      'page-help',
      'help',
      'done',
    ]);
  });

  it('a Member has no Intake, Costs or Vaults step', () => {
    const steps = ids('member', MEMBER_NAV);
    expect(steps).toContain('workstations');
    expect(steps).toContain('interests');
    for (const gone of ['intake', 'costs', 'vaults']) expect(steps).not.toContain(gone);
  });

  it('a Guest gets the short tour', () => {
    const steps = ids('guest', MEMBER_NAV);
    expect(steps).toEqual([
      'welcome',
      'board',
      'desk',
      'workstations',
      'interests',
      'settings',
      'palette',
      'page-help',
      'help',
      'done',
    ]);
    expect(tourSteps('guest', new Set(MEMBER_NAV))[0]?.body).toMatch(/invited/);
  });

  it('a platform administrator gets the platform area, not the work sidebar', () => {
    const steps = tourSteps('platform', new Set());
    expect(steps.map((s) => s.id)).toEqual([
      'welcome',
      'platform-orgs',
      'platform-invitations',
      'platform-users',
      'platform-support',
      'platform-audit',
      'page-help',
      'platform-help',
      'done',
    ]);
    expect(steps.some((s) => s.target?.startsWith('nav-'))).toBe(false);
  });

  it('never points at an area the user does not have', () => {
    const only = ids('manager', ['board', 'desk', 'help']);
    expect(only).not.toContain('intake');
    expect(only).toContain('board');
  });

  it('every step has a title and text, and the Add a workstation step names the wizard', () => {
    for (const role of ['manager', 'member', 'guest', 'platform'] as const)
      for (const s of tourSteps(role, new Set(ALL_NAV))) {
        expect(s.title.length).toBeGreaterThan(2);
        expect(s.body.length).toBeGreaterThan(20);
      }
    expect(tourSteps('manager', new Set(ALL_NAV)).find((s) => s.id === 'workstations')?.body).toMatch(
      /Add a workstation/,
    );
  });
});

// ---------------------------------------------------------------- the component

const U = '0192f3a0-0000-7000-8000-000000000001';
let me: MeResponse;
let workstations: unknown[];
const puts: Array<{ status: string; step: number }> = [];
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

const makeMe = (tour: unknown, over: Record<string, unknown> = {}) =>
  ({
    user: {
      id: U,
      email: 'me@example.test',
      displayName: 'Me',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      ...(tour ? { tour } : {}),
    },
    account: { kind: 'user' },
    isAdmin: true,
    activeOrg: { id: U, name: 'Acme', role: 'owner', status: 'active' },
    visibleProjectIds: [],
    features: { mockUi: false },
    ...over,
  }) as unknown as MeResponse;

beforeEach(() => {
  puts.length = 0;
  workstations = [{ id: U, status: 'active' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/me') return json(me);
      if (url === '/api/auth/tour' && init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        me = { ...me, user: { ...me.user, tour: body } } as MeResponse;
        return json(me);
      }
      if (url === '/api/workstations') return json({ workstations });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const NAV = new Set(['board', 'desk', 'workstations', 'settings', 'help']);

function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
function Replay() {
  const t = useTour();
  return (
    <>
      <button type="button" onClick={t.start}>
        replay
      </button>
      <button type="button" onClick={t.resume}>
        resume
      </button>
      <p data-testid="state">{`${t.status}:${t.step}`}</p>
    </>
  );
}

function mount(opts: { mobile?: boolean; onDrawer?: (o: boolean) => void } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TourProvider
          navIds={NAV}
          mobile={opts.mobile ?? false}
          {...(opts.onDrawer ? { onDrawer: opts.onDrawer } : {})}
        >
          <a href="/x" data-tour="nav-board">
            Board
          </a>
          <Replay />
          <Where />
        </TourProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the first-login tour', () => {
  it('opens for a user who never saw it, steps with Next and Back, and remembers the step', async () => {
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    const dlg = await screen.findByRole('dialog');
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome to Guildwise HQ');
    expect(screen.getByTestId('tour-progress')).toHaveTextContent(/Step 1 of \d+/);
    expect(dlg).toHaveAccessibleName('Welcome to Guildwise HQ');
    expect(screen.queryByTestId('tour-back')).toBeNull();
    await waitFor(() => expect(puts[0]).toEqual({ status: 'in_progress', step: 0 }));

    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Board');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    expect(puts.at(-1)).toEqual({ status: 'in_progress', step: 1 });
    await user.click(screen.getByTestId('tour-back'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome');
    expect(puts.at(-1)).toEqual({ status: 'in_progress', step: 0 });
  });

  it('Skip dismisses it for good and Esc does the same; Resume carries on from the saved step', async () => {
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('tour-next'));
    await user.click(screen.getByTestId('tour-next'));
    await user.click(screen.getByTestId('tour-skip'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts.at(-1)).toEqual({ status: 'dismissed', step: 2 });
    expect(screen.getByTestId('state')).toHaveTextContent('dismissed:2');

    await user.click(screen.getByText('resume'));
    expect(await screen.findByTestId('tour-progress')).toHaveTextContent(/Step 3 of/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts.at(-1)).toEqual({ status: 'dismissed', step: 2 });

    await user.click(screen.getByText('replay'));
    expect(await screen.findByTestId('tour-progress')).toHaveTextContent(/Step 1 of/);
  });

  it('does not open for a user who completed or skipped it, nor when the server sends no tour state', async () => {
    for (const tour of [{ status: 'completed', step: 5 }, { status: 'dismissed', step: 1 }, null]) {
      me = makeMe(tour);
      const view = mount();
      await screen.findByTestId('state');
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByRole('dialog')).toBeNull();
      view.unmount();
    }
    expect(puts).toHaveLength(0);
  });

  it('does not pop up again for an interrupted tour (new login, other device); Help resumes it', async () => {
    me = makeMe({ status: 'in_progress', step: 3 });
    const user = userEvent.setup();
    mount();
    await screen.findByTestId('state');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toHaveLength(0);
    await user.click(screen.getByText('resume'));
    expect(await screen.findByTestId('tour-progress')).toHaveTextContent(/Step 4 of/);
  });

  it('ends with Finish, stored as completed, and offers Add a workstation to a user who has none', async () => {
    me = makeMe({ status: 'in_progress', step: 100 });
    workstations = [];
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByText('resume'));
    expect(await screen.findByTestId('tour-offer')).toHaveTextContent('Add a workstation');
    await user.click(screen.getByTestId('tour-offer'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent('/workstations?add=1');
    expect(puts.at(-1)?.status).toBe('completed');
  });

  it('finishes quietly when there is a workstation', async () => {
    me = makeMe({ status: 'in_progress', step: 100 });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByText('resume'));
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('tour-offer')).toBeNull();
    await user.click(screen.getByTestId('tour-next'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts.at(-1)).toEqual({ status: 'completed', step: expect.any(Number) });
    expect(screen.getByTestId('state')).toHaveTextContent(/^completed:/);
  });

  it('opens the menu drawer on a phone for the steps that point into the sidebar', async () => {
    me = makeMe({ status: 'new', step: 0 });
    const onDrawer = vi.fn();
    const user = userEvent.setup();
    mount({ mobile: true, onDrawer });
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('tour-next'));
    await waitFor(() => expect(onDrawer).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByTestId('tour-skip'));
    await waitFor(() => expect(onDrawer).toHaveBeenLastCalledWith(false));
  });

  it('the guest tour is chosen from the role of the tab', async () => {
    me = makeMe({ status: 'new', step: 0 }, { activeOrg: null });
    mount();
    expect(await screen.findByRole('dialog')).toHaveTextContent(/invited to work on someone else/);
  });
});
