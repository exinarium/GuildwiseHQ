import type { DeskItemDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem } from '../pages/Desk.tsx';

// easy-runner-setup: a step waiting on the workstation shows its sentence, the exact command and Copy, once.
afterEach(() => vi.unstubAllGlobals());

const CMD = 'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner setup';
const item = (command = CMD): DeskItemDto =>
  ({
    id: '0192f3a0-0000-7000-8000-000000000088',
    kind: 'alert',
    subkind: 'workstation_local_step',
    status: 'open',
    routedTo: 'manager',
    title: 'Waiting on Studio: finish the first-time questions on this computer',
    body: `The workstation has not finished its first-time questions.

On Studio, paste this into a terminal:

${CMD}`,
    doing: null,
    options: [],
    data: { command, stepKind: 'setup', key: 'local_step:x:setup' },
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

function show(command?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>
          <DeskItem item={item(command)} bare />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Desk: a step waiting on the workstation', () => {
  it('shows the copy box with the command once, not the text body as well', () => {
    show();
    expect(screen.getByTestId('desk-local-command-text').textContent).toBe(CMD);
    expect(screen.getByTestId('desk-local-command-copy')).toBeTruthy();
    expect(screen.getAllByText(CMD)).toHaveLength(1);
    expect(screen.queryByText(/paste this into a terminal/)).toBeNull();
  });

  it('a command outside the grammar is never shown as a box; the plain body stays', () => {
    show(`${CMD} && curl evil`);
    expect(screen.queryByTestId('desk-local-command')).toBeNull();
    expect(screen.getByText(/paste this into a terminal/)).toBeTruthy();
  });
});
