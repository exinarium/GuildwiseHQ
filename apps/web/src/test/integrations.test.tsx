import type { DeskItemDto, IntegrationStatus } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JiraStatusLine } from '../components/JiraStatusLine.tsx';
import { McpServersPanel } from '../components/McpServersPanel.tsx';
import { RepoProviderControl } from '../components/RepoProviderControl.tsx';
import { DeskItem } from '../pages/Desk.tsx';
import { Integrations, IntegrationsIndex } from '../pages/Integrations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const WS = ID(10);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = '2026-10-14T10:00:00.000Z';
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let privateKey: CryptoKey;
let publicKeyB64: string;
beforeEach(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  privateKey = pair.privateKey;
  publicKeyB64 = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
});

interface Env {
  envelope: { keyId: string; wrappedKey: string; iv: string; ct: string };
}
/** What the runner does with an envelope: unwrap, decrypt with the AAD rebuilt from the plaintext's own fields. */
async function open(env: Env['envelope'], workstationId: string) {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(env.wrappedKey));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  // Try the AAD for each op and ref the test cares about by reading the ref back out of a first, AAD-less guess: the
  // caller passes candidates through `tryAad`.
  return { aes, iv: unb64(env.iv), ct: unb64(env.ct), workstationId };
}
async function decryptWith(
  env: Env['envelope'],
  aad: { workstationId: string; ref: string; kind: string; instance: string; op: string },
) {
  const o = await open(env, aad.workstationId);
  const text = new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: o.iv,
        additionalData: new TextEncoder().encode(
          `guildwise-integration-v1\n${aad.workstationId}\n${aad.ref}\n${aad.kind}\n${aad.instance}\n${aad.op}`,
        ),
      },
      o.aes,
      o.ct,
    ),
  );
  return JSON.parse(text) as { op: string; ref: string; fields: Record<string, string> };
}

const status = (over: Partial<IntegrationStatus> & Pick<IntegrationStatus, 'kind'>): IntegrationStatus => ({
  instance: '',
  state: 'connected',
  checkedAt: NOW,
  scope: 'workstation',
  ...over,
});

interface Server {
  page: Record<string, unknown>;
  requests: Map<string, Record<string, unknown>>;
  calls: Array<{ method: string; url: string; body?: unknown; raw?: string }>;
  chooser: unknown[];
  workstations: unknown[];
}
let server: Server;

const makePage = (
  over: { integrations?: IntegrationStatus[]; runner?: Record<string, unknown>; legacy?: boolean } = {},
) => ({
  workstation: { id: WS, name: 'Desk' },
  key: { keyId: 'key-3f9a', publicKey: publicKeyB64 },
  serverTime: NOW,
  runner: {
    connected: true,
    version: '0.1.11',
    integrationsVersion: 1,
    policy: { allowWeb: true, primaryPairing: true, machineScopeFromWeb: 'primary' },
    ...over.runner,
  },
  integrations: over.integrations ?? [],
  activeSessions: [],
  legacy: over.legacy ?? false,
});

const req = (id: string, over: Record<string, unknown>) => ({
  id,
  op: 'connect',
  kind: 'jira',
  instance: '',
  method: 'token',
  state: 'pending',
  prompt: null,
  status: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  server = { page: makePage(), requests: new Map(), calls: [], chooser: [], workstations: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const raw = init.body ? String(init.body) : undefined;
      server.calls.push({ method, url, ...(raw ? { body: JSON.parse(raw), raw } : {}) });
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
      if (url === '/api/integrations/workstations') return json({ workstations: server.chooser });
      if (url === '/api/workstations') return json({ workstations: server.workstations });
      if (url === `/api/workstations/${WS}/integrations`) return json(server.page);
      if (url === `/api/workstations/${WS}/ai-runtimes`)
        return json({
          workstationId: WS,
          online: true,
          runnerVersion: '0.1.58',
          tiles: [],
          lastPromote: null,
        });
      const m = /\/integrations\/requests\/([^/]+)$/.exec(url);
      if (m) return json(server.requests.get(m[1] as string) ?? req(m[1] as string, {}));
      if (method === 'POST' && url.endsWith('/integrations/connect')) {
        const id = (JSON.parse(raw ?? '{}') as { requestId: string }).requestId;
        server.requests.set(id, req(id, { state: 'pending' }));
        return json({ id, state: 'pending' }, 202);
      }
      if (method === 'POST' && url.endsWith('/integrations/sessions')) {
        server.requests.set(
          ID(900),
          req(ID(900), {
            op: 'session',
            kind: 'mcp',
            instance: 'plugin_atlassian_atlassian',
            method: 'oauth_paste',
            state: 'starting',
          }),
        );
        return json({ id: ID(900), state: 'starting' }, 202);
      }
      if (method === 'POST') return json({ id: ID(901), state: 'pending' }, 202);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
    </QueryClientProvider>,
  );

const page = (search = '') =>
  wrap(
    <Routes>
      <Route path="/workstations/:id/integrations" element={<Integrations />} />
    </Routes>,
    `/workstations/${WS}/integrations${search}`,
  );

describe('Integrations page: tiles', () => {
  it('shows a badge per state, with facts, missing scopes in amber and expiry in red under 14 days', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    server.page = makePage({
      integrations: [
        status({ kind: 'claude-code', account: 'me@x.io', method: 'oauth_token', expiresAt: soon }),
        status({
          kind: 'github',
          instance: 'github.com',
          scope: 'machine',
          state: 'refused',
          detail: 'Bad credentials',
        }),
        status({ kind: 'gitlab', instance: 'gitlab.com', state: 'expired' }),
        status({
          kind: 'bitbucket-cloud',
          account: 'bb',
          scopes: ['read:user:bitbucket'],
          missingScopes: ['write:pullrequest:bitbucket'],
        }),
        status({ kind: 'jira', state: 'unreachable' }),
        status({
          kind: 'ssh',
          instance: 'github@github.com',
          scope: 'machine',
          state: 'unavailable',
          publicKey: 'ssh-ed25519 AAAA',
        }),
        status({
          kind: 'mcp',
          instance: 'plugin_atlassian_atlassian',
          scope: 'machine',
          state: 'needs_sign_in',
        }),
        status({ kind: 'mcp', instance: 'plugin_x_stdio', scope: 'machine', state: 'not_needed' }),
      ],
    });
    page();
    const claude = await screen.findByTestId('tile-claude-code');
    expect(within(claude).getByTestId('tile-badge')).toHaveTextContent('Connected');
    expect(within(claude).getByTestId('tile-expiry')).toHaveTextContent('in 5 days');
    expect(within(claude).getByTestId('tile-expiry').className).toContain('text-danger');
    expect(claude).toHaveTextContent('me@x.io');
    expect(within(screen.getByTestId('tile-github:github.com')).getByTestId('tile-badge')).toHaveTextContent(
      'Refused',
    );
    expect(screen.getByTestId('tile-github:github.com')).toHaveTextContent(
      'Shared by every pairing on this machine',
    );
    expect(within(screen.getByTestId('tile-gitlab:gitlab.com')).getByTestId('tile-badge')).toHaveTextContent(
      'Expired',
    );
    const bb = screen.getByTestId('tile-bitbucket-cloud');
    expect(bb.querySelector('[data-missing="true"]')).toHaveTextContent('write:pullrequest:bitbucket');
    expect(within(screen.getByTestId('tile-jira')).getByTestId('tile-badge')).toHaveTextContent(
      'Unreachable',
    );
    expect(
      within(screen.getByTestId('tile-ssh:github@github.com')).getByTestId('tile-badge'),
    ).toHaveTextContent('Tool missing');
    expect(screen.getByTestId('tile-ssh:github@github.com')).toHaveTextContent('ssh-ed25519 AAAA');
    expect(
      within(screen.getByTestId('tile-mcp:plugin_atlassian_atlassian')).getByTestId('tile-badge'),
    ).toHaveTextContent('Needs sign-in');
    expect(within(screen.getByTestId('tile-mcp:plugin_x_stdio')).getByTestId('tile-badge')).toHaveTextContent(
      'Not needed',
    );
    // A kind with no record yet is Not connected.
    expect(within(screen.getByTestId('tile-azure-devops')).getByTestId('tile-badge')).toHaveTextContent(
      'Not connected',
    );
    expect(screen.getByTestId('key-line')).toHaveTextContent('key-3f9a');
  });

  it('keeps the group order and shows the terminal command under "From a terminal"', async () => {
    page();
    await screen.findByTestId('group-ai');
    const ids = [...document.querySelectorAll('section[data-testid^="group-"]')].map((e) =>
      e.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['group-ai', 'group-git', 'group-tracker', 'group-mcp']);
    expect(within(screen.getByTestId('tile-jira')).getByTestId('tile-terminal')).toHaveTextContent(
      'aom-runner jira-connect',
    );
  });
});

describe('Integrations page: several Claude accounts', () => {
  beforeEach(() => {
    server.page = makePage({
      integrations: [
        status({ kind: 'claude-code', account: 'me@x.io', method: 'oauth_token' }),
        status({
          kind: 'claude-code',
          instance: 'work',
          account: 'a@x.io',
          method: 'claude_login',
          scope: 'machine',
        }),
      ],
    });
  });

  it('shows one tile per account: the main account and one per key', async () => {
    page();
    const main = await screen.findByTestId('tile-claude-code');
    expect(main).toHaveTextContent('Main account');
    const work = screen.getByTestId('tile-claude-code:work');
    expect(work).toHaveTextContent('Claude Code (work)');
    expect(work).toHaveTextContent('Sign in with your Claude subscription');
    expect(screen.getByTestId('connect-another-claude-code')).toHaveTextContent('Connect another account');
  });

  it('"Sign in with your Claude subscription" is offered first for a key and never for the main account', async () => {
    const user = userEvent.setup();
    page();
    const main = await screen.findByTestId('tile-claude-code');
    expect(main).not.toHaveTextContent('own Claude folder');
    await user.click(within(main).getByRole('button', { name: 'Replace' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).queryByText(/own Claude folder/)).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: 'Close dialog' }));

    const work = screen.getByTestId('tile-claude-code:work');
    await user.click(within(work).getByRole('button', { name: 'Replace' }));
    const dlg2 = await screen.findByRole('dialog');
    const radios = within(dlg2).getAllByRole('radio');
    expect(radios[0]).toHaveAccessibleName(/^Sign in with your Claude subscription\(recommended\)/);
    expect(radios[0]).toBeChecked();
  });

  it('an account key needs the newer runner: the reason names 0.1.33, the main account keeps 0.1.11', async () => {
    server.page = makePage({
      runner: { integrationsVersion: null },
      legacy: true,
      integrations: [
        status({ kind: 'claude-code', account: 'me@x.io', method: 'oauth_token' }),
        status({ kind: 'claude-code', instance: 'work', method: 'claude_login', scope: 'machine' }),
      ],
    });
    page();
    const work = await screen.findByTestId('tile-claude-code:work');
    expect(work.querySelector('button[disabled]')?.getAttribute('title')).toContain('0.1.33');
    const main = screen.getByTestId('tile-claude-code');
    expect(main.querySelector('button[disabled]')?.getAttribute('title')).toContain('0.1.11');
  });
});

describe('Integrations page: disabled reasons', () => {
  it('an old runner shows a banner and a read-only reason with the CLI line', async () => {
    server.page = makePage({
      runner: { integrationsVersion: null, policy: null },
      legacy: true,
      integrations: [status({ kind: 'jira' })],
    });
    page();
    expect(await screen.findByTestId('old-runner-banner')).toHaveTextContent('Update to runner >= 0.1.11');
    const tile = screen.getByTestId('tile-jira');
    expect(within(tile).getByRole('button', { name: 'Replace' })).toBeDisabled();
    expect(within(tile).getByTestId('tile-blocked')).toHaveTextContent(
      'until then run aom-runner jira-connect',
    );
  });

  it('web connect turned off and a machine-scope login from a non-primary pairing say why', async () => {
    server.page = makePage({
      runner: { policy: { allowWeb: false, primaryPairing: true, machineScopeFromWeb: 'primary' } },
    });
    const first = page();
    expect(await screen.findByTestId('web-off-banner')).toHaveTextContent(
      'Turned off on this workstation (aom-runner integrations allow-web on)',
    );
    expect(within(screen.getByTestId('tile-jira')).getByRole('button', { name: 'Connect' })).toBeDisabled();
    first.unmount();

    server.page = makePage({
      runner: { policy: { allowWeb: true, primaryPairing: false, machineScopeFromWeb: 'primary' } },
    });
    page();
    const gh = await screen.findByTestId('tile-github:github.com');
    expect(within(gh).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(gh).getByTestId('tile-blocked')).toHaveTextContent('shared by every pairing');
    // A workstation-scope tile stays usable.
    expect(within(screen.getByTestId('tile-jira')).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('the Sign out confirmation of a machine-wide sign-in says "shared by every pairing" once', async () => {
    server.page = makePage({
      integrations: [
        status({ kind: 'mcp', instance: 'plugin_atlassian_atlassian', scope: 'machine', state: 'connected' }),
      ],
    });
    page();
    const tile = await screen.findByTestId('tile-mcp:plugin_atlassian_atlassian');
    await userEvent.click(within(tile).getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: /Sign out of/ });
    expect(dialog.textContent?.match(/shared by every pairing/g)).toHaveLength(1);
  });
});

describe('Connect dialog', () => {
  it('sends only the sealed envelope: no typed value appears in the request body', async () => {
    const user = userEvent.setup();
    page();
    const tile = await screen.findByTestId('tile-jira');
    await user.click(within(tile).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByTestId('connect-dialog-jira');
    const token = within(dialog).getByLabelText('API token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(token).toHaveAttribute('spellcheck', 'false');
    await user.type(within(dialog).getByLabelText('Jira base URL'), 'https://acme.atlassian.net');
    await user.type(within(dialog).getByLabelText(/Atlassian e-mail address/), 'me@acme.com');
    await user.type(token, 'SECRET-TOKEN-123');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/integrations/connect'))).toBe(true));
    const call = server.calls.find((c) => c.url.endsWith('/integrations/connect')) as {
      body: Record<string, unknown>;
      raw: string;
    };
    expect(Object.keys(call.body).sort()).toEqual(['envelope', 'instance', 'kind', 'method', 'requestId']);
    for (const v of ['SECRET-TOKEN-123', 'https://acme.atlassian.net', 'me@acme.com'])
      expect(call.raw).not.toContain(v);
    const env = call.body.envelope as Env['envelope'];
    expect(env.keyId).toBe('key-3f9a');
    const opened = await decryptWith(env, {
      workstationId: WS,
      ref: call.body.requestId as string,
      kind: 'jira',
      instance: '',
      op: 'connect',
    });
    expect(opened.fields).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.com',
      token: 'SECRET-TOKEN-123',
    });
    // The typed values left the form; the provider's answer arrives by polling.
    expect(within(dialog).queryByDisplayValue('SECRET-TOKEN-123')).toBeNull();
    server.requests.set(
      call.body.requestId as string,
      req(call.body.requestId as string, { state: 'done', status: status({ kind: 'jira', account: 'Me' }) }),
    );
    expect(await screen.findByTestId('connect-result', {}, { timeout: 4000 })).toHaveTextContent(
      'Connected as Me',
    );
  });

  it('shows the provider reason when it refuses', async () => {
    const user = userEvent.setup();
    page();
    const tile = await screen.findByTestId('tile-bitbucket-cloud');
    await user.click(within(tile).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByTestId('connect-dialog-bitbucket-cloud');
    await user.type(within(dialog).getByLabelText(/Atlassian e-mail/), 'a@b.co');
    await user.type(within(dialog).getByLabelText('API token'), 'tok');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/integrations/connect'))).toBe(true));
    const id = (
      server.calls.find((c) => c.url.endsWith('/integrations/connect')) as { body: { requestId: string } }
    ).body.requestId;
    server.requests.set(
      id,
      req(id, {
        kind: 'bitbucket-cloud',
        state: 'failed',
        error: 'Bitbucket refused the token: missing scope write:pullrequest:bitbucket',
      }),
    );
    expect(await screen.findByTestId('connect-result', {}, { timeout: 4000 })).toHaveTextContent(
      'missing scope write:pullrequest:bitbucket',
    );
  });
});

describe('Sign-in session', () => {
  it('walks the stepper: link, paste (sealed with op input and a per-attempt ref), finishing, connected', async () => {
    const user = userEvent.setup();
    server.page = makePage({
      integrations: [
        status({
          kind: 'mcp',
          instance: 'plugin_atlassian_atlassian',
          scope: 'machine',
          state: 'needs_sign_in',
        }),
      ],
    });
    page();
    const tile = await screen.findByTestId('tile-mcp:plugin_atlassian_atlassian');
    await user.click(within(tile).getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Start sign-in' }));
    const sess = await screen.findByTestId('sign-in-session');
    const sent = server.calls.find((c) => c.url.endsWith('/integrations/sessions'));
    expect(sent?.body).toEqual({
      kind: 'mcp',
      instance: 'plugin_atlassian_atlassian',
      method: 'oauth_paste',
    });

    server.requests.set(
      ID(900),
      req(ID(900), {
        op: 'session',
        kind: 'mcp',
        instance: 'plugin_atlassian_atlassian',
        method: 'oauth_paste',
        state: 'awaiting_user',
        prompt: {
          url: 'https://auth.atlassian.com/authorize?x=1',
          urlHost: 'auth.atlassian.com',
          inputKind: 'redirect_url',
          inputLabel: 'Address',
        },
      }),
    );
    const host = await within(sess).findByTestId('session-host', {}, { timeout: 4000 });
    expect(host).toHaveTextContent('auth.atlassian.com');
    expect(within(sess).getByTestId('session-link')).toHaveAttribute('target', '_blank');
    expect(within(sess).getByTestId('session-countdown')).toHaveTextContent(/^\d+:\d\d left$/);
    expect(within(sess).getByTestId('mcp-hint')).toHaveTextContent(/expected/);

    server.requests.set(
      ID(900),
      req(ID(900), {
        op: 'session',
        kind: 'mcp',
        instance: 'plugin_atlassian_atlassian',
        method: 'oauth_paste',
        state: 'awaiting_code',
        prompt: {
          url: 'https://auth.atlassian.com/authorize?x=1',
          urlHost: 'auth.atlassian.com',
          inputKind: 'redirect_url',
          inputLabel: 'Address',
        },
      }),
    );
    const input = await within(sess).findByLabelText('Address', {}, { timeout: 4000 });
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, 'http://localhost:1234/callback?code=SECRETCODE&state=s');
    await user.click(within(sess).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.url.endsWith(`/sessions/${ID(900)}/input`))).toBe(true),
    );
    const inp = server.calls.find((c) => c.url.endsWith(`/sessions/${ID(900)}/input`)) as {
      body: Record<string, unknown>;
      raw: string;
    };
    expect(Object.keys(inp.body)).toEqual(['envelope']);
    expect(inp.raw).not.toContain('SECRETCODE');
    const opened = await decryptWith(inp.body.envelope as Env['envelope'], {
      workstationId: WS,
      ref: `${ID(900)}:1`,
      kind: 'mcp',
      instance: 'plugin_atlassian_atlassian',
      op: 'input',
    });
    expect(opened.op).toBe('input');
    expect(opened.fields).toEqual({ value: 'http://localhost:1234/callback?code=SECRETCODE&state=s' });

    server.requests.set(
      ID(900),
      req(ID(900), {
        op: 'session',
        kind: 'mcp',
        instance: 'plugin_atlassian_atlassian',
        state: 'connected',
        updatedAt: '2026-10-14T10:05:00.000Z',
        status: status({ kind: 'mcp', instance: 'plugin_atlassian_atlassian', account: 'me@x' }),
      }),
    );
    expect(await within(sess).findByTestId('session-result', {}, { timeout: 4000 })).toHaveTextContent(
      'Connected as me@x',
    );
  });

  it('shows a device code with Copy and cancels on request', async () => {
    const user = userEvent.setup();
    page();
    const tile = await screen.findByTestId('tile-github:github.com');
    await user.click(within(tile).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByTestId('connect-dialog-github');
    await user.click(within(dialog).getByRole('button', { name: 'Start sign-in' }));
    server.requests.set(
      ID(900),
      req(ID(900), {
        op: 'session',
        kind: 'github',
        instance: 'github.com',
        method: 'device',
        state: 'awaiting_user',
        prompt: {
          url: 'https://github.com/login/device',
          urlHost: 'github.com',
          userCode: 'ABCD-1234',
          inputKind: 'none',
        },
      }),
    );
    expect(await screen.findByTestId('session-code', {}, { timeout: 4000 })).toHaveTextContent('ABCD-1234');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.url.endsWith(`/sessions/${ID(900)}/cancel`))).toBe(true),
    );
  });
});

describe('Chooser and deep links', () => {
  const ws = (n: number, name: string, connected: boolean, needsAttention: number) => ({
    id: ID(n),
    name,
    connected,
    lastSeenAt: NOW,
    needsAttention,
    total: 6,
  });

  it('shows a chooser with several workstations and remembers the choice', async () => {
    const user = userEvent.setup();
    server.chooser = [ws(10, 'Desk', true, 2), ws(11, 'Laptop', false, 0)];
    wrap(
      <Routes>
        <Route path="/integrations" element={<IntegrationsIndex />} />
        <Route path="/workstations/:id/integrations" element={<p>page</p>} />
      </Routes>,
      '/integrations',
    );
    const list = await screen.findByTestId('workstation-chooser');
    expect(within(list).getByTestId(`choose-${ID(10)}`)).toHaveTextContent('2 need attention');
    expect(within(list).getByTestId(`choose-${ID(11)}`)).toHaveTextContent('Offline');
    await user.click(within(list).getByTestId(`choose-${ID(11)}`));
    expect(await screen.findByText('page')).toBeInTheDocument();
    expect(localStorage.getItem(`guildwise-integrations-last-${ID(1)}`)).toBe(ID(11));
  });

  it('goes straight to the only workstation, and a deep link goes to the last one used', async () => {
    server.chooser = [ws(10, 'Desk', true, 0)];
    const first = wrap(
      <Routes>
        <Route path="/integrations" element={<IntegrationsIndex />} />
        <Route path="/workstations/:id/integrations" element={<p>page</p>} />
      </Routes>,
      '/integrations',
    );
    expect(await screen.findByText('page')).toBeInTheDocument();
    first.unmount();
    server.chooser = [ws(10, 'Desk', true, 0), ws(11, 'Laptop', true, 0)];
    localStorage.setItem(`guildwise-integrations-last-${ID(1)}`, ID(11));
    wrap(
      <Routes>
        <Route path="/integrations" element={<IntegrationsIndex />} />
        <Route path="/workstations/:id/integrations" element={<p>page</p>} />
      </Routes>,
      '/integrations?focus=jira',
    );
    expect(await screen.findByText('page')).toBeInTheDocument();
  });

  it('?focus highlights the tile and connect=1 opens the dialog', async () => {
    page('?focus=jira&connect=1');
    const tile = await screen.findByTestId('tile-jira');
    expect(tile).toHaveAttribute('data-highlight', 'true');
    expect(await screen.findByTestId('connect-dialog-jira')).toBeInTheDocument();
  });

  const deskBase = {
    id: ID(500),
    kind: 'alert',
    subkind: 'claude_auth_expired',
    status: 'open',
    routedTo: 'manager',
    title: 'Claude login expired',
    body: 'x',
    doing: '',
    options: [],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system', agentId: null, agentName: null, role: null },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: null,
    canAnswer: true,
    createdAt: NOW,
  } as unknown as DeskItemDto;

  it('Desk notices get "Sign in from the web" pointing at the tile', () => {
    const a = wrap(<DeskItem item={{ ...deskBase, data: { workstationId: WS } } as never} />);
    expect(screen.getByTestId('desk-sign-in-web')).toHaveAttribute(
      'href',
      `/workstations/${WS}/integrations?focus=claude-code&connect=1`,
    );
    a.unmount();
    wrap(
      <DeskItem
        item={
          {
            ...deskBase,
            subkind: 'mcp_needs_sign_in',
            data: { workstationId: WS, key: `mcp_signin:${WS}:plugin_atlassian_atlassian` },
          } as never
        }
      />,
    );
    expect(screen.getByTestId('desk-sign-in-web').getAttribute('href')).toBe(
      `/workstations/${WS}/integrations?focus=mcp%3Aplugin_atlassian_atlassian&connect=1`,
    );
  });

  it("the notice for a project account points at that account's tile", () => {
    wrap(
      <DeskItem
        item={
          {
            ...deskBase,
            subkind: 'claude_account_login',
            data: { workstationId: WS, key: `claude_account:${WS}:work` },
          } as never
        }
      />,
    );
    expect(screen.getByTestId('desk-sign-in-web').getAttribute('href')).toBe(
      `/workstations/${WS}/integrations?focus=claude-code%3Awork&connect=1`,
    );
  });

  it('McpServersPanel links a needs-sign-in server to its tile', async () => {
    server.workstations = [
      { id: WS, userId: ID(1), name: 'Desk', status: 'active', connected: true, runtimes: [], repos: [] },
    ];
    wrap(
      <McpServersPanel
        projectId={ID(2)}
        granted={['plugin_atlassian_atlassian']}
        canGrant={false}
        candidates={[
          {
            name: 'plugin_atlassian_atlassian',
            plugin: 'atlassian',
            server: 'atlassian',
            transport: 'http',
            host: null,
            tools: null,
            workstations: ['Desk'],
            needsSignIn: ['Desk'],
          },
        ]}
      />,
    );
    const link = await screen.findByTestId('mcp-sign-in-link-plugin_atlassian_atlassian');
    expect(link.getAttribute('href')).toBe(
      `/workstations/${WS}/integrations?focus=mcp%3Aplugin_atlassian_atlassian`,
    );
  });

  it('RepoProviderControl offers "Connect on the Integrations page" and keeps the CLI line under "From a terminal"', async () => {
    const user = userEvent.setup();
    server.workstations = [
      {
        id: WS,
        userId: ID(1),
        name: 'Desk',
        status: 'active',
        connected: true,
        runtimes: [],
        repos: [],
        git: { connections: [], checkedAt: NOW },
      },
    ];
    wrap(
      <RepoProviderControl
        projectId={ID(2)}
        isOwner
        repo={
          {
            id: ID(50),
            projectId: ID(2),
            name: 'shop',
            remoteUrl: 'https://github.com/a/b',
            remoteUrlNormalized: 'github.com/a/b',
            workingBranch: 'main',
            removedAt: null,
            forge: 'github',
            forgeOverride: null,
          } as never
        }
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    const link = await screen.findByTestId('connect-on-integrations-github');
    expect(link.getAttribute('href')).toContain(`/workstations/${WS}/integrations?focus=github&connect=1`);
    expect(screen.getByTestId('from-terminal-github')).toHaveTextContent('aom-runner git-connect github');
  });

  it('JiraStatusLine links to the Jira tile', () => {
    wrap(<JiraStatusLine w={{ id: WS, connected: true, jira: null } as never} />);
    expect(screen.getByTestId('jira-open-integrations').getAttribute('href')).toBe(
      `/workstations/${WS}/integrations?focus=jira&connect=1`,
    );
  });
});
