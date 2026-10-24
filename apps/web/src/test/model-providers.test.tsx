import type { ReportedProvider, WorkstationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewBoardroomDialog } from '../components/boardroom/NewBoardroomDialog.tsx';
import { ModelChip } from '../components/ceo/ModelChip.tsx';
import { NewDiscoveryDialog } from '../components/discovery/NewDiscoveryDialog.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ModelProviders } from '../components/workstations/ModelProviders.tsx';

const WS = '0192f3a0-0000-7000-8000-0000000000c1';
const openai: ReportedProvider = {
  id: 'openai',
  label: 'OpenAI',
  models: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'medium' },
    { id: 'gpt-5', label: 'GPT-5', tier: 'large' },
  ],
};
const google: ReportedProvider = {
  id: 'google',
  label: 'Google Gemini',
  models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'large' }],
};
const ws = (over: Record<string, unknown> = {}, providers?: ReportedProvider[]): WorkstationDto =>
  ({
    id: WS,
    name: 'Desktop',
    connected: true,
    runtimes: [
      { id: 'claude-code', version: '1', available: true, capabilities: [] },
      ...(providers
        ? [{ id: 'direct-model', version: '1', available: true, capabilities: [], providers }]
        : []),
    ],
    ...over,
  }) as unknown as WorkstationDto;

type Call = { method: string; url: string; body?: any };
let calls: Call[];
let workstations: WorkstationDto[];
beforeEach(() => {
  calls = [];
  workstations = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/sudo-key')) return json({ keyId: 'k1', publicKey: 'AAAA' });
      if (url.includes('/providers/')) return json({ queued: true }, 202);
      if (url.startsWith('/api/workstations')) return json({ workstations });
      if (url.startsWith('/api/capabilities'))
        return json({
          items: [
            {
              kind: 'persona',
              key: 'cost-hawk',
              name: 'Cost Hawk',
              description: 'Money',
              hash: 'h',
              source: 'builtin',
              overrides: false,
            },
            {
              kind: 'persona',
              key: 'security',
              name: 'Security',
              description: 'Risk',
              hash: 'h',
              source: 'builtin',
              overrides: false,
            },
            {
              kind: 'persona',
              key: 'ops',
              name: 'Ops',
              description: 'Run it',
              hash: 'h',
              source: 'builtin',
              overrides: false,
            },
          ],
          issues: [],
          indexedAt: null,
        });
      if (url.startsWith('/api/board-rooms')) return json({ rooms: [] });
      if (url.startsWith('/api/agents')) return json({ agents: [] });
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/ceo')) return json({ state: 'none' });
      if (url === '/api/board' && method === 'POST') return json({ state: { threadId: 'x' } }, 201);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

// Web Crypto: sealing needs a real RSA public key; the test swaps the sealing function for a marker.
vi.mock('@aom/shared', async (orig) => ({
  ...(await orig<typeof import('@aom/shared')>()),
  sealLarge: async (_k: string, text: string) => `h1.sealed(${text.length})`,
}));

describe('model providers settings', () => {
  it('shows configured and unconfigured providers with their models and the data note', () => {
    wrap(<ModelProviders w={ws({}, [openai])} canEdit />);
    expect(within(screen.getByTestId('provider-openai')).getByText('Configured')).toBeInTheDocument();
    expect(screen.getByTestId('provider-models-openai')).toHaveTextContent('GPT-5 mini, GPT-5');
    expect(within(screen.getByTestId('provider-google')).getByText('Not configured')).toBeInTheDocument();
    expect(screen.getAllByText(/Guildwise never sees the key/).length).toBeGreaterThan(0);
    expect(screen.getByText(/encrypted in your browser for the runner/)).toBeInTheDocument();
  });

  it('shows a provider problem', () => {
    wrap(<ModelProviders w={ws({}, [{ ...openai, problem: 'The key was refused (401)' }])} canEdit />);
    expect(screen.getByRole('alert')).toHaveTextContent('The key was refused (401)');
  });

  it('seals the key in the browser: the request has ciphertext and never the plaintext', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws({}, [])} canEdit />);
    await user.click(screen.getByTestId('provider-edit-openai'));
    expect(screen.getByTestId('provider-key-openai')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('provider-save-openai')).toBeDisabled();
    await user.type(screen.getByTestId('provider-key-openai'), 'sk-secret-123');
    await user.type(screen.getByTestId('provider-models-input-openai'), 'gpt-9, gpt-9-mini');
    await user.click(screen.getByTestId('provider-save-openai'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const put = calls.find((c) => c.method === 'PUT') as Call;
    expect(put.url).toBe(`/api/workstations/${WS}/providers/openai`);
    expect(put.body).toEqual({
      keyId: 'k1',
      ciphertext: 'h1.sealed(13)',
      models: ['gpt-9', 'gpt-9-mini'],
    });
    expect(JSON.stringify(calls)).not.toContain('sk-secret-123');
  });

  it('an OpenAI-compatible endpoint needs a base URL and may be keyless', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws({}, [])} canEdit />);
    await user.click(screen.getByTestId('provider-edit-openai-compatible'));
    const save = screen.getByTestId('provider-save-openai-compatible');
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('provider-url-openai-compatible'), 'localhost:11434');
    expect(save).toBeDisabled();
    await user.clear(screen.getByTestId('provider-url-openai-compatible'));
    await user.type(screen.getByTestId('provider-url-openai-compatible'), 'http://localhost:11434/v1');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect((calls.find((c) => c.method === 'PUT') as Call).body).toEqual({
      keyId: 'k1',
      baseUrl: 'http://localhost:11434/v1',
      models: [],
    });
  });

  it('seals a long credential (a service-account JSON) the same way, without a length limit', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws({}, [])} canEdit />);
    await user.click(screen.getByTestId('provider-edit-google'));
    const sa = JSON.stringify({ type: 'service_account', private_key: 'x'.repeat(2500) });
    await user.click(screen.getByTestId('provider-key-google'));
    await user.paste(sa);
    await user.click(screen.getByTestId('provider-save-google'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect((calls.find((c) => c.method === 'PUT') as Call).body.ciphertext).toBe(`h1.sealed(${sa.length})`);
    expect(JSON.stringify(calls)).not.toContain('service_account');
  });

  it('warns about a plain http:// endpoint away from this machine, not about https or localhost', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws({}, [])} canEdit />);
    await user.click(screen.getByTestId('provider-edit-openai-compatible'));
    const url = screen.getByTestId('provider-url-openai-compatible');
    await user.type(url, 'http://llm.internal:8000/v1');
    expect(screen.getByTestId('provider-http-warning')).toHaveTextContent('unencrypted');
    await user.clear(url);
    await user.type(url, 'http://localhost:11434/v1');
    expect(screen.queryByTestId('provider-http-warning')).toBeNull();
    await user.clear(url);
    await user.type(url, 'https://openrouter.ai/api/v1');
    expect(screen.queryByTestId('provider-http-warning')).toBeNull();
  });

  it('removes a provider', async () => {
    const user = userEvent.setup();
    wrap(<ModelProviders w={ws({}, [openai])} canEdit />);
    await user.click(screen.getByTestId('provider-remove-openai'));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url === `/api/workstations/${WS}/providers/openai`),
      ).toBe(true),
    );
    expect(screen.queryByTestId('provider-remove-google')).toBeNull();
  });

  it('is disabled while the workstation is offline and tells an old runner to update', () => {
    const { unmount } = wrap(<ModelProviders w={ws({ connected: false }, [openai])} canEdit />);
    expect(screen.getByTestId('provider-edit-openai')).toBeDisabled();
    expect(screen.getByTestId('provider-remove-openai')).toBeDisabled();
    expect(screen.getAllByText(/offline/).length).toBeGreaterThan(0);
    unmount();
    wrap(<ModelProviders w={ws()} canEdit />);
    expect(screen.getByTestId('providers-update-runner')).toHaveTextContent('Update the runner');
    expect(screen.queryByTestId('provider-openai')).toBeNull();
  });

  it('shows no edit buttons to someone who does not own the workstation', () => {
    wrap(<ModelProviders w={ws({}, [openai])} canEdit={false} />);
    expect(screen.queryByTestId('provider-edit-openai')).toBeNull();
    expect(screen.queryByTestId('provider-remove-openai')).toBeNull();
  });
});

describe('model pickers with direct providers', () => {
  it('the CEO chat model chip offers direct models, marks them conversation only and keeps provider in the choice', async () => {
    const user = userEvent.setup();
    const onMessage = vi.fn();
    wrap(
      <ModelChip
        model={{
          default: { runtime: 'claude-code', model: 'sonnet' },
          thread: null,
          runtimes: ['claude-code', 'direct-model'],
          providers: [openai],
        }}
        messageChoice={null}
        onMessageChoice={onMessage}
      />,
    );
    await user.click(screen.getByTestId('model-chip'));
    expect(screen.getByText('OpenAI (direct)')).toBeInTheDocument();
    expect(screen.getByTestId('direct-note')).toHaveTextContent('no tools');
    await user.click(screen.getByLabelText('GPT-5 mini'));
    await user.click(screen.getByRole('button', { name: 'This message' }));
    await user.click(screen.getByTestId('model-apply'));
    expect(onMessage).toHaveBeenCalledWith({ runtime: 'direct-model', model: 'openai:gpt-5-mini' });
  });

  it('a boardroom can mix providers: seat on OpenAI, seat on Claude, the Chair on Gemini', async () => {
    workstations = [ws({}, [openai, google])];
    const user = userEvent.setup();
    wrap(<NewBoardroomDialog open onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Topic'), 'Launch?');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Cost Hawk' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Security' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Ops' }));
    await user.click(within(dialog).getByText(/Model per seat/));
    await user.selectOptions(
      await within(dialog).findByLabelText('Model for Cost Hawk'),
      'direct-model/openai:gpt-5-mini',
    );
    await user.selectOptions(within(dialog).getByLabelText('Model for Security'), 'claude-code/haiku');
    await user.selectOptions(
      within(dialog).getByLabelText('The Chair runs on'),
      'direct-model/google:gemini-2.5-pro',
    );
    await user.click(within(dialog).getByTestId('start-boardroom'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/board')).toBeTruthy(),
    );
    const body = (calls.find((c) => c.method === 'POST' && c.url === '/api/board') as Call).body;
    expect(body.models).toEqual({ chair: { runtime: 'direct-model', model: 'google:gemini-2.5-pro' } });
    expect(body.cast).toEqual([
      { kind: 'persona', refId: 'optimist', seat: 'Optimist' },
      { kind: 'persona', refId: 'devils-advocate', seat: "Devil's Advocate" },
      { kind: 'persona', refId: 'cost-hawk', model: { runtime: 'direct-model', model: 'openai:gpt-5-mini' } },
      { kind: 'persona', refId: 'security', model: { runtime: 'claude-code', model: 'haiku' } },
      { kind: 'persona', refId: 'ops' },
    ]);
  });

  it('a discovery session can pick the facilitator model', async () => {
    workstations = [ws({}, [openai])];
    const user = userEvent.setup();
    wrap(<NewDiscoveryDialog open onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Title/), 'Idea');
    await user.selectOptions(
      await within(dialog).findByLabelText('Facilitator model (optional)'),
      'direct-model/openai:gpt-5',
    );
    await user.click(within(dialog).getByRole('button', { name: /start|create/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/discovery')).toBeTruthy(),
    );
    expect((calls.find((c) => c.url === '/api/discovery') as Call).body.model).toEqual({
      runtime: 'direct-model',
      model: 'openai:gpt-5',
    });
  });
});

describe('card work stays on Claude Code', () => {
  it('the agent pickers do not use the direct model groups', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) {
          if (f.name !== 'test') walk(p);
        } else if (/\.tsx?$/.test(f.name)) files.push(p);
      }
    };
    walk(dir);
    const users = files.filter((f) => /modelChoicesFor\(/.test(readFileSync(f, 'utf8')));
    // Only the session and chat pickers merge providers; none of them is an agent or role default picker.
    for (const f of users) {
      if (/ModelChip|ModelSelect/.test(f)) continue;
      // The hire form suggests the models of one runtime: it passes no direct providers, so no direct group can appear.
      expect(f).toMatch(/Agents\.tsx$/);
      expect(readFileSync(f, 'utf8')).toMatch(/modelChoicesFor\(\s*\[effectiveRuntime\],\s*\[\],/);
    }
  });
});
