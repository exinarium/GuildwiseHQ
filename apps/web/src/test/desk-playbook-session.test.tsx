import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem } from '../pages/Desk.tsx';

// An agent started a playbook as a guided session: the notice on the manager's desk links to it.
afterEach(() => vi.unstubAllGlobals());
const THREAD = '0192f3a0-0000-7000-8000-0000000000d9';
const item = {
  id: '0192f3a0-0000-7000-8000-000000000078',
  kind: 'alert',
  subkind: 'playbook_input_needed',
  status: 'open',
  routedTo: 'manager',
  title: 'Bea started "PRD": your answers are needed',
  body: 'The facilitator asks you questions on the session page.',
  doing: null,
  options: [],
  recommendation: null,
  blocking: false,
  pinned: false,
  urgent: false,
  affectedCardIds: [],
  affectedCount: 0,
  askedBy: { kind: 'agent', agentId: '0192f3a0-0000-7000-8000-0000000000a1', agentName: 'Bea', role: 'ba' },
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
  data: { threadId: THREAD },
} as unknown as DeskItemDto;

describe('the desk notice of a playbook session an agent started', () => {
  it('links to the session', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <DeskItem item={item} bare />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('open-playbook-session')).toHaveAttribute('href', `/discovery/${THREAD}`);
  });
});
