import type { DeskItemDto, JourneyDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceWaitPanel } from '../components/journeys/InstanceWaitPanel.tsx';
import { StepSettings } from '../components/journeys/StepSettings.tsx';
import { JourneyDeskItem } from '../components/JourneyDeskItem.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { addStep, durationError, relativeTime, timeoutOf, waitForOf } from '../lib/journeys.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const W1 = '0192f3a0-0000-7000-8000-0000000000a1';
const I1 = '0192f3a0-0000-7000-8000-0000000000b1';

let posts: Array<{ url: string; body: unknown }>;
let waits: unknown;

beforeEach(() => {
  posts = [];
  waits = { waits: [], calls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return json({ ok: true });
      }
      if (url.endsWith('/waits')) return json(waits);
      if (url.startsWith('/api/forms')) return json({ forms: [{ id: '0192f3a0-0000-7000-8000-0000000000f1', title: 'Rental application' }] });
      if (url.startsWith('/api/workstations')) return json({ workstations: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const desk = (subkind: string): DeskItemDto =>
  ({ id: 'd1', kind: 'question', subkind, status: 'open', canAnswer: true, data: { waitId: W1, instanceId: I1 } }) as unknown as DeskItemDto;

const def = (): JourneyDefinition =>
  ({
    name: 'J',
    description: '',
    recordType: 'client',
    firstStepId: 'w',
    steps: [
      { kind: 'wait', id: 'w', label: 'Documents' },
      { kind: 'gate', id: 'g', label: 'Approval' },
      { kind: 'workflow', id: 'a', label: 'Lease', workflowKey: null, fieldsIn: [] },
    ],
    handoffs: [],
  }) as unknown as JourneyDefinition;

describe('journey desk items', () => {
  it('approves a gate on the desk (AC: a gate shows on the desk and is decided there)', async () => {
    wrap(<JourneyDeskItem item={desk('journey_gate')} />);
    await userEvent.click(screen.getByTestId('journey-gate-approve'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: `/api/journey-gates/${W1}/decide`, body: { decision: 'approved' } });
  });
  it('rejects a gate only with a note', async () => {
    wrap(<JourneyDeskItem item={desk('journey_gate')} />);
    expect(screen.getByTestId('journey-gate-reject')).toBeDisabled();
    await userEvent.type(screen.getByTestId('journey-gate-note'), 'Income not proven');
    await userEvent.click(screen.getByTestId('journey-gate-reject'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ decision: 'rejected', note: 'Income not proven' });
  });
  it('lets the desk extend, continue or cancel a wait that timed out', async () => {
    wrap(<JourneyDeskItem item={desk('journey_wait_escalated')} />);
    await userEvent.click(screen.getByTestId('journey-wait-extend'));
    await userEvent.click(screen.getByTestId('journey-wait-continue'));
    await userEvent.click(screen.getByTestId('journey-wait-cancel'));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map((p) => p.url)).toEqual([
      `/api/journey-waits/${W1}/extend`,
      `/api/journey-waits/${W1}/continue`,
      `/api/journey-waits/${W1}/cancel`,
    ]);
    expect(posts[0]!.body).toEqual({ duration: { amount: 1, unit: 'days' } });
  });
  it('offers a new client link on a link task', async () => {
    wrap(<JourneyDeskItem item={desk('journey_wait_link')} />);
    expect(screen.getByText('Open the journey')).toHaveAttribute('href', `/journeys/instances/${I1}`);
    await userEvent.click(screen.getByTestId('journey-link-resend'));
    await waitFor(() => expect(posts[0]?.url).toBe(`/api/journey-waits/${W1}/resend-link`));
  });
});

describe('instance wait panel', () => {
  const wait = (over: Record<string, unknown> = {}) => ({
    id: W1, visit: 1, stepId: 'w', kind: 'form', status: 'open', startedAt: '2026-11-01T09:00:00Z',
    deadlineAt: '2099-11-04T09:00:00Z', nextFireAt: null, remindersSent: 1, remindersMax: 3,
    linkUrl: 'https://x.test/f/abc', linkExpiresAt: null, fellBack: false, resolution: null, resolvedAt: null,
    events: [{ at: '2026-11-02T09:00:00Z', type: 'JourneyWaitReminded', text: 'Reminder 1 of 3 recorded.' }],
    ...over,
  });
  it('shows the wait with its deadline, reminders, link and events (AC: the instance shows the wait and its deadline)', async () => {
    waits = { waits: [wait()], calls: [] };
    wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    expect(await screen.findByTestId('wait-deadline')).toHaveTextContent(/Deadline .*Reminders 1 of 3/);
    expect(screen.getByTestId('wait-link')).toHaveTextContent('https://x.test/f/abc');
    expect(screen.getByTestId('wait-events')).toHaveTextContent('Reminder 1 of 3 recorded.');
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });
  it('shows a timed out wait without actions and a failed call with its error', async () => {
    waits = {
      waits: [wait({ status: 'timed_out', linkUrl: null })],
      calls: [{ id: 'c1', visit: 2, stepId: 'g', status: 'failed', attempts: 5, nextAttemptAt: null, lastHttpStatus: 500, lastError: 'Server answered 500', finishedAt: '2026-11-03T09:00:00Z' }],
    };
    wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    expect(await screen.findByText('Timed out')).toBeInTheDocument();
    expect(screen.queryByText('Continue now')).toBeNull();
    expect(screen.getByTestId('call-c1')).toHaveTextContent('Server answered 500');
    expect(screen.getByTestId('call-c1')).toHaveTextContent('5 attempts');
  });
  it('lets a person decide an open gate from the instance', async () => {
    waits = { waits: [wait({ kind: 'gate', stepId: 'g', linkUrl: null })], calls: [] };
    wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts[0]?.url).toBe(`/api/journey-gates/${W1}/decide`));
  });
});

describe('step settings', () => {
  it('picks what a wait waits for, its duration and its timeout action', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const d = addStep(def(), 'wait', 'Extra');
    const step = d.steps.at(-1)!;
    wrap(<StepSettings def={d} step={step} onStep={(p) => patches.push(p)} />);
    await userEvent.selectOptions(screen.getByLabelText('Wait for'), 'form');
    expect(patches.at(-1)).toEqual({ waitFor: waitForOf('form') });
    await userEvent.selectOptions(screen.getByLabelText('When time runs out'), 'goto');
    expect(patches.at(-1)).toEqual({ onTimeout: { action: 'goto', stepId: 'w' } });
    await userEvent.type(screen.getByLabelText('Wait at most'), '3');
    expect(patches.at(-1)).toMatchObject({ duration: { amount: 3, unit: 'days' } });
  });
  it('picks the approver of a gate', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const d = addStep(def(), 'gate', 'Extra');
    wrap(<StepSettings def={d} step={d.steps.at(-1)!} onStep={(p) => patches.push(p)} />);
    await userEvent.selectOptions(screen.getByLabelText('Who decides'), 'role:admin');
    expect(patches.at(-1)).toEqual({ approver: { kind: 'org_role', role: 'admin' } });
  });
  it('edits the URL of a webhook call', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const d = addStep(def(), 'webhook_call', 'Call');
    wrap(<StepSettings def={d} step={d.steps.at(-1)!} onStep={(p) => patches.push(p)} />);
    await userEvent.type(screen.getByLabelText('URL'), 'h');
    expect(patches.at(-1)).toEqual({ url: 'h' });
  });
});

describe('journey wait helpers', () => {
  it('builds a fresh wait and timeout config', () => {
    expect(waitForOf('duration')).toEqual({ kind: 'duration' });
    expect(timeoutOf('remind')).toMatchObject({ action: 'remind', maxReminders: 3 });
    expect(timeoutOf('cancel')).toEqual({ action: 'cancel' });
  });
  it('refuses durations the server refuses', () => {
    expect(durationError({ amount: 1, unit: 'minutes' })).not.toBeNull();
    expect(durationError({ amount: 2, unit: 'days' })).toBeNull();
    expect(durationError({ amount: 400, unit: 'days' })).not.toBeNull();
    expect(durationError(undefined)).not.toBeNull();
  });
  it('says when a deadline is', () => {
    const now = new Date('2026-11-04T09:00:00Z');
    expect(relativeTime('2026-11-06T09:00:00Z', now)).toBe('in 2 days');
    expect(relativeTime('2026-11-04T06:00:00Z', now)).toBe('3 hours ago');
  });
});
