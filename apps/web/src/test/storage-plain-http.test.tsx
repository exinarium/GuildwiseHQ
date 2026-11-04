import type { StorageConnectionDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageConnectDialog } from '../components/orgsettings/StorageConnectDialog.tsx';
import { StorageTab } from '../components/orgsettings/StorageTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

// The app is also served over plain HTTP on a LAN address for testing. There crypto.randomUUID and
// navigator.clipboard do not exist and WebCrypto cannot seal, so the storage screens must still work or say why not.

const WS = '0192f3a0-0000-7000-8000-000000000001';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seal = vi.hoisted(() => vi.fn(async (_: unknown) => ({ v: 1, ciphertext: 'sealed' })));

vi.mock('../lib/runner-seal.ts', () => ({ sealIntegration: seal }));
vi.mock('../api/queries/integrations.ts', () => ({
  useWorkstationIntegrations: () => ({
    data: { key: { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' }, serverTime: '2026-11-03T10:00:00.000Z' },
    isPending: false,
  }),
}));
vi.mock('../api/queries/vaults.ts', () => ({ useVaults: () => ({ data: [] }) }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const conn = (over: Partial<StorageConnectionDto> & Record<string, unknown> = {}): StorageConnectionDto =>
  ({
    id: '0192f3a0-0000-7000-8000-0000000000c1',
    kind: 'local',
    label: 'Office NAS',
    workstation: { id: WS, name: 'Desk', online: true },
    health: { state: 'ok', errorCode: null, message: null, checkedAt: null, lastOkAt: null },
    createdAt: '2026-11-03T10:00:00.000Z',
    canConnect: true,
    ...over,
  }) as StorageConnectionDto;

let calls: Array<{ method: string; url: string; body: Record<string, unknown> | undefined }> = [];
let list: StorageConnectionDto[] = [];
let request: Record<string, unknown> = {};

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  calls = [];
  seal.mockClear();
  // A plain-HTTP page: getRandomValues exists, randomUUID does not.
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/org/storage/connections' && method === 'GET') return json({ connections: list });
      if (url.endsWith('/auth') && method === 'POST') return json({ sessionId: 'sess-1' }, 202);
      if (url.endsWith('/connect') && method === 'POST') return json({ id: 'req-1', state: 'pending' }, 202);
      if (url.endsWith('/test') && method === 'POST') return json({ id: 'req-2', state: 'pending' }, 202);
      if (url.startsWith('/api/org/storage/requests/')) return json({ request });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

describe('storage settings without crypto.randomUUID', () => {
  it('Test connection still sends a v4 request id', async () => {
    list = [conn()];
    render(wrap(<StorageTab canManage />));
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/test'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/test'))?.body;
    expect(String(body?.requestId)).toMatch(UUID_V4);
  });

  it('connecting a local folder seals it with a v4 request id', async () => {
    render(wrap(<StorageConnectDialog connection={conn()} open onOpenChange={() => {}} />));
    await userEvent.type(screen.getByLabelText('Folder on the workstation'), '/srv/clients');
    await userEvent.click(screen.getByTestId('storage-seal-connect'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/connect'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/connect'))?.body;
    expect(String(body?.requestId)).toMatch(UUID_V4);
    expect((seal.mock.calls[0]?.[0] as { ref?: string } | undefined)?.ref).toBe(body?.requestId);
  });

  it('copies the device code without the Clipboard API', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
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
    render(
      wrap(<StorageConnectDialog connection={conn({ kind: 'google_drive' })} open onOpenChange={() => {}} />),
    );
    await userEvent.click(screen.getByTestId('storage-signin'));
    await screen.findByTestId('storage-device-code');
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('explains that sealing needs HTTPS and keeps Connect disabled', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    render(wrap(<StorageConnectDialog connection={conn({ kind: 's3' })} open onOpenChange={() => {}} />));
    expect(screen.getByTestId('storage-insecure-context')).toHaveTextContent('not on HTTPS');
    expect(screen.getByTestId('storage-seal-connect')).toBeDisabled();
    expect(seal).not.toHaveBeenCalled();
  });
});
