import { type DeskItemDto, DeskItemDtoSchema } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskItem, devopsAllowShown } from '../pages/Desk.tsx';

// gate-fixes-3 (d): the Desk list item (schema-parsed, as the list endpoint sends it) carries the Allow once / Always allow
// data, so the buttons show and the plain Approve (which opened nothing the box needed) is hidden.
afterEach(() => vi.unstubAllGlobals());

const REQ = '0192f3a0-0000-7000-8000-000000000009';
const listItem = (data: Record<string, unknown>) =>
  DeskItemDtoSchema.parse({
    id: '0192f3a0-0000-7000-8000-000000000088',
    kind: 'approval',
    subkind: 'devops',
    status: 'open',
    routedTo: 'manager',
    title: 'DevOps wants to run mkdir -p ~/.local/share/guildwise/toolchains/devops/jq/1.7',
    body: 'Writing paths outside the agent sandbox is off for this workstation.',
    doing: '',
    options: [],
    recommendation: null,
    blocking: true,
    pinned: true,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: {
      kind: 'agent',
      agentId: '0192f3a0-0000-7000-8000-000000000001',
      agentName: 'Forge',
      role: 'devops',
    },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-11-28T10:00:00.000Z',
    data,
  }) as DeskItemDto;

function renderItem(item: DeskItemDto) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
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
}

const SWITCH = {
  devopsSwitch: 'allowedPaths',
  switchLabel: 'Writable paths outside the agent sandbox',
  workstationName: 'devbox',
};

describe('gate-fixes-3 (d): Allow once / Always allow from the Desk list', () => {
  it('the schema keeps the new fields; the buttons show and desk-approve is hidden', () => {
    const item = listItem({
      ...SWITCH,
      requestId: REQ,
      exactCommand: 'mkdir -p /srv/app/conf',
      allowOnce: true,
      allowAlways: true,
      alwaysPath: '/srv/app',
    });
    expect(item.data).toMatchObject({
      requestId: REQ,
      exactCommand: 'mkdir -p /srv/app/conf',
      allowOnce: true,
      allowAlways: true,
      alwaysPath: '/srv/app',
    });
    expect(devopsAllowShown(item)).toBe(true);
    renderItem(item);
    expect(screen.getByTestId('desk-devops-allow-once')).toBeTruthy();
    expect(screen.getByTestId('desk-devops-allow-always')).toBeTruthy();
    expect(screen.queryByTestId('desk-approve')).toBeNull();
  });

  it('an item without the command data keeps the plain Approve', () => {
    const item = listItem({ ...SWITCH });
    expect(devopsAllowShown(item)).toBe(false);
    renderItem(item);
    expect(screen.queryByTestId('desk-devops-allow-once')).toBeNull();
    expect(screen.getByTestId('desk-approve')).toBeTruthy();
  });
});
