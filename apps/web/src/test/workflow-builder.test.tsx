import {
  type DefinitionIssue,
  instantiateTemplate,
  type OrgCatalogueResponse,
  type WorkflowDefinitionInput,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateGallery } from '../components/builder/TemplateGallery.tsx';
import { WorkflowBuilder } from '../components/builder/WorkflowBuilder.tsx';
import { type BuilderModel, fromDefinition, syncKey } from '../lib/builder.ts';
import { WorkflowBuilderPage } from '../pages/WorkflowBuilderPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function roleDef(key: string, stages: string[], workflowKey = 'simple_review') {
  return {
    key,
    name: key[0]?.toUpperCase() + key.slice(1),
    version: 1,
    builtIn: false,
    purpose: 'p',
    instructions: 'i',
    coreRules: [],
    seniorityLevels: ['junior', 'senior'],
    defaultModel: { runtime: 'claude-code', model: 'sonnet' },
    permissions: {
      allowedTools: ['read'],
      deniedShellPatterns: [],
      writableGlobs: null,
      mayCommit: false,
      browser: false,
      readOrgRepos: false,
      riskTiers: ['small', 'large'],
      repoIds: null,
    },
    skills: [],
    claimableStages: stages.map((stageId) => ({ workflowKey, stageId })),
  };
}
const ROLES = [roleDef('writer', ['work']), roleDef('editor', ['review'])] as never[];

function template(id = 'simple-review'): BuilderModel {
  const def = instantiateTemplate(id, { key: id }) as WorkflowDefinitionInput;
  return syncKey(fromDefinition(def, { freeze: false }), new Set());
}

function Harness(props: {
  initial?: BuilderModel;
  roles?: never[];
  frozen?: Parameters<typeof WorkflowBuilder>[0]['frozen'];
  readOnly?: boolean;
  hired?: string[];
  server?: DefinitionIssue[];
  slot?: Parameters<typeof WorkflowBuilder>[0]['renderSubworkflowEditor'];
  onModel?: (m: BuilderModel) => void;
}) {
  const [m, setM] = useState(props.initial ?? template());
  return (
    <MemoryRouter>
      <WorkflowBuilder
        model={m}
        onChange={(n) => {
          setM(n);
          props.onModel?.(n);
        }}
        roles={props.roles ?? ROLES}
        departments={['support']}
        frozen={props.frozen}
        readOnly={props.readOnly}
        hiredRoleKeys={props.hired ? new Set(props.hired) : undefined}
        serverIssues={props.server}
        renderSubworkflowEditor={props.slot}
      />
    </MemoryRouter>
  );
}

const step = (name: RegExp | string) => screen.getByRole('region', { name });

describe('workflow builder: the step list', () => {
  it('shows a template as numbered steps with a live diagram', () => {
    render(<Harness />);
    const list = screen.getByTestId('step-list');
    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Request', 'Work', 'Review', 'Finished']);
    expect(screen.getByTestId('workflow-graph')).toBeInTheDocument();
    expect(screen.getByTestId('edge-review.rework')).toBeInTheDocument();
    expect(step('Request')).toHaveTextContent('Step 1');
  });

  it('pins plain-language problems on the step and in the issue bar, and clears them when fixed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const bar = screen.getByTestId('issue-bar');
    expect(bar).toHaveTextContent(/things to fix/);
    expect(within(step('Work')).getByText(/has no role that may work it/)).toBeInTheDocument();
    // The role select points at the message.
    const select = within(step('Work')).getByLabelText('Who does it');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    const describedBy = select.getAttribute('aria-describedby') as string;
    expect(document.getElementById(describedBy)).toHaveTextContent(/no role/);
    await user.selectOptions(select, 'writer');
    await user.selectOptions(within(step('Review')).getByLabelText('Who does it'), 'editor');
    await waitFor(() => expect(screen.getByTestId('issues-ok')).toBeInTheDocument());
    expect(within(step('Work')).queryByTestId('step-issue')).toBeNull();
  });

  it('jumps from the issue bar to the step', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getAllByTestId('issue-bar-item')[0] as HTMLElement;
    await user.click(within(first).getByRole('button'));
    expect(document.activeElement).toBe(within(step('Work')).getByRole('heading', { level: 3 }));
  });

  it('renaming a saved step changes its label but not its id; the diagram follows', async () => {
    const user = userEvent.setup();
    const seen: BuilderModel[] = [];
    const saved = fromDefinition(
      instantiateTemplate('simple-review', { key: 'sr' }) as WorkflowDefinitionInput,
    );
    render(<Harness initial={saved} onModel={(m) => seen.push(m)} />);
    const name = within(step('Work')).getByLabelText('Step name');
    await user.clear(name);
    await user.type(name, 'Write the post');
    expect(screen.getByTestId('node-work')).toHaveTextContent('Write the post');
    expect(seen.at(-1)?.steps.find((s) => s.uid === 'work')?.id).toBe('work');
  });

  it('a step that was never saved gets its id from its name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const name = within(step('Work')).getByLabelText('Step name');
    await user.clear(name);
    await user.type(name, 'Write the post');
    expect(screen.getByTestId('node-write_the_post')).toHaveTextContent('Write the post');
  });

  it('adds a step, moves focus to its name, and chains it into the flow', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add a step after Work' }));
    const input = screen.getByDisplayValue('New step');
    await waitFor(() => expect(document.activeElement).toBe(input));
    const titles = within(screen.getByTestId('step-list'))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual(['Request', 'Work', 'New step', 'Review', 'Finished']);
    await user.clear(input);
    await user.type(input, 'Legal check');
    expect(screen.getByTestId('node-legal_check')).toBeInTheDocument();
    // "When finished, go to" of Work now says the new step.
    expect(within(step('Work')).getByLabelText('When finished, go to')).toHaveDisplayValue('3. Legal check');
  });

  it('adds a step before the final step from the bottom button, and removes one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add a step before the end' }));
    expect(screen.getByDisplayValue('New step')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove New step' }));
    expect(screen.queryByDisplayValue('New step')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
  });

  it('reorders with buttons, no drag needed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Move Request up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Review up' }));
    const titles = within(screen.getByTestId('step-list'))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual(['Request', 'Review', 'Work', 'Finished']);
  });

  it('sets where a step sends work back to, and draws it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const sel = within(step('Review')).getByLabelText('If it is not good enough, send back to');
    await user.selectOptions(sel, 'Nowhere (this step cannot send work back)');
    expect(screen.queryByTestId('edge-review.rework')).toBeNull();
    await user.selectOptions(sel, '2. Work');
    expect(screen.getByTestId('edge-review.rework')).toBeInTheDocument();
  });

  it('collapses and expands step details for keyboard and screen-reader users', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = within(step('Work')).getByRole('button', { name: /Hide details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(step('Work')).queryByLabelText('Step name')).toBeNull();
    expect(within(step('Work')).getByRole('button', { name: /Edit details/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('warns when no agent holds the chosen role, with a hire link', async () => {
    const user = userEvent.setup();
    render(<Harness hired={['editor']} />);
    await user.selectOptions(within(step('Work')).getByLabelText('Who does it'), 'writer');
    const warn = within(step('Work')).getByTestId('unhired-work');
    expect(warn).toHaveTextContent(/No agent with the Writer role is hired/);
    expect(within(warn).getByRole('link', { name: 'Hire one' })).toHaveAttribute(
      'href',
      '/agents?hire=writer',
    );
    await user.selectOptions(within(step('Review')).getByLabelText('Who does it'), 'editor');
    expect(within(step('Review')).queryByTestId('unhired-review')).toBeNull();
  });
});

describe('workflow builder: card information, conditions and "Try a card"', () => {
  it('adds yes/no information, uses it as an "only when" condition, and the preview skips the step', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    const label = screen.getByLabelText('Field 1 name');
    await waitFor(() => expect(document.activeElement).toBe(label));
    await user.type(label, 'Needs legal review');
    await user.selectOptions(screen.getByLabelText('Field 1 kind'), 'Yes or no');
    await user.selectOptions(
      within(step('Review')).getByLabelText('Only when this answer applies'),
      'Needs legal review',
    );
    // Not ticked: the step is skipped.
    await user.selectOptions(within(step('Review')).getByLabelText('is'), 'Yes');
    const path = screen.getByTestId('try-path');
    expect(within(path).getByText('Skipped for this card')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('try-a-card')).getByLabelText('Needs legal review'));
    expect(within(screen.getByTestId('try-path')).queryByText('Skipped for this card')).toBeNull();
  });

  it('walks the path, lets you choose "sent back", highlights it on the diagram', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const path = screen.getByTestId('try-path');
    expect(
      within(path)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('span')?.textContent),
    ).toEqual(['Request', 'Work', 'Review', 'Finished']);
    expect(screen.getByTestId('node-review')).toHaveAttribute('data-path-step', '3');
    const radios = within(screen.getByTestId('try-step-2')).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    await user.click(within(screen.getByTestId('try-step-2')).getByLabelText(/Not good enough/));
    // Review, sent back to Work, Work, Review again, then finished.
    const labels = within(screen.getByTestId('try-path'))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent);
    expect(labels).toEqual(['Request', 'Work', 'Review', 'Work', 'Review', 'Finished']);
  });

  it('shows "no role yet" in the preview for agent steps without a role', () => {
    render(<Harness />);
    expect(within(screen.getByTestId('try-a-card')).getAllByText('No role yet')).toHaveLength(2);
  });
});

describe('workflow builder: approved versions, read-only and extension points', () => {
  it('marks steps of an approved version as locked and warns when one is removed', async () => {
    const user = userEvent.setup();
    const def = instantiateTemplate('simple-review', { key: 'simple-review' }) as WorkflowDefinitionInput;
    const { frozenIdsOf } = await import('@aom/shared');
    render(<Harness initial={fromDefinition(def)} frozen={frozenIdsOf(def)} />);
    expect(within(step('Work')).getByText('Approved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Review' }));
    expect(screen.getByTestId('issue-bar')).toHaveTextContent(/approved step 'review' was removed/);
  });

  it('read-only: no editing controls', () => {
    render(<Harness readOnly />);
    expect(screen.queryByRole('button', { name: 'Add a step before the end' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Work' })).toBeNull();
    expect(within(step('Work')).getByLabelText('Step name')).toBeDisabled();
  });

  it('shows a sub-workflow step read-only, and hands it to the extension slot when one is plugged in', () => {
    const def = instantiateTemplate('simple-review', { key: 'sw' }) as WorkflowDefinitionInput;
    const sub = {
      ...def,
      stages: def.stages.map((s) =>
        s.id === 'work'
          ? {
              ...s,
              kind: 'subworkflow' as const,
              claimRole: null,
              subworkflow: { workflowKey: 'translate', mode: 'wait' as const },
            }
          : s,
      ),
    };
    const { unmount } = render(<Harness initial={fromDefinition(sub)} />);
    expect(within(step('Work')).getByTestId('subworkflow-work')).toHaveTextContent(
      /Starts a card in the workflow "translate" and waits/,
    );
    unmount();
    render(
      <Harness initial={fromDefinition(sub)} slot={({ step: s }) => <p>custom editor for {s.uid}</p>} />,
    );
    expect(screen.getByText('custom editor for work')).toBeInTheDocument();
  });

  it('prefers the server issues after a save', () => {
    render(
      <Harness
        server={[
          {
            severity: 'error',
            code: 'unreachable_stage',
            message: "stage 'review' unreachable",
            stageId: 'review',
          },
        ]}
      />,
    );
    expect(within(step('Review')).getByText(/can never be reached/)).toBeInTheDocument();
    expect(screen.getAllByTestId('issue-bar-item')).toHaveLength(1);
  });
});

describe('template gallery', () => {
  it('lists the templates and copies of built-in workflows with the notice', async () => {
    const user = userEvent.setup();
    const onTemplate = vi.fn();
    const onCopy = vi.fn();
    render(<TemplateGallery onTemplate={onTemplate} onCopy={onCopy} />);
    expect(screen.getByTestId('template-blank')).toBeInTheDocument();
    expect(screen.getByTestId('template-simple-review')).toHaveTextContent('Review');
    await user.click(screen.getByRole('button', { name: 'Use the Simple review template' }));
    expect(onTemplate).toHaveBeenCalledWith('simple-review');
    expect(screen.getByRole('note')).toHaveTextContent(
      /special behaviour of the built-in one does not carry over/,
    );
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(onCopy).toHaveBeenCalledWith('code');
  });
});

// -------------------------------------------------------------------------------- the page

const version = (
  n: number,
  definition: unknown,
  status: string,
  v: number,
  extra: Record<string, unknown> = {},
) => ({
  id: ID(n),
  version: v,
  status,
  deskItemId: null,
  vaultPath: null,
  draftedByAgent: false,
  createdAt: new Date(0).toISOString(),
  definition: { ...(definition as object), version: v, builtIn: false },
  cardsInFlight: 0,
  ...extra,
});
const wfDef = (key = 'simple-review') =>
  instantiateTemplate('simple-review', { key, name: 'Simple review' }) as WorkflowDefinitionInput;

function catalogue(over: Partial<OrgCatalogueResponse> = {}): OrgCatalogueResponse {
  return {
    orgId: ID(900),
    canEdit: true,
    roles: [
      {
        key: 'writer',
        builtIn: false,
        versions: [{ ...version(50, ROLES[0], 'active', 1) } as never],
        extensions: null,
      },
      {
        key: 'editor',
        builtIn: false,
        versions: [{ ...version(51, ROLES[1], 'active', 1) } as never],
        extensions: null,
      },
    ],
    workflows: [],
    departments: [{ id: null, name: 'support', builtIn: false, roleKeys: [], workflowKeys: [] }],
    ...over,
  };
}

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="location">{`${l.pathname}${l.search}`}</p>;
}

function mountPage(cat: OrgCatalogueResponse, path: string) {
  const calls: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push([method, url, body]);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.startsWith('/api/org/catalogue')) return json(cat);
      if (url.startsWith('/api/agents')) return json({ agents: [] });
      if (method === 'POST' && url === '/api/workflows') {
        const draft = version(70, body, 'draft', 1);
        cat.workflows = [{ key: body.key, builtIn: false, versions: [draft as never] }];
        return json({ id: draft.id, key: body.key, version: 1, status: 'draft', issues: [] });
      }
      if (method === 'POST' && url.endsWith('/submit'))
        return json({ id: ID(70), deskItemId: ID(71), status: 'pending_approval' });
      return json({ ok: true });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/org/workflows/:draftId" element={<WorkflowBuilderPage />} />
          <Route path="/org" element={<p>org page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the builder page', () => {
  it('template -> edit -> save draft: the key follows the name, ids are fixed, the page moves to the draft', async () => {
    const user = userEvent.setup();
    const calls = mountPage(catalogue(), '/org/workflows/new');
    await user.click(await screen.findByRole('button', { name: 'Use the Simple review template' }));
    expect(await screen.findByTestId('workflow-builder')).toBeInTheDocument();
    expect(screen.getByTestId('builder-status')).toHaveTextContent('Not saved yet');
    // Sending for approval is blocked while problems remain; saving a draft is not.
    expect(screen.getByRole('button', { name: 'Save and send for approval' })).toBeDisabled();
    const name = screen.getByLabelText('Workflow name');
    await user.clear(name);
    await user.type(name, 'Press release');
    expect(screen.getByText(/Internal key: press_release/)).toBeInTheDocument();
    await user.selectOptions(within(step('Work')).getByLabelText('Who does it'), 'writer');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some(([m, u]) => m === 'POST' && u === '/api/workflows')).toBe(true));
    const post = calls.find(
      ([m, u]) => m === 'POST' && u === '/api/workflows',
    )?.[2] as WorkflowDefinitionInput;
    expect(post).toMatchObject({ key: 'press_release', name: 'Press release', fieldSet: 'custom' });
    expect(post.stages.map((s) => s.id)).toEqual(['request', 'work', 'review', 'finished']);
    expect(post.stages[1]?.claimRole).toBe('writer');
    expect(post).not.toHaveProperty('version');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/org/workflows/${ID(70)}`));
    expect(await screen.findByTestId('builder-status')).toHaveTextContent('Draft');
  });

  it('save and send for approval puts the draft on the desk', async () => {
    const user = userEvent.setup();
    const calls = mountPage(catalogue(), '/org/workflows/new?template=simple-review');
    await screen.findByTestId('workflow-builder');
    await user.selectOptions(within(step('Work')).getByLabelText('Who does it'), 'writer');
    await user.selectOptions(within(step('Review')).getByLabelText('Who does it'), 'editor');
    const send = screen.getByRole('button', { name: 'Save and send for approval' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() =>
      expect(calls.some(([m, u]) => m === 'POST' && u === `/api/workflows/${ID(70)}/submit`)).toBe(true),
    );
    expect(calls.findIndex(([, u]) => u === '/api/workflows')).toBeLessThan(
      calls.findIndex(([, u]) => u.endsWith('/submit')),
    );
  });

  it('opens a saved draft with its versions and a step-level "Compare with previous"', async () => {
    const user = userEvent.setup();
    const v1 = wfDef();
    const v2 = {
      ...wfDef(),
      stages: v1.stages.map((s) => (s.id === 'work' ? { ...s, doneCriteria: 'Changed words.' } : s)),
    };
    const v3 = {
      ...v2,
      stages: [
        ...v2.stages.slice(0, 2),
        { ...(v2.stages[2] as object), id: 'legal', label: 'Legal check' },
        ...v2.stages.slice(2),
      ],
    };
    const cat = catalogue({
      workflows: [
        {
          key: 'simple-review',
          builtIn: false,
          versions: [
            version(3, v3, 'draft', 3) as never,
            version(2, v2, 'active', 2) as never,
            version(1, v1, 'superseded', 1) as never,
          ],
        },
      ],
    });
    mountPage(cat, `/org/workflows/${ID(3)}`);
    expect(await screen.findByTestId('workflow-builder')).toBeInTheDocument();
    expect(screen.getByTestId('builder-status')).toHaveTextContent('Draft');
    // The steps of the active version are locked.
    expect(within(step('Work')).getByText('Approved')).toBeInTheDocument();
    const compare = screen.getByTestId('version-compare');
    await user.click(within(compare).getByRole('button', { name: /what changed in v2 compared with v1/ }));
    expect(within(compare).getByTestId('diff-lines')).toHaveTextContent("Changed step 'Work': doneCriteria");
    await user.click(within(compare).getByRole('button', { name: 'Compare this draft with v2' }));
    expect(within(compare).getAllByTestId('diff-lines').at(-1)).toHaveTextContent("Added step 'Legal check'");
  });

  it('an active version is read-only with "Edit as new version"', async () => {
    const user = userEvent.setup();
    const cat = catalogue({
      workflows: [
        { key: 'simple-review', builtIn: false, versions: [version(2, wfDef(), 'active', 2) as never] },
      ],
    });
    mountPage(cat, `/org/workflows/${ID(2)}`);
    expect(await screen.findByTestId('workflow-builder')).toBeInTheDocument();
    expect(screen.getByTestId('builder-status')).toHaveTextContent('Active');
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit as new version' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`?from=${ID(2)}`));
    expect(await screen.findByTestId('builder-status')).toHaveTextContent('Not saved yet');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
  });

  it('a copy of a built-in workflow shows what was lost', async () => {
    mountPage(catalogue(), '/org/workflows/new?copy=code');
    const notice = await screen.findByTestId('copy-notices');
    expect(notice).toHaveTextContent(/not carried over|became a plain/);
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Code (copy)');
  });

  it('a draft that does not exist says so', async () => {
    mountPage(catalogue(), `/org/workflows/${ID(999)}`);
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument();
  });

  it('members see it read-only', async () => {
    mountPage(catalogue({ canEdit: false }), '/org/workflows/new');
    expect(
      await screen.findByText(/Only the organization's Owner and Admins build workflows/),
    ).toBeInTheDocument();
  });

  it('keeps the table editor as Advanced, and edits there show in the step list', async () => {
    const user = userEvent.setup();
    mountPage(catalogue(), '/org/workflows/new?template=simple-review');
    await screen.findByTestId('workflow-builder');
    const panel = screen.getByTestId('advanced-panel');
    expect(panel).toHaveTextContent('Advanced: table editor');
    fireEvent.click(within(panel).getByText('Advanced: table editor'));
    await user.click(within(panel).getByRole('button', { name: 'Add stage' }));
    expect(within(screen.getByTestId('step-list')).getAllByRole('heading', { level: 3 })).toHaveLength(5);
  });

  it('asks for a BA to talk the draft through when none is hired', async () => {
    mountPage(catalogue(), '/org/workflows/new?template=simple-review');
    expect(await screen.findByTestId('builder-no-ba')).toBeInTheDocument();
  });
});
