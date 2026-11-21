import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorksFor } from '../components/workstations/WorksFor.tsx';
import { AcceptInvite } from '../pages/AcceptInvite.tsx';
import { Workstations } from '../pages/Workstations.tsx';

/** R9 (audit F4): "Works for" on the Workstations page and the workstation choice when accepting an invitation. */
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = ID(1);
const ORG = ID(90);
const OWN_ORG = ID(91);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ws = (n: number, name: string) => ({
  id: ID(n),
  userId: ME,
  name,
  platform: 'linux',
  hostname: `${name}.lan`,
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
});
const me = (email = 'me@example.test') => ({
  user: {
    id: ME,
    email,
    displayName: 'Me',
    role: 'member',
    status: 'active',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastLoginAt: null,
  },
  isAdmin: false,
  orgs: [{ id: ORG, name: 'Initech', role: 'member', status: 'active' }],
  activeOrg: {
    id: ORG,
    name: 'Initech',
    role: 'member',
    status: 'active',
    plan: 'founding',
    planName: 'Founding',
    features: {},
  },
  visibleProjectIds: [],
});

let serving: Record<string, boolean>;
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  serving = { [ORG]: false, [OWN_ORG]: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/auth/me') return json(me());
      // ID(12) is the user's simulated workstation: it never appears in the "Works for" list
      if (url === '/api/workstations')
        return json({ workstations: [ws(10, 'Desk'), ws(11, 'Laptop'), ws(12, 'Simulated workstation')] });
      if (url === '/api/workstations/serving')
        return json({
          workstations: [10, 11].map((n) => ({
            workstationId: ID(n),
            orgs: [
              { orgId: ORG, orgName: 'Initech', role: 'member', serving: n === 10 ? serving[ORG] : false },
              { orgId: OWN_ORG, orgName: 'Mine', role: 'owner', serving: true },
            ],
          })),
        });
      if (method === 'PUT' && url.startsWith(`/api/workstations/${ID(10)}/orgs/`)) {
        serving[url.split('/').at(-1) as string] = (body as { serving: boolean }).serving;
        return json({ ok: true });
      }
      if (url.startsWith('/api/invitations/tok-1234567890abcdef') && method === 'GET')
        return json({
          kind: 'org_member',
          email: 'me@example.test',
          expiresAt: '2026-12-01T00:00:00.000Z',
          invitedBy: 'Bill',
          orgName: 'Initech',
          role: 'member',
          accountExists: true,
        });
      if (url.endsWith('/accept-existing')) return json(me(), 201);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('Works for', () => {
  it('lists the organizations with a switch, notes the ones not served yet, and switches one on', async () => {
    const user = userEvent.setup();
    wrap(<WorksFor w={ws(10, 'Desk') as never} />);
    const sw = await screen.findByRole('switch', { name: 'Desk works for Initech' });
    expect(sw).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Desk works for Mine' })).toBeChecked();
    expect(screen.getByTestId('works-for-notice')).toHaveTextContent(/does not work for Initech yet/);
    await user.click(sw);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: `/api/workstations/${ID(10)}/orgs/${ORG}`,
        body: { serving: true },
      }),
    );
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Desk works for Initech' })).toBeChecked());
  });

  it('switching off asks first and says what happens to the agents', async () => {
    serving[ORG] = true;
    const user = userEvent.setup();
    wrap(<WorksFor w={ws(10, 'Desk') as never} />);
    await user.click(await screen.findByRole('switch', { name: 'Desk works for Initech' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/wait for a new home/);
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: `/api/workstations/${ID(10)}/orgs/${ORG}`,
        body: { serving: false },
      }),
    );
  });

  it('is not shown on someone else’s workstation', async () => {
    wrap(<WorksFor w={{ ...ws(12, 'Theirs'), userId: ID(2) } as never} />);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(screen.queryByTestId('works-for')).toBeNull();
    expect(calls.some((c) => c.url === '/api/workstations/serving')).toBe(false);
  });

  it('the Workstations page notes an organization none of your workstations works for', async () => {
    wrap(<Workstations />);
    expect(await screen.findByTestId('not-served-notice')).toHaveTextContent(
      /None of your workstations works for Initech/,
    );
  });
});

describe('accepting an invitation while signed in', () => {
  it('asks which workstations may work for the organization: none by default for a member invitation', async () => {
    const user = userEvent.setup();
    wrap(
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>,
      '/invite/tok-1234567890abcdef',
    );
    const desk = await screen.findByTestId(`invite-serve-${ID(10)}`);
    expect(desk).not.toBeChecked();
    expect(screen.getByTestId(`invite-serve-${ID(11)}`)).not.toBeChecked();
    expect(screen.queryByTestId(`invite-serve-${ID(12)}`)).toBeNull();
    expect(screen.getByTestId('invite-serve')).toHaveTextContent(/Nobody in Initech can change this/);
    await user.click(desk);
    await user.click(screen.getByRole('button', { name: 'Join Initech' }));
    await waitFor(() => {
      const accept = calls.find((c) => c.url.endsWith('/accept-existing'));
      expect(accept?.body).toMatchObject({ serveWorkstationIds: [ID(10)] });
    });
  });
});
