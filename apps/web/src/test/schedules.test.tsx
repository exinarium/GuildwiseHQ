import {
  codeWorkflowV1,
  type ProjectDto,
  type ScheduleDto,
  type ScheduleRunDto,
  type SystemScheduleDto,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScheduleRequest, describeAction, describeTrigger, emptyWizard } from '../lib/schedules.ts';
import { Automations } from '../pages/Automations.tsx';

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
  projectKey: null,
  projectName: null,
  nextFireAt: null,
  lastFiredAt: null,
  lastCardId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ownerName: 'Pieter',
  canEdit: true,
};
const baSchedule: ScheduleDto = {
  ...base,
  id: ID(20),
  projectId: null,
  name: 'Friday review',
  kind: 'ba_task',
  cron: '0 16 * * 5',
  timezone: 'Africa/Johannesburg',
  trigger: { kind: 'cron', cron: '0 16 * * 5', timezone: 'Africa/Johannesburg' },
  action: { kind: 'ba_task', projectId: null, prompt: 'List what is open', deliver: 'desk_notice' },
  enabled: true,
  nextFireAt: '2026-10-09T14:00:00.000Z',
  orgLevel: true,
  lastStatus: 'ok',
  lastSummary: 'Asked the BA',
};
const hook: ScheduleDto = {
  ...base,
  id: ID(21),
  projectId: project.id,
  projectKey: 'WEB',
  projectName: 'Web',
  name: 'Tell Slack',
  kind: 'integration',
  cron: null,
  timezone: null,
  trigger: { kind: 'event', event: 'card_finalized' },
  action: {
    kind: 'integration',
    integration: 'webhook',
    operation: 'post',
    url: 'https://hooks.slack.com/services/T/B/X',
    format: 'slack',
    message: '{ref} is done',
    projectId: project.id,
  },
  enabled: true,
  orgLevel: false,
  hasWebhookSecret: true,
};
const system: SystemScheduleDto[] = [
  {
    id: 'system:hygiene:1',
    kind: 'hygiene',
    name: 'Repository hygiene on Desk',
    description: 'Tidies.',
    when: 'Every 24 hours',
    lastRunAt: null,
    nextRunAt: '2026-10-08T00:00:00.000Z',
    configureAt: '/workstations',
  },
  {
    id: 'system:floor_report:1',
    kind: 'floor_report',
    name: 'CEO daily report',
    description: 'One report a day.',
    when: 'Daily at 08:00 (UTC)',
    lastRunAt: null,
    nextRunAt: '2026-10-08T08:00:00.000Z',
    configureAt: '/settings',
  },
];
const run = (over: Partial<ScheduleRunDto>): ScheduleRunDto => ({
  id: ID(90),
  scheduleId: hook.id,
  trigger: 'event',
  label: 'Card finalized: card WEB-3 finalized',
  status: 'ok',
  summary: 'Webhook to hooks.slack.com',
  error: null,
  result: null,
  delivery: { kind: 'webhook', target: 'https://hooks.slack.com/services/T/B/X' },
  attempts: 1,
  nextAttemptAt: null,
  startedAt: '2026-10-07T10:00:00.000Z',
  finishedAt: '2026-10-07T10:00:01.000Z',
  attemptLog: [
    { attempt: 1, at: '2026-10-07T10:00:01.000Z', ok: true, httpStatus: 200, error: null, durationMs: 41 },
  ],
  ...over,
});

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
let role: 'owner' | 'member' = 'owner';
let runs: ScheduleRunDto[] = [];
let created: Record<string, unknown> | null = null;

beforeEach(() => {
  calls = [];
  runs = [];
  created = null;
  role = 'owner';
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
      if (url.startsWith('/api/schedules') && method === 'GET' && url.includes('/runs'))
        return json({ runs });
      if (url.startsWith('/api/schedules') && method === 'GET')
        return json({ schedules: [baSchedule, hook], system });
      if (url.startsWith('/api/projects') && method === 'GET') return json({ projects: [project] });
      if (url.startsWith('/api/workstations')) return json({ workstations: [] });
      if (url.startsWith('/api/workflows'))
        return json({
          workflows: [{ id: ID(50), orgId: null, status: 'active', definition: codeWorkflowV1 }],
        });
      if (url === '/api/schedules' && method === 'POST')
        return json({ ...hook, id: ID(30), webhookSecret: 'whsec_abc123', ...(created ?? {}) }, 201);
      if (url.endsWith('/test'))
        return json({
          ok: false,
          httpStatus: 500,
          error: 'the endpoint answered 500',
          durationMs: 12,
          runId: ID(91),
        });
      if (url.endsWith('/run'))
        return json({ runId: ID(92), status: 'ok', summary: 'Asked the BA', cardId: null, ref: null }, 201);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Automations />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('describing a schedule', () => {
  it('says when and what in plain words', () => {
    expect(describeTrigger(baSchedule.trigger)).toBe('Fridays at 16:00 (Africa/Johannesburg)');
    expect(describeTrigger(hook.trigger)).toBe('When a card is finalized');
    expect(describeTrigger({ kind: 'manual' })).toBe('Only when run by hand');
    expect(describeAction(hook.action)).toBe('POST to hooks.slack.com');
    expect(describeAction(baSchedule.action)).toBe('Ask the CEO: List what is open');
  });
});

describe('building the request', () => {
  const ctx = { workflow: undefined, mockUi: false, myEmail: 'p@x.test' };
  it('a manual trigger with a BA task', () => {
    const s = emptyWizard({ name: 'Weekly', triggerKind: 'manual', tile: 'ba_task', prompt: 'Summarise' });
    expect(buildScheduleRequest(s, ctx).body).toEqual({
      name: 'Weekly',
      enabled: true,
      trigger: { kind: 'manual' },
      action: { kind: 'ba_task', projectId: null, prompt: 'Summarise', deliver: 'desk_notice' },
    });
  });
  it('an event trigger with a project filter and a webhook', () => {
    const s = emptyWizard({
      name: 'Hook',
      triggerKind: 'event',
      event: 'phase_completed',
      eventProjectId: project.id,
      tile: 'webhook',
      url: 'https://x.test/h',
      format: 'teams',
      projectId: project.id,
    });
    expect(buildScheduleRequest(s, ctx).body).toMatchObject({
      trigger: { kind: 'event', event: 'phase_completed', projectId: project.id },
      action: {
        kind: 'integration',
        integration: 'webhook',
        url: 'https://x.test/h',
        format: 'teams',
        projectId: project.id,
      },
    });
  });
  it('a cron preset and an e-mail digest default to my address', () => {
    const s = emptyWizard({
      name: 'Morning',
      preset: 'daily-0700',
      timezone: 'Africa/Johannesburg',
      tile: 'email',
    });
    const r = buildScheduleRequest(s, ctx);
    expect(r.body).toMatchObject({
      trigger: { kind: 'cron', cron: '0 7 * * *', timezone: 'Africa/Johannesburg' },
      action: { integration: 'email', to: ['p@x.test'], digest: 'floor_report' },
    });
    expect(r.body?.action).not.toHaveProperty('projectId');
  });
  it('reports what is missing', () => {
    const r = buildScheduleRequest(emptyWizard({ tile: 'webhook', url: 'nope' }), ctx);
    expect(r.body).toBeNull();
    expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(['name', 'url']));
    expect(buildScheduleRequest(emptyWizard({ name: 'x', tile: 'github' }), ctx).errors).toMatchObject({
      workstationId: expect.any(String),
      query: expect.any(String),
    });
  });
});

describe('Automations page', () => {
  it('groups schedules by project and shows the system jobs read-only', async () => {
    wrap();
    const ba = await screen.findByTestId('schedule-Friday review');
    expect(within(ba).getByTestId('schedule-when')).toHaveTextContent(
      'Fridays at 16:00 (Africa/Johannesburg)',
    );
    expect(within(ba).getByText('Organization')).toBeInTheDocument();
    expect(within(ba).getByTestId('schedule-action')).toHaveTextContent('Ask the CEO: List what is open');
    expect(within(ba).getByText('Last run done')).toBeInTheDocument();
    const slack = screen.getByTestId('schedule-Tell Slack');
    expect(within(slack).getByTestId('schedule-next')).toHaveTextContent('on the event');
    expect(screen.getByRole('region', { name: 'Whole organization' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'WEB Web' })).toBeInTheDocument();
    const sys = screen.getByTestId('system-schedules');
    expect(within(sys).getByText('CEO daily report')).toBeInTheDocument();
    expect(within(sys).getByText('Repository hygiene on Desk')).toBeInTheDocument();
    expect(within(sys).queryByRole('button')).toBeNull();
    expect(within(sys).getAllByRole('link', { name: 'Configure' })).toHaveLength(2);
  });

  it('runs a schedule now and tells what happened', async () => {
    wrap();
    const row = await screen.findByTestId('schedule-Friday review');
    await userEvent.setup().click(within(row).getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/schedules/${baSchedule.id}/run` });
    expect(await within(row).findByTestId('run-result')).toHaveTextContent('Asked the BA');
  });

  it('a webhook has a test button and a delivery log with every try', async () => {
    runs = [
      run({
        id: ID(95),
        status: 'pending',
        attempts: 1,
        nextAttemptAt: '2026-10-07T10:01:00.000Z',
        error: 'the endpoint answered 503',
        attemptLog: [
          {
            attempt: 1,
            at: '2026-10-07T10:00:01.000Z',
            ok: false,
            httpStatus: 503,
            error: 'the endpoint answered 503',
            durationMs: 20,
          },
        ],
      }),
      run({}),
    ];
    wrap();
    const row = await screen.findByTestId('schedule-Tell Slack');
    const user = userEvent.setup();
    await user.click(within(row).getByTestId('test-delivery'));
    expect(await within(row).findByTestId('test-result')).toHaveTextContent('Test failed (HTTP 500)');
    await user.click(within(row).getByTestId('toggle-history'));
    const rows = await within(row).findAllByTestId('run-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Waiting')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/Next try/)).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByTestId('run-error')).toHaveTextContent('503');
    expect(within(rows[1] as HTMLElement).getByText('Done')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/HTTP 200/)).toBeInTheDocument();
  });

  it('creates a webhook schedule through the wizard and shows the secret once', async () => {
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Friday review');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    await user.click(within(wizard).getByTestId('tile-event'));
    await user.selectOptions(within(wizard).getByLabelText('Event'), 'A phase is completed');
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(within(wizard).getByTestId('tile-webhook'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(within(wizard).getByLabelText('Name'), 'Phase to Slack');
    await user.type(within(wizard).getByLabelText('URL'), 'https://hooks.slack.com/services/T/B/Y');
    await user.selectOptions(within(wizard).getByLabelText('Format'), 'Slack incoming webhook');
    await user.selectOptions(within(wizard).getByLabelText(/Project/), 'WEB Web');
    await user.click(screen.getByTestId('wizard-save'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/schedules')).toBe(true),
    );
    const body = calls.find((c) => c.url === '/api/schedules')?.body as Record<string, any>;
    expect(body).toMatchObject({
      name: 'Phase to Slack',
      enabled: true,
      trigger: { kind: 'event', event: 'phase_completed' },
      action: { kind: 'integration', integration: 'webhook', format: 'slack', projectId: project.id },
    });
    expect(await screen.findByTestId('secret-value')).toHaveTextContent('whsec_abc123');
    await user.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByTestId('secret-value')).toBeNull();
  });

  it('creates a card schedule from a template on a cron preset', async () => {
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Friday review');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    await user.selectOptions(within(wizard).getByLabelText('Runs'), 'Weekdays at 18:00');
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(within(wizard).getByTestId('tile-create_card'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(within(wizard).getByLabelText('Name'), 'Evening sweep');
    await user.selectOptions(within(wizard).getByLabelText('Project'), 'WEB Web');
    const template = await within(wizard).findByTestId('card-template');
    // a scheduled card has no repository or completion action: those belong to a real card
    expect(within(template).queryByLabelText('Repository')).toBeNull();
    await user.type(within(template).getByLabelText('Title'), 'Sweep the backlog');
    await user.click(screen.getByTestId('wizard-save'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/schedules')).toBe(true));
    const body = calls.find((c) => c.url === '/api/schedules')?.body as Record<string, any>;
    expect(body).toMatchObject({
      name: 'Evening sweep',
      trigger: { kind: 'cron', cron: '0 18 * * 1-5' },
      action: {
        kind: 'create_card',
        projectId: project.id,
        template: { title: 'Sweep the backlog', cardType: 'feature' },
      },
    });
  });

  it('an organization-level action is not saved for a member who is not an Owner or Admin', async () => {
    role = 'member';
    wrap();
    const user = userEvent.setup();
    await screen.findByTestId('schedule-Friday review');
    await user.click(screen.getByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    await user.click(within(wizard).getByTestId('tile-manual'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(within(wizard).getByTestId('tile-ba_task'));
    await user.click(screen.getByTestId('wizard-next'));
    await user.type(within(wizard).getByLabelText('Name'), 'Mine');
    await user.type(within(wizard).getByLabelText('Instructions for the BA'), 'Do it');
    expect(within(wizard).getByTestId('org-level-note')).toHaveTextContent('only the Owner and Admins');
    expect(screen.getByTestId('wizard-save')).toBeDisabled();
    await user.selectOptions(within(wizard).getByLabelText(/Project/), 'WEB Web');
    expect(screen.getByTestId('wizard-save')).toBeEnabled();
  });

  it('shows an empty state with a call to action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/schedules')) return json({ schedules: [], system: [] });
        if (url.startsWith('/api/projects')) return json({ projects: [project] });
        if (url.startsWith('/api/auth/me'))
          return json({
            user: { id: ID(900), displayName: 'P', email: 'p@x.test' },
            isAdmin: true,
            visibleProjectIds: [],
          });
        return json({});
      }),
    );
    wrap();
    expect(await screen.findByTestId('schedules-empty')).toHaveTextContent('No automations yet');
  });
});
