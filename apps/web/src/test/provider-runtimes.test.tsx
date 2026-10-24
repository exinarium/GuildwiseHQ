/* eslint-disable @typescript-eslint/no-explicit-any */
import type { WorkstationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelect, unionExtras } from '../components/ModelSelect.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ModelProviders } from '../components/workstations/ModelProviders.tsx';
import { Agents } from '../pages/Agents.tsx';

vi.mock('@aom/shared', async (orig) => ({
  ...(await orig<typeof import('@aom/shared')>()),
  sealLarge: async (_k: string, text: string) => `h1.sealed-${text.length}`,
}));
vi.mock('../lib/runner-seal.ts', async (orig) => ({
  ...(await orig<typeof import('../lib/runner-seal.ts')>()),
  encryptForRunner: async (_k: string, text: string) => `sealed(${text.length})`,
}));

const WS = '0192f3a0-0000-7000-8000-0000000000c1';
const ORG = '0192f3a0-0000-7000-8000-0000000000d1';
const rt = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: '1',
  available: true,
  capabilities: ['shell'],
  ...over,
});
const ws = (runtimes: unknown[], over: Record<string, unknown> = {}): WorkstationDto =>
  ({
    id: WS,
    name: 'Desktop',
    connected: true,
    status: 'active',
    platform: 'linux',
    userId: ORG,
    runtimes,
    repos: [],
    ...over,
  }) as unknown as WorkstationDto;

type Call = { method: string; url: string; body?: any };
let calls: Call[];
let stations: unknown[];
beforeEach(() => {
  calls = [];
  stations = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.split('?')[0] as string;
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (path.endsWith('/sudo-key')) return json({ keyId: 'k1', publicKey: 'AAAA' });
      if (path.includes('/providers/')) return json({ queued: true }, 202);
      if (path === '/api/workstations') return json({ workstations: stations });
      if (path === '/api/roles')
        return json({
          roles: [
            {
              definition: {
                key: 'builder',
                name: 'Builder',
                seniorityLevels: ['senior'],
                defaultModel: { runtime: 'claude-code', model: 'sonnet' },
                permissions: {
                  allowedTools: ['read', 'edit', 'shell'],
                  deniedShellPatterns: [],
                  writableGlobs: null,
                  mayCommit: true,
                  browser: false,
                },
              },
              orgId: null,
              status: 'active',
              extensions: null,
            },
            {
              definition: {
                key: 'tester',
                name: 'Tester',
                seniorityLevels: ['senior'],
                defaultModel: { runtime: 'claude-code', model: 'sonnet' },
                permissions: {
                  allowedTools: ['read', 'edit', 'shell'],
                  deniedShellPatterns: [],
                  writableGlobs: ['e2e/**'],
                  mayCommit: false,
                  browser: true,
                },
              },
              orgId: null,
              status: 'active',
              extensions: null,
            },
          ],
        });
      if (path === '/api/auth/me' || path === '/api/me')
        return json({
          user: { id: ORG, email: 'o@x.test', displayName: 'Olga', kind: 'user' },
          activeOrg: { id: ORG, name: 'Org', role: 'owner', status: 'active', features: {}, banners: [] },
          orgs: [],
          features: {},
        });
      if (path === '/api/agents') return json({ agents: [] });
      if (path === '/api/hr/board')
        return json({ windowDays: 30, agents: [], recommendations: [], roleUpdates: [] });
      if (path === '/api/projects') return json({ projects: [] });
      if (path === '/api/agents/name-suggestions') return json({ names: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('the workstation: whose key is in effect, and Claude Code on another backend', () => {
  const direct = (providers: unknown[], keys: unknown[]) =>
    rt('direct-model', { providers, keys, capabilities: [] });
  const openai = { id: 'openai', label: 'OpenAI', models: [{ id: 'gpt-5', label: 'GPT-5' }] };

  it('says whether a key is the organization’s or the workstation’s own, and that an own key overrides', () => {
    wrap(
      <ModelProviders
        w={ws([
          rt('claude-code'),
          direct(
            [
              { ...openai, keySource: 'org', orgKey: true },
              {
                id: 'google',
                label: 'Google Gemini',
                models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
                keySource: 'workstation',
                orgKey: true,
              },
            ],
            [],
          ),
        ])}
        canEdit
      />,
    );
    expect(within(screen.getByTestId('provider-openai')).getByText('Organization key')).toBeInTheDocument();
    const g = within(screen.getByTestId('provider-google'));
    expect(g.getByText(/Own key \(overrides the organization/)).toBeInTheDocument();
  });

  it('adds Bedrock credentials sealed as one JSON; the request never carries them in plain', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws([rt('claude-code'), direct([openai], [])])} canEdit />);
    expect(within(screen.getByTestId('backend-bedrock')).getByText('Not configured')).toBeInTheDocument();
    await user.click(screen.getByTestId('backend-edit-bedrock'));
    expect(screen.getByTestId('backend-save-bedrock')).toBeDisabled();
    await user.type(screen.getByTestId('backend-field-bedrock-region'), 'us-east-1');
    await user.type(screen.getByTestId('backend-field-bedrock-accessKeyId'), 'AKIAEXAMPLE');
    expect(screen.getByTestId('backend-save-bedrock')).toBeDisabled(); // an access key needs its secret too
    await user.type(screen.getByTestId('backend-field-bedrock-secretAccessKey'), 'sekrit-value');
    expect(screen.getByTestId('backend-field-bedrock-secretAccessKey')).toHaveAttribute('type', 'password');
    await user.click(screen.getByTestId('backend-save-bedrock'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const put = calls.find((c) => c.method === 'PUT') as Call;
    expect(put.url).toBe(`/api/workstations/${WS}/providers/bedrock`);
    expect(put.body.keyId).toBe('k1');
    expect(put.body.ciphertext).toMatch(/^h1\.sealed-\d+$/);
    expect(JSON.stringify(calls)).not.toMatch(/AKIAEXAMPLE|sekrit-value/);
  });

  it('warns about non-Claude models behind a gateway, and lists a configured backend with its models', () => {
    wrap(
      <ModelProviders
        w={ws([
          rt('claude-code', {
            backends: [
              {
                id: 'gateway',
                label: 'Anthropic-compatible gateway',
                models: [{ id: 'gemini/gemini-2.5-pro', label: 'gemini/gemini-2.5-pro' }],
                detail: 'litellm.example.com',
                keySource: 'org',
                orgKey: true,
              },
            ],
          }),
          direct([openai], []),
        ])}
        canEdit
      />,
    );
    expect(screen.getByTestId('backend-warning-gateway')).toHaveTextContent(/less reliably/);
    expect(screen.getByTestId('backend-models-gateway')).toHaveTextContent(
      'litellm.example.com: gemini/gemini-2.5-pro',
    );
    expect(within(screen.getByTestId('backend-gateway')).getByText('Organization key')).toBeInTheDocument();
    expect(screen.queryByTestId('backend-warning-bedrock')).toBeNull();
  });

  it('tells an older runner to update for the backends', () => {
    wrap(
      <ModelProviders
        w={ws([rt('claude-code'), rt('direct-model', { providers: [openai], capabilities: [] })])}
        canEdit
      />,
    );
    expect(screen.getByTestId('backends-update-runner')).toBeInTheDocument();
    expect(screen.queryByTestId('backend-bedrock')).toBeNull();
  });
});

describe('model pickers offer what each workstation reports', () => {
  const stationsWith = [
    ws([
      rt('claude-code', {
        backends: [
          {
            id: 'bedrock',
            label: 'Amazon Bedrock',
            models: [{ id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
          },
          {
            id: 'gateway',
            label: 'Anthropic-compatible gateway',
            models: [{ id: 'gemini/gemini-2.5-pro', label: 'gemini/gemini-2.5-pro' }],
          },
        ],
      }),
      rt('gemini', { models: [{ id: 'gemini-9-custom', label: 'gemini-9-custom' }] }),
      rt('opencode', { models: [{ id: 'openai/gpt-5', label: 'openai/gpt-5' }] }),
    ]),
  ] as WorkstationDto[];

  it('unions the backends and the model lists of the workstations', () => {
    const x = unionExtras([
      ...stationsWith,
      ws([
        rt('opencode', {
          models: [
            { id: 'openai/gpt-5', label: 'x' },
            { id: 'google/gemini-2.5-pro', label: 'y' },
          ],
        }),
      ]),
    ]);
    expect(x.backends?.map((b) => b.id)).toEqual(['bedrock', 'gateway']);
    expect(x.models?.opencode?.map((m) => m.id)).toEqual(['openai/gpt-5', 'google/gemini-2.5-pro']);
    expect(x.models?.gemini?.map((m) => m.id)).toEqual(['gemini-9-custom']);
  });

  it('lists a group per backend and shows the caution once a gateway model is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const Harness = () => {
      const [v, setV] = useState('');
      return (
        <ModelSelect
          label="Model"
          value={v}
          onChange={(x) => {
            setV(x);
            onChange(x);
          }}
          runtimes={['claude-code', 'gemini', 'opencode']}
          providers={[]}
          extras={unionExtras(stationsWith)}
        />
      );
    };
    wrap(<Harness />);
    const select = screen.getByLabelText('Model');
    expect(
      within(select).getByRole('option', { name: 'Amazon Bedrock (Claude Code): Claude Sonnet 4.6' }),
    ).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Gemini CLI: gemini-9-custom' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'opencode: openai/gpt-5' })).toBeInTheDocument();
    await user.selectOptions(select, 'claude-code/bedrock:us.anthropic.claude-sonnet-4-6');
    expect(screen.queryByText(/less reliably/)).toBeNull();
    await user.selectOptions(select, 'claude-code/gateway:gemini/gemini-2.5-pro');
    expect(screen.getByText(/less reliably/)).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('claude-code/gateway:gemini/gemini-2.5-pro');
  });
});

describe('the hire form: which roles a runtime can take', () => {
  async function open() {
    stations = [
      ws([
        rt('claude-code'),
        rt('gemini', { models: [{ id: 'gemini-9-custom', label: 'gemini-9-custom' }] }),
        rt('direct-model', { providers: [], keys: [] }),
      ]),
    ];
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Hire agent' }));
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    await within(form).findByRole('option', { name: /Desktop/ });
    return { user, form };
  }

  it('does not offer the direct API models as a runtime for an agent, and suggests the models of the chosen runtime', async () => {
    const { user, form } = await open();
    const runtime = within(form).getByLabelText('Runtime');
    expect(within(runtime).queryByRole('option', { name: 'direct-model' })).toBeNull();
    await user.selectOptions(runtime, 'gemini');
    const list = document.getElementById('hire-model-suggestions') as HTMLElement;
    expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(
      expect.arrayContaining(['gemini-2.5-pro', 'gemini-9-custom']),
    );
  });

  it('says a tester cannot run on the Gemini CLI (browsers, path-limited writes) and refuses to send it', async () => {
    const { user, form } = await open();
    await user.selectOptions(within(form).getByLabelText('Role'), 'tester');
    await user.selectOptions(within(form).getByLabelText('Runtime'), 'gemini');
    expect(await within(form).findByTestId('hire-runtime-problem')).toHaveTextContent(
      /cannot run on gemini.*browsers/,
    );
    await user.type(within(form).getByLabelText('Name'), 'Tess');
    await user.click(within(form).getByRole('button', { name: 'Hire' }));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/agents')).toBe(false);
    // a builder runs there
    await user.selectOptions(within(form).getByLabelText('Role'), 'builder');
    expect(within(form).queryByTestId('hire-runtime-problem')).toBeNull();
  });

  it('cautions about a model behind a gateway as it is typed', async () => {
    const { user, form } = await open();
    expect(within(form).queryByTestId('hire-model-caution')).toBeNull();
    await user.type(within(form).getByLabelText('Model'), 'gateway:gemini/gemini-2.5-pro');
    expect(await within(form).findByTestId('hire-model-caution')).toHaveTextContent(/less reliably/);
  });
});
