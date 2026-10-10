import type { MeResponse, SetupChecklist } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupChecklistProvider, SetupHelpCard, SetupWidget } from '../components/setup/SetupChecklist.tsx';

const U = '0192f3a0-0000-7000-8000-000000000001';
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

const me = {
  user: {
    id: U,
    email: 'me@example.test',
    displayName: 'Me',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  },
  account: { kind: 'user' },
  isAdmin: true,
  activeOrg: { id: U, name: 'Acme', role: 'owner', status: 'active' },
  visibleProjectIds: [],
  features: { mockUi: false },
} as unknown as MeResponse;

const step = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  hint: `${title} hint`,
  done: false,
  actionable: true,
  link: `/go/${id}`,
  ...over,
});
let checklist: SetupChecklist;
const puts: unknown[] = [];

const base = (): SetupChecklist => ({
  steps: [
    step('project', 'Create your first project', { done: true, link: null }),
    step('repository', 'Add its repository', { actionable: false, link: null }),
    step('workstation', 'Pair a workstation'),
    step('team', 'Hire your team', { missing: ['reviewer', 'tester'] }),
    step('ba', 'Talk to the business analyst'),
  ] as SetupChecklist['steps'],
  doneCount: 1,
  complete: false,
  dismissed: false,
});

beforeEach(() => {
  puts.length = 0;
  checklist = base();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/me') return json(me);
      if (url === '/api/setup-checklist' && init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        checklist = { ...checklist, dismissed: body.dismissed };
        return json(checklist);
      }
      if (url === '/api/setup-checklist') return json(checklist);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SetupChecklistProvider>
          <SetupWidget />
          <SetupHelpCard />
        </SetupChecklistProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('setup checklist', () => {
  it('shows progress in the sidebar button and the steps with their links in the list', async () => {
    mount();
    expect(await screen.findByTestId('setup-widget-count')).toHaveTextContent('1/5');
    await userEvent.click(screen.getByTestId('setup-widget'));
    expect(screen.getByTestId('setup-step-project')).toHaveAttribute('data-done', 'true');
    expect(screen.queryByTestId('setup-go-project')).toBeNull();
    expect(screen.getByTestId('setup-go-workstation')).toHaveAttribute('href', '/go/workstation');
    expect(screen.getByTestId('setup-step-team')).toHaveTextContent('Still to hire: reviewer, tester.');
    // a step this user may not do is read-only: no link, and it says who does it
    expect(screen.queryByTestId('setup-go-repository')).toBeNull();
    expect(screen.getByTestId('setup-readonly-repository')).toBeInTheDocument();
  });

  it('can be hidden, and comes back from the Help card', async () => {
    mount();
    await userEvent.click(await screen.findByTestId('setup-widget'));
    await userEvent.click(screen.getByTestId('setup-hide'));
    await waitFor(() => expect(screen.queryByTestId('setup-widget')).toBeNull());
    expect(puts).toEqual([{ dismissed: true }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Show the checklist' }));
    await waitFor(() => expect(puts).toEqual([{ dismissed: true }, { dismissed: false }]));
    expect(await screen.findByTestId('setup-widget')).toBeInTheDocument();
    expect(screen.getByTestId('setup-checklist')).toBeInTheDocument();
  });

  it('disappears from the sidebar once every step is done, and Help says so', async () => {
    checklist = {
      ...base(),
      steps: base().steps.map((s) => ({ ...s, done: true, link: null })),
      doneCount: 5,
      complete: true,
    };
    mount();
    expect(await screen.findByTestId('help-setup')).toHaveTextContent('All five steps are done.');
    expect(screen.queryByTestId('setup-widget')).toBeNull();
  });
});
