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

describe('Settings: how your BA reports to you', () => {
  let prefs = { routeViaBa: true, dailyAt: '08:00', timezone: 'Africa/Johannesburg' as string | null };
  beforeEach(() => {
    prefs = { routeViaBa: true, dailyAt: '08:00', timezone: 'Africa/Johannesburg' };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const m = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/reporting') && m === 'PUT') prefs = { ...prefs, ...body };
      if (url.endsWith('/auth/timezone') && m === 'PUT') {
        prefs = { ...prefs, timezone: body.timezone };
        return json(me(body.timezone));
      }
      return json({ ...prefs, effectiveTimezone: prefs.timezone ?? 'UTC', canEdit: true });
    });
  });

  it('shows the routing switch (on by default) and turns it off', async () => {
    renderWith(<Settings />);
    const box = (await screen.findByTestId('route-via-ba')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    await waitFor(() => expect(bodyOf('PUT', '/reporting')).toEqual({ routeViaBa: false }));
    await waitFor(() => expect((screen.getByTestId('route-via-ba') as HTMLInputElement).checked).toBe(false));
  });

  it('edits the time zone and the time of the daily report', async () => {
    renderWith(<Settings />);
    const zone = (await screen.findByTestId('timezone')) as HTMLSelectElement;
    expect(zone.value).toBe('Africa/Johannesburg');
    expect(screen.getByText(/posted at 08:00 on your clock/)).toBeTruthy();
    await userEvent.selectOptions(zone, 'UTC');
    await waitFor(() => expect(bodyOf('PUT', '/auth/timezone')).toEqual({ timezone: 'UTC' }));

    const time = screen.getByTestId('daily-at') as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save time' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.clear(time);
    await userEvent.type(time, '07:30');
    await userEvent.click(save);
    await waitFor(() => expect(bodyOf('PUT', '/reporting')).toEqual({ dailyAt: '07:30' }));
  });

  it('offers the browser zone when it differs', async () => {
    const fmt = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        () =>
          ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) }) as unknown as Intl.DateTimeFormat,
      );
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
};

const base: DeskItemDto = {
  id: U(50),
  kind: 'alert',
  subkind: 'floor_report',
  status: 'open',
  routedTo: 'manager',
  title: 'Floor report 2026-11-10',
  body: '# Floor report\n\nOne card needs you first.',
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

describe('the floor report on the desk', () => {
  it('is labelled, shows the BA narrative, the six sections and the link to the standing chat', () => {
    const item: DeskItemDto = { ...base, floor: digest, chatThreadId: U(60) };
    renderWith(<DeskItem item={item} now={Date.parse('2026-11-10T07:00:00.000Z')} />);
    expect(deskKindLabel(item)).toBe('Floor report');
    expect(screen.getByTestId('desk-kind').textContent).toBe('Floor report');
    expect(screen.getByText(/One card needs you first/)).toBeTruthy();
    const report = within(screen.getByTestId('floor-report'));
    for (const h of [
      /Phases waiting or open/,
      /Stuck, blocked and backing-off cards/,
      /Repeated approvals/,
      /Failures/,
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
