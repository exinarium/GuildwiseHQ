import { type AgentMayDo, GATE_CLASSES, GATE_INFO } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayDoButton } from '../components/agents/MayDo.tsx';
import { PlaybookGrants } from '../components/slash/PlaybookGrants.tsx';
import { ToastProvider } from '../components/ui.tsx';

afterEach(() => vi.unstubAllGlobals());

const AGENT = '0192f3a0-0000-7000-8000-000000000001';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const mayDo = (over: Partial<AgentMayDo> = {}): AgentMayDo => ({
  agentId: AGENT,
  agentName: 'Mia',
  tools: {
    allowedTools: ['read', 'edit', 'mcp:github'],
    deniedShellPatterns: ['git push*'],
    writableGlobs: null,
    mayCommit: true,
    browser: false,
    riskTiers: ['small', 'large'],
  },
  repos: { readOrgRepos: false, repos: [{ id: '0192f3a0-0000-7000-8000-0000000000e1', name: 'web-app' }] },
  data: {
    projects: [{ id: '0192f3a0-0000-7000-8000-0000000000f1', key: 'ACM', name: 'Acme app' }],
    mcpServers: ['github'],
  },
  provider: { runtime: 'claude-code', model: 'sonnet', effort: null, workstation: 'Desk', keySource: 'org' },
  delegation: [
    {
      kind: 'persona',
      name: 'devils-advocate',
      handle: 'devils-advocate',
      inherited: true,
      excluded: false,
      maxCalls: 4,
      maxProfile: null,
    },
    {
      kind: 'persona',
      name: 'optimist',
      handle: 'optimist',
      inherited: true,
      excluded: true,
      maxCalls: 4,
      maxProfile: null,
    },
  ],
  playbooks: [{ key: 'brainstorm', name: 'Brainstorm' }],
  skills: [],
  packs: [{ packId: '0192f3a0-0000-7000-8000-0000000000d1', name: 'acme', scopes: ['shell'] }],
  spend: {
    currency: 'USD',
    monthMicros: 12_340_000,
    totalMicros: 99_000_000,
    budgets: [{ label: 'Project ACM, monthly', capMicros: 50_000_000, usedMicros: 20_000_000 }],
  },
  gates: GATE_CLASSES.map((c) => ({
    actionClass: c,
    label: GATE_INFO[c].label,
    description: GATE_INFO[c].description,
    enforcement: GATE_INFO[c].enforcement,
    note: GATE_INFO[c].note,
    gated: GATE_INFO[c].enforcement === 'always',
    pending: 0,
  })),
  canGate: true,
  canUngate: false,
  ...over,
});

function renderMayDo(initial: AgentMayDo) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let current = initial;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'PUT' && url.endsWith('/gates')) {
        const b = JSON.parse(String(init.body)) as { actionClass: string; gated: boolean };
        current = {
          ...current,
          gates: current.gates.map((g) => (g.actionClass === b.actionClass ? { ...g, gated: b.gated } : g)),
        };
        return json(current);
      }
      return json(current);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <MayDoButton agentId={AGENT} agentName="Mia" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe('What it may do', () => {
  it('fetches nothing until it is opened, then shows every part in one view', async () => {
    const calls = renderMayDo(mayDo());
    expect(calls).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'What Mia may do' }));
    const view = await screen.findByTestId('may-do');
    const w = within(view);
    expect(w.getByText('mcp:github')).toBeTruthy();
    expect(w.getByText(/Only: web-app/)).toBeTruthy();
    expect(w.getByText(/Projects: ACM/)).toBeTruthy();
    expect(w.getByText(/Pays with: The organization’s key/)).toBeTruthy();
    expect(w.getAllByText('from its role')).toHaveLength(2);
    expect(w.getByText('excluded for this agent')).toBeTruthy();
    expect(w.getByText(/needs shell/)).toBeTruthy();
    expect(w.getByText(/Project ACM, monthly: \$20\.00 of \$50\.00/)).toBeTruthy();
    expect(w.getByText(/\$12\.34 this month/)).toBeTruthy();
    for (const c of GATE_CLASSES) expect(w.getByTestId(`gate-${c}`)).toBeTruthy();
  });

  it('switches a gate on with one click; the always-on one cannot be switched', async () => {
    const calls = renderMayDo(mayDo());
    await userEvent.click(screen.getByRole('button', { name: 'What Mia may do' }));
    const row = async (c: string) =>
      within(await screen.findByTestId(`gate-${c}`)).getByRole('checkbox') as HTMLInputElement;
    expect((await row('outbound_mail')).disabled).toBe(true);
    expect((await row('outbound_mail')).checked).toBe(true);
    expect((await row('pack_scripts')).disabled).toBe(false);
    const merge = await row('merge_push');
    expect(merge.checked).toBe(false);
    await userEvent.click(merge);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: `/api/agents/${AGENT}/gates`,
      body: { actionClass: 'merge_push', gated: true },
    });
    await waitFor(async () => expect((await row('merge_push')).checked).toBe(true));
    // switching it off again is for an Owner or an Admin only
    expect((await row('merge_push')).disabled).toBe(true);
    expect(screen.getByText(/Only an Owner or an Admin switches a gate off again/)).toBeTruthy();
  });

  it('a viewer who may not gate sees the gates but cannot change them', async () => {
    renderMayDo(mayDo({ canGate: false, canUngate: false }));
    await userEvent.click(screen.getByRole('button', { name: 'What Mia may do' }));
    const box = within(await screen.findByTestId('gate-deploy')).getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(
      screen.getByText(/Only an Owner, an Admin or the agent’s manager switches a gate on/),
    ).toBeTruthy();
  });
});

describe('a playbook that needs a scope the agent lacks', () => {
  it('asks for a confirmation that lists what is missing, then grants with it', async () => {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    let granted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });
        if (url.includes('/slash-commands'))
          return json({
            items: [
              {
                kind: 'playbook',
                key: 'acme:ship',
                name: 'Ship',
                description: 'd',
                source: 'pack',
                canStartSession: true,
                scopes: ['shell', 'commit'],
              },
            ],
          });
        if (url.endsWith('/playbook-grants') && method === 'PUT') {
          if (!body.confirmScopes)
            return json(
              {
                error: {
                  code: 'scopes_missing',
                  message: 'This needs commit',
                  details: {
                    required: [
                      { scope: 'shell', label: 'Run shell commands', known: true, has: true },
                      { scope: 'commit', label: 'Commit to git', known: true, has: false },
                    ],
                    missing: ['commit'],
                  },
                },
              },
              409,
            );
          granted = [body.key];
        }
        return json({ agentId: AGENT, keys: granted, canManage: true });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <PlaybookGrants agentId={AGENT} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId('playbook-grants-toggle'));
    const select = await screen.findByLabelText('Playbook to allow');
    // the option says what it needs
    expect(
      await screen.findByRole('option', { name: /Ship \(acme:ship\) · needs shell, commit/ }),
    ).toBeTruthy();
    await userEvent.selectOptions(select, 'acme:ship');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/needs commit/)).toBeTruthy();
    expect(within(dlg).getByText('Commit to git')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Grant anyway' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]?.body).toEqual({
      key: 'acme:ship',
      granted: true,
      confirmScopes: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByTestId('playbook-grant-acme:ship')).toBeTruthy();
  });
});
