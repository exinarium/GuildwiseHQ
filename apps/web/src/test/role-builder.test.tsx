import type { OrgCatalogueResponse, RoleDraftInput } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleBuilder } from '../components/builder/RoleBuilder.tsx';
import { blankRole, blankWorkflow, workflowToInput } from '../lib/designer.ts';
import {
  applyToggle,
  mcpToolsOf,
  PERMISSION_TOGGLES,
  permissionSummary,
  toggleOn,
  withFolderLimit,
  withMcpTools,
} from '../lib/permissions-ui.ts';
import {
  type ClaimableWorkflow,
  claimableWorkflows,
  claimsAny,
  claimsStep,
  keyFromName,
  toggleAnyStep,
  toggleStep,
  unknownClaims,
} from '../lib/role-builder.ts';
import { OrgDesigner } from '../pages/OrgDesigner.tsx';

afterEach(() => vi.unstubAllGlobals());

const wfs: ClaimableWorkflow[] = [
  {
    key: 'support',
    name: 'Support',
    status: 'active',
    steps: [
      { id: 'triage', label: 'Triage', claimRole: 'triager' },
      { id: 'resolve', label: 'Resolve', claimRole: null },
    ],
  },
  {
    key: 'drafty',
    name: 'Content',
    status: 'draft',
    steps: [{ id: 'write', label: 'Write', claimRole: null }],
  },
];

describe('permission toggles', () => {
  const base = blankRole().permissions;

  it('maps every switch to AgentPermissions and back', () => {
    let p: typeof base = { ...base, allowedTools: ['read'], deniedShellPatterns: [] };
    expect(toggleOn(p, 'read')).toBe(true);
    expect(toggleOn(p, 'edit')).toBe(false);
    p = applyToggle(p, 'edit', true);
    p = applyToggle(p, 'web', true);
    expect(p.allowedTools).toEqual(['read', 'edit', 'web']);
    p = applyToggle(p, 'edit', false);
    expect(p.allowedTools).toEqual(['read', 'web']);
    p = applyToggle(p, 'commit', true);
    p = applyToggle(p, 'browser', true);
    p = applyToggle(p, 'readOrgRepos', true);
    expect(p).toMatchObject({ mayCommit: true, browser: true, readOrgRepos: true });
    expect(toggleOn(p, 'commit') && toggleOn(p, 'browser') && toggleOn(p, 'readOrgRepos')).toBe(true);
    // Read cannot be switched off.
    expect(applyToggle(p, 'read', false).allowedTools).toContain('read');
  });

  it('running commands brings the standard denied patterns when there are none', () => {
    const p = applyToggle({ ...base, allowedTools: ['read'], deniedShellPatterns: [] }, 'shell', true);
    expect(p.deniedShellPatterns).toEqual(expect.arrayContaining(['git push*', 'git rebase*', 'sudo *']));
    const own = applyToggle({ ...base, allowedTools: ['read'], deniedShellPatterns: ['x*'] }, 'shell', true);
    expect(own.deniedShellPatterns).toEqual(['x*']);
  });

  it('keeps external tools, folder limits and a summary', () => {
    let p = applyToggle({ ...base, allowedTools: ['read'] }, 'web', true);
    p = withMcpTools(p, ['github', ' ', 'github', 'jira']);
    expect(p.allowedTools).toEqual(['read', 'web', 'mcp:github', 'mcp:jira']);
    expect(mcpToolsOf(p)).toEqual(['github', 'jira']);
    // Switching a basic tool keeps the external ones, after the basic tools.
    expect(applyToggle(p, 'edit', true).allowedTools).toEqual([
      'read',
      'edit',
      'web',
      'mcp:github',
      'mcp:jira',
    ]);
    p = withFolderLimit(applyToggle(p, 'edit', true), ['docs/**']);
    const s = permissionSummary(p);
    expect(s.can).toEqual(
      expect.arrayContaining([
        'change files in docs/**',
        'search the web',
        'use external tools: github, jira',
      ]),
    );
    expect(s.cannot).toEqual(
      expect.arrayContaining(['run commands', 'commit', 'push, rebase or switch branches']),
    );
  });

  it('every switch has a risk note, and only reading all repositories is Owner only', () => {
    for (const t of PERMISSION_TOGGLES) expect(t.riskNote.length).toBeGreaterThan(20);
    expect(PERMISSION_TOGGLES.filter((t) => t.ownerOnly).map((t) => t.id)).toEqual(['readOrgRepos']);
  });
});

describe('steps checklist helpers', () => {
  const claim = (workflowKey: string, stageId: string) => ({ workflowKey, stageId });

  it('ticks, unticks and expands "any step"', () => {
    const wf = wfs[0] as ClaimableWorkflow;
    let c = toggleStep([], wf, 'triage', true);
    expect(c).toEqual([claim('support', 'triage')]);
    c = toggleAnyStep(c, 'support', true);
    expect(c).toEqual([claim('support', '*')]);
    expect(claimsStep(c, 'support', 'resolve')).toBe(true);
    expect(claimsAny(c, 'support')).toBe(true);
    // Unticking one step under "any" keeps the others as single claims.
    c = toggleStep(c, wf, 'triage', false);
    expect(c).toEqual([claim('support', 'resolve')]);
    expect(toggleStep(c, wf, 'resolve', false)).toEqual([]);
    expect(toggleAnyStep(c, 'support', false)).toEqual([]);
  });

  it('finds claims that point at nothing', () => {
    const stale = unknownClaims(
      [claim('support', 'triage'), claim('support', 'gone'), claim('old', '*'), claim('support', 'res*')],
      wfs,
    );
    expect(stale).toEqual([claim('support', 'gone'), claim('old', '*')]);
  });

  it('lists custom workflows with their agent steps, newest usable version, drafts included', () => {
    const w = workflowToInput({ ...blankWorkflow(), version: 1, builtIn: false } as never);
    w.stages[1] = { ...(w.stages[1] as (typeof w.stages)[number]), claimRole: 'x' };
    const v = (status: string, version: number) => ({
      id: `id${version}`,
      version,
      status,
      deskItemId: null,
      vaultPath: null,
      draftedByAgent: false,
      createdAt: new Date(0).toISOString(),
      definition: { ...w, version, builtIn: false },
    });
    const out = claimableWorkflows([
      { key: 'support', builtIn: false, versions: [v('draft', 3), v('active', 2)] as never },
      { key: 'code', builtIn: true, versions: [v('active', 1)] as never },
      { key: 'old', builtIn: false, versions: [v('superseded', 1), v('rejected', 2)] as never },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'support', status: 'draft' });
    expect(out[0]?.steps.map((s) => s.id)).toEqual(['work']);
    expect(out[0]?.steps[0]?.claimRole).toBe('x');
  });

  it('derives a short name from a display name', () => {
    expect(keyFromName('Support Triager!')).toBe('support-triager');
    expect(keyFromName('3rd line')).toBe('rd-line');
    expect(keyFromName('')).toBe('');
  });
});

// ---------------------------------------------------------------------------------- the component

function mockFetch(preview?: (body: any, url: string) => unknown) {
  const calls: Array<[string, string, any]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push([init?.method ?? 'GET', url, body]);
      if (url.startsWith('/api/roles/preview')) {
        const json = preview?.(body, url) ?? {
          text: `# Who you are\n\nYou are Sample Agent, a ${body.seniority} ${body.role.name}.\n\n# Role instructions\n\n${body.role.instructions}\n`,
          stage: body.workflowKey
            ? { workflowKey: body.workflowKey, stageId: body.stageId, stageLabel: 'Triage' }
            : null,
          headings: ['Who you are', 'Role instructions'],
        };
        return new Response(JSON.stringify(json), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  return calls;
}

function Harness({
  isOwner = true,
  initial,
  workflows = wfs,
  departments = ['support'],
  keyLocked = false,
  onValue,
  skills = ['git'],
}: {
  isOwner?: boolean;
  initial?: Partial<RoleDraftInput>;
  workflows?: ClaimableWorkflow[];
  departments?: string[];
  keyLocked?: boolean;
  onValue?: (v: RoleDraftInput) => void;
  skills?: string[];
}) {
  const [v, setV] = useState<RoleDraftInput>({ ...blankRole(), ...initial });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoleBuilder
          value={v}
          onChange={(x) => {
            setV(x);
            onValue?.(x);
          }}
          departments={departments}
          workflows={workflows}
          knownSkills={skills}
          isOwner={isOwner}
          keyLocked={keyLocked}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('role builder form', () => {
  it('shows the guided sections in order', () => {
    mockFetch();
    render(<Harness />);
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual([
      'Basics',
      'How it works',
      'What it may do',
      'Model',
      'Seniority',
      'Steps it can take',
      'Preview what the agent is told',
    ]);
    expect(screen.getByRole('link', { name: 'Ask the BA to help' })).toHaveAttribute(
      'href',
      '/org?tab=design',
    );
  });

  it('derives the short name from the name until it is edited, and locks it for existing roles', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    const { unmount } = render(<Harness onValue={(v) => values.push(v)} />);
    await user.type(screen.getByLabelText('Name'), 'Support Triager');
    expect(screen.getByLabelText('Short name (key)')).toHaveValue('support-triager');
    await user.clear(screen.getByLabelText('Short name (key)'));
    await user.type(screen.getByLabelText('Short name (key)'), 'tri');
    await user.type(screen.getByLabelText('Name'), 's');
    expect(screen.getByLabelText('Short name (key)')).toHaveValue('tri');
    unmount();
    render(<Harness keyLocked initial={{ key: 'triager', name: 'Triager' }} />);
    expect(screen.getByLabelText('Short name (key)')).toBeDisabled();
  });

  it('explains problems in plain words, pinned to the section, and clears them as they are fixed', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<Harness />);
    const bar = screen.getByTestId('issue-bar');
    expect(bar).toHaveTextContent(/things? to fix/);
    expect(within(screen.getByTestId('section-instructions')).getByTestId('issue')).toHaveTextContent(
      'Tell the role how to do its work',
    );
    expect(within(screen.getByTestId('section-steps')).getByTestId('issue')).toHaveTextContent(
      /Pick at least one step this role can take/,
    );
    await user.type(screen.getByLabelText('Name'), 'Triager');
    await user.type(screen.getByLabelText('Instructions'), 'Sort tickets.');
    await user.click(screen.getByRole('checkbox', { name: /^Triage/ }));
    await waitFor(() => expect(screen.getByTestId('validation-ok')).toBeInTheDocument());
    expect(bar).toHaveAttribute('data-errors', '0');
    // A built-in key is explained, not shown as a validator message.
    await user.clear(screen.getByLabelText('Short name (key)'));
    await user.type(screen.getByLabelText('Short name (key)'), 'builder');
    expect(within(screen.getByTestId('section-basics')).getByTestId('issue')).toHaveTextContent(
      '"builder" is the short name of a built-in role',
    );
  });

  it('prefers the issues the server reported once a draft was saved', () => {
    mockFetch();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RoleBuilder
            value={{ ...blankRole(), key: 'x', name: 'X', instructions: 'i' }}
            onChange={() => {}}
            departments={[]}
            workflows={[]}
            isOwner
            serverIssues={[
              {
                severity: 'error',
                code: 'unknown_department',
                message: "department 'ghost' does not exist",
                field: 'department',
              },
            ]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(within(screen.getByTestId('section-basics')).getByTestId('issue')).toHaveTextContent(
      'The department "ghost" does not exist yet',
    );
  });

  it('tools are plain-language switches with a risk note each', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    render(
      <Harness
        initial={{ permissions: { ...blankRole().permissions, allowedTools: ['read'] } }}
        onValue={(v) => values.push(v)}
      />,
    );
    for (const t of PERMISSION_TOGGLES) {
      const row = screen.getByTestId(`toggle-${t.id}`);
      expect(within(row).getByRole('checkbox', { name: t.label })).toBeInTheDocument();
      expect(screen.getByTestId(`risk-${t.id}`)).toHaveTextContent(t.riskNote);
    }
    expect(screen.getByRole('checkbox', { name: 'Read files' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Read files' })).toBeChecked();
    expect(within(screen.getByTestId('toggle-shell')).getByText('High risk')).toBeInTheDocument();
    expect(within(screen.getByTestId('toggle-edit')).getByText('Medium risk')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Run commands' }));
    await user.click(screen.getByRole('checkbox', { name: 'Search the web' }));
    await user.click(screen.getByRole('checkbox', { name: 'Save its work (commit)' }));
    const last = values.at(-1) as RoleDraftInput;
    expect(last.permissions.allowedTools).toEqual(['read', 'shell', 'web']);
    expect(last.permissions.mayCommit).toBe(true);
    expect(last.permissions.deniedShellPatterns).toContain('git push*');
    expect(screen.getByTestId('permission-summary')).toHaveTextContent('run commands (sandboxed)');
    await user.type(screen.getByLabelText(/External tools/), 'github');
    expect((values.at(-1) as RoleDraftInput).permissions.allowedTools).toContain('mcp:github');
    await user.click(screen.getByRole('checkbox', { name: 'Only these folders' }));
    await user.type(screen.getByLabelText('Folders it may change'), 'docs/**');
    expect((values.at(-1) as RoleDraftInput).permissions.writableGlobs).toEqual(['docs/**']);
  });

  it('reading all organization repositories is Owner only: disabled for Admins, with the risk explained', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    const { unmount } = render(<Harness isOwner={false} onValue={(v) => values.push(v)} />);
    const admin = screen.getByRole('checkbox', { name: 'Read all organization repositories' });
    expect(admin).toBeDisabled();
    expect(screen.getByTestId('risk-readOrgRepos')).toHaveTextContent('read only, but wide');
    expect(screen.getByTestId('risk-readOrgRepos')).toHaveTextContent('ask the Owner');
    expect(within(screen.getByTestId('toggle-readOrgRepos')).getByText('Owner only')).toBeInTheDocument();
    await user.click(admin);
    expect(values).toHaveLength(0);
    // Other switches stay available to Admins.
    expect(screen.getByRole('checkbox', { name: 'Run browsers' })).toBeEnabled();
    unmount();
    render(<Harness isOwner onValue={(v) => values.push(v)} />);
    const owner = screen.getByRole('checkbox', { name: 'Read all organization repositories' });
    expect(owner).toBeEnabled();
    await user.click(owner);
    expect((values.at(-1) as RoleDraftInput).permissions.readOrgRepos).toBe(true);
    expect(within(screen.getByTestId('section-permissions')).getByTestId('issue')).toHaveTextContent(
      'read every repository',
    );
  });

  it('model and effort are pickers; an unknown stored model is kept', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    render(
      <Harness
        initial={{ defaultModel: { runtime: 'claude-code', model: 'claude-x-1' } }}
        onValue={(v) => values.push(v)}
      />,
    );
    const model = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(model.value).toBe('claude-x-1');
    await user.selectOptions(model, 'opus');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'high');
    expect((values.at(-1) as RoleDraftInput).defaultModel).toEqual({
      runtime: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), '');
    expect((values.at(-1) as RoleDraftInput).defaultModel.effort).toBeUndefined();
  });

  it('seniority and skills: chips, quick picks from other roles', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    await user.click(screen.getByRole('checkbox', { name: 'Senior' }));
    expect((values.at(-1) as RoleDraftInput).seniorityLevels).toEqual(['junior']);
    await user.click(screen.getByRole('checkbox', { name: 'Junior' }));
    expect(screen.getByText('Pick at least one seniority level.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Add a skill'), 'lint, docs{Enter}');
    expect((values.at(-1) as RoleDraftInput).skills).toEqual(['lint', 'docs']);
    await user.click(screen.getByRole('button', { name: '+ git' }));
    expect((values.at(-1) as RoleDraftInput).skills).toEqual(['lint', 'docs', 'git']);
    expect(screen.queryByRole('button', { name: '+ git' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove skill lint' }));
    expect((values.at(-1) as RoleDraftInput).skills).toEqual(['docs', 'git']);
  });

  it('steps are a checklist of custom workflow steps, not free text', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    const claims = screen.getByTestId('claims');
    expect(within(claims).getByText('Support')).toBeInTheDocument();
    expect(within(claims).getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByLabelText(/May claim/)).toBeNull();
    expect(within(claims).getByText('(now worked by triager)')).toBeInTheDocument();
    await user.click(within(claims).getByRole('checkbox', { name: /^Triage/ }));
    await user.click(within(claims).getByRole('checkbox', { name: 'Write' }));
    expect((values.at(-1) as RoleDraftInput).claimableStages).toEqual([
      { workflowKey: 'support', stageId: 'triage' },
      { workflowKey: 'drafty', stageId: 'write' },
    ]);
    await user.click(within(claims).getByRole('checkbox', { name: 'Any step of Support' }));
    expect((values.at(-1) as RoleDraftInput).claimableStages).toEqual([
      { workflowKey: 'drafty', stageId: 'write' },
      { workflowKey: 'support', stageId: '*' },
    ]);
    expect(within(claims).getByRole('checkbox', { name: 'Resolve' })).toBeChecked();
  });

  it('keeps old free-text claims visible so they can be removed, and explains an empty workflow list', async () => {
    mockFetch();
    const user = userEvent.setup();
    const values: RoleDraftInput[] = [];
    const { unmount } = render(
      <Harness
        initial={{ claimableStages: [{ workflowKey: 'old', stageId: 'x' }] }}
        onValue={(v) => values.push(v)}
      />,
    );
    const stale = screen.getByTestId('stale-claims');
    expect(stale).toHaveTextContent('old.x');
    await user.click(within(stale).getByRole('button', { name: 'Remove old.x' }));
    expect((values.at(-1) as RoleDraftInput).claimableStages).toEqual([]);
    unmount();
    render(<Harness workflows={[]} />);
    expect(screen.getByTestId('no-workflows')).toHaveTextContent('no custom workflows yet');
  });

  it('previews the prompt with a sample brief for a chosen step (no agent runs)', async () => {
    const calls = mockFetch();
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          key: 'triager',
          name: 'Triager',
          instructions: 'Sort tickets.',
          claimableStages: [{ workflowKey: 'support', stageId: 'triage' }],
        }}
      />,
    );
    expect(screen.queryByTestId('prompt-preview')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Preview the prompt' }));
    const pre = await screen.findByTestId('prompt-preview', undefined, { timeout: 3000 });
    expect(pre).toHaveTextContent('You are Sample Agent, a junior Triager.');
    expect(pre).toHaveTextContent('Sort tickets.');
    expect(screen.getByTestId('preview-headings')).toHaveTextContent('Who you are, Role instructions');
    await user.selectOptions(screen.getByLabelText('Sample step'), 'support|triage');
    await user.selectOptions(screen.getByLabelText('Sample hire'), 'senior');
    await waitFor(
      () => {
        const last = calls.filter(([, u]) => u.startsWith('/api/roles/preview')).at(-1);
        expect(last?.[2]).toMatchObject({ workflowKey: 'support', stageId: 'triage', seniority: 'senior' });
      },
      { timeout: 3000 },
    );
    expect(calls.every(([m, u]) => !u.includes('/shifts') && (m === 'POST' || m === 'GET'))).toBe(true);
    expect(await screen.findByText(/a senior Triager/)).toBeInTheDocument();
  });

  it('asks for a name before it can preview', async () => {
    const calls = mockFetch();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Preview the prompt' }));
    expect(screen.getByTestId('preview-needs-key')).toBeInTheDocument();
    expect(calls.filter(([, u]) => u.startsWith('/api/roles/preview'))).toHaveLength(0);
  });

  it('the advanced view shows every field and goes back', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Advanced: all fields' }));
    expect(screen.getByTestId('role-editor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the guided form' }));
    expect(screen.getByTestId('section-basics')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------- the page

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function catalogue(): OrgCatalogueResponse {
  const w = workflowToInput({ ...blankWorkflow(), version: 1, builtIn: false } as never);
  return {
    orgId: ID(900),
    canEdit: true,
    roles: [],
    workflows: [
      {
        key: 'support',
        builtIn: false,
        versions: [
          {
            id: ID(3),
            version: 1,
            status: 'active',
            deskItemId: null,
            vaultPath: null,
            draftedByAgent: false,
            createdAt: new Date(0).toISOString(),
            definition: { ...w, key: 'support', name: 'Support', version: 1, builtIn: false },
            cardsInFlight: 0,
          } as never,
        ],
      },
    ],
    departments: [],
  };
}

function mountPage(role: 'owner' | 'admin') {
  const calls: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined]);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.startsWith('/api/org/catalogue')) return json(catalogue());
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/auth/me'))
        return json({
          user: { id: ID(900), displayName: 'Olga', email: 'o@x.test' },
          isAdmin: false,
          activeOrg: {
            id: ID(900),
            name: 'Acme',
            status: 'active',
            role,
            plan: 'p',
            planName: 'P',
            features: {},
          },
        });
      if (url.startsWith('/api/agents')) return json({ agents: [] });
      if (url === '/api/roles')
        return json({ id: ID(50), key: 'x', version: 1, status: 'draft', issues: [] }, 201);
      return json({ ok: true });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/org']}>
        <OrgDesigner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the organization page uses the role builder', () => {
  it('New custom role opens the builder with the workflow steps; the Owner can switch on wide access', async () => {
    const user = userEvent.setup();
    const calls = mountPage('owner');
    await user.click(await screen.findByRole('button', { name: 'New custom role' }));
    expect(await screen.findByTestId('role-builder')).toBeInTheDocument();
    expect(within(screen.getByTestId('claims')).getByRole('checkbox', { name: 'Work' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Read all organization repositories' })).toBeEnabled(),
    );
    await user.type(screen.getByLabelText('Name'), 'Helper');
    await user.type(screen.getByLabelText('Instructions'), 'Help out.');
    await user.click(screen.getByRole('checkbox', { name: 'Any step of Support' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some(([m, u]) => m === 'POST' && u === '/api/roles')).toBe(true));
    const body = calls.find(([m, u]) => m === 'POST' && u === '/api/roles')?.[2] as RoleDraftInput;
    expect(body).toMatchObject({
      key: 'helper',
      name: 'Helper',
      claimableStages: [{ workflowKey: 'support', stageId: '*' }],
    });
    // Once saved the short name is fixed.
    await waitFor(() => expect(screen.getByLabelText('Short name (key)')).toBeDisabled());
  });

  it('an Admin sees wide access disabled', async () => {
    const user = userEvent.setup();
    mountPage('admin');
    await user.click(await screen.findByRole('button', { name: 'New custom role' }));
    await screen.findByTestId('role-builder');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Run commands' })).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: 'Read all organization repositories' })).toBeDisabled();
  });
});
