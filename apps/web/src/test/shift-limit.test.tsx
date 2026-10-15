import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Workstations } from '../pages/Workstations.tsx';

// Backlog #76: the shift limit control on the Workstations page.

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const shifts = (over: Record<string, unknown> = {}) => ({
  running: 1,
  limit: 4,
  setting: null,
  unlimited: false,
  platformCap: 16,
  runnerLimit: 4,
  supported: true,
  ...over,
});
const ws = (name: string, s: unknown) => ({
  id: ID(10),
  userId: ID(1),
  name,
  platform: 'linux',
  hostname: `${name}.lan`,
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  shifts: s,
});

let current: unknown;
const puts: unknown[] = [];
beforeEach(() => {
  puts.length = 0;
  current = shifts();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'admin',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: false,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (method === 'PUT' && url === `/api/workstations/${ID(10)}/shift-limit`) {
        puts.push(JSON.parse(String(init.body)));
        return json({});
      }
      if (url === '/api/workstations') return json({ workstations: [ws('Desk', current)] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <Workstations />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  const desk = await screen.findByTestId('workstation-Desk');
  await user.click(within(desk).getByRole('button', { name: 'Show details of Desk' }));
  return { user, form: await within(desk).findByRole('form', { name: 'Shift limit of Desk' }), desk };
};

describe('shift limit control', () => {
  it('shows the running count and the limit, with the runner value selected by default', async () => {
    const { form, desk } = await open();
    expect(within(desk).getByTestId('workstation-shifts')).toHaveTextContent('1 of 4');
    expect(within(form).getByLabelText('Shifts at once')).toHaveValue('default');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(form).toHaveTextContent("Runner's own value: 4");
  });

  it('saves a number', async () => {
    const { user, form } = await open();
    await user.selectOptions(within(form).getByLabelText('Shifts at once'), 'number');
    await user.type(within(form).getByLabelText('Number'), '6');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ limit: 6 }]));
  });

  it('refuses a number out of range or not a number', async () => {
    const { user, form } = await open();
    await user.selectOptions(within(form).getByLabelText('Shifts at once'), 'number');
    await user.type(within(form).getByLabelText('Number'), '0');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/whole number from 1 to 10,000/)).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('saves unlimited and says what still limits it', async () => {
    const { user, form } = await open();
    await user.selectOptions(within(form).getByLabelText('Shifts at once'), 'unlimited');
    expect(within(form).getByTestId('shift-limit-unlimited-note')).toHaveTextContent(
      'memory and CPU, and the model usage limit, still apply',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ limit: 'unlimited' }]));
  });

  it('going back to the runner value sends null', async () => {
    current = shifts({ setting: 3, limit: 3 });
    const { user, form } = await open();
    expect(within(form).getByLabelText('Shifts at once')).toHaveValue('number');
    await user.selectOptions(within(form).getByLabelText('Shifts at once'), 'default');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ limit: null }]));
  });

  it('an unlimited workstation reads as unlimited', async () => {
    current = shifts({ setting: 'unlimited', limit: null, unlimited: true, platformCap: null });
    const { form, desk } = await open();
    expect(within(desk).getByTestId('workstation-shifts')).toHaveTextContent('1 (unlimited)');
    expect(within(form).getByTestId('shift-limit-unlimited')).toHaveTextContent('No limit from Guildwise');
    expect(within(form).queryByTestId('shift-limit-capped')).toBeNull();
  });

  it('shows when the platform ceiling is lower than the choice', async () => {
    current = shifts({ setting: 50, limit: 16 });
    const { form, desk } = await open();
    expect(within(desk).getByTestId('workstation-shifts')).toHaveTextContent('1 of 16');
    expect(within(form).getByTestId('shift-limit-capped')).toHaveTextContent(
      'The platform allows at most 16 shifts per workstation, so 16 applies, not 50',
    );
  });

  it('unlimited under a platform ceiling says the ceiling applies', async () => {
    current = shifts({ setting: 'unlimited', limit: 16 });
    const { form } = await open();
    expect(within(form).getByTestId('shift-limit-capped')).toHaveTextContent('so 16 applies, not unlimited');
  });

  it('warns that an old runner keeps its own value', async () => {
    current = shifts({ setting: 8, limit: 8, supported: false });
    const { form } = await open();
    expect(within(form).getByTestId('shift-limit-old-runner')).toHaveTextContent('too old');
  });
});
