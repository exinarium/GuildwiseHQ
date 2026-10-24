import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem } from '../pages/Desk.tsx';

// Q69: an agent started a playbook from my chat and it would run on a workstation that is not mine: pick one of mine or decline.
afterEach(() => vi.unstubAllGlobals());

const WS_A = '0192f3a0-0000-7000-8000-0000000000a1';
const WS_B = '0192f3a0-0000-7000-8000-0000000000a2';
const item = (): DeskItemDto =>
  ({
    id: '0192f3a0-0000-7000-8000-000000000088',
    kind: 'approval',
    subkind: 'playbook_workstation',
    status: 'open',
    routedTo: 'manager',
    title: 'Eve wants to start "Brainstorm": which of your workstations should run it?',
    body: 'Eve started the playbook "Brainstorm" from your chat. Pick one of yours to start it there, or decline and nothing starts.',
    doing: null,
    options: [
      { id: WS_A, label: 'Desk' },
      { id: WS_B, label: 'Laptop' },
    ],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'agent', agentId: '0192f3a0-0000-7000-8000-000000000001' },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-10-24T10:00:00.000Z',
  }) as unknown as DeskItemDto;

function renderItem() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <DeskItem item={item()} bare />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe('where an agent-started playbook runs (Q69)', () => {
  it('offers the person’s own workstations and starts it on the one picked', async () => {
    const user = userEvent.setup();
    const calls = renderItem();
    const select = screen.getByLabelText('Workstation to run the playbook on');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Desk', 'Laptop']);
    await user.selectOptions(select, WS_B);
    await user.click(screen.getByTestId('desk-playbook-start'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/resolve'))?.body).toEqual({
        resolution: 'approved',
        workstationId: WS_B,
      }),
    );
  });

  it('declines with one click: nothing is started', async () => {
    const user = userEvent.setup();
    const calls = renderItem();
    await user.click(screen.getByTestId('desk-playbook-decline'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/resolve'))?.body).toEqual({ resolution: 'rejected' }),
    );
    expect(screen.queryByTestId('desk-approve')).toBeNull();
  });
});
