import type { StorageConnectionDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageAddDialog } from '../components/orgsettings/StorageAddDialog.tsx';
import { StorageConnectDialog } from '../components/orgsettings/StorageConnectDialog.tsx';
import { StorageTab } from '../components/orgsettings/StorageTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

const WS = '0192f3a0-0000-7000-8000-000000000001';
const U = '0192f3a0-0000-7000-8000-0000000000aa';
const seal = vi.hoisted(() => vi.fn(async (_: unknown) => ({ v: 1, ciphertext: 'sealed' })));

vi.mock('../lib/runner-seal.ts', () => ({ sealIntegration: seal }));
vi.mock('../api/queries/integrations.ts', () => ({
  useWorkstationIntegrations: () => ({
    data: { key: { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' }, serverTime: '2026-11-03T10:00:00.000Z' },
    isPending: false,
  }),
}));
vi.mock('../api/queries/vaults.ts', () => ({
  useVaults: () => ({ data: [{ id: 'v1', name: 'Firm vault' }] }),
}));
vi.mock('../api/queries/auth.ts', () => ({ useMe: () => ({ data: { user: { id: U } } }) }));
vi.mock('../api/queries/workstations.ts', () => ({
  useWorkstations: () => ({
    data: [{ id: WS, name: 'Desk', userId: U, status: 'active', connected: true }],
  }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const conn = (over: Partial<StorageConnectionDto> & Record<string, unknown> = {}): StorageConnectionDto =>
  ({
    id: '0192f3a0-0000-7000-8000-0000000000c1',
    kind: 'google_drive',
    label: 'Firm drive',
    workstation: { id: WS, name: 'Desk', online: true },
    health: { state: 'pending', errorCode: null, message: null, checkedAt: null, lastOkAt: null },
    createdAt: '2026-11-03T10:00:00.000Z',
    canConnect: true,
    ...over,
  }) as StorageConnectionDto;

let calls: Array<{ method: string; url: string; body: unknown }> = [];
let list: StorageConnectionDto[] = [];
let request: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  seal.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/org/storage/connections' && method === 'GET') return json({ connections: list });
      if (url === '/api/org/storage/connections' && method === 'POST')
        return json({ connection: conn({ id: 'new-id' }) }, 201);
      if (url.endsWith('/auth') && method === 'POST') return json({ sessionId: 'sess-1' }, 202);
      if (url.endsWith('/connect') && method === 'POST') return json({ id: 'req-1', state: 'pending' }, 202);
      if (url.endsWith('/test') && method === 'POST') return json({ id: 'req-2', state: 'pending' }, 202);
      if (url.startsWith('/api/org/storage/requests/')) return json({ request: request });
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

describe('StorageTab', () => {
  it('shows Needs re-authentication with a Reconnect action', async () => {
    list = [
      conn({
        health: {
          state: 'needs_reauth',
          errorCode: 'auth_expired',
          message: null,
          checkedAt: null,
          lastOkAt: null,
        },
      }),
    ];
    render(wrap(<StorageTab canManage />));
    expect(await screen.findByText('Needs re-authentication')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });

  it('hides the actions from a member and shows Connect only for a pending connection', async () => {
    list = [conn()];
    const { unmount } = render(wrap(<StorageTab canManage={false} />));
    await screen.findByText('Firm drive');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    unmount();
    render(wrap(<StorageTab canManage />));
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });
});

describe('StorageAddDialog', () => {
  it('creates the connection on the chosen workstation and hands it to the connect step', async () => {
    const onCreated = vi.fn();
    render(wrap(<StorageAddDialog open onOpenChange={() => {}} onCreated={onCreated} />));
    await userEvent.type(screen.getByLabelText('Display name'), 'Firm S3');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 's3');
    await userEvent.click(screen.getByTestId('storage-add-next'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 's3',
      label: 'Firm S3',
      workstationId: WS,
    });
  });
});

describe('StorageConnectDialog', () => {
  it.each(['onedrive', 'google_drive'] as const)(
    '%s starts the device sign-in and shows the code',
    async (kind) => {
      request = {
        id: 'sess-1',
        op: 'auth',
        state: 'awaiting_user',
        prompt: {
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.test/device',
          expiresAt: '2026-11-03T11:00:00.000Z',
        },
        errorCode: null,
        message: null,
      };
      render(wrap(<StorageConnectDialog connection={conn({ kind })} open onOpenChange={() => {}} />));
      await userEvent.click(screen.getByTestId('storage-signin'));
      expect(await screen.findByTestId('storage-device-code')).toHaveTextContent('ABCD-EFGH');
      expect(screen.getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute(
        'href',
        'https://example.test/device',
      );
      // no secret is typed or sealed for a sign-in
      expect(seal).not.toHaveBeenCalled();
    },
  );

  it('shows the error of a failed sign-in', async () => {
    request = {
      id: 'sess-1',
      op: 'auth',
      state: 'failed',
      prompt: null,
      errorCode: 'unavailable',
      message: null,
    };
    render(wrap(<StorageConnectDialog connection={conn()} open onOpenChange={() => {}} />));
    await userEvent.click(screen.getByTestId('storage-signin'));
    expect(await screen.findByTestId('storage-device-error')).toHaveTextContent('could not be reached');
  });

  it('seals the S3 keys for the workstation and sends only the envelope', async () => {
    render(wrap(<StorageConnectDialog connection={conn({ kind: 's3' })} open onOpenChange={() => {}} />));
    await userEvent.type(screen.getByLabelText('Endpoint'), 'https://s3.test');
    await userEvent.type(screen.getByLabelText('Region'), 'eu-west-1');
    await userEvent.type(screen.getByLabelText('Bucket'), 'docs');
    await userEvent.type(screen.getByLabelText('Access key id'), 'AKIATESTKEY');
    await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET-VALUE-XYZ');
    await userEvent.click(screen.getByTestId('storage-seal-connect'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/connect'))).toBe(true));
    expect(seal).toHaveBeenCalledOnce();
    const sealed = seal.mock.calls[0]?.[0] as { kind: string; fields: Record<string, string> };
    expect(sealed.kind).toBe('storage');
    expect(sealed.fields).toMatchObject({ bucket: 'docs', secretAccessKey: 'SECRET-VALUE-XYZ' });
    const sent = JSON.stringify(calls.filter((c) => c.url.endsWith('/connect')));
    expect(sent).not.toContain('SECRET-VALUE-XYZ');
    expect(sent).not.toContain('AKIATESTKEY');
  });

  it('seals a local folder path and a vault folder', async () => {
    const { unmount } = render(
      wrap(<StorageConnectDialog connection={conn({ kind: 'local' })} open onOpenChange={() => {}} />),
    );
    await userEvent.type(screen.getByLabelText('Folder on the workstation'), '/srv/clients');
    await userEvent.click(screen.getByTestId('storage-seal-connect'));
    await waitFor(() => expect(seal).toHaveBeenCalledTimes(1));
    expect((seal.mock.calls[0]?.[0] as { fields: unknown }).fields).toEqual({ root: '/srv/clients' });
    expect(JSON.stringify(calls)).not.toContain('/srv/clients');
    unmount();

    render(wrap(<StorageConnectDialog connection={conn({ kind: 'vault' })} open onOpenChange={() => {}} />));
    await userEvent.selectOptions(screen.getByLabelText('Vault'), 'v1');
    await userEvent.type(screen.getByLabelText('Folder inside the vault'), 'client-documents');
    await userEvent.click(screen.getByTestId('storage-seal-connect'));
    await waitFor(() => expect(seal).toHaveBeenCalledTimes(2));
    expect((seal.mock.calls[1]?.[0] as { fields: unknown }).fields).toEqual({
      vaultId: 'v1',
      folder: 'client-documents',
    });
  });
});
