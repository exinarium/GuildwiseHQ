import {
  codeWorkflowV1,
  instantiateTemplate,
  type ProjectDto,
  type ScheduleDto,
  type WorkflowDefinitionInput,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoStartSection } from '../components/builder/AutoStartSection.tsx';
import { WorkflowBuilder } from '../components/builder/WorkflowBuilder.tsx';
import { MappingEditor, OFFERED_TOKENS } from '../components/schedules/MappingEditor.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { articleBySlug } from '../help/articles.ts';
import { type BuilderModel, fromDefinition, syncKey } from '../lib/builder.ts';
import {
  buildScheduleRequest,
  describeTrigger,
  emptyWizard,
  mappingOf,
  stateFromSchedule,
  type WizardState,
} from '../lib/schedules.ts';
import { Automations } from '../pages/Automations.tsx';
import { routes } from '../router.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const project: ProjectDto = {
  id: ID(10),
  orgId: ID(1),
  key: 'WEB',
  name: 'Web',
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  myRole: 'owner',
};
const base = {
  projectKey: 'WEB',
  projectName: 'Web',
  nextFireAt: null,
  lastFiredAt: null,
  lastCardId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ownerName: 'Pieter',
  canEdit: true,
  projectId: project.id,
  kind: 'card' as const,
  cron: null,
  timezone: null,
  enabled: true,
  orgLevel: false,
};
const followUp: ScheduleDto = {
  ...base,
  id: ID(20),
  name: 'Release notes',
  trigger: {
    kind: 'event',
    event: 'card_done',
    workflowKey: 'code',
    filter: { cardType: 'feature', fieldEquals: [{ field: 'urgent', equals: true }] },
  },
  action: {
    kind: 'create_card',
    projectId: project.id,
    template: {
      title: 'Notes',
      fields: {},
      mapping: { title: 'Notes for {card.ref}' },
      start: 'draft',
    },
    ratePerHour: 5,
    dedupe: 'thread',
  },
} as ScheduleDto;
const intake: ScheduleDto = {
  ...base,
  id: ID(21),
  name: 'Triage',
  trigger: { kind: 'intake_ticket', source: 'issues' },
  action: { kind: 'create_card', projectId: project.id, template: { title: 'Look', fields: {} } },
} as ScheduleDto;
const unrelated: ScheduleDto = {
  ...base,
  id: ID(22),
  name: 'Elsewhere',
  trigger: { kind: 'event', event: 'card_done', workflowKey: 'research' },
  action: { kind: 'create_card', projectId: project.id, template: { title: 'x', fields: {} } },
} as ScheduleDto;

let calls: Array<{ method: string; url: string; body: unknown }>;
let role = 'owner';
let workflows: unknown[];

beforeEach(() => {
  calls = [];
  role = 'owner';
  workflows = [{ id: ID(50), orgId: null, status: 'active', definition: codeWorkflowV1 }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET')
        calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/auth/me'))
        return json({
          user: { id: ID(900), displayName: 'Pieter', email: 'p@x.test' },
          isAdmin: role === 'owner',
          visibleProjectIds: [project.id],
          activeOrg: {
            id: ID(1),
            name: 'Acme',
            role,
            status: 'active',
            plan: 'team',
            planName: 'Team',
            features: {},
          },
        });
      if (url.startsWith('/api/schedules') && method === 'GET')
        return json({ schedules: [followUp, intake, unrelated], system: [] });
      if (url.startsWith('/api/projects') && method === 'GET') return json({ projects: [project] });
      if (url.startsWith('/api/workstations')) return json({ workstations: [] });
      if (url.startsWith('/api/workflows')) return json({ workflows });
      if (url === '/api/schedules' && method === 'POST') return json({ ...followUp, id: ID(30) }, 201);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

describe('describing the new triggers', () => {
  it('names the workflow, filters and source in plain words', () => {
    expect(describeTrigger(followUp.trigger)).toBe(
      'When a card of a workflow is done (workflow code, type feature, urgent = true)',
    );
    expect(
      describeTrigger({ kind: 'event', event: 'card_stage_reached', workflowKey: 'code', stageId: 'review' }),
    ).toBe('When a card reaches a stage (workflow code, stage review)');
    expect(describeTrigger(intake.trigger)).toBe('When an intake ticket is created (from issues)');
  });
});

describe('building an automation request', () => {
  const ctx = { workflow: undefined, mockUi: false, myEmail: 'p@x.test' };
  const card = (over: Partial<WizardState>): WizardState =>
    emptyWizard({ name: 'Auto', tile: 'regression_run', projectId: project.id, ...over });

  it('a stage trigger needs the workflow and the stage', () => {
    const r = buildScheduleRequest(card({ triggerKind: 'event', event: 'card_stage_reached' }), ctx);
    expect(r.body).toBeNull();
    expect(r.errors).toMatchObject({
      eventWorkflowKey: expect.any(String),
      eventStageId: expect.any(String),
    });
  });

  it('a stage trigger carries the workflow, the stage and the filter', () => {
    const r = buildScheduleRequest(
      card({
        triggerKind: 'event',
        event: 'card_stage_reached',
        eventWorkflowKey: 'code',
        eventStageId: 'review',
        filterCardType: 'bug',
        filterField: 'urgent',
        filterEquals: 'true',
      }),
      ctx,
    );
    expect(r.body?.trigger).toEqual({
      kind: 'event',
      event: 'card_stage_reached',
      workflowKey: 'code',
      stageId: 'review',
      filter: { cardType: 'bug', fieldEquals: [{ field: 'urgent', equals: true }] },
    });
  });

  it('other events carry no workflow or stage, even when the form still holds them', () => {
    const r = buildScheduleRequest(
      card({ triggerKind: 'event', event: 'phase_completed', eventWorkflowKey: 'code', eventStageId: 'x' }),
      ctx,
    );
    expect(r.body?.trigger).toEqual({ kind: 'event', event: 'phase_completed' });
  });

  it('an intake trigger, with its source', () => {
    expect(
      buildScheduleRequest(card({ triggerKind: 'intake_ticket', intakeSource: 'web' }), ctx).body?.trigger,
    ).toEqual({
      kind: 'intake_ticket',
      source: 'web',
    });
    expect(buildScheduleRequest(card({ triggerKind: 'intake_ticket' }), ctx).body?.trigger).toEqual({
      kind: 'intake_ticket',
    });
  });

  it('mapping rows become a record; blank rows are dropped', () => {
    expect(
      mappingOf([
        { target: 'title', text: 'Notes for {card.ref}' },
        { target: '', text: 'lost' },
        { target: 'context', text: '  ' },
      ]),
    ).toEqual({ title: 'Notes for {card.ref}' });
    expect(mappingOf([])).toBeUndefined();
  });

  it('an existing automation comes back into the form', () => {
    const st = stateFromSchedule(followUp);
    expect(st).toMatchObject({
      triggerKind: 'event',
      event: 'card_done',
      eventWorkflowKey: 'code',
      filterCardType: 'feature',
      filterField: 'urgent',
      filterEquals: 'true',
      start: 'draft',
      ratePerHour: '5',
      dedupe: 'thread',
      mapping: [{ target: 'title', text: 'Notes for {card.ref}' }],
    });
    expect(stateFromSchedule(intake)).toMatchObject({ triggerKind: 'intake_ticket', intakeSource: 'issues' });
  });
});

describe('the mapping editor', () => {
  function Harness({ initial = [] as WizardState['mapping'] }) {
    const [rows, setRows] = useState(initial);
    return (
      <>
        <MappingEditor rows={rows} onChange={setRows} error={rows.length > 2 ? 'Too many' : undefined} />
        <output data-testid="rows">{JSON.stringify(rows)}</output>
      </>
    );
  }

  it('lists the tokens (without the e-mail ones) and adds one to the line being edited', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ target: 'title', text: 'Notes for' }]} />);
    const tokens = within(screen.getByTestId('mapping-tokens'));
    for (const t of OFFERED_TOKENS) expect(tokens.getByText(`{${t}}`)).toBeInTheDocument();
    expect(tokens.queryByText('{email.subject}')).toBeNull();
    expect(tokens.getByText('{card.ref}')).toBeInTheDocument();
    await user.click(tokens.getByText('{card.ref}'));
    expect(JSON.parse(screen.getByTestId('rows').textContent ?? '[]')).toEqual([
      { target: 'title', text: 'Notes for {card.ref}' },
    ]);
  });

  it('a token with no line starts one; lines can be added and removed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('{issue.title}'));
    expect(JSON.parse(screen.getByTestId('rows').textContent ?? '[]')).toEqual([
      { target: 'title', text: '{issue.title}' },
    ]);
    await user.click(screen.getByTestId('add-mapping'));
    expect(screen.getAllByLabelText(/^Field of line/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.getAllByLabelText(/^Field of line/)).toHaveLength(1);
  });
});

describe('the Automations page and its wizard', () => {
  const wrap = () =>
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <Automations />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('is called Automations and shows what each one starts on', async () => {
    wrap();
    expect(await screen.findByRole('heading', { name: 'Automations', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('new-schedule')).toHaveTextContent('New automation');
    const row = await screen.findByTestId('schedule-Release notes');
    expect(within(row).getByTestId('schedule-when')).toHaveTextContent('When a card of a workflow is done');
    expect(
      within(await screen.findByTestId('schedule-Triage')).getByTestId('schedule-when'),
    ).toHaveTextContent('intake ticket');
  });

  it('offers the intake trigger and the new events, with filters for card events', async () => {
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Release notes');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    expect(within(wizard).getByTestId('tile-intake_ticket')).toBeInTheDocument();
    await user.click(within(wizard).getByTestId('tile-event'));
    const event = within(wizard).getByLabelText('Event');
    for (const label of [
      'A card reaches a stage',
      'A card of a workflow is done',
      'An investigation is reported',
    ])
      expect(within(event).getByRole('option', { name: label })).toBeInTheDocument();
    await user.selectOptions(event, 'A card reaches a stage');
    const workflow = within(wizard).getByLabelText('Workflow');
    await user.selectOptions(workflow, 'code');
    expect(within(wizard).getByLabelText('Stage reached')).toBeEnabled();
    // a stage is required before moving on
    await user.click(screen.getByTestId('wizard-next'));
    expect(await within(wizard).findByText('Choose the stage the card must reach')).toBeInTheDocument();
  });

  it('creates a card automation for a stage, mapped and as a draft', async () => {
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Release notes');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    await user.click(within(wizard).getByTestId('tile-event'));
    await user.selectOptions(within(wizard).getByLabelText('Event'), 'A card of a workflow is done');
    await user.selectOptions(within(wizard).getByLabelText('Workflow'), 'code');
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(within(wizard).getByTestId('tile-create_card'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(within(wizard).getByLabelText('Name'), 'Notes');
    await user.selectOptions(within(wizard).getByLabelText('Project'), 'WEB Web');
    const template = await within(wizard).findByTestId('card-template');
    await user.type(within(template).getByLabelText('Title'), 'Follow-up');
    const options = within(wizard).getByTestId('automation-card-options');
    await user.click(within(options).getByText('{card.ref}'));
    await user.selectOptions(within(options).getByLabelText('The card starts as'), 'Draft for specifying');
    await user.type(within(options).getByLabelText('At most per hour'), '3');
    await user.click(screen.getByTestId('wizard-save'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/schedules')).toBe(true));
    const body = calls.find((c) => c.url === '/api/schedules')?.body as Record<string, any>;
    expect(body.trigger).toMatchObject({ kind: 'event', event: 'card_done', workflowKey: 'code' });
    expect(body.action).toMatchObject({
      kind: 'create_card',
      ratePerHour: 3,
      template: { title: 'Follow-up', start: 'draft', mapping: { title: '{card.ref}' } },
    });
  });

  it('a member can only choose drafts', async () => {
    role = 'member';
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Release notes');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    await user.click(within(wizard).getByTestId('tile-intake_ticket'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(within(wizard).getByTestId('tile-create_card'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.selectOptions(within(wizard).getByLabelText('Project'), 'WEB Web');
    const options = await within(wizard).findByTestId('automation-card-options');
    const start = within(options).getByLabelText('The card starts as');
    expect(start).toBeDisabled();
    expect(within(start).queryByRole('option', { name: /Queued/ })).toBeNull();
  });
});

describe('the old Schedules address and the new name', () => {
  it('/schedules goes to /automations', async () => {
    const flat = (rs: Array<{ path?: string; element?: unknown; children?: unknown[] }>): typeof rs =>
      rs.flatMap((r) => [r, ...flat((r.children ?? []) as typeof rs)]);
    const old = flat(routes as never).find((r) => r.path === '/schedules');
    const next = flat(routes as never).find((r) => r.path === '/automations');
    expect(old).toBeDefined();
    expect(next).toBeDefined();
    render(
      <MemoryRouter initialEntries={['/schedules']}>
        <Routes>
          <Route path="/schedules" element={old?.element as never} />
          <Route path="/automations" element={<p>landed on automations</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('landed on automations')).toBeInTheDocument();
  });

  it('the sidebar says Automations and links to the new address', () => {
    const items = buildNav({ projectKey: 'WEB', canManage: true }).sections.flatMap((s) => s.items);
    const item = items.find((i) => i.id === 'schedules');
    expect(item).toMatchObject({ label: 'Automations', to: '/automations' });
  });

  it('the old help article address still opens the renamed article, with its anchors', () => {
    const article = articleBySlug('schedules-and-integrations');
    expect(article?.slug).toBe('automations-and-integrations');
    expect(article?.title).toBe('Automations and integrations');
    const ids = article?.headings.map((h) => h.id) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining(['schedules', 'triggers', 'actions', 'integrations', 'history']),
    );
  });
});

describe('"Starts automatically when" in the workflow builder', () => {
  const wrapSection = (key: string) =>
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <AutoStartSection workflowKey={key} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('lists only the automations of this workflow', async () => {
    wrapSection('code');
    const row = await screen.findByTestId('autostart-Release notes');
    expect(row).toHaveTextContent('When a card of a workflow is done');
    expect(screen.queryByTestId('autostart-Elsewhere')).toBeNull();
    expect(screen.queryByTestId('autostart-Triage')).toBeNull();
  });

  it('says so when nothing starts from the workflow', async () => {
    wrapSection('docs');
    expect(await screen.findByTestId('autostart-empty')).toBeInTheDocument();
  });

  it('adds a trigger with the workflow already chosen; a workflow that is not active cannot yet', async () => {
    const user = userEvent.setup();
    wrapSection('code');
    await waitFor(() => expect(screen.getByTestId('autostart-add')).toBeEnabled());
    await user.click(screen.getByTestId('autostart-add'));
    const wizard = await screen.findByTestId('schedule-wizard');
    expect(within(wizard).getByLabelText('Workflow')).toHaveValue('code');
    expect(within(wizard).getByLabelText('Event')).toHaveValue('card_done');
  });

  it('is disabled for a draft that is not an active workflow', async () => {
    wrapSection('not-yet');
    await screen.findByTestId('autostart-empty');
    expect(screen.getByTestId('autostart-add')).toBeDisabled();
    expect(screen.getByText(/once this workflow is approved/)).toBeInTheDocument();
  });

  it('the builder shows it only when asked', async () => {
    const def = instantiateTemplate('simple-review', { key: 'simple-review' }) as WorkflowDefinitionInput;
    const model: BuilderModel = syncKey(fromDefinition(def, { freeze: false }), new Set());
    const props = { model, onChange: () => {}, roles: [], departments: [] };
    const mount = (autoStart: boolean) =>
      render(
        <QueryClientProvider client={client()}>
          <MemoryRouter>
            <WorkflowBuilder {...props} autoStart={autoStart} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    const off = mount(false);
    expect(screen.queryByTestId('autostart')).toBeNull();
    off.unmount();
    mount(true);
    expect(await screen.findByTestId('autostart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Starts automatically when/ })).toBeInTheDocument();
  });
});
