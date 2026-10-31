import type { BriefPlaybookDto, ProjectDto, ScheduleDto } from '@aom/shared';
import { BRIEF_PLAYBOOKS } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Automations } from '../pages/Automations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const project = {
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
} as ProjectDto;

const dto = (key: 'morning_plan' | 'weekly_owner_brief', scheduleId: string | null): BriefPlaybookDto => {
  const p = BRIEF_PLAYBOOKS[key];
  return {
    key,
    name: p.name,
    description: p.description,
    cadence: p.cadence,
    defaultTime: p.defaultTime,
    defaultWeekday: p.defaultWeekday ?? null,
    defaultOwnerRole: p.defaultOwnerRole,
    maxWords: p.maxWords,
    scheduleId,
  };
};
const installedSchedule = {
  id: ID(20),
  projectId: project.id,
  projectKey: 'WEB',
  projectName: 'Web',
  name: 'Morning plan',
  kind: 'card',
  trigger: { kind: 'cron', cron: '30 8 * * 1-5', timezone: 'Africa/Johannesburg' },
  action: {
    kind: 'create_card',
    projectId: project.id,
    template: {
      title: 'Morning plan {date}',
      cardType: 'report',
      workflowKey: 'business-brief-personal-assistant',
      fields: { maxWords: 90 },
    },
    deliverOutput: { destinations: [{ kind: 'email', to: ['a@b.co'], subject: '' }] },
    playbook: { key: 'morning_plan', version: 1 },
  },
  cron: '30 8 * * 1-5',
  timezone: 'Africa/Johannesburg',
  enabled: true,
  nextFireAt: '2026-11-03T06:30:00.000Z',
  lastFiredAt: null,
  lastCardId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  canEdit: true,
} as unknown as ScheduleDto;

let mode: 'dev' | 'business';
let role: string;
let installed: boolean;
let calls: Array<{ method: string; url: string; body: unknown }>;

beforeEach(() => {
  mode = 'business';
  role = 'owner';
  installed = false;
  calls = [];
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
            mode,
            features: {},
          },
        });
      if (url.startsWith('/api/brief-playbooks') && method === 'GET')
        return json({
          playbooks: [dto('morning_plan', installed ? ID(20) : null), dto('weekly_owner_brief', null)],
        });
      if (url.startsWith('/api/brief-playbooks')) return json({ scheduleId: ID(20) }, 201);
      if (url.startsWith('/api/schedules') && method === 'GET')
        return json({ schedules: installed ? [installedSchedule] : [], system: [] });
      if (url.startsWith('/api/projects') && method === 'GET') return json({ projects: [project] });
      if (url.startsWith('/api/workstations')) return json({ workstations: [] });
      if (url === `/api/schedules/${ID(20)}` && method === 'DELETE') return json({ ok: true });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Automations />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Brief playbooks on the Automations page', () => {
  it('are not shown in a dev organization, and nothing is fetched', async () => {
    mode = 'dev';
    wrap();
    await screen.findByRole('heading', { name: 'Automations', level: 1 });
    await screen.findByTestId('schedules-empty');
    expect(screen.queryByTestId('brief-playbooks')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('are not shown to a member of a business organization', async () => {
    role = 'member';
    wrap();
    await screen.findByTestId('schedules-empty');
    expect(screen.queryByTestId('brief-playbooks')).toBeNull();
  });

  it('show both playbooks to a manager of a business organization', async () => {
    wrap();
    expect(await screen.findByTestId('playbook-morning_plan')).toHaveTextContent('Morning plan');
    expect(screen.getByTestId('playbook-weekly_owner_brief')).toHaveTextContent('Weekly owner brief');
  });

  it('install in one request with the chosen time, role, cap and destination', async () => {
    wrap();
    const user = userEvent.setup();
    const tile = await screen.findByTestId('playbook-morning_plan');
    await user.click(within(tile).getByTestId('playbook-install'));
    const dialog = await screen.findByTestId('playbook-dialog');
    await user.clear(within(dialog).getByLabelText('Time'));
    await user.type(within(dialog).getByLabelText('Time'), '08:15');
    await user.selectOptions(within(dialog).getByLabelText('Written by'), 'billing_clerk');
    await user.clear(within(dialog).getByLabelText('Word cap'));
    await user.type(within(dialog).getByLabelText('Word cap'), '120');
    // a destination is required
    await user.click(screen.getByTestId('playbook-save'));
    expect(await screen.findByText(/add at least one destination/i)).toBeInTheDocument();
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: /add a destination/i }));
    await user.type(within(dialog).getByRole('textbox', { name: /to/i }), 'boss@example.com');
    await user.click(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/brief-playbooks/morning_plan/install' });
    expect(calls[0]?.body).toMatchObject({
      time: '08:15',
      ownerRole: 'billing_clerk',
      maxWords: 120,
      destinations: [{ kind: 'email', to: ['boss@example.com'] }],
    });
  });

  it('edit an installed playbook with its current time, and save through the playbook route', async () => {
    installed = true;
    wrap();
    const user = userEvent.setup();
    const tile = await screen.findByTestId('playbook-morning_plan');
    expect(await within(tile).findByTestId('playbook-when')).toBeInTheDocument();
    await user.click(within(tile).getByTestId('playbook-edit'));
    const dialog = await screen.findByTestId('playbook-dialog');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('08:30');
    expect(within(dialog).getByLabelText('Word cap')).toHaveValue(90);
    await user.clear(within(dialog).getByLabelText('Time'));
    await user.type(within(dialog).getByLabelText('Time'), '09:00');
    await user.click(screen.getByTestId('playbook-save'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `/api/brief-playbooks/schedules/${ID(20)}` });
    expect(calls[0]?.body).toMatchObject({ time: '09:00', maxWords: 90 });
  });

  it('remove an installed playbook through the schedule route after a confirmation', async () => {
    installed = true;
    wrap();
    const user = userEvent.setup();
    const tile = await screen.findByTestId('playbook-morning_plan');
    await user.click(await within(tile).findByTestId('playbook-remove'));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/schedules/${ID(20)}`)).toBe(true),
    );
  });

  it('an installed playbook edits in its own dialog from the schedule list too, and carries a Playbook badge', async () => {
    installed = true;
    wrap();
    const row = await screen.findByTestId('schedule-Morning plan');
    expect(within(row).getByText('Playbook')).toBeInTheDocument();
  });
});
