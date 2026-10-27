import type { DeskItemDto, FloorDigest, MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../components/Layout.tsx';
import { deskKindLabel } from '../lib/desk.ts';
import { DeskItem } from '../pages/Desk.tsx';
import { Settings } from '../pages/Settings.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const calls = () =>
  fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`);
const bodyOf = (method: string, urlPart: string) => {
  const c = fetchMock.mock.calls.find(
    ([u, i]) => String(u).includes(urlPart) && (i as RequestInit | undefined)?.method === method,
  );
  return c ? JSON.parse(String((c[1] as RequestInit).body)) : undefined;
};

const user = (timezone: string | null) => ({
  id: U(1),
  email: 'm@example.com',
  displayName: 'Mia',
  kind: 'user' as const,
  twoFactorEnabled: false,
  status: 'active' as const,
  createdAt: '2026-10-01T10:00:00.000Z',
  lastLoginAt: null,
  timezone,
});
const me = (timezone: string | null): MeResponse => ({
  user: user(timezone),
  account: { kind: 'user' },
  isAdmin: false,
  orgs: [],
  activeOrg: null,
  guestIn: [],
  guestProjectIds: [],
  pendingInvitations: 0,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  mustChangePassword: false,
  visibleProjectIds: [],
  features: { mockUi: false },
});

function renderWith(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings: time zone (the BA no longer reports to you)', () => {
  let prefs = { dailyAt: '08:00', timezone: 'Africa/Johannesburg' as string | null };
  let mine: MeResponse = me('Africa/Johannesburg');
  let reportingFails = false;
  const asRole = (role: 'owner' | 'admin' | 'member', timezone: string | null) => {
    mine = {
      ...me(timezone),
      activeOrg: { id: U(9), name: 'Acme', role, status: 'active', plan: 'p', planName: 'P', features: {} },
    } as unknown as MeResponse;
  };
  beforeEach(() => {
    prefs = { dailyAt: '08:00', timezone: 'Africa/Johannesburg' };
    reportingFails = false;
    asRole('owner', 'Africa/Johannesburg');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const m = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/auth/me')) return json(mine);
      if (url.endsWith('/auth/timezone') && m === 'PUT') {
        mine = { ...mine, user: { ...mine.user, timezone: body.timezone } };
        return json(mine);
      }
      if (url.endsWith('/reporting') && reportingFails) return json({ error: 'boom' }, 500);
      if (url.endsWith('/reporting') && m === 'PUT') prefs = { ...prefs, ...body };
      return json({ ...prefs, effectiveTimezone: prefs.timezone ?? 'UTC', canEdit: true });
    });
  });

  it('has no BA routing switch and no report time field: the CEO writes the report', async () => {
    renderWith(<Settings />);
    await screen.findByTestId('timezone');
    expect(screen.queryByTestId('route-via-ba')).toBeNull();
    expect(screen.queryByTestId('daily-at')).toBeNull();
    expect(screen.queryByText(/Your BA reports to you/)).toBeNull();
  });

  it('Owner: shows their own zone, and the text names the CEO daily report time on their clock', async () => {
    renderWith(<Settings />);
    const zone = (await screen.findByTestId('timezone')) as HTMLSelectElement;
    await waitFor(() => expect(zone.value).toBe('Africa/Johannesburg'));
    await waitFor(() =>
      expect(screen.getByTestId('timezone-help').textContent).toMatch(
        /daily report is written at 08:00 on your clock.*Reporting & alerts tab on the CEO's page/,
      ),
    );
    await userEvent.selectOptions(zone, 'UTC');
    await waitFor(() => expect(bodyOf('PUT', '/auth/timezone')).toEqual({ timezone: 'UTC' }));
  });

  it("non-Owner: shows their own zone, not the Owner's, and says the report follows the Owner's zone", async () => {
    asRole('member', 'Europe/Amsterdam');
    renderWith(<Settings />);
    const zone = (await screen.findByTestId('timezone')) as HTMLSelectElement;
    await waitFor(() => expect(zone.value).toBe('Europe/Amsterdam'));
    await waitFor(() => {
      const help = screen.getByTestId('timezone-help').textContent ?? '';
      expect(help).toContain("follows the Owner's zone (Africa/Johannesburg)");
      expect(help).toContain('written at 08:00');
      expect(help).not.toContain('on your clock');
    });
  });

  it('still shows the zone picker when the reporting settings fail to load', async () => {
    reportingFails = true;
    renderWith(<Settings />);
    const zone = (await screen.findByTestId('timezone')) as HTMLSelectElement;
    expect(zone.value).toBe('Africa/Johannesburg');
    expect(screen.getByTestId('timezone-help').textContent).not.toMatch(/daily report/);
  });

  it('offers the browser zone when it differs from your own zone', async () => {
    asRole('member', 'Europe/Amsterdam');
    const fmt = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        () =>
          ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) }) as unknown as Intl.DateTimeFormat,
      );
    const { unmount } = renderWith(<Settings />);
    await screen.findByTestId('timezone');
    expect(screen.queryByTestId('use-browser-zone')).toBeNull();
    unmount();
    asRole('member', 'Africa/Johannesburg');
    renderWith(<Settings />);
    const use = await screen.findByTestId('use-browser-zone');
    expect(use.textContent).toContain('Europe/Amsterdam');
    await userEvent.click(use);
    await waitFor(() => expect(bodyOf('PUT', '/auth/timezone')).toEqual({ timezone: 'Europe/Amsterdam' }));
    fmt.mockRestore();
  });
});

describe('first login: the time zone comes from the browser', () => {
  const shell = () =>
    renderWith(
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<p>home</p>} />
        </Route>
      </Routes>,
    );
  const answer = (timezone: string | null) =>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/timezone') && init?.method === 'PUT')
        return json(me(JSON.parse(String(init.body)).timezone));
      if (url.endsWith('/auth/me')) return json(me(timezone));
      if (url.includes('/desk')) return json({ items: [], counts: { open: 0, blocking: 0, urgent: 0 } });
      if (url.includes('/projects')) return json([]);
      return json({});
    });

  it('sends the detected zone once when none is stored', async () => {
    const fmt = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        () =>
          ({ resolvedOptions: () => ({ timeZone: 'America/New_York' }) }) as unknown as Intl.DateTimeFormat,
      );
    answer(null);
    shell();
    await screen.findByText('home');
    await waitFor(() => expect(bodyOf('PUT', '/auth/timezone')).toEqual({ timezone: 'America/New_York' }));
    expect(calls().filter((c) => c.startsWith('PUT') && c.includes('/auth/timezone'))).toHaveLength(1);
    fmt.mockRestore();
  });

  it('leaves a stored zone alone', async () => {
    answer('Europe/Paris');
    shell();
    await screen.findByText('home');
    expect(calls().some((c) => c.startsWith('PUT') && c.includes('/auth/timezone'))).toBe(false);
  });
});

const digest: FloorDigest = {
  generatedAt: '2026-11-10T06:00:00.000Z',
  localDate: '2026-11-10',
  since: null,
  highRiskMerges: [],
  highRiskMergesMore: 0,
  phases: [{ ref: 'TOY-P1', name: 'Autosave', status: 'open', projectKey: 'TOY', lateBugs: ['TOY-9'] }],
  signals: [
    {
      id: U(20),
      kind: 'blocked',
      urgency: 'normal',
      fingerprint: 'blocked:card:x',
      count: 1,
      status: 'open',
      firstSeenAt: 'a',
      lastSeenAt: 'b',
      subject: { title: 'TOY-4 has been blocked for 5 hours', detail: 'Waiting on: Tabs or spaces?' },
      evidence: {},
      isNew: true,
    },
    {
      id: U(21),
      kind: 'repeated_approval',
      urgency: 'normal',
      fingerprint: 'approval:devops:docker',
      count: 3,
      status: 'open',
      firstSeenAt: 'a',
      lastSeenAt: 'b',
      subject: { title: 'DevOps needs approval: docker compose up', detail: '' },
      evidence: {},
      isNew: true,
    },
    {
      id: U(22),
      kind: 'rework',
      urgency: 'normal',
      fingerprint: 'rework:card:y',
      count: 3,
      status: 'open',
      firstSeenAt: 'a',
      lastSeenAt: 'b',
      subject: { title: 'TOY-5 is in rework round 3', detail: '' },
      evidence: {},
      isNew: false,
    },
  ],
  backingOff: [{ ref: 'TOY-2', title: 'Looping builder', failures: 4, until: 'later' }],
  devopsOpen: [{ id: U(30), summary: 'Deploy staging', status: 'needs_approval', workstation: 'Box' }],
  resolvedByBa: [{ id: U(31), title: 'Noise', how: 'dismissed', note: 'duplicate' }],
  failures: [{ ref: 'TOY-2', title: 'Looping builder', failedShifts: 4 }],
  interests: { count: 0, active: 0, runs: 0, delivered: 0, unrated: 0, highlights: [], failing: [] },
  spend: {
    currency: 'USD',
    sinceMicros: 2_000_000,
    monthMicros: 41_000_000,
    overheadMonthMicros: 1_000_000,
    projects: [
      {
        key: 'TOY',
        name: 'Toy',
        monthMicros: 40_000_000,
        budgetMicros: 50_000_000,
        percent: 80,
        state: 'warning',
      },
    ],
  },
};

const base: DeskItemDto = {
  id: U(50),
  kind: 'alert',
  subkind: 'floor_report',
  status: 'open',
  routedTo: 'manager',
  title: 'Daily report 2026-11-10',
  body: '# Daily report\n\nOne card needs you first.',
  doing: '',
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: U(7), agentName: 'Ben', role: 'ba' },
  card: null,
  projectId: null,
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: null,
  canAnswer: true,
  createdAt: '2026-11-10T06:00:00.000Z',
};

describe('the older daily report on the desk', () => {
  it('is labelled, shows the BA narrative, the six sections and the link to the standing chat', () => {
    const item: DeskItemDto = { ...base, floor: digest, chatThreadId: U(60) };
    renderWith(<DeskItem item={item} now={Date.parse('2026-11-10T07:00:00.000Z')} />);
    expect(deskKindLabel(item)).toBe('Daily report');
    expect(screen.getByTestId('desk-kind').textContent).toBe('Daily report');
    expect(screen.getByText(/One card needs you first/)).toBeTruthy();
    const report = within(screen.getByTestId('floor-report'));
    for (const h of [
      /Phases waiting or open/,
      /Stuck, blocked and backing-off cards/,
      /Repeated approvals/,
      /Failures/,
      /Spend/,
      /DevOps requests that are open/,
      /Resolved by the BA without bothering you/,
    ])
      expect(report.getByRole('heading', { name: h })).toBeTruthy();
    expect(report.getByText(/held open by late bugs TOY-9/)).toBeTruthy();
    expect(report.getByText(/TOY-4 has been blocked for 5 hours/)).toBeTruthy();
    expect(report.getByText(/TOY-2 Looping builder: backing off after 4 failed shifts/)).toBeTruthy();
    expect(report.getByText(/docker compose up \(3 times\)/)).toBeTruthy();
    expect(report.getByText(/TOY-2 Looping builder: 4 failed shifts/)).toBeTruthy();
    expect(report.getByText(/Deploy staging on Box: needs_approval/)).toBeTruthy();
    expect(report.getByText(/Noise \(dismissed: duplicate\)/)).toBeTruthy();
    const link = screen.getByTestId('ba-chat-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/chat/${U(60)}`);
    // an alert is acknowledged like any other
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
  });

  it('shows a high-risk card waiting and the high-risk cards finished (old stored digests have neither field)', () => {
    const waiting = {
      id: U(70),
      kind: 'high_risk_waiting' as const,
      urgency: 'normal' as const,
      fingerprint: 'high_risk_waiting:card:x',
      count: 1,
      status: 'open' as const,
      firstSeenAt: 'a',
      lastSeenAt: 'b',
      subject: { title: 'TOY-8 is rated high risk and has waited 30 hours for approval', detail: '' },
      evidence: {},
      isNew: true,
    };
    const full = {
      ...digest,
      signals: [...digest.signals, waiting],
      highRiskMerges: [
        { ref: 'TOY-7', title: 'Billing rewrite', projectKey: 'TOY', analysis: 'touches money' },
      ],
      highRiskMergesMore: 2,
    };
    const { unmount } = renderWith(
      <DeskItem item={{ ...base, floor: full }} now={Date.parse('2026-11-10T07:00:00.000Z')} />,
    );
    const report = within(screen.getByTestId('floor-report'));
    expect(report.getByRole('heading', { name: /High-risk cards finished/ })).toBeTruthy();
    expect(report.getByText(/TOY-7 Billing rewrite \(TOY\): touches money/)).toBeTruthy();
    expect(report.getByText('and 2 more')).toBeTruthy();
    expect(report.getByText(/TOY-8 is rated high risk/)).toBeTruthy();
    unmount();
    const { highRiskMerges: _a, highRiskMergesMore: _b, ...old } = digest;
    renderWith(
      <DeskItem
        item={{ ...base, floor: old as unknown as typeof digest }}
        now={Date.parse('2026-11-10T07:00:00.000Z')}
      />,
    );
    expect(
      within(screen.getByTestId('floor-report')).getByRole('heading', { name: /High-risk cards finished/ }),
    ).toBeTruthy();
  });

  it('an empty section says None', () => {
    renderWith(
      <DeskItem
        item={{ ...base, floor: { ...digest, phases: [], devopsOpen: [] } }}
        now={Date.parse('2026-11-10T07:00:00.000Z')}
      />,
    );
    const report = within(screen.getByTestId('floor-report'));
    expect(report.getAllByText('None.').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the BA note and how the routing handled an item', () => {
  const question: DeskItemDto = {
    ...base,
    kind: 'approval',
    subkind: 'devops',
    title: 'DevOps needs approval: docker compose up',
    body: 'why',
    blocking: true,
    pinned: true,
    urgent: true,
    floor: null,
    askedBy: { kind: 'system', agentId: null, agentName: null, role: null },
  };

  it('shows the BA note on an urgent item that went straight to the desk', () => {
    renderWith(
      <DeskItem
        item={{
          ...question,
          baNote: 'The 6th request for docker compose up on WS-1 in 24 hours. Grant allowDocker.',
        }}
        now={Date.parse('2026-11-10T07:00:00.000Z')}
      />,
    );
    const note = screen.getByTestId('ba-note');
    expect(note.textContent).toContain('BA note');
    expect(note.textContent).toContain('Grant allowDocker');
    expect(screen.getByTestId('desk-kind').textContent).toBe('DevOps approval');
  });

  it('says so when the BA passed an item on or ran out of time', () => {
    const { unmount } = renderWith(
      <DeskItem item={{ ...question, triage: 'passed' }} now={Date.parse('2026-11-10T07:00:00.000Z')} />,
    );
    expect(screen.getByTestId('triage-passed')).toBeTruthy();
    unmount();
    renderWith(
      <DeskItem item={{ ...question, triage: 'released' }} now={Date.parse('2026-11-10T07:00:00.000Z')} />,
    );
    expect(screen.getByTestId('triage-released').textContent).toContain('unchanged');
  });

  it('shows nothing extra for an item the routing did not touch', () => {
    renderWith(
      <DeskItem item={{ ...question, triage: 'none' }} now={Date.parse('2026-11-10T07:00:00.000Z')} />,
    );
    expect(screen.queryByTestId('ba-note')).toBeNull();
    expect(screen.queryByTestId('triage-passed')).toBeNull();
    expect(screen.queryByTestId('ba-chat-link')).toBeNull();
  });
});
