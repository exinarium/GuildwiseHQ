import type { ScheduleDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MappingEditor } from '../components/schedules/MappingEditor.tsx';
import {
  buildScheduleRequest,
  describeTrigger,
  emptyWizard,
  stateFromSchedule,
  TRIGGER_TILES,
  type WizardState,
} from '../lib/schedules.ts';
import { Automations } from '../pages/Automations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const hookSchedule = (over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id: ID(40),
  projectId: ID(10),
  projectKey: 'WEB',
  projectName: 'Web',
  name: 'Monitoring alerts',
  kind: 'card',
  trigger: { kind: 'webhook_in', maxPerHour: 30 },
  action: {
    kind: 'create_card',
    projectId: ID(10),
    template: { title: 'Alert', fields: {}, mapping: { title: '{hook.title}' } },
  },
  cron: null,
  timezone: null,
  enabled: true,
  nextFireAt: null,
  lastFiredAt: null,
  lastCardId: null,
  failCount: 0,
  lastError: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ownerUserId: ID(2),
  ownerName: 'Pieter',
  orgLevel: false,
  canEdit: true,
  hasWebhookSecret: true,
  hookUrl: `/api/hooks/${ID(40)}`,
  ...over,
});

describe('incoming webhook automations: the request', () => {
  const ctx = { workflow: undefined, mockUi: false, myEmail: 'p@x.test' };
  const st = (over: Partial<WizardState>): WizardState =>
    emptyWizard({ name: 'Alerts', tile: 'regression_run', projectId: ID(10), ...over });

  it('is offered as a trigger and described in words', () => {
    expect(TRIGGER_TILES.map((t) => t.id)).toContain('webhook_in');
    expect(describeTrigger({ kind: 'webhook_in' })).toBe('When its web address is called');
    expect(describeTrigger({ kind: 'webhook_in', maxPerHour: 30 })).toContain('at most 30 an hour');
  });

  it('builds the trigger without any secret, with the limit and the Owner choice', () => {
    expect(buildScheduleRequest(st({ triggerKind: 'webhook_in' }), ctx).body?.trigger).toEqual({
      kind: 'webhook_in',
    });
    expect(
      buildScheduleRequest(
        st({ triggerKind: 'webhook_in', hookMaxPerHour: '30', hookAllowQueued: true }),
        ctx,
      ).body?.trigger,
    ).toEqual({ kind: 'webhook_in', maxPerHour: 30, allowQueued: true });
    const bad = buildScheduleRequest(st({ triggerKind: 'webhook_in', hookMaxPerHour: '0' }), ctx);
    expect(bad.body).toBeNull();
    expect(bad.errors.hookMaxPerHour).toBeTruthy();
  });

  it('is read back into the wizard when editing', () => {
    const s = stateFromSchedule(
      hookSchedule({ trigger: { kind: 'webhook_in', maxPerHour: 30, allowQueued: true } }),
    );
    expect(s).toMatchObject({ triggerKind: 'webhook_in', hookMaxPerHour: '30', hookAllowQueued: true });
  });

  it('offers the hook tokens and says the payload is outside content', () => {
    render(<MappingEditor rows={[]} onChange={() => {}} hook />);
    const tokens = screen.getByTestId('mapping-tokens');
    expect(tokens).toHaveTextContent('{hook.title}');
    expect(tokens).toHaveTextContent('{hook.json}');
    expect(tokens).not.toHaveTextContent('{email.subject}');
    expect(screen.getByText(/outside content/)).toBeInTheDocument();
  });
});

describe('incoming webhook automations: the page', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const wrap = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Automations />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };
  const route = (handler: (url: string, init?: RequestInit) => Response | undefined) =>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const r = handler(url, init);
      if (r) return r;
      if (url.includes('/schedules')) return json({ schedules: [hookSchedule()], system: [] });
      if (url.includes('/projects')) return json({ projects: [] });
      return json({});
    });

  it('shows the address without its secret, and the secret and URL once after a new secret', async () => {
    route((url, init) => {
      if (url.endsWith('/rotate-secret') && init?.method === 'POST')
        return json({
          webhookSecret: 'hook_abc',
          hookUrlWithSecret: `https://app.example/api/hooks/${ID(40)}/hook_abc`,
        });
      return undefined;
    });
    const user = userEvent.setup();
    wrap();
    const addr = await screen.findByTestId('hook-url');
    expect(addr).toHaveTextContent(`/api/hooks/${ID(40)}/<secret>`);
    expect(addr).not.toHaveTextContent('hook_');
    await user.click(screen.getByRole('button', { name: /New secret/ }));
    expect(await screen.findByTestId('hook-url-value')).toHaveTextContent(
      `https://app.example/api/hooks/${ID(40)}/hook_abc`,
    );
    await user.click(screen.getByRole('button', { name: /I have saved it/ }));
    await waitFor(() => expect(screen.queryByTestId('hook-url-value')).toBeNull());
  });

  it('switching the secret off calls the server and a revoked hook says so', async () => {
    let revoked = false;
    route((url, init) => {
      if (url.endsWith('/revoke-secret') && init?.method === 'POST') {
        revoked = true;
        return json(hookSchedule({ hasWebhookSecret: false }));
      }
      if (url.includes('/schedules') && revoked)
        return json({ schedules: [hookSchedule({ hasWebhookSecret: false })], system: [] });
      return undefined;
    });
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByTestId('revoke-secret'));
    await waitFor(() => expect(screen.getByTestId('hook-url')).toHaveTextContent('switched off'));
    expect(screen.queryByTestId('revoke-secret')).toBeNull();
  });
});
