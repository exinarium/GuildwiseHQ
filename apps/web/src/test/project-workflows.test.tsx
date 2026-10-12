import {
  BUILTIN_ROLES,
  codeWorkflowV1,
  type ProjectWorkflowDto,
  type ProjectWorkflowsResponse,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflows } from '../components/ProjectWorkflows.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { CardNewForm } from '../pages/CardNew.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stagesOf = (extra: Array<{ id: string; label: string; after: string }> = []) => {
  const base = codeWorkflowV1.stages.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    claimRole: s.claimRole,
    inherited: true,
  }));
  for (const e of extra) {
    const at = base.findIndex((s) => s.id === e.after);
    base.splice(at + 1, 0, {
      id: e.id,
      label: e.label,
      kind: 'agent',
      claimRole: 'securer',
      inherited: false,
    });
  }
  return base;
};

const wf = (over: Partial<ProjectWorkflowDto> = {}): ProjectWorkflowDto => ({
  workflowKey: 'code',
  name: 'Code',
  version: 1,
  versionId: ID(10),
  isPrimary: true,
  enabled: true,
  defaultCardTypes: [],
  cardTypes: ['feature', 'bug', 'support', 'refactor', 'docs', 'regression'],
  variantOf: null,
  baseUpdate: null,
  pendingVersion: null,
  variantSpec: null,
  stages: stagesOf(),
  openCards: 0,
  ...over,
});

const variant = (over: Partial<ProjectWorkflowDto> = {}): ProjectWorkflowDto =>
  wf({
    workflowKey: 'code-toy',
    name: 'Code (TOY)',
    versionId: ID(11),
    isPrimary: false,
    variantOf: { key: 'code', version: 1 },
    stages: stagesOf([{ id: 'security_check', label: 'Security check', after: 'build' }]),
    ...over,
  });

const entry = (definition: unknown, orgId: string | null = null) => ({
  definition,
  orgId,
  status: 'active',
  extensions: null,
});
const roles = [
  ...BUILTIN_ROLES.map((r) => entry(r)),
  entry(
    {
      ...(BUILTIN_ROLES.find((r) => r.key === 'reviewer') as object),
      key: 'securer',
      name: 'Securer',
      claimableStages: [{ workflowKey: 'code-toy', stageId: '*' }],
    },
    ID(2),
  ),
];

const calls: Array<{ method: string; url: string; body?: any }> = [];
let view: ProjectWorkflowsResponse;
let draftReply: { issues: any[] };
beforeEach(() => {
  calls.length = 0;
  view = { enabled: [wf()], available: [], canEdit: true };
  draftReply = { issues: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/workflow-variants') && method !== 'GET') {
        if (url.endsWith('/submit'))
          return json({ id: ID(20), deskItemId: ID(21), status: 'pending_approval' });
        return json(
          {
            id: ID(20),
            key: 'code-toy',
            version: 1,
            status: 'draft',
            issues: draftReply.issues,
            stages: [],
          },
          method === 'POST' ? 201 : 200,
        );
      }
      if (url.includes('/workflows') && url.includes(`/projects/${PROJECT}`)) {
        if (method === 'PUT') {
          const next = JSON.parse(String(init.body)).enabled as Array<{
            workflowKey: string;
            defaultCardTypes: string[];
          }>;
          const all = [...view.enabled, ...view.available];
          view = {
            ...view,
            enabled: next.flatMap((n) => {
              const w = all.find((x) => x.workflowKey === n.workflowKey);
              return w ? [{ ...w, enabled: true, defaultCardTypes: n.defaultCardTypes }] : [];
            }),
            available: all.filter((x) => !next.some((n) => n.workflowKey === x.workflowKey)),
          };
        }
        return json(view);
      }
      if (url.endsWith('/cards') && method === 'POST')
        return json({ card: { id: ID(40), ref: 'TOY-1' } }, 201);
      if (url.includes('/org/catalogue'))
        return json({ orgId: ID(2), canEdit: true, roles: [], workflows: [], departments: [] });
      if (url.includes('/roles')) return json({ roles });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

describe('project settings: Workflows section', () => {
  it('lists the primary workflow and offers the others to enable', async () => {
    view = { enabled: [wf()], available: [variant({ enabled: false })], canEdit: true };
    const user = userEvent.setup();
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    const row = await screen.findByTestId('wf-code');
    expect(within(row).getByText('Primary')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Enable another workflow'), 'code-toy');
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(screen.getByTestId('wf-code-toy')).toBeInTheDocument());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      enabled: [
        { workflowKey: 'code', defaultCardTypes: [] },
        { workflowKey: 'code-toy', defaultCardTypes: [] },
      ],
    });
  });

  it('making a workflow the default for a card type moves the default away from the other', async () => {
    view = {
      enabled: [wf({ defaultCardTypes: ['feature'] }), variant({ enabled: true })],
      available: [],
      canEdit: true,
    };
    const user = userEvent.setup();
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    await screen.findByTestId('wf-code-toy');
    await user.click(screen.getByLabelText('Code (TOY) is the default for feature cards'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      enabled: [
        { workflowKey: 'code', defaultCardTypes: [] },
        { workflowKey: 'code-toy', defaultCardTypes: ['feature'] },
      ],
    });
  });

  it('disabling is offered for non-primary workflows only', async () => {
    view = { enabled: [wf(), variant()], available: [], canEdit: true };
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    await screen.findByTestId('wf-code-toy');
    expect(screen.getByRole('button', { name: 'Disable Code (TOY)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable Code' })).toBeNull();
  });

  it('shows the state of a variant: based on, a newer base, and a version waiting for approval', async () => {
    view = {
      enabled: [
        wf(),
        variant({
          baseUpdate: { version: 2 },
          pendingVersion: {
            id: ID(30),
            version: 2,
            status: 'pending_approval',
            deskItemId: ID(31),
            variantSpec: null,
          },
        }),
      ],
      available: [],
      canEdit: true,
    };
    const user = userEvent.setup();
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    const row = await screen.findByTestId('wf-code-toy');
    expect(within(row).getByText('based on code v1')).toBeInTheDocument();
    expect(within(row).getByText('code v2 available')).toBeInTheDocument();
    expect(within(row).getByText('v2 waits for approval')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Rebase on v2' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/workflow-variants/${ID(11)}/rebase`))).toBe(true),
    );
  });

  it('a variant that waits for its first approval is listed apart and cannot be enabled', async () => {
    view = {
      enabled: [wf()],
      available: [
        variant({
          enabled: false,
          version: 1,
          pendingVersion: {
            id: ID(11),
            version: 1,
            status: 'pending_approval',
            deskItemId: ID(31),
            variantSpec: null,
          },
        }),
      ],
      canEdit: true,
    };
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    const note = await screen.findByTestId('wf-pending-code-toy');
    expect(note).toHaveTextContent("waiting for the owner's approval");
    expect(screen.queryByLabelText('Enable another workflow')).toBeNull();
  });

  it('members see the section read only', async () => {
    view = { enabled: [wf(), variant()], available: [], canEdit: false };
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    await screen.findByTestId('wf-code-toy');
    expect(screen.queryByRole('button', { name: /Customise|Edit steps|Disable/ })).toBeNull();
    expect(screen.getByLabelText('Code (TOY) is the default for feature cards')).toBeDisabled();
    expect(screen.getByText(/Only the organization's Owner and Admins/)).toBeInTheDocument();
  });
});

describe('the variant editor (workflow builder, project-variant scope)', () => {
  const open = async (view_?: ProjectWorkflowsResponse, button = 'Customise') => {
    if (view_) view = view_;
    const user = userEvent.setup();
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    await user.click(await screen.findByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('variant-stages');
    return { user, dialog };
  };
  const postBody = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/workflow-variants'))?.body;
  const labels = (dialog: HTMLElement) =>
    within(within(dialog).getByTestId('variant-stages'))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
  const insertCustom = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    after: string,
    label: string,
    role = 'securer',
  ) => {
    await user.click(within(dialog).getByRole('button', { name: `Insert step after ${after}` }));
    await user.selectOptions(within(dialog).getByLabelText('Template'), 'custom');
    await user.type(within(dialog).getByLabelText('Label'), label);
    await user.selectOptions(within(dialog).getByLabelText('Role'), role);
    await user.type(within(dialog).getByLabelText('Done when'), 'Checked.');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
  };

  it('lists the base steps locked with an insert button between them, plus the diagram and Try a card', async () => {
    const { dialog } = await open();
    const list = within(dialog).getByTestId('variant-stages');
    expect(
      within(list)
        .getAllByTestId('base-stage')
        .map((s) => s.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining('Build'), expect.stringContaining('Review')]));
    expect(within(list).queryAllByTestId('inserted-stage')).toHaveLength(0);
    expect(within(list).getAllByText(/cannot be changed/).length).toBeGreaterThan(5);
    // Base steps have no edit controls.
    expect(within(list).queryByRole('button', { name: /^Remove step/ })).toBeNull();
    expect(within(list).queryByLabelText('Step name')).toBeNull();
    // The final stage has nothing to insert after.
    expect(within(list).queryByRole('button', { name: 'Insert step after Done' })).toBeNull();
    expect(within(dialog).getByLabelText('Key')).toHaveValue('code-toy');
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(within(dialog).getByRole('heading', { name: 'Diagram' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('try-a-card')).toBeInTheDocument();
    expect(within(dialog).getByTestId('issues-ok')).toBeInTheDocument();
  });

  it('inserts a custom step after Build; Save draft sends insertions only, then it can be sent for approval', async () => {
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Build', 'Security check');
    // The new step shows between Build and Review, before anything is saved.
    const l = labels(dialog);
    expect(l[l.indexOf('Security check') - 1]).toBe('Build');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(within(dialog).getByTestId('variant-unsaved')).toBeInTheDocument();
    // "Try a card" walks the new step too.
    expect(within(dialog).getByTestId('try-path')).toHaveTextContent('Security check');
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({
      key: 'code-toy',
      name: 'Code (TOY)',
      base: { key: 'code', version: 1 },
      insertions: [
        { after: 'build', stage: { id: 'security_check', label: 'Security check', claimRole: 'securer' } },
      ],
    });
    expect(postBody()).not.toHaveProperty('stages');
    expect(await within(dialog).findByTestId('variant-saved')).toBeInTheDocument();
    const send = within(dialog).getByRole('button', { name: 'Send for approval' });
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/workflow-variants/${ID(20)}/submit`))).toBe(true),
    );
  });

  it('Send for approval saves a changed draft first, then submits it', async () => {
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Build', 'Security check');
    await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    const order = calls.filter((c) => c.method !== 'GET' && c.url.includes('/workflow-variants'));
    expect(order.map((c) => c.method + (c.url.endsWith('/submit') ? ' submit' : ''))).toEqual([
      'POST',
      'POST submit',
    ]);
  });

  it('the Investigate & design template inserts the architect step with its report data', async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Insert step after Build' }));
    // The architect template is the default when the architect role exists.
    expect(within(dialog).getByLabelText('Template')).toHaveValue('investigate');
    expect(within(dialog).getByLabelText('Role')).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(labels(dialog)).toContain('Investigate & design');
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().insertions[0]).toMatchObject({
      after: 'build',
      stage: {
        id: 'investigate_after_build',
        claimRole: 'architect',
        data: 'investigation',
        seniorOnly: true,
      },
    });
  });

  it('inserted steps can be renamed, moved and removed; base steps never can', async () => {
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Build', 'Security check');
    const start = labels(dialog);
    const at = start.indexOf('Security check');
    // Edit the name in place: the id stays.
    const name = within(dialog).getByLabelText('Step name');
    await user.clear(name);
    await user.type(name, 'Security scan');
    expect(labels(dialog)).toContain('Security scan');
    // Move it down past the step that follows it, then up again.
    const next = start[at + 1];
    await user.click(within(dialog).getByRole('button', { name: 'Move Security scan down' }));
    expect(labels(dialog).indexOf('Security scan')).toBe(at + 1);
    expect(labels(dialog)[at]).toBe(next);
    await user.click(within(dialog).getByRole('button', { name: 'Move Security scan up' }));
    expect(labels(dialog).indexOf('Security scan')).toBe(at);
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().insertions).toHaveLength(1);
    expect(postBody().insertions[0].stage).toMatchObject({ id: 'security_check', label: 'Security scan' });
    // Remove it.
    await user.click(within(dialog).getByRole('button', { name: 'Remove step Security scan' }));
    expect(labels(dialog)).toEqual(start.filter((x) => x !== 'Security check'));
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('moving a step re-anchors the insertion on the step before it', async () => {
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Build', 'Security check');
    const start = labels(dialog);
    const next = start[start.indexOf('Security check') + 1];
    await user.click(within(dialog).getByRole('button', { name: 'Move Security check down' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(postBody()).toBeDefined());
    const nextId = codeWorkflowV1.stages.find((s) => s.label === next)?.id;
    expect(postBody().insertions[0].after).toBe(nextId);
  });

  it('shows the issues the server reports on the step and in the issue bar, and keeps sending blocked', async () => {
    draftReply = {
      issues: [
        {
          severity: 'error',
          code: 'role_cannot_claim_stage',
          message: "role 'writer' cannot claim stage 'code-toy.docs_check'",
          stageId: 'docs_check',
        },
      ],
    };
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Docs', 'Docs check', 'writer');
    await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(postBody()).toBeDefined());
    await waitFor(() => expect(within(dialog).getByTestId('issue-bar')).toHaveAttribute('data-errors', '1'));
    expect(within(dialog).getByTestId('step-issues-docs_check')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });

  it('validates live in the browser: a role that cannot claim the step blocks sending before any save', async () => {
    const { user, dialog } = await open();
    await insertCustom(user, dialog, 'Docs', 'Docs check', 'writer');
    expect(within(dialog).getByTestId('issue-bar')).toHaveAttribute('data-errors', '1');
    expect(within(dialog).getByTestId('step-issues-docs_check')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a step needs a label, a role and a done criterion; a duplicate id is refused', async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole('button', { name: 'Insert step after Build' }));
    await user.selectOptions(within(dialog).getByLabelText('Template'), 'custom');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the step a label');
    await user.type(within(dialog).getByLabelText('Label'), 'Review');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent("A step 'review' exists already");
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('continues an existing draft and compares it with the approved variant', async () => {
    const spec = {
      key: 'code-toy',
      name: 'Code (TOY)',
      projectId: PROJECT,
      base: { key: 'code', version: 1 },
      insertions: [
        {
          after: 'build',
          stage: { id: 'security_check', label: 'Security check', claimRole: 'securer', doneCriteria: 'ok' },
        },
      ],
    };
    const v = variant({
      variantSpec: { ...spec, insertions: [] as never },
      pendingVersion: {
        id: ID(30),
        version: 2,
        status: 'draft',
        deskItemId: null,
        variantSpec: spec as never,
      },
    });
    const { user, dialog } = await open({ enabled: [wf(), v], available: [], canEdit: true }, 'Edit steps');
    expect(labels(dialog)).toContain('Security check');
    await user.click(within(dialog).getByRole('button', { name: 'Compare with previous' }));
    expect(within(dialog).getByTestId('diff-lines')).toHaveTextContent("Added step 'Security check'");
  });

  it('rebase: a variant with a newer base offers Rebase in the editor', async () => {
    const { user, dialog } = await open(
      { enabled: [wf(), variant({ baseUpdate: { version: 2 } })], available: [], canEdit: true },
      'Edit steps',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Rebase on v2' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/workflow-variants/${ID(11)}/rebase`))).toBe(true),
    );
  });

  it('a version waiting for approval is read only', async () => {
    const { dialog } = await open(
      {
        enabled: [
          wf(),
          variant({
            pendingVersion: {
              id: ID(30),
              version: 2,
              status: 'pending_approval',
              deskItemId: ID(31),
              variantSpec: null,
            },
          }),
        ],
        available: [],
        canEdit: true,
      },
      'Edit steps',
    );
    expect(within(dialog).getByText(/waits for the owner's approval/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Insert step after/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });
});

describe('card create: workflow picker', () => {
  const wfDef = (key: string, name: string, cardTypes: string[]) =>
    ({ ...codeWorkflowV1, key, name, cardTypes }) as typeof codeWorkflowV1;
  const setup = (props: Partial<React.ComponentProps<typeof CardNewForm>> = {}) =>
    wrap(
      <CardNewForm
        projectId={PROJECT}
        projectKey="TOY"
        projectKeys={['TOY']}
        onProject={() => {}}
        workflow={wfDef('code', 'Code', ['feature', 'bug'])}
        repos={[{ id: ID(5), name: 'toy' }]}
        {...props}
      />,
    );

  it('is not shown when only one workflow runs the card type', () => {
    setup();
    expect(screen.queryByTestId('card-workflow')).toBeNull();
  });

  it('is shown when two enabled workflows run the type, defaulted to the project default', async () => {
    setup({
      extraWorkflows: [wfDef('code-toy', 'Code (TOY)', ['feature'])],
      defaultWorkflowFor: { feature: 'code-toy' },
    });
    const picker = screen.getByTestId('card-workflow');
    expect(picker).toHaveValue('code-toy');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Code', 'Code (TOY)']);
    // A type only the primary runs has no choice.
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Card type'), 'bug');
    expect(screen.queryByTestId('card-workflow')).toBeNull();
  });

  it('defaults to the primary when no default is set, and sends the chosen workflow key', async () => {
    setup({ extraWorkflows: [wfDef('code-toy', 'Code (TOY)', ['feature'])] });
    const picker = screen.getByTestId('card-workflow');
    expect(picker).toHaveValue('code');
    const user = userEvent.setup();
    await user.selectOptions(picker, 'code-toy');
    await user.type(screen.getByLabelText('Title'), 'Add throttle');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cards'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/cards'))?.body).toMatchObject({
      projectId: PROJECT,
      title: 'Add throttle',
      cardType: 'feature',
      workflowKey: 'code-toy',
    });
  });
});
