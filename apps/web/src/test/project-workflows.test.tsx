import { codeWorkflowV1, type ProjectWorkflowDto, type ProjectWorkflowsResponse } from '@aom/shared';
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

const roles = [
  {
    definition: {
      key: 'securer',
      name: 'Securer',
      claimableStages: [{ workflowKey: 'code-toy', stageId: '*' }],
    },
    orgId: ID(2),
    status: 'active',
    extensions: null,
  },
  {
    definition: {
      key: 'writer',
      name: 'Writer',
      claimableStages: [{ workflowKey: 'code', stageId: 'docs' }],
    },
    orgId: null,
    status: 'active',
    extensions: null,
  },
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

describe('the insert-step editor', () => {
  const open = async () => {
    const user = userEvent.setup();
    wrap(<ProjectWorkflows projectId={PROJECT} projectKey="TOY" />);
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    return user;
  };

  it('lists the base steps read only with an insert button between them', async () => {
    await open();
    const dialog = await screen.findByRole('dialog');
    const list = within(dialog).getByTestId('variant-stages');
    expect(
      within(list)
        .getAllByTestId('base-stage')
        .map((s) => s.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining('Build'), expect.stringContaining('Review')]));
    expect(within(list).queryAllByTestId('inserted-stage')).toHaveLength(0);
    expect(within(list).getAllByText(/cannot be changed/).length).toBeGreaterThan(5);
    // The final stage has nothing to insert after.
    expect(within(list).queryByRole('button', { name: 'Insert step after Done' })).toBeNull();
    expect(within(dialog).getByLabelText('Key')).toHaveValue('code-toy');
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });

  it('inserts a custom step after Build, saves the draft with it and enables sending for approval', async () => {
    const user = await open();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Insert step after Build' }));
    await user.type(within(dialog).getByLabelText('Label'), 'Security check');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'securer');
    await user.type(within(dialog).getByLabelText('Done when'), 'The change was checked.');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/workflow-variants'))).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/workflow-variants'));
    expect(post?.body).toMatchObject({
      key: 'code-toy',
      name: 'Code (TOY)',
      base: { key: 'code', version: 1 },
      insertions: [
        { after: 'build', stage: { id: 'security_check', label: 'Security check', claimRole: 'securer' } },
      ],
    });
    // The new step shows between Build and Review.
    const items = within(within(dialog).getByTestId('variant-stages')).getAllByRole('listitem');
    const labels = items.map((li) => li.textContent ?? '');
    const at = labels.findIndex((t) => t.includes('Security check'));
    expect(labels[at - 1]).toContain('Build');
    expect(await within(dialog).findByTestId('variant-saved')).toBeInTheDocument();
    const send = within(dialog).getByRole('button', { name: 'Send for approval' });
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/workflow-variants/${ID(20)}/submit`))).toBe(true),
    );
  });

  it('shows the issues the server reports and keeps sending blocked', async () => {
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
    const user = await open();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Insert step after Docs' }));
    await user.type(within(dialog).getByLabelText('Label'), 'Docs check');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'writer');
    await user.type(within(dialog).getByLabelText('Done when'), 'Checked.');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    const issues = await within(dialog).findByTestId('variant-issues');
    expect(issues).toHaveTextContent("role 'writer' cannot claim stage");
    expect(within(dialog).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });

  it('a step needs a label, a role and a done criterion; a duplicate id is refused', async () => {
    const user = await open();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Insert step after Build' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the step a label');
    await user.type(within(dialog).getByLabelText('Label'), 'Review');
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent("A step 'review' exists already");
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
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
