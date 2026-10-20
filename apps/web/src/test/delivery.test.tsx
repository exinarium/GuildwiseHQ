import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryPanel } from '../components/delivery/DeliveryPanel.tsx';
import { ReleaseQueue } from '../components/delivery/ReleaseQueue.tsx';
import { ToastProvider } from '../components/ui.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const env = (name: string, releasedBy: 'owner' | 'ceo' | 'auto', targets: string[], extra = {}) => ({
  name,
  targets: targets.map((t) => ({ name: t, production: name === 'production', exists: true })),
  releasedBy,
  triggers: name === 'local' ? ['after_merge'] : ['on_request'],
  gate: name === 'local' ? 'none' : 'inline',
  secrets: name === 'production' ? ['P5_PROD_DEPLOY_KEY'] : [],
  ...extra,
});
const settings = (over: Record<string, unknown> = {}, recipe: Record<string, unknown> = {}) => ({
  mode: 'instructions',
  vault: { storage: 'local', name: 'P5 vault', folder: 'projects/p5' },
  recipe: {
    id: U(1),
    status: 'observed',
    present: true,
    observedHash: 'a'.repeat(64),
    observedCommit: null,
    approvedHash: null,
    approvedCommit: null,
    approvedAt: null,
    approvedBy: null,
    version: 0,
    observedAt: null,
    recipe: null,
    approvedRecipe: null,
    lint: [],
    fileCount: 4,
    changes: [],
    ...recipe,
  },
  canApprove: true,
  canChangeMode: true,
  environments: [env('local', 'auto', ['p5-local']), env('production', 'owner', ['p5-prod'])],
  secrets: [],
  ...over,
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('DeliveryPanel', () => {
  it('shows who releases each environment, the vault backup note, and approves exactly the hash it showed', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (u.includes('/delivery/approve'))
        return json(
          settings(
            { mode: 'instructions' },
            { status: 'approved', approvedHash: 'a'.repeat(64), version: 1 },
          ),
        );
      if (u.includes('/workstations')) return json({ workstations: [] });
      return json(settings());
    });
    wrap(<DeliveryPanel projectId={U(5)} />);
    expect(await screen.findByTestId('delivery-recipe')).toBeTruthy();
    expect(screen.getByTestId('delivery-vault').textContent).toContain('not backed up by Guildwise');
    expect(
      within(screen.getByTestId('env-local')).getByText(/automatically, once the gate holds/),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('env-production')).getByText(/Owner or an Admin \(release queue\)/),
    ).toBeTruthy();
    // the environment's name and the red production badge on its target
    expect(within(screen.getByTestId('env-production')).getAllByText('production')).toHaveLength(2);
    // recipe mode is not offered before an approval
    expect((screen.getByRole('option', { name: /Recipe/ }) as HTMLOptionElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('approve-recipe'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/delivery/approve'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/delivery/approve'))?.body).toEqual({ hash: 'a'.repeat(64) });
  });

  it('only the Owner can approve; lint errors block it; a changed recipe lists what changed', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/workstations')
        ? json({ workstations: [] })
        : json(
            settings(
              { canApprove: false },
              {
                status: 'changed_unapproved',
                approvedHash: 'b'.repeat(64),
                version: 2,
                changes: [
                  'production: released by changed from "owner" to "ceo"',
                  'scripts/production.sh content changed',
                ],
                lint: [
                  { level: 'error', code: 'missing_script', message: 'scripts/x.sh is not in delivery/' },
                ],
              },
            ),
          ),
    );
    wrap(<DeliveryPanel projectId={U(5)} />);
    expect(((await screen.findByTestId('approve-recipe')) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only the Owner approves a recipe.')).toBeTruthy();
    expect(screen.getByText('changed: needs a new approval')).toBeTruthy();
    expect(screen.getByTestId('recipe-changes').textContent).toContain(
      'scripts/production.sh content changed',
    );
    expect(screen.getByTestId('recipe-lint').textContent).toContain(
      'Must fix: scripts/x.sh is not in delivery/',
    );
  });

  it('an approved recipe in recipe mode offers a Deploy button per environment and the secrets it names', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET' });
      if (u.endsWith('/delivery/deploy'))
        return json({
          runs: [{ runId: U(7), target: 'p5-local', status: 'queued' }],
          message: 'local on p5-local was released',
        });
      if (u.includes('/workstations') && !u.includes('/sudo-key'))
        return json({
          workstations: [
            {
              id: U(2),
              name: 'Desk',
              ownerId: U(9),
              ownerName: 'Me',
              mine: true,
              connected: true,
              hasDevops: true,
            },
          ],
        });
      return json(
        settings({ mode: 'recipe' }, { status: 'approved', approvedHash: 'a'.repeat(64), version: 1 }),
      );
    });
    wrap(<DeliveryPanel projectId={U(5)} />);
    expect(await screen.findByTestId('deploy-buttons')).toBeTruthy();
    await userEvent.click(screen.getByTestId('deploy-local'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/delivery/deploy') && c.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText('local on p5-local was released')).toBeTruthy();
    // the secret the recipe names, with the promise that the value stays on the workstation
    const field = await screen.findByTestId('deploy-secret-P5_PROD_DEPLOY_KEY');
    expect((field as HTMLInputElement).type).toBe('password');
    expect(screen.getByTestId('delivery-secrets').textContent).toContain('Guildwise never sees');
  });
});

describe('ReleaseQueue', () => {
  const item = (targets: string[], over: Record<string, unknown> = {}) => ({
    projectId: U(5),
    projectKey: 'P5',
    env: 'production',
    commit: 'abc1234567890',
    waitingFor: 'owner',
    requestedAt: new Date().toISOString(),
    gateNow: { satisfied: true, missing: [] },
    targets: targets.map((t, i) => ({
      runId: U(10 + i),
      targetId: U(20 + i),
      targetName: t,
      production: true,
      host: `h${i}`,
      workstationName: 'Desk',
    })),
    ...over,
  });

  it('offers a target choice when an environment has several servers: Release sends only the ticked runs', async () => {
    const posted: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/delivery/release')) {
        posted.push(JSON.parse(String(init?.body)));
        return json({ runs: [], message: 'released' });
      }
      return json({ items: [item(['p5-prod-1', 'p5-prod-2', 'p5-prod-3'])] });
    });
    wrap(<ReleaseQueue />);
    const row = await screen.findByTestId('release-P5-production');
    expect(within(row).getByText('abc1234567')).toBeTruthy();
    const button = within(row).getByTestId('release-P5-production-button') as HTMLButtonElement;
    // nothing is ticked by default for several servers: the Owner chooses
    expect(button.disabled).toBe(true);
    await userEvent.click(within(row).getByTestId('pick-p5-prod-2'));
    await userEvent.click(within(row).getByTestId('pick-p5-prod-3'));
    expect(button.textContent).toBe('Release to 2 of 3');
    await userEvent.click(button);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ runIds: [U(11), U(12)] });
  });

  it('a single server releases with one click, and a gate that no longer holds is said out loud', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        items: [item(['p5-prod'], { gateNow: { satisfied: false, missing: ['releases are frozen'] } })],
      }),
    );
    wrap(<ReleaseQueue />);
    const row = await screen.findByTestId('release-P5-production');
    expect(within(row).queryByTestId('pick-p5-prod')).toBeNull();
    expect((within(row).getByTestId('release-P5-production-button') as HTMLButtonElement).textContent).toBe(
      'Release',
    );
    expect(row.textContent).toContain('releases are frozen');
  });

  it('says so when nothing waits', async () => {
    fetchMock.mockImplementation(async () => json({ items: [] }));
    wrap(<ReleaseQueue />);
    expect(await screen.findByTestId('release-queue-empty')).toBeTruthy();
  });
});
