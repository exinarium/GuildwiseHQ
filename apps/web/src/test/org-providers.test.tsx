/* eslint-disable @typescript-eslint/no-explicit-any */
import type { OrgProvider, OrgProviderWorkstation } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { OrgProviders } from '../pages/OrgProviders.tsx';

// Web Crypto in the test: sealing is swapped for a marker that keeps only the length (the real one is RSA-OAEP + AES-GCM).
vi.mock('@aom/shared', async (orig) => ({
  ...(await orig<typeof import('@aom/shared')>()),
  sealLarge: async (publicKey: string, text: string) => `h1.for-${publicKey}.len-${text.length}`,
}));

const W1 = '0192f3a0-0000-7000-8000-0000000000a1';
const W2 = '0192f3a0-0000-7000-8000-0000000000a2';
const W3 = '0192f3a0-0000-7000-8000-0000000000a3';
const AT = '2026-10-24T10:00:00.000Z';

const ws = (
  id: string,
  name: string,
  over: Partial<OrgProviderWorkstation> = {},
): OrgProviderWorkstation => ({
  workstationId: id,
  name,
  ownerName: 'Olga',
  online: true,
  supported: true,
  status: 'not_shared',
  overriddenByOwn: false,
  keyId: `key-${name}`,
  publicKey: `pub-${name}`,
  canShare: false,
  ...over,
});

const provider = (id: string, label: string, over: Partial<OrgProvider> = {}): OrgProvider => ({
  provider: id as never,
  label,
  configured: false,
  detail: null,
  baseUrl: null,
  models: [],
  setAt: null,
  setByName: null,
  cap: {
    monthlyMicros: null,
    spendMicros: 0,
    unknownCostTurns: 0,
    percent: null,
    state: 'none',
    month: '2026-10',
    resetsAt: '2026-11-01T00:00:00.000Z',
  },
  workstations: [],
  ...over,
});

let role = 'owner';
let providers: OrgProvider[] = [];
type Call = { method: string; url: string; body?: any };
let calls: Call[];

beforeEach(() => {
  calls = [];
  role = 'owner';
  providers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/auth/me') || url === '/api/me')
        return json({
          user: { id: 'u', email: 'o@x.test', displayName: 'Olga' },
          activeOrg: { id: 'o', name: 'Org', role },
        });
      if (url === '/api/org/providers' && method === 'GET') return json({ providers });
      if (url.startsWith('/api/org/providers'))
        return json(
          { queued: true },
          method === 'PUT' || method === 'POST' || method === 'DELETE' ? 202 : 200,
        );
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter>
          <OrgProviders />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
const puts = () => calls.filter((c) => c.method === 'PUT');

describe('Settings > Model providers', () => {
  it('is for Owners and Admins only', async () => {
    role = 'member';
    wrap();
    expect(await screen.findByText('Owners and Admins only')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/org/providers')).toBe(false);
  });

  it('lists every provider with its key, its workstations, and whose key a workstation uses', async () => {
    providers = [
      provider('openai', 'OpenAI', {
        configured: true,
        detail: 'main account',
        setByName: 'Olga',
        setAt: AT,
        workstations: [
          ws(W1, 'Desktop', { status: 'stored', canShare: true }),
          ws(W2, 'Laptop', { status: 'stored', overriddenByOwn: true }),
          ws(W3, 'Joined later', { status: 'not_shared' }),
        ],
      }),
      provider('google', 'Google Gemini'),
    ];
    wrap();
    const openai = await screen.findByTestId('org-provider-openai');
    expect(within(openai).getByTestId('org-provider-status-openai')).toHaveTextContent('Key set');
    expect(within(openai).getByText(/Set by Olga/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId(`org-provider-ws-openai-${W2}`)).getByText('Own key in use'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId(`org-provider-ws-openai-${W3}`)).getByText('Not shared'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('org-provider-google')).getByTestId('org-provider-empty-google'),
    ).toBeInTheDocument();
    expect(screen.getByText(/encrypted in your browser for each workstation/)).toBeInTheDocument();
  });

  it('seals the key in the browser once per ticked workstation: the request carries ciphertexts, never the key', async () => {
    const user = userEvent.setup();
    providers = [
      provider('openai', 'OpenAI', {
        workstations: [
          ws(W1, 'Desktop', { status: 'not_shared' }),
          ws(W2, 'Laptop', { status: 'not_shared', online: false }),
        ],
      }),
    ];
    wrap();
    await user.click(await screen.findByTestId('org-provider-set-openai'));
    expect(screen.getByTestId('org-set-send')).toBeDisabled();
    await user.type(screen.getByTestId('org-set-key-openai'), 'sk-org-secret-123');
    expect(screen.getByTestId('org-set-key-openai')).toHaveAttribute('type', 'password');
    // both are ticked (the offline one gets it when it connects); untick the laptop
    await user.click(screen.getByTestId(`org-set-target-${W2}`));
    await user.click(screen.getByTestId('org-set-send'));
    await waitFor(() => expect(puts().find((c) => c.url === '/api/org/providers/openai')).toBeTruthy());
    const put = puts().find((c) => c.url === '/api/org/providers/openai') as Call;
    expect(put.body.shares).toEqual([
      {
        workstationId: W1,
        keyId: 'key-Desktop',
        ciphertext: `h1.for-pub-Desktop.len-${'sk-org-secret-123'.length}`,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('sk-org-secret-123');
  });

  it('seals a Bedrock credential as one JSON, with the gateway-style caution only for gateways', async () => {
    const user = userEvent.setup();
    providers = [
      provider('bedrock', 'Amazon Bedrock', { workstations: [ws(W1, 'Desktop')] }),
      provider('gateway', 'Anthropic-compatible gateway', { workstations: [ws(W1, 'Desktop')] }),
    ];
    wrap();
    await user.click(await screen.findByTestId('org-provider-set-bedrock'));
    expect(screen.queryByTestId('org-set-warning-bedrock')).toBeNull();
    await user.type(screen.getByTestId('org-set-field-bedrock-region'), 'us-east-1');
    await user.type(screen.getByTestId('org-set-field-bedrock-bearerToken'), 'bedrock-key-xyz');
    await user.click(screen.getByTestId('org-set-send'));
    await waitFor(() => expect(puts().find((c) => c.url === '/api/org/providers/bedrock')).toBeTruthy());
    const put = puts().find((c) => c.url === '/api/org/providers/bedrock') as Call;
    expect(put.body.detail).toBe('us-east-1');
    expect(put.body.shares[0].ciphertext).toMatch(/^h1\.for-pub-Desktop\.len-\d+$/);
    expect(JSON.stringify(calls)).not.toContain('bedrock-key-xyz');
  });

  it('shows the gateway caution and asks for model ids', async () => {
    const user = userEvent.setup();
    providers = [provider('gateway', 'Anthropic-compatible gateway', { workstations: [ws(W1, 'Desktop')] })];
    wrap();
    await user.click(await screen.findByTestId('org-provider-set-gateway'));
    expect(screen.getByTestId('org-set-warning-gateway')).toHaveTextContent(/less reliably/);
    await user.type(screen.getByTestId('org-set-field-gateway-baseUrl'), 'https://litellm.example.com');
    expect(screen.getByTestId('org-set-send')).toBeDisabled(); // no model id yet
    await user.type(screen.getByTestId('org-set-models-gateway'), 'gemini/gemini-2.5-pro');
    expect(screen.getByTestId('org-set-send')).toBeEnabled();
  });

  it('sets and removes a cap in dollars, and shows the spend, the state and the unpriced runs', async () => {
    const user = userEvent.setup();
    providers = [
      provider('google', 'Google Gemini', {
        configured: true,
        workstations: [ws(W1, 'Desktop', { status: 'stored' })],
        cap: {
          monthlyMicros: 10_000_000,
          spendMicros: 8_100_000,
          unknownCostTurns: 3,
          percent: 81,
          state: 'warning',
          month: '2026-10',
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
      }),
    ];
    wrap();
    expect(await screen.findByTestId('org-provider-spend-google')).toHaveTextContent(
      "$8.10 spent on the organization's key of $10.00",
    );
    expect(screen.getByTestId('org-provider-cap-state-google')).toHaveTextContent('81% used');
    expect(screen.getByTestId('org-provider-unknown-google')).toHaveTextContent(
      /3 runs this month used a model with no known price/,
    );
    expect(screen.queryByTestId('org-provider-cap-override-google')).toBeNull();
    const input = screen.getByTestId('org-provider-cap-input-google');
    expect(input).toHaveValue(10);
    await user.clear(input);
    await user.type(input, '25.5');
    await user.click(screen.getByTestId('org-provider-cap-save-google'));
    await waitFor(() => expect(puts().find((c) => c.url === '/api/org/providers/google/cap')).toBeTruthy());
    expect((puts().find((c) => c.url === '/api/org/providers/google/cap') as Call).body).toEqual({
      monthlyUsd: 25.5,
    });
    await user.clear(input);
    await user.click(screen.getByTestId('org-provider-cap-save-google'));
    await waitFor(() =>
      expect(puts().filter((c) => c.url === '/api/org/providers/google/cap')).toHaveLength(2),
    );
    expect((puts().filter((c) => c.url === '/api/org/providers/google/cap')[1] as Call).body).toEqual({
      monthlyUsd: null,
    });
  });

  it('offers the override only when the cap is reached', async () => {
    const user = userEvent.setup();
    providers = [
      provider('google', 'Google Gemini', {
        configured: true,
        workstations: [ws(W1, 'Desktop', { status: 'stored' })],
        cap: {
          monthlyMicros: 5_000_000,
          spendMicros: 5_200_000,
          unknownCostTurns: 0,
          percent: 104,
          state: 'paused',
          month: '2026-10',
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
      }),
    ];
    wrap();
    expect(await screen.findByTestId('org-provider-cap-state-google')).toHaveTextContent(
      'Cap reached: new runs are refused',
    );
    await user.click(screen.getByTestId('org-provider-cap-override-google'));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url === '/api/org/providers/google/cap/override'),
      ).toBeTruthy(),
    );
  });

  it('shares with a workstation that joined later: from a runner that holds the key, or by entering it again', async () => {
    const user = userEvent.setup();
    providers = [
      provider('openai', 'OpenAI', {
        configured: true,
        workstations: [
          ws(W1, 'Desktop', { status: 'stored', canShare: true }),
          ws(W3, 'Joined later', { status: 'not_shared' }),
        ],
      }),
    ];
    wrap();
    await user.click(await screen.findByTestId(`org-provider-reshare-openai-${W3}`));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/org/providers/openai/reshare')).toBeTruthy(),
    );
    expect(calls.find((c) => c.url === '/api/org/providers/openai/reshare')?.body).toEqual({
      sourceWorkstationId: W1,
      targetWorkstationId: W3,
    });
    await user.click(screen.getByTestId(`org-provider-enter-openai-${W3}`));
    await user.type(screen.getByTestId('org-share-key-openai'), 'sk-again-456');
    await user.click(screen.getByTestId('org-share-send'));
    await waitFor(() =>
      expect(puts().find((c) => c.url === '/api/org/providers/openai/shares')).toBeTruthy(),
    );
    expect((puts().find((c) => c.url === '/api/org/providers/openai/shares') as Call).body).toEqual({
      workstationId: W3,
      keyId: 'key-Joined later',
      ciphertext: `h1.for-pub-Joined later.len-${'sk-again-456'.length}`,
    });
    expect(JSON.stringify(calls)).not.toContain('sk-again-456');
  });

  it('tells an old runner to update, and revokes after a confirmation', async () => {
    const user = userEvent.setup();
    providers = [
      provider('openai', 'OpenAI', {
        configured: true,
        workstations: [
          ws(W1, 'Desktop', { status: 'stored' }),
          ws(W2, 'Old box', { supported: false, status: 'too_old', keyId: null, publicKey: null }),
        ],
      }),
    ];
    wrap();
    expect(
      within(await screen.findByTestId(`org-provider-ws-openai-${W2}`)).getByText('Update the runner'),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('org-provider-revoke-openai'));
    await user.click(await screen.findByRole('button', { name: 'Revoke key' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE' && c.url === '/api/org/providers/openai')).toBeTruthy(),
    );
  });
});
