import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNav } from '../components/shell/nav-config.ts';
import { TourProvider } from '../components/tour/Tour.tsx';
import { useTour } from '../components/tour/TourContext.tsx';
import { type TourRole, tourSteps } from '../lib/tour.ts';
import { resetVideoManifest } from '../lib/video-manifest.ts';
import { manifestOf } from './video-fixtures.ts';

const navIdsOf = (canManage: boolean) => [
  ...buildNav({ projectKey: 'P', hasResearch: true, hasEnvironments: true, canManage }).sections.flatMap(
    (x) => x.items.map((i) => i.id),
  ),
  ...buildNav({ projectKey: 'P', canManage }).footer.map((i) => i.id),
];
const ALL_NAV = navIdsOf(true);
const MEMBER_NAV = navIdsOf(false);
const ids = (role: TourRole, nav: string[]) => tourSteps(role, new Set(nav)).map((s) => s.id);

describe('the tour steps', () => {
  it('Owner and Admin see every sidebar area, from the board to settings, then the palette and Help', () => {
    const steps = ids('manager', ALL_NAV);
    expect(steps).toEqual([
      'video',
      'welcome',
      'board',
      'backlog',
      'environments',
      'research',
      'desk',
      'intake',
      'discovery',
      'boardroom',
      'schedules',
      'projects',
      'agents',
      'org-chart',
      'ceo',
      'org',
      'workstations',
      'releases',
      'integrations',
      'metrics',
      'costs',
      'interests',
      'ledger',
      'documents',
      'vaults',
      'capabilities',
      'settings',
      'organization',
      'palette',
      'page-help',
      'ask-devops',
      'help',
      'done',
    ]);
  });

  it('the first step of the Owner, Admin, Member and Guest tours is the training video; the platform tour has none', () => {
    for (const role of ['manager', 'member', 'guest'] as const) {
      const first = tourSteps(role, new Set(ALL_NAV))[0];
      expect(first).toMatchObject({ id: 'video', video: true, nextLabel: 'Next: take the tour' });
      expect(first?.title).toBe('Watch the 3-minute getting-started video');
    }
    expect(tourSteps('platform', new Set()).some((s) => s.video)).toBe(false);
  });

  it('a Member has no Intake, CEO, Costs or Vaults step, and has Capabilities (their own packs)', () => {
    const steps = ids('member', MEMBER_NAV);
    expect(steps).toContain('workstations');
    expect(steps).toContain('interests');
    for (const gone of ['intake', 'ceo', 'costs', 'vaults'])
      expect(steps).not.toContain(gone);
  });

  it('a Guest gets the short tour', () => {
    const steps = ids('guest', MEMBER_NAV);
    expect(steps).toEqual([
      'video',
      'welcome',
      'board',
      'desk',
      'workstations',
      'interests',
      'settings',
      'palette',
      'page-help',
      'ask-devops',
      'help',
      'done',
    ]);
    expect(tourSteps('guest', new Set(MEMBER_NAV))[1]?.body).toMatch(/invited/);
  });

  it('a platform administrator gets the platform area, not the work sidebar', () => {
    const steps = tourSteps('platform', new Set());
    expect(steps.map((s) => s.id)).toEqual([
      'welcome',
      'platform-orgs',
      'platform-invitations',
      'platform-users',
      'platform-billing',
      'platform-support',
      'platform-blog',
      'platform-api-keys',
      'platform-runners',
      'platform-team',
      'platform-inbound',
      'platform-audit',
      'page-help',
      'platform-help',
      'done',
    ]);
    expect(steps.some((s) => s.target?.startsWith('nav-'))).toBe(false);
  });

  it('every sidebar entry of an Owner has a step, in sidebar order', () => {
    const sidebar = ALL_NAV.filter((n) => n !== 'help');
    const steps = ids('manager', ALL_NAV).filter((id) => sidebar.includes(id));
    expect(steps).toEqual(sidebar);
  });

  it('every nav step targets a sidebar entry that buildNav can produce', () => {
    const real = new Set([...ALL_NAV, ...MEMBER_NAV]);
    for (const role of ['manager', 'member', 'guest'] as const)
      for (const s of tourSteps(role, real))
        if (s.target?.startsWith('nav-')) expect(real.has(s.target.slice(4))).toBe(true);
  });

  it('every platform step targets an entry of the platform navigation', () => {
    const platformNav = [
      'orgs',
      'invitations',
      'users',
      'billing',
      'support',
      'blog',
      'api-keys',
      'runners',
      'team',
      'inbound',
      'audit',
    ];
    for (const s of tourSteps('platform', new Set()))
      if (s.target?.startsWith('platform-nav-')) expect(platformNav).toContain(s.target.slice(13));
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
  videoInfo = null;
  mediaUp = true;
  resetVideoManifest();
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
      if (url === '/videos/manifest.json')
        return mediaUp ? json(manifestOf('getting-started')) : new Response('down', { status: 503 });
      if (url.split('?')[0] === '/videos/getting-started.json')
        return videoInfo ? json(videoInfo) : new Response('<html></html>', { status: 200 });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

let videoInfo: unknown = null;
/** False: the media service is down, so the manifest cannot be loaded. */
let mediaUp = true;
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
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Watch the 3-minute getting-started video');
    expect(screen.getByTestId('tour-progress')).toHaveTextContent(/Step 1 of \d+/);
    expect(dlg).toHaveAccessibleName('Watch the 3-minute getting-started video');
    expect(screen.getByTestId('tour-next')).toHaveTextContent('Next: take the tour');
    expect(screen.queryByTestId('tour-back')).toBeNull();
    await waitFor(() => expect(puts[0]).toEqual({ status: 'in_progress', step: 0 }));

    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome to Guildwise HQ');
    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Board');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(puts.at(-1)).toEqual({ status: 'in_progress', step: 2 });
    await user.click(screen.getByTestId('tour-back'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome');
    expect(puts.at(-1)).toEqual({ status: 'in_progress', step: 1 });
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
    await user.click(screen.getByTestId('tour-next'));
    await waitFor(() => expect(onDrawer).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByTestId('tour-skip'));
    await waitFor(() => expect(onDrawer).toHaveBeenLastCalledWith(false));
  });

  it('the guest tour is chosen from the role of the tab (after the video step)', async () => {
    const user = userEvent.setup();
    me = makeMe({ status: 'new', step: 0 }, { activeOrg: null });
    mount();
    expect(await screen.findByRole('dialog')).toHaveTextContent(/getting-started video/);
    await user.click(screen.getByTestId('tour-next'));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/invited to work on someone else/);
  });

  it('the first step shows the training video with captions and chapters, and pauses it when moving on', async () => {
    videoInfo = {
      title: 'Getting started with Guildwise HQ',
      src: '/videos/getting-started.webm',
      type: 'video/webm',
      captions: '/videos/getting-started.vtt',
      duration: 180,
      chapters: [
        { t: 0, title: 'Create your first project' },
        { t: 30, title: 'Hire your agents' },
      ],
    };
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    const player = (await screen.findByTestId('getting-started-player')) as HTMLVideoElement;
    expect(screen.getByTestId('tour-video')).toContainElement(player);
    expect(player.querySelector('track')).toHaveAttribute('kind', 'captions');
    expect(screen.getByTestId('video-chapter-2')).toBeInTheDocument();
    const pause = vi.fn();
    player.pause = pause;
    await user.click(screen.getByTestId('tour-next'));
    expect(pause).toHaveBeenCalled();
    expect(screen.queryByTestId('getting-started-player')).toBeNull();
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome to Guildwise HQ');
  });

  it('shows the text intro only when the video file is missing, and the tour carries on', async () => {
    videoInfo = null; // an HTML fallback page instead of the JSON
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('getting-started-player')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent(/from an empty organization to a team at work/);
    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome to Guildwise HQ');
  });

  it('shows the text intro only when the media service is down, and the tour carries on', async () => {
    videoInfo = {
      title: 'x',
      src: '/videos/getting-started.webm',
      type: 'video/webm',
      duration: 1,
      chapters: [],
    };
    mediaUp = false;
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('tour-video')).toBeNull();
    expect(screen.queryByTestId('getting-started-player')).toBeNull();
    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-title')).toHaveTextContent('Welcome to Guildwise HQ');
  });

  it('Skip tour on the video step closes the tour as skipped', async () => {
    me = makeMe({ status: 'new', step: 0 });
    const user = userEvent.setup();
    mount();
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('tour-skip'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts.at(-1)).toEqual({ status: 'dismissed', step: 0 });
  });
});
