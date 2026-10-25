import {
  type AiRuntimeAccount,
  type AiRuntimeTile,
  buildAiRuntimeTiles,
  PROVIDER_ACCOUNTS_CAPABILITY,
  providerKeyAad,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Integrations } from '../pages/Integrations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const WS = ID(10);
const NOW = '2026-10-14T10:00:00.000Z';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let privateKey: CryptoKey;
let publicKeyB64: string;
let tiles: AiRuntimeTile[];
let online = true;
let lastPromote: unknown = null;
let pinnedProjects: unknown[] = [];
const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];

const info = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: 'config_dir' as const,
  login: 'ok' as const,
  usage: 'ok' as const,
  ...over,
});
const CAPS = ['claude-accounts:1', PROVIDER_ACCOUNTS_CAPABILITY];
const defaultTiles = (caps = CAPS) =>
  buildAiRuntimeTiles({
    capabilities: caps,
    runtimes: [
      { id: 'claude-code', version: '2.1.0', available: true, accounts: [info('main')] },
      {
        id: 'codex',
        version: '0.163.0',
        available: true,
        accounts: [info('main', { email: 'me@x.test' }), info('work', { login: 'none' })],
      },
      {
        id: 'direct-model',
        version: 'v',
        available: true,
        keys: [
          { provider: 'openai', source: 'workstation', orgKey: true, orgIds: [ID(77)], accounts: ['work'] },
          { provider: 'anthropic', source: 'org', orgKey: true, orgIds: [ID(77)], accounts: [] },
        ],
      },
    ] as never,
  });

beforeEach(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  privateKey = pair.privateKey;
  publicKeyB64 = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  tiles = defaultTiles();
  online = true;
  lastPromote = null;
  pinnedProjects = [];
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'admin',
            status: 'active',
            createdAt: NOW,
            lastLoginAt: null,
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (url === `/api/workstations/${WS}/integrations`)
        return json({
          workstation: { id: WS, name: 'Desk' },
          key: { keyId: 'key-3f9a', publicKey: publicKeyB64 },
          serverTime: NOW,
          runner: {
            connected: online,
            version: '0.1.58',
            integrationsVersion: 1,
            policy: { allowWeb: true, primaryPairing: true, machineScopeFromWeb: 'primary' },
          },
          integrations: [],
          activeSessions: [],
          legacy: false,
        });
      if (url === `/api/workstations/${WS}/ai-runtimes`)
        return json({
          workstationId: WS,
          online,
          runnerVersion: '0.1.58',
          tiles,
          lastPromote,
          pinnedProjects,
        });
      if (url === `/api/workstations/${WS}/sudo-key`)
        return json({ keyId: 'key-3f9a', publicKey: publicKeyB64 });
      if (method === 'POST' && url.endsWith('/integrations/sessions'))
        return json({ id: ID(900), state: 'starting' }, 202);
      if (method !== 'GET') return json({ id: ID(901), state: 'pending', queued: true }, 202);
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

const page = (search = '') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/workstations/${WS}/integrations${search}`]}>
        <Routes>
          <Route path="/workstations/:id/integrations" element={<Integrations />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const tile = async (id: string) => within(await screen.findByTestId(`ai-tile-${id}`));
const callTo = (method: string, part: string) =>
  calls.find((c) => c.method === method && c.url.includes(part));

describe('Integrations > AI runtime: the tiles', () => {
  it('lists the runtimes and providers with their accounts and what state each is in', async () => {
    page();
    const codex = await tile('codex');
    expect(codex.getByTestId('ai-installed-codex')).toHaveTextContent('Installed 0.163.0');
    expect(codex.getByTestId('ai-status-codex-main')).toHaveTextContent('Signed in');
    expect(codex.getByTestId('ai-account-codex-main')).toHaveTextContent('me@x.test');
    expect(codex.getByTestId('ai-status-codex-work')).toHaveTextContent('Not signed in');
    // not installed: the hint and the restart note
    const gemini = await tile('gemini');
    expect(gemini.getByTestId('ai-not-installed-gemini')).toBeInTheDocument();
    expect(gemini.getByTestId('ai-install-gemini')).toHaveTextContent('npm install -g @google/gemini-cli');
    expect(gemini.getByTestId('ai-install-gemini')).toHaveTextContent('restart the runner');
    expect(gemini.queryByTestId('ai-signin-gemini-main')).toBeNull();
    expect(gemini.getByTestId('ai-add-gemini')).toBeDisabled();
    // providers: whose key is in effect
    const openai = await tile('openai');
    expect(openai.getByTestId('ai-status-openai-main')).toHaveTextContent(
      'Own key (overrides the organization’s)',
    );
    expect(openai.getByTestId('ai-status-openai-work')).toHaveTextContent('Key set');
    expect(openai.getByTestId('ai-key-in-effect-openai')).toHaveTextContent('own key is in effect');
    const anthropic = await tile('anthropic');
    expect(anthropic.getByTestId('ai-status-anthropic-main')).toHaveTextContent('Organization key in effect');
    expect(anthropic.queryByTestId('ai-setkey-anthropic-main')).toBeNull();
    const google = await tile('google');
    expect(google.getByTestId('ai-status-google-main')).toHaveTextContent('No key');
    expect(google.getByTestId('ai-setkey-google-main')).toHaveTextContent('Set key');
    // the organization's keys and caps stay on their own page
    expect(screen.getByTestId('ai-models-link')).toHaveAttribute('href', '/settings/providers');
  });

  it('shows a usage limit and an expired login on the account', async () => {
    tiles = buildAiRuntimeTiles({
      capabilities: CAPS,
      runtimes: [
        {
          id: 'codex',
          version: '0.163.0',
          available: true,
          accounts: [
            info('main', { usage: 'limited', limitedUntil: '2026-10-14T18:00:00.000Z' }),
            info('work', { login: 'expired' }),
          ],
        },
      ] as never,
    });
    page();
    const codex = await tile('codex');
    expect(codex.getByTestId('ai-status-codex-main')).toHaveTextContent('Usage limit until');
    expect(codex.getByTestId('ai-status-codex-work')).toHaveTextContent('Sign-in expired');
    expect(codex.getByTestId('ai-signin-codex-work')).toHaveTextContent('Sign in');
  });

  it('a runner without accounts is told to update: no actions on the tile', async () => {
    tiles = defaultTiles(['claude-accounts:1']);
    page();
    const codex = await tile('codex');
    expect(codex.getByTestId('ai-old-runner-codex')).toHaveTextContent('Runner too old');
    expect(codex.getByTestId('ai-signin-codex-main')).toBeDisabled();
    expect(codex.queryByTestId('ai-add-codex')).toBeNull();
    const openai = await tile('openai');
    expect(openai.getByTestId('ai-old-runner-openai')).toBeInTheDocument();
    expect(openai.getByTestId('ai-setkey-openai-main')).toBeDisabled();
  });

  it('an offline workstation disables the actions and says why', async () => {
    online = false;
    page();
    const codex = await tile('codex');
    expect(codex.getByTestId('ai-signin-codex-work')).toBeDisabled();
    expect(codex.getByText('Desk is offline.')).toBeInTheDocument();
  });

  it('shows the answer of a refused Make main', async () => {
    lastPromote = {
      scope: 'openai',
      key: 'work',
      ok: false,
      error: 'there is no openai key under the account work',
      at: NOW,
    };
    page();
    expect(await screen.findByTestId('ai-promote-error')).toHaveTextContent(
      'there is no openai key under the account work',
    );
  });
});

describe('Integrations > AI runtime: sign in', () => {
  it('Sign in starts the CLI’s own login for that account', async () => {
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-signin-codex-work'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Connect Codex (work)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /start|sign in|continue/i }));
    await waitFor(() => expect(callTo('POST', '/integrations/sessions')).toBeDefined());
    expect(callTo('POST', '/integrations/sessions')?.body).toMatchObject({
      kind: 'codex',
      instance: 'work',
      method: 'codex_login',
    });
  });

  it('the main account signs in at the owner’s own login (empty instance)', async () => {
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-signin-codex-main'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /start|sign in|continue/i }));
    await waitFor(() => expect(callTo('POST', '/integrations/sessions')).toBeDefined());
    expect(callTo('POST', '/integrations/sessions')?.body).toMatchObject({
      kind: 'codex',
      instance: '',
      method: 'codex_login',
    });
  });

  it('Add a named account asks for a name and refuses main and org', async () => {
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-add-codex'));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/account/i);
    const start = () => within(dialog).getByRole('button', { name: /start|sign in|continue/i });
    expect(start()).toBeDisabled();
    for (const bad of ['main', 'org', 'Bad Name']) {
      await user.clear(name);
      await user.type(name, bad);
      expect(start()).toBeDisabled();
    }
    await user.clear(name);
    await user.type(name, 'team');
    expect(start()).toBeEnabled();
    await user.click(start());
    await waitFor(() => expect(callTo('POST', '/integrations/sessions')).toBeDefined());
    expect(callTo('POST', '/integrations/sessions')?.body).toMatchObject({ kind: 'codex', instance: 'team' });
  });

  it('a deep link (focus and connect=1) opens the sign-in of that account', async () => {
    page('?focus=codex:work&connect=1');
    expect(await screen.findByText('Connect Codex (work)')).toBeInTheDocument();
    expect(screen.getByTestId('ai-account-codex-work')).toHaveAttribute('data-focus', 'true');
  });

  it('Remove asks first, then removes the named account through the integrations route', async () => {
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-remove-codex-work'));
    expect(await screen.findByText(/Remove account work of Codex\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callTo('POST', '/integrations/remove')).toBeDefined());
    expect(callTo('POST', '/integrations/remove')?.body).toMatchObject({ kind: 'codex', instance: 'work' });
    // the main account has no Remove
    expect(codex.queryByTestId('ai-remove-codex-main')).toBeNull();
  });

  it('has a per-workstation switch “Allow projects to use my accounts”, off by default', async () => {
    const user = userEvent.setup();
    page();
    const box = await screen.findByRole('checkbox', { name: /Allow projects to use my accounts/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(callTo('PUT', '/account-sharing')).toBeDefined());
    expect(callTo('PUT', '/account-sharing')?.body).toEqual({ allow: true });
  });

  it('Make main lists the projects that name the main or the named account before it swaps them', async () => {
    pinnedProjects = [
      { scope: 'codex', account: 'main', projectKey: 'TOY', projectName: 'Toy' },
      { scope: 'codex', account: 'work', projectKey: 'WEB', projectName: 'Web' },
      { scope: 'codex', account: 'other', projectKey: 'OTH', projectName: 'Other' },
      { scope: 'openai', account: 'main', projectKey: 'KEY', projectName: 'Keys' },
    ];
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-promote-codex-work'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('TOY (main account)');
    expect(dialog).toHaveTextContent('WEB (work)');
    expect(dialog).not.toHaveTextContent('OTH');
    expect(dialog).not.toHaveTextContent('KEY');
  });

  it('Make main asks first and sends the swap', async () => {
    const user = userEvent.setup();
    page();
    const codex = await tile('codex');
    await user.click(codex.getByTestId('ai-promote-codex-work'));
    expect(await screen.findByText(/Make work the main Codex account\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make main' }));
    await waitFor(() => expect(callTo('POST', '/accounts/promote')).toBeDefined());
    expect(callTo('POST', '/accounts/promote')?.body).toEqual({ scope: 'codex', key: 'work' });
    expect(codex.queryByTestId('ai-promote-codex-main')).toBeNull();
  });
});

describe('Integrations > AI runtime: keys', () => {
  async function openAndFill(
    user: ReturnType<typeof userEvent.setup>,
    testId: string,
    key: string,
    name?: string,
  ) {
    const openai = await tile('openai');
    await user.click(openai.getByTestId(testId));
    const dialog = await screen.findByRole('dialog');
    if (name) await user.type(within(dialog).getByTestId('ai-key-name'), name);
    await user.type(within(dialog).getByTestId('ai-key-key-openai'), key);
    return dialog;
  }
  async function sentBlob() {
    await waitFor(() => expect(callTo('PUT', '/providers/openai')).toBeDefined());
    return callTo('PUT', '/providers/openai')?.body as {
      ciphertext: string;
      generation: number;
      account?: string;
      keyId: string;
    };
  }
  async function open(blob: string, aad: string): Promise<string> {
    const [tag, wrapped, iv, ct] = blob.split('.') as [string, string, string, string];
    expect(tag).toBe('h2');
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(wrapped));
    const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(aad) },
      aes,
      unb64(ct),
    );
    return new TextDecoder().decode(plain);
  }

  it('Replace key of a named account seals it for the runner with the account name bound in', async () => {
    const user = userEvent.setup();
    page();
    await openAndFill(user, 'ai-setkey-openai-work', 'sk-work-1234');
    await user.click(screen.getByTestId('ai-key-save'));
    const body = await sentBlob();
    expect(body.account).toBe('work');
    expect(body.keyId).toBe('key-3f9a');
    const aad = (account?: string) =>
      providerKeyAad({
        scope: 'workstation',
        provider: 'openai',
        generation: body.generation,
        keyId: 'key-3f9a',
        ...(account ? { account } : {}),
      });
    expect(await open(body.ciphertext, aad('work'))).toBe('sk-work-1234');
    // it opens for no other account, and not as the main key
    await expect(open(body.ciphertext, aad('personal'))).rejects.toBeDefined();
    await expect(open(body.ciphertext, aad())).rejects.toBeDefined();
    expect(JSON.stringify(calls)).not.toContain('sk-work-1234');
  });

  it('the main key is sealed as it always was (no account)', async () => {
    const user = userEvent.setup();
    page();
    await openAndFill(user, 'ai-setkey-openai-main', 'sk-main-5678');
    await user.click(screen.getByTestId('ai-key-save'));
    const body = await sentBlob();
    expect(body.account).toBeUndefined();
    const aad = providerKeyAad({
      scope: 'workstation',
      provider: 'openai',
      generation: body.generation,
      keyId: 'key-3f9a',
    });
    expect(await open(body.ciphertext, aad)).toBe('sk-main-5678');
  });

  it('Add a named account asks for the name, then seals the key for it', async () => {
    const user = userEvent.setup();
    page();
    const openai = await tile('openai');
    await user.click(openai.getByTestId('ai-add-openai'));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByTestId('ai-key-save');
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByTestId('ai-key-name'), 'main');
    await user.type(within(dialog).getByTestId('ai-key-key-openai'), 'sk-new-9999');
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/not "main" or "org"/)).toBeInTheDocument();
    await user.clear(within(dialog).getByTestId('ai-key-name'));
    await user.type(within(dialog).getByTestId('ai-key-name'), 'team');
    expect(save).toBeEnabled();
    await user.click(save);
    const body = await sentBlob();
    expect(body.account).toBe('team');
  });

  it('is not sent over a page that cannot encrypt: the notice shows and Save stays off', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const user = userEvent.setup();
    page();
    await openAndFill(user, 'ai-setkey-openai-work', 'sk-work-1234');
    expect(await screen.findByTestId('secure-context-notice')).toHaveTextContent(
      'Encrypting secrets needs HTTPS or localhost',
    );
    expect(screen.getByTestId('ai-key-save')).toBeDisabled();
    expect(callTo('PUT', '/providers/openai')).toBeUndefined();
  });

  it('removes a named account’s key, and the main key', async () => {
    const user = userEvent.setup();
    page();
    const openai = await tile('openai');
    await user.click(openai.getByTestId('ai-remove-openai-work'));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callTo('DELETE', '/providers/openai')).toBeDefined());
    expect(callTo('DELETE', '/providers/openai')?.url).toContain('?account=work');
    calls.length = 0;
    await user.click(openai.getByTestId('ai-remove-openai-main'));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callTo('DELETE', '/providers/openai')).toBeDefined());
    expect(callTo('DELETE', '/providers/openai')?.url).not.toContain('account');
  });

  it('Make main on a key account swaps it with the main key', async () => {
    const user = userEvent.setup();
    page();
    const openai = await tile('openai');
    await user.click(openai.getByTestId('ai-promote-openai-work'));
    await user.click(await screen.findByRole('button', { name: 'Make main' }));
    await waitFor(() => expect(callTo('POST', '/accounts/promote')).toBeDefined());
    expect(callTo('POST', '/accounts/promote')?.body).toEqual({ scope: 'openai', key: 'work' });
  });
});

describe('the accounts helper text', () => {
  it('tiles carry no secret', () => {
    const t = defaultTiles();
    expect(JSON.stringify(t)).not.toMatch(/sk-|ciphertext|token/i);
    const acct: AiRuntimeAccount | undefined = t.find((x) => x.id === 'codex')?.accounts[1];
    expect(acct).toMatchObject({ key: 'work', canPromote: true });
  });
});
