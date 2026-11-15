import type { OrgAppDto, OrgAppsResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppsTab } from '../components/orgsettings/AppsTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

const WS = '0192f3a0-0000-7000-8000-000000000001';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nTUlJRW93SUJBQUtDQVFFQXUxU1Ux\n-----END RSA PRIVATE KEY-----\n';
const seal = vi.hoisted(() =>
  vi.fn(async (_: unknown) => ({
    v: 1,
    alg: 'RSA-OAEP-256+A256GCM',
    keyId: 'abcd1234abcd1234',
    wrappedKey: 'w',
    iv: 'i',
    ct: 'sealed',
  })),
);
vi.mock('../lib/runner-seal.ts', () => ({ sealIntegration: seal }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const APP: OrgAppDto = {
  id: '0192f3a0-0000-7000-8000-0000000000c1',
  provider: 'github-app',
  label: 'Guild bot',
  host: 'github.com',
  appId: '4242',
  appSlug: 'guild-bot',
  appName: 'Guild Bot',
  installationId: '777',
  account: 'acme',
  botLogin: 'guild-bot[bot]',
  commitName: 'guild-bot[bot]',
  commitEmail: '99001+guild-bot[bot]@users.noreply.github.com',
  permissions: { contents: 'write' },
  missingPermissions: [],
  createdAt: '2026-11-14T10:00:00.000Z',
  state: 'connected',
};

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let response: OrgAppsResponse;
let request: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  seal.mockClear();
  request = { id: 'r1', state: 'pending', results: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/org/apps' && method === 'GET') return json(response);
      if (url === '/api/org/apps' && method === 'POST') return json({ requestId: 'r1' }, 202);
      if (url.startsWith('/api/org/apps/requests/')) return json(request);
      if (url.endsWith('/test')) return json({ requestId: 'r2' }, 202);
      if (method === 'DELETE') return json({ queued: true }, 202);
      return json({}, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

const owner = (): OrgAppsResponse => ({
  apps: [{ ...APP, workstations: [{ id: WS, name: 'Desk', ownerName: 'Pat', state: 'connected' }] }],
  canManage: true,
  serverTime: '2026-11-14T10:00:00.000Z',
  targets: [
    {
      id: WS,
      name: 'Desk',
      ownerName: 'Pat',
      keyId: 'abcd1234abcd1234',
      publicKey: 'AAAA',
      online: true,
      supported: true,
    },
  ],
});

describe('Settings > Automated apps', () => {
  it('a member sees the app and its commit identity but none of the actions', async () => {
    response = { apps: [APP], canManage: false, serverTime: '2026-11-14T10:00:00.000Z' };
    render(wrap(<AppsTab />));
    expect(await screen.findByTestId('org-app-commit')).toHaveTextContent(APP.commitEmail);
    expect(screen.queryByTestId('org-apps-add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('the Owner adds an app: the request holds only envelopes, never the key, and success shows the bot identity', async () => {
    response = owner();
    const user = userEvent.setup();
    render(wrap(<AppsTab />));
    await user.click(await screen.findByTestId('org-apps-add'));
    await user.type(screen.getByLabelText('App ID or client ID'), '4242');
    await user.type(screen.getByLabelText('Installation ID'), '777');
    await user.upload(screen.getByTestId('org-app-key-file'), new File([PEM], 'app.pem'));
    const save = screen.getByTestId('org-app-save');
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/org/apps')).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/org/apps');
    expect(JSON.stringify(post?.body)).not.toContain('PRIVATE KEY');
    expect(post?.body).toMatchObject({ provider: 'github-app', appRef: '4242', installationId: '777' });
    expect(seal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'github-app',
        instance: '4242:777',
        workstationId: WS,
        fields: { privateKey: PEM },
      }),
    );
    request = {
      id: 'r1',
      state: 'done',
      results: [{ workstationId: WS, ok: true }],
      identity: { botLogin: 'guild-bot[bot]', commitName: 'guild-bot[bot]', commitEmail: APP.commitEmail },
    };
    expect(
      await screen.findByText(/Connected as guild-bot\[bot\]/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it('a failed check shows the non-secret sentence and that nothing was saved', async () => {
    response = owner();
    request = {
      id: 'r1',
      state: 'failed',
      results: [{ workstationId: WS, ok: false, code: 'jwt_rejected' }],
    };
    const user = userEvent.setup();
    render(wrap(<AppsTab />));
    await user.click(await screen.findByTestId('org-apps-add'));
    await user.type(screen.getByLabelText('App ID or client ID'), '4242');
    await user.click(screen.getByRole('button', { name: 'Paste instead' }));
    await user.type(screen.getByTestId('org-app-key-paste'), PEM.replace(/\n/g, ' '));
    await user.click(screen.getByTestId('org-app-save'));
    expect(await screen.findByText(/Nothing was saved/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('the Owner removes an app after confirming', async () => {
    response = owner();
    const user = userEvent.setup();
    render(wrap(<AppsTab />));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const buttons = await screen.findAllByRole('button', { name: 'Remove' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/org/apps/${APP.id}`)).toBe(true),
    );
  });
});
