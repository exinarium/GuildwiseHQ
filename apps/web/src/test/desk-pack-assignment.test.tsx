import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem } from '../pages/Desk.tsx';

// A pack an admin put on a member's workstation arrives on the member's desk: Allow the pack or Decline.
afterEach(() => vi.unstubAllGlobals());

const item = (): DeskItemDto =>
  ({
    id: '0192f3a0-0000-7000-8000-000000000077',
    kind: 'approval',
    subkind: 'pack_assignment',
    status: 'open',
    routedTo: 'manager',
    title: 'Allow the pack "acme" on Desk?',
    body: 'Olga wants to put the capability pack "acme" on your workstation. Nothing is downloaded until you accept.',
    doing: null,
    options: [],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'user', userId: '0192f3a0-0000-7000-8000-000000000001' },
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

describe('the opt-in for a pack on my workstation, on the desk', () => {
  it('offers Allow the pack and Decline, and sends the answer', async () => {
    const user = userEvent.setup();
    const calls = renderItem();
    expect(screen.getByText(/Nothing is downloaded until you accept/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/resolve'))?.body).toEqual({ resolution: 'rejected' }),
    );
  });

  it('allows the pack with one click', async () => {
    const user = userEvent.setup();
    const calls = renderItem();
    await user.click(screen.getByTestId('desk-approve'));
    expect(screen.getByTestId('desk-approve')).toHaveTextContent('Allow the pack');
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/resolve'))?.body).toEqual({ resolution: 'approved' }),
    );
  });
});
