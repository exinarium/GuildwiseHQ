import type { DeployKeyDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aom/shared', async (orig) => ({
  ...(await orig<typeof import('@aom/shared')>()),
  // the real seal needs WebCrypto; here we only check WHAT is sealed and that nothing else carries it
  sealLarge: async (_key: string, text: string) => `h1.SEALED.${text.length}.x`,
}));

import { ConnectServer } from '../components/delivery/connect/ConnectServer.tsx';
import { KeysList } from '../components/delivery/connect/KeysList.tsx';
import { PrepareServer } from '../components/delivery/connect/PrepareServer.tsx';
import { needsReconnect, ReachabilityChip } from '../components/delivery/connect/ReachabilityChip.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { agoText } from '../lib/ago.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECT = ID(1);
const WS = ID(20);
const WS2 = ID(21);
const TARGET = ID(32);
const FP = `SHA256:${'A'.repeat(43)}`;
const base = `/api/projects/${PROJECT}`;

const calls: Array<{ method: string; url: string; body?: any }> = [];
let routes: Record<string, (init: RequestInit) => Response> = {};
beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return routes[`${init.method ?? 'GET'} ${String(url).split('?')[0]}`]?.(init) ?? json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

const ws = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  connected: true,
  mine: true,
  canProbe: true,
  blocked: null,
  canConnect: true,
  ...over,
});
const setupState = (workstations = [ws(WS, 'Office PC')]) => ({
  canEdit: true,
  canApprove: true,
  draft: null,
  current: {
    setup: null,
    handEdited: [],
    recipePresent: false,
    recipeStatus: null,
    observedHash: null,
    approvedHash: null,
    lint: [],
    dryRunOk: [],
    custom: false,
  },
  publish: null,
  targets: [],
  workstations,
  probes: [],
  writeBlocked: null,
  scan: null,
  scanProblem: null,
  proposal: null,
  generator: 'setup-1.2',
});
const op = (id: string, body: Record<string, unknown>) => {
  routes[`GET ${base}/delivery/ops/${id}`] = () => json({ id, at: '2026-10-20T10:00:00.000Z', ...body });
};
const serve = (workstations?: ReturnType<typeof ws>[]) => {
  routes[`GET ${base}/delivery/setup`] = () => json(setupState(workstations));
  routes[`GET /api/workstations/${WS}/sudo-key`] = () => json({ keyId: 'k1', publicKey: 'cHVibGlj' });
  routes[`GET /api/workstations/${WS2}/sudo-key`] = () => json({ keyId: 'k2', publicKey: 'cHVibGlj' });
};
const key = (over: Partial<DeployKeyDto> = {}): DeployKeyDto => ({
  targetId: TARGET,
  workstationId: WS,
  workstationName: 'Old laptop',
  fingerprint: FP as never,
  state: 'active',
  alias: 'aom-shop',
  address: 'shop.example.com',
  user: 'root',
  port: 22,
  hostKeyFingerprint: null,
  addedAt: '2026-10-01T10:00:00.000Z',
  revokedAt: null,
  ...over,
});

describe('the reachability chip', () => {
  it.each([
    ['reachable', 'Can sign in'],
    ['asks_password', 'Needs a sign-in'],
    ['unreachable', 'Cannot reach the server'],
    ['host_key_changed', 'Server identity changed'],
  ] as const)('%s says "%s" and how it signs in', (state, text) => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    render(
      <ReachabilityChip
        reachability={{ state, at, detail: null, method: 'deploy_key', workstationId: WS }}
      />,
    );
    expect(screen.getByTestId('reachability-state')).toHaveTextContent(text);
    expect(screen.getByTestId('reachability-detail')).toHaveTextContent(
      'with its own Guildwise key, checked 3 hours ago',
    );
  });
  it('never checked, and when Reconnect is offered', () => {
    render(<ReachabilityChip reachability={null} />);
    expect(screen.getByTestId('reachability-state')).toHaveTextContent('Never checked');
    expect(needsReconnect(null)).toBe(true);
    expect(
      needsReconnect({
        state: 'reachable',
        at: '2026-10-20T10:00:00.000Z',
        detail: null,
        method: 'existing_alias',
        workstationId: WS,
      }),
    ).toBe(false);
    expect(
      needsReconnect({
        state: 'asks_password',
        at: '2026-10-20T10:00:00.000Z',
        detail: null,
        method: 'existing_alias',
        workstationId: WS,
      }),
    ).toBe(true);
    expect(agoText('2026-10-20T10:00:00.000Z', Date.parse('2026-10-20T10:00:20.000Z'))).toBe('just now');
    expect(agoText('2026-10-18T10:00:00.000Z', Date.parse('2026-10-20T10:00:00.000Z'))).toBe('2 days ago');
  });
});

describe('guided connect with a password', () => {
  it('asks where, shows the fingerprint in plain words, only then the password; the password goes out sealed and is never in a request body as text', async () => {
    serve();
    routes[`POST ${base}/delivery/hostkey`] = () => json({ commandId: 'scan1', workstationId: WS }, 202);
    op('scan1', {
      kind: 'hostkey',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP, bits: 256 }] },
    });
    routes[`POST ${base}/delivery/connect`] = () =>
      json({ commandId: 'conn1', workstationId: WS, targetId: TARGET, alias: 'aom-shop-live' }, 202);
    op('conn1', {
      kind: 'connect',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, installed: 'added' },
    });
    const onDone = vi.fn();
    const user = userEvent.setup();
    wrap(<ConnectServer projectId={PROJECT} onDone={onDone} onCancel={() => undefined} production />);
    // 1. where
    await user.type(await screen.findByTestId('connect-name'), 'Shop live');
    await user.type(screen.getByTestId('connect-address'), 'shop.example.com');
    expect((screen.getByTestId('connect-user') as HTMLInputElement).value).toBe('root');
    expect(screen.getByTestId('connect-continue')).toBeEnabled();
    await user.click(screen.getByTestId('connect-continue'));
    // 2. the fingerprint, confirmed before it is trusted
    expect(await screen.findByTestId('connect-fp')).toHaveTextContent(FP);
    expect(screen.getByTestId('connect-fingerprint')).toHaveTextContent(
      'If your hosting company shows a fingerprint',
    );
    expect(calls.find((c) => c.url.endsWith('/delivery/hostkey'))?.body).toMatchObject({
      workstationId: WS,
      address: 'shop.example.com',
      port: 22,
    });
    expect(calls.some((c) => c.url.endsWith('/delivery/connect'))).toBe(false);
    await user.click(screen.getByTestId('connect-fp-matches'));
    // 3. the promise comes before the password
    expect(screen.getByTestId('connect-password-promise')).toHaveTextContent('Guildwise never stores it');
    expect(screen.getByTestId('connect-exact-change')).toHaveTextContent('~/.ssh/authorized_keys');
    expect(screen.getByTestId('connect-go')).toBeDisabled();
    await user.type(screen.getByTestId('connect-password'), 'hunter2-very-secret');
    await user.click(screen.getByTestId('connect-go'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/delivery/connect'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/delivery/connect'))?.body;
    expect(body).toMatchObject({
      workstationId: WS,
      method: 'password',
      address: 'shop.example.com',
      user: 'root',
      port: 22,
      hostKeyFingerprint: FP,
      newTarget: { name: 'Shop live', production: true },
      keyId: 'k1',
    });
    expect(body.ciphertext).toMatch(/^h1\.SEALED\./);
    expect(JSON.stringify(calls)).not.toContain('hunter2-very-secret');
    // 4. done
    expect(await screen.findByTestId('connect-done')).toHaveTextContent('can sign in to shop.example.com');
    await user.click(screen.getByTestId('connect-finish'));
    expect(onDone).toHaveBeenCalledWith({
      targetId: TARGET,
      alias: 'aom-shop-live',
      name: 'Shop live',
      workstationId: WS,
    });
  });

  it('"I can\'t check, continue" is allowed but marked; "This is not it" goes back; a wrong password is a sentence and the field is empty again', async () => {
    serve();
    routes[`POST ${base}/delivery/hostkey`] = () => json({ commandId: 'scan1', workstationId: WS }, 202);
    op('scan1', {
      kind: 'hostkey',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP }] },
    });
    routes[`POST ${base}/delivery/connect`] = () =>
      json({ commandId: 'conn1', workstationId: WS, targetId: TARGET, alias: 'aom-x' }, 202);
    op('conn1', {
      kind: 'connect',
      state: 'failed',
      ok: false,
      result: { ok: false, error: 'bad_password' },
      errorText:
        'The server did not accept that user name and password. Check them in your hosting company’s email or panel, then try again.',
    });
    const user = userEvent.setup();
    wrap(<ConnectServer projectId={PROJECT} onDone={() => undefined} onCancel={() => undefined} />);
    await user.type(await screen.findByTestId('connect-name'), 'X');
    await user.type(screen.getByTestId('connect-address'), '203.0.113.9');
    await user.click(screen.getByTestId('connect-continue'));
    await user.click(await screen.findByTestId('connect-fp-no'));
    expect(screen.getByTestId('connect-where')).toBeInTheDocument();
    await user.click(screen.getByTestId('connect-continue'));
    await user.click(await screen.findByTestId('connect-fp-skip'));
    expect(screen.getByTestId('connect-unchecked')).toHaveTextContent('Fingerprint not checked');
    await user.type(screen.getByTestId('connect-password'), 'wrong');
    await user.click(screen.getByTestId('connect-go'));
    expect(await screen.findByTestId('connect-error')).toHaveTextContent(
      'did not accept that user name and password',
    );
    expect((screen.getByTestId('connect-password') as HTMLInputElement).value).toBe('');
  });

  it('an unreachable address stops at the fingerprint with a plain sentence', async () => {
    serve();
    routes[`POST ${base}/delivery/hostkey`] = () => json({ commandId: 'scan1', workstationId: WS }, 202);
    op('scan1', {
      kind: 'hostkey',
      state: 'failed',
      ok: false,
      result: { ok: false, error: 'unreachable' },
      errorText: 'This computer cannot reach that address. Check the address and that the server is on.',
    });
    const user = userEvent.setup();
    wrap(<ConnectServer projectId={PROJECT} onDone={() => undefined} onCancel={() => undefined} />);
    await user.type(await screen.findByTestId('connect-name'), 'X');
    await user.type(screen.getByTestId('connect-address'), 'nowhere.example.com');
    await user.click(screen.getByTestId('connect-continue'));
    expect(await screen.findByTestId('connect-scan-error')).toHaveTextContent('cannot reach that address');
  });

  it('refuses addresses and users that are not plain before anything is sent', async () => {
    serve();
    const user = userEvent.setup();
    wrap(<ConnectServer projectId={PROJECT} onDone={() => undefined} onCancel={() => undefined} />);
    await user.type(await screen.findByTestId('connect-name'), 'X');
    for (const bad of ['-oProxyCommand=x', 'a b', 'root@host']) {
      await user.clear(screen.getByTestId('connect-address'));
      await user.type(screen.getByTestId('connect-address'), bad);
      expect(screen.getByTestId('connect-continue')).toBeDisabled();
    }
    await user.clear(screen.getByTestId('connect-address'));
    await user.type(screen.getByTestId('connect-address'), 'ok.example.com');
    await user.clear(screen.getByTestId('connect-user'));
    await user.type(screen.getByTestId('connect-user'), 'a b');
    expect(screen.getByTestId('connect-continue')).toBeDisabled();
  });
});

describe('guided connect: a key file and a hosting panel', () => {
  async function toHow(method: 'keyfile' | 'panel', over: { target?: any } = {}) {
    serve();
    routes[`POST ${base}/delivery/hostkey`] = () => json({ commandId: 'scan1', workstationId: WS }, 202);
    op('scan1', {
      kind: 'hostkey',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP }] },
    });
    const user = userEvent.setup();
    wrap(<ConnectServer projectId={PROJECT} onDone={() => undefined} onCancel={() => undefined} {...over} />);
    if (!over.target) await user.type(await screen.findByTestId('connect-name'), 'X');
    await user.type(await screen.findByTestId('connect-address'), '203.0.113.9');
    await user.click(screen.getByTestId(`connect-method-${method}`));
    await user.click(screen.getByTestId('connect-continue'));
    await user.click(await screen.findByTestId('connect-fp-matches'));
    return user;
  }

  it('key file: sealed with the passphrase, never as text', async () => {
    const user = await toHow('keyfile');
    routes[`POST ${base}/delivery/connect`] = () =>
      json({ commandId: 'conn1', workstationId: WS, targetId: TARGET, alias: 'aom-x' }, 202);
    op('conn1', {
      kind: 'connect',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, installed: 'added' },
    });
    expect(screen.getByTestId('connect-keyfile-promise')).toHaveTextContent('never stored');
    const file = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'abcdefgh'.repeat(10)}\n-----END OPENSSH PRIVATE KEY-----`;
    await user.click(screen.getByTestId('connect-keyfile'));
    await user.paste(file);
    await user.type(screen.getByTestId('connect-passphrase'), 'sekret-pass');
    await user.click(screen.getByTestId('connect-go'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/delivery/connect'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/delivery/connect'))?.body).toMatchObject({
      method: 'keyfile',
      keyId: 'k1',
    });
    expect(JSON.stringify(calls)).not.toContain('abcdefgh');
    expect(JSON.stringify(calls)).not.toContain('sekret-pass');
  });

  it('hosting panel: the public key is shown with Copy and the steps, and "I pasted it" tests the connection', async () => {
    routes[`POST ${base}/delivery/key`] = () => json({ commandId: 'key1', workstationId: WS }, 202);
    op('key1', {
      kind: 'key',
      state: 'done',
      ok: true,
      errorText: null,
      result: {
        ok: true,
        publicKey: 'ssh-ed25519 AAAAC3Nza guildwise-deploy:abcd1234:Office-PC',
        fingerprint: FP,
        existed: false,
      },
    });
    const user = await toHow('panel');
    expect(await screen.findByTestId('connect-public-key')).toHaveTextContent(
      'ssh-ed25519 AAAAC3Nza guildwise-deploy:abcd1234:Office-PC',
    );
    expect(screen.getByTestId('connect-panel-key')).toHaveTextContent(
      'Add a new key, paste this one in, and save',
    );
    expect(calls.find((c) => c.url.endsWith('/delivery/key'))?.body).toMatchObject({ workstationId: WS });
    expect(calls.find((c) => c.url.endsWith('/delivery/key'))?.body.keyRef).toMatch(/^[0-9a-f-]{36}$/);
    routes[`POST ${base}/delivery/connect`] = () =>
      json({ commandId: 'conn1', workstationId: WS, targetId: TARGET, alias: 'aom-x' }, 202);
    op('conn1', {
      kind: 'connect',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, installed: 'pasted' },
    });
    await user.click(screen.getByTestId('connect-go'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/delivery/connect'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/delivery/connect'))?.body;
    expect(body).toMatchObject({ method: 'panel' });
    expect(body.ciphertext).toBeUndefined();
    expect(body.keyRef).toBe(calls.find((c) => c.url.endsWith('/delivery/key'))?.body.keyRef);
    expect(await screen.findByTestId('connect-done')).toBeInTheDocument();
  });
});

describe('Reconnect from a new computer', () => {
  const target = { id: TARGET, name: 'Shop live', host: 'aom-shop', workstationId: WS, keys: [key()] };

  it("starts from what is known about the server, makes the new computer the one that deploys, and offers to remove the old computer's key", async () => {
    serve([ws(WS, 'Old laptop', { connected: false }), ws(WS2, 'New PC')]);
    routes[`POST ${base}/delivery/hostkey`] = () => json({ commandId: 'scan1', workstationId: WS2 }, 202);
    op('scan1', {
      kind: 'hostkey',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, keys: [{ type: 'ssh-ed25519', fingerprint: FP }] },
    });
    routes[`POST ${base}/delivery/connect`] = () =>
      json({ commandId: 'conn1', workstationId: WS2, targetId: TARGET, alias: 'aom-shop' }, 202);
    op('conn1', {
      kind: 'connect',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, installed: 'added' },
    });
    routes[`PATCH /api/deploy-targets/${TARGET}`] = () => json({ id: TARGET });
    routes[`POST ${base}/delivery/targets/${TARGET}/revoke-key`] = () =>
      json({ commandId: 'rev1', workstationId: WS2 }, 202);
    op('rev1', {
      kind: 'revoke',
      state: 'done',
      ok: true,
      errorText: null,
      result: { ok: true, removed: 1 },
    });
    const user = userEvent.setup();
    wrap(
      <ConnectServer
        projectId={PROJECT}
        target={target}
        onDone={() => undefined}
        onCancel={() => undefined}
      />,
    );
    // the offline old laptop is not the default; the address and user are known
    await waitFor(() =>
      expect((screen.getByTestId('connect-computer') as HTMLSelectElement).value).toBe(WS2),
    );
    expect((screen.getByTestId('connect-address') as HTMLInputElement).value).toBe('shop.example.com');
    expect(screen.queryByTestId('connect-name')).toBeNull();
    await user.click(screen.getByTestId('connect-method-panel'));
    routes[`POST ${base}/delivery/key`] = () => json({ commandId: 'key1', workstationId: WS2 }, 202);
    op('key1', {
      kind: 'key',
      state: 'done',
      ok: true,
      errorText: null,
      result: {
        ok: true,
        publicKey: 'ssh-ed25519 BBBB guildwise-deploy:x:New-PC',
        fingerprint: FP,
        existed: false,
      },
    });
    await user.click(screen.getByTestId('connect-continue'));
    await user.click(await screen.findByTestId('connect-fp-matches'));
    await screen.findByTestId('connect-public-key');
    // the key is made for the existing target, not a reference
    expect(calls.find((c) => c.url.endsWith('/delivery/key'))?.body).toMatchObject({
      workstationId: WS2,
      targetId: TARGET,
    });
    await user.click(screen.getByTestId('connect-go'));
    expect(calls.find((c) => c.url.endsWith('/delivery/connect'))?.body).toMatchObject({
      workstationId: WS2,
      targetId: TARGET,
      method: 'panel',
    });
    // the new computer deploys it from now on
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ workstationId: WS2 }),
    );
    // the old computer's key is still allowed: offered for removal with its fingerprint shown first
    const old = await screen.findByTestId('connect-old-keys');
    expect(old).toHaveTextContent('Old laptop');
    await user.click(within(old).getByTestId('key-remove'));
    expect(await screen.findByTestId('key-remove-fingerprint')).toHaveTextContent(FP);
    expect(calls.some((c) => c.url.endsWith('/revoke-key'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Remove the key' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/revoke-key'))?.body).toEqual({
        workstationId: WS2,
        fingerprint: FP,
      }),
    );
    expect(await screen.findByTestId('key-remove-result')).toHaveTextContent(
      'The key was removed from the server',
    );
  });
});

describe('the keys of a server', () => {
  it("lists them; removing is offered for another computer's key only, and never for a key nobody has to remove", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeysList
          projectId={PROJECT}
          targetId={TARGET}
          signInWorkstationId={WS2}
          keys={[
            key(),
            key({
              workstationId: WS2,
              workstationName: 'New PC',
              fingerprint: `SHA256:${'B'.repeat(43)}` as never,
            }),
            key({ fingerprint: `SHA256:${'C'.repeat(43)}` as never, state: 'revoked' }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('key-remove')).toHaveLength(1);
    expect(screen.getByText('Removed from the server')).toBeInTheDocument();
  });
});

describe('preparing a server', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    scope: 'ssh_target',
    at: '2026-10-20T10:00:00.000Z',
    docker: { installed: false, usable: false },
    containers: [],
    composeFiles: [],
    volumes: [],
    folders: [],
    backups: [],
    proxies: [],
    urls: [],
    listeners: [],
    ...over,
  });

  it('lists what it would add, tries it without changing anything, and sets it up only on the press of the button', async () => {
    routes[`POST ${base}/delivery/prepare`] = () => json({ commandId: 'prep1', workstationId: WS }, 202);
    op('prep1', {
      kind: 'prepare',
      state: 'done',
      ok: true,
      errorText: null,
      result: {
        ok: true,
        steps: [
          { kind: 'install_docker', outcome: 'would', detail: 'install Docker' },
          { kind: 'create_dir', outcome: 'skipped', detail: '/opt/shop-live already exists' },
        ],
      },
    });
    const onPrepared = vi.fn();
    const user = userEvent.setup();
    wrap(
      <PrepareServer
        projectId={PROJECT}
        hosting="ssh"
        workstationId={WS}
        targetId={TARGET}
        report={report() as never}
        suggestedName="Shop live"
        onPrepared={onPrepared}
      />,
    );
    expect(screen.getByTestId('prepare-dir')).toHaveValue('/opt/shop-live');
    const list = screen.getByTestId('prepare-actions');
    expect(list).toHaveTextContent('Install Docker on the server');
    expect(list).toHaveTextContent('Create the folder /opt/shop-live');
    await user.type(screen.getByTestId('prepare-domain'), 'shop.example.com');
    expect(screen.getByTestId('prepare-actions')).toHaveTextContent('HTTPS for shop.example.com with Caddy');
    // 1. try it
    await user.click(screen.getByTestId('prepare-dry'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/delivery/prepare'))?.body).toMatchObject({
        dryRun: true,
        confirmed: true,
        hosting: 'ssh',
        targetId: TARGET,
      }),
    );
    expect(await screen.findByTestId('prepare-result')).toHaveTextContent('Would do');
    expect(onPrepared).not.toHaveBeenCalled();
    // 2. for real
    await user.click(screen.getByTestId('prepare-run'));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/delivery/prepare'))).toHaveLength(2));
    const real = calls.filter((c) => c.url.endsWith('/delivery/prepare'))[1]?.body;
    expect(real).toMatchObject({ dryRun: false, confirmed: true });
    expect(real.actions.map((a: any) => a.kind)).toEqual([
      'install_docker',
      'create_dir',
      'create_dir',
      'write_compose',
      'caddy_site',
    ]);
    expect(await screen.findByTestId('prepare-done')).toBeInTheDocument();
    await waitFor(() =>
      expect(onPrepared).toHaveBeenCalledWith({
        dir: '/opt/shop-live',
        composeFile: '/opt/shop-live/docker-compose.yml',
      }),
    );
  });

  it('what is there is kept; nginx or a busy port is explained and blocks, nothing to do says so', async () => {
    wrap(
      <PrepareServer
        projectId={PROJECT}
        hosting="ssh"
        workstationId={WS}
        report={
          report({
            docker: { installed: true, usable: true, version: '29' },
            folders: [{ path: '/opt/shop-live', exists: true, entries: ['docker-compose.yml', 'backups'] }],
            composeFiles: [
              {
                path: '/opt/shop-live/docker-compose.yml',
                services: [{ name: 'app', ports: [], volumes: [], envFiles: [], vars: [] }],
                volumes: [],
              },
            ],
            backups: [{ dir: '/opt/shop-live/backups', count: 2 }],
            proxies: [{ kind: 'nginx', via: 'systemd', name: 'nginx', sites: [] }],
          }) as never
        }
        suggestedName="Shop live"
        onPrepared={() => undefined}
      />,
    );
    expect(screen.getByTestId('prepare-reuse')).toHaveTextContent(
      'The folder /opt/shop-live exists and is kept as it is',
    );
    expect(screen.getByTestId('prepare-nothing')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('prepare-domain'), 'shop.example.com');
    expect(screen.getByTestId('prepare-blockers')).toHaveTextContent('only sets up HTTPS with Caddy');
    expect(screen.getByTestId('prepare-run')).toBeDisabled();
  });
});
