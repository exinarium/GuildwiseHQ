import type { DefinitionIssue, OrgCatalogueResponse, WorkflowDraftInput } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleEditor } from '../components/org/RoleEditor.tsx';
import { WorkflowEditor } from '../components/org/WorkflowEditor.tsx';
import { WorkflowGraph } from '../components/org/WorkflowGraph.tsx';
import {
  blankRole,
  blankWorkflow,
  claimText,
  departmentsOf,
  groupIssues,
  inDepartment,
  layoutWorkflow,
  parseClaims,
  stageId,
  workflowToInput,
} from '../lib/designer.ts';
import { OrgDesigner } from '../pages/OrgDesigner.tsx';

afterEach(() => vi.unstubAllGlobals());

const role = (key: string, stages: Array<[string, string]> = [['support', '*']]) => ({
  ...blankRole(),
  key,
  name: key,
  purpose: 'p',
  instructions: 'work',
  claimableStages: stages.map(([workflowKey, stageId]) => ({ workflowKey, stageId })),
});
const roleDef = (key: string, stages?: Array<[string, string]>) => ({
  ...role(key, stages),
  version: 1,
  builtIn: false,
});

const wf = (): WorkflowDraftInput => {
  const w = blankWorkflow();
  w.key = 'support';
  w.name = 'Support';
  w.stages[1] = {
    ...(w.stages[1] as WorkflowDraftInput['stages'][number]),
    claimRole: 'triager',
    doneCriteria: 'Sorted.',
  };
  return w;
};

describe('workflow graph layout', () => {
  it('layers stages by distance from the first stage and flags loops and unreachable stages', () => {
    const w = wf();
    w.stages.splice(2, 0, {
      ...(w.stages[1] as WorkflowDraftInput['stages'][number]),
      id: 'orphan',
      label: 'Orphan',
      outcomes: [],
    });
    (w.stages[1] as WorkflowDraftInput['stages'][number]).outcomes.push({
      id: 'back',
      label: 'back',
      kind: 'failure',
      to: 'intake',
      event: 'StageCompleted',
      data: 'none',
      rework: true,
      effect: 'none',
    });
    const g = layoutWorkflow({ initialStage: w.initialStage, stages: w.stages as never });
    const layer = Object.fromEntries(g.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toMatchObject({ intake: 0, work: 1, finished: 2 });
    expect(g.nodes.find((n) => n.id === 'orphan')).toMatchObject({ unreachable: true, layer: 3 });
    expect(g.edges.find((e) => e.id === 'work.back')).toMatchObject({ back: true, failure: true });
    expect(g.edges.find((e) => e.id === 'intake.ready')).toMatchObject({ back: false, failure: false });
    expect(g.width).toBeGreaterThan(0);
  });

  it('renders every stage and edge in the preview', () => {
    const w = wf();
    render(<WorkflowGraph def={w as never} flagged={new Set(['work'])} />);
    expect(screen.getByTestId('node-intake')).toBeInTheDocument();
    expect(screen.getByTestId('node-finished')).toBeInTheDocument();
    expect(screen.getByTestId('edge-work.done')).toBeInTheDocument();
    expect(screen.getByTestId('node-work').querySelector('rect')?.getAttribute('stroke')).toBe('#dc2626');
  });
});

describe('designer helpers', () => {
  it('groups issues by stage', () => {
    const issues: DefinitionIssue[] = [
      { severity: 'error', code: 'unreachable_stage', message: 'x', stageId: 'a' },
      { severity: 'error', code: 'no_terminal_stage', message: 'y' },
    ];
    const g = groupIssues(issues);
    expect(g.byStage.get('a')).toHaveLength(1);
    expect(g.general).toHaveLength(1);
  });

  it('converts claims, ids and departments', () => {
    expect(parseClaims('support.triage, support.*, other')).toEqual([
      { workflowKey: 'support', stageId: 'triage' },
      { workflowKey: 'support', stageId: '*' },
      { workflowKey: 'other', stageId: '*' },
    ]);
    expect(claimText(parseClaims('a.b, c.*'))).toBe('a.b, c.*');
    expect(stageId('Second opinion!')).toBe('second_opinion');
    expect(stageId('3rd')).toBe('rd');
    const items = [{ department: 'support' }, { department: 'delivery' }, { department: null }, {}];
    expect(departmentsOf(items)).toEqual(['delivery', 'support']);
    expect(inDepartment(items, 'support')).toHaveLength(1);
    expect(inDepartment(items, '')).toHaveLength(4);
  });

  it('turns a stored definition into the draft for its next version', () => {
    const input = workflowToInput({ ...blankWorkflow(), version: 3, builtIn: false } as never);
    expect(input).not.toHaveProperty('version');
    expect(input).not.toHaveProperty('builtIn');
  });
});

function Harness({ roles }: { roles: ReturnType<typeof roleDef>[] }) {
  const [v, setV] = useState<WorkflowDraftInput>(wf());
  return (
    <WorkflowEditor value={v} onChange={setV} roles={roles as never} departments={['delivery', 'support']} />
  );
}

describe('workflow editor', () => {
  it('shows validation issues inline: unreachable stage, unclaimable stage', async () => {
    const user = userEvent.setup();
    render(<Harness roles={[roleDef('triager', [['elsewhere', '*']])]} />);
    // The role cannot claim support.work.
    expect(await screen.findAllByTestId('issue')).not.toHaveLength(0);
    expect(screen.getByTestId('stage-work')).toHaveAttribute('data-invalid', 'true');
    expect(screen.getByText(/cannot claim stage 'support.work'/)).toBeInTheDocument();
    // Fix it by giving the role the stage: the issue disappears.
    render(<Harness roles={[roleDef('triager')]} />);
    await waitFor(() => expect(screen.getAllByTestId('validation-ok')).toHaveLength(1));
    // Add a stage nobody reaches.
    await user.click(screen.getAllByRole('button', { name: 'Add stage' })[1] as HTMLElement);
    const issues = screen.getAllByTestId('issue').map((i) => i.getAttribute('data-code'));
    expect(issues).toContain('unreachable_stage');
  });

  it('flags a failure route that never ends', async () => {
    const user = userEvent.setup();
    render(<Harness roles={[roleDef('triager')]} />);
    expect(screen.getByTestId('validation-ok')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add stage' }));
    const added = screen.getByTestId('stage-stage_4');
    expect(added).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Stage stage_4 role'), 'triager');
    await user.click(screen.getByRole('button', { name: 'Add outcome to stage_4' }));
    // stage_4 loops on itself: it cannot reach the end.
    await user.selectOptions(screen.getByLabelText('stage_4.outcome_1 goes to'), 'stage_4');
    await user.selectOptions(screen.getByLabelText('stage_4.outcome_1 kind'), 'failure');
    // And the first stage's work outcome now fails into it.
    await user.click(screen.getByRole('button', { name: 'Add outcome to work' }));
    await user.selectOptions(screen.getByLabelText('work.outcome_2 goes to'), 'stage_4');
    await user.selectOptions(screen.getByLabelText('work.outcome_2 kind'), 'failure');
    const codes = screen.getAllByTestId('issue').map((i) => i.getAttribute('data-code'));
    expect(codes).toEqual(expect.arrayContaining(['failure_no_path_to_terminal', 'no_path_to_terminal']));
    expect(within(screen.getByTestId('validation')).getAllByText('error').length).toBeGreaterThan(0);
  });

  it('prefers the server issues once a draft was saved', () => {
    render(
      <WorkflowEditor
        value={wf()}
        onChange={() => {}}
        roles={[roleDef('triager')] as never}
        departments={['support']}
        serverIssues={[{ severity: 'error', code: 'x', message: 'from the server', stageId: 'work' }]}
      />,
    );
    expect(screen.getByText('from the server')).toBeInTheDocument();
    expect(screen.queryByTestId('validation-ok')).toBeNull();
  });
});

describe('role editor', () => {
  it('validates the key, the claimable stages and the department locally', async () => {
    const user = userEvent.setup();
    function R() {
      const [v, setV] = useState(blankRole());
      return <RoleEditor value={v} onChange={setV} departments={['support']} />;
    }
    render(<R />);
    await user.type(screen.getByLabelText('Key'), 'builder');
    expect(screen.getAllByTestId('issue').map((i) => i.getAttribute('data-code'))).toContain(
      'no_claimable_stages',
    );
    expect(screen.getAllByTestId('issue').map((i) => i.getAttribute('data-code'))).toContain('builtin_key');
    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), 'triager');
    await user.type(screen.getByLabelText('Name'), 'Triager');
    await user.type(screen.getByLabelText('Instructions'), 'Sort tickets.');
    await user.type(screen.getByLabelText(/May claim/), 'code.review');
    expect(screen.getAllByTestId('issue').map((i) => i.getAttribute('data-code'))).toContain(
      'claims_builtin_workflow',
    );
    await user.clear(screen.getByLabelText(/May claim/));
    await user.type(screen.getByLabelText(/May claim/), 'support.triage');
    await waitFor(() => expect(screen.getByTestId('validation-ok')).toBeInTheDocument());
  });
});

// ------------------------------------------------------------------------------------- the page

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const version = (n: number, definition: unknown, status = 'active', extra: Record<string, unknown> = {}) => ({
  id: ID(n),
  version: (definition as { version?: number }).version ?? 1,
  status,
  deskItemId: null,
  vaultPath: null,
  draftedByAgent: false,
  createdAt: new Date(0).toISOString(),
  definition,
  ...extra,
});
const builderDef = {
  ...role('builder', [['code', 'build']]),
  version: 1,
  builtIn: true,
  coreRules: ['Write unit tests.'],
  department: 'delivery',
};

function catalogue(canEdit: boolean): OrgCatalogueResponse {
  return {
    orgId: ID(900),
    canEdit,
    roles: [
      { key: 'builder', builtIn: true, versions: [version(1, builderDef) as never], extensions: null },
      {
        key: 'triager',
        builtIn: false,
        versions: [version(2, roleDef('triager'), 'pending_approval', { deskItemId: ID(77) }) as never],
        extensions: null,
      },
    ],
    workflows: [
      {
        key: 'support',
        builtIn: false,
        versions: [
          version(3, { ...wf(), version: 2, builtIn: false }, 'active', { cardsInFlight: 0 }) as never,
          version(4, { ...wf(), version: 1, builtIn: false }, 'superseded', { cardsInFlight: 3 }) as never,
        ],
      },
    ],
    departments: [
      { id: null, name: 'delivery', builtIn: true, roleKeys: ['builder'], workflowKeys: ['code'] },
      { id: ID(5), name: 'support', builtIn: false, roleKeys: ['triager'], workflowKeys: ['support'] },
    ],
  };
}

function mountPage(cat: OrgCatalogueResponse, path = '/org') {
  const calls: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined]);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.startsWith('/api/org/catalogue')) return json(cat);
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/auth/me'))
        return json({ user: { id: ID(900), displayName: 'Olga', email: 'o@x.test' }, isAdmin: false });
      if (url.startsWith('/api/agents')) return json({ agents: [] });
      return json({ ok: true, roleKey: 'builder', baseVersion: 1 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <OrgDesigner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the organization page', () => {
  it('owner: shows built-in and custom roles, statuses, and extends a built-in role without touching core rules', async () => {
    const user = userEvent.setup();
    const calls = mountPage(catalogue(true));
    const builtin = await screen.findByTestId('builtin-roles');
    expect(within(builtin).getByText('Built in')).toBeInTheDocument();
    const custom = screen.getByTestId('custom-roles');
    expect(within(custom).getByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New custom role' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Extend builder' }));
    const rules = await screen.findByTestId('core-rules');
    expect(rules).toHaveTextContent('Write unit tests.');
    expect(rules).toHaveTextContent('cannot be changed');
    await user.type(screen.getByLabelText('Extra instructions'), 'Prefer small commits.');
    await user.type(screen.getByLabelText('Extra skills (comma separated)'), 'git, lint');
    await user.type(screen.getByLabelText('Standing orders (one per line)'), 'Never touch legacy/');
    await user.click(screen.getByRole('button', { name: 'Save extensions' }));
    await waitFor(() =>
      expect(calls.some(([m, u]) => m === 'PUT' && u === '/api/roles/builder/extensions')).toBe(true),
    );
    const put = calls.find(([m]) => m === 'PUT');
    expect(put?.[2]).toEqual({
      instructions: 'Prefer small commits.',
      skills: ['git', 'lint'],
      standingOrders: ['Never touch legacy/'],
    });
  });

  it('member: read only, no editing controls', async () => {
    mountPage(catalogue(false));
    expect(await screen.findByTestId('read-only-note')).toHaveTextContent('only the owner can change them');
    expect(screen.queryByRole('button', { name: 'New custom role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Extend builder' })).toBeNull();
  });

  it('workflows: versions with cards in flight, graph view, and the editor with inline validation', async () => {
    const user = userEvent.setup();
    mountPage(catalogue(true), '/org?tab=workflows');
    const card = await screen.findByTestId('workflow-support');
    expect(within(card).getByText('3 card(s) in flight on this version')).toBeInTheDocument();
    expect(within(card).getByText('Replaced by a newer version')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'View support v1' }));
    expect(within(screen.getByTestId('view-support-v1')).getByTestId('workflow-graph')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'New version of support v2' }));
    expect(await screen.findByTestId('workflow-editor')).toBeInTheDocument();
    expect(screen.getByTestId('stage-table')).toBeInTheDocument();
  });

  it('departments: lists them with their roles and workflows and creates one', async () => {
    const user = userEvent.setup();
    const calls = mountPage(catalogue(true), '/org?tab=departments');
    const d = await screen.findByTestId('department-support');
    expect(d).toHaveTextContent('Roles: triager');
    await user.type(screen.getByRole('textbox', { name: 'New department' }), 'marketing');
    await user.click(screen.getByRole('button', { name: 'Create department' }));
    await waitFor(() => expect(calls.some(([m, u]) => m === 'POST' && u === '/api/departments')).toBe(true));
    expect(calls.find(([, u]) => u === '/api/departments')?.[2]).toEqual({ name: 'marketing' });
  });

  it('design tab: asks for a BA when none is hired', async () => {
    mountPage(catalogue(true), '/org?tab=design');
    expect(await screen.findByTestId('no-ba')).toBeInTheDocument();
  });
});
