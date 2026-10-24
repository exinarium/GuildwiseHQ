import type { AgentDraftDto, DeskItemDto, StarterGalleryResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DescribeAgentDialog } from '../components/agents/DescribeAgent.tsx';
import { HireDialog } from '../components/agents/HireDialog.tsx';
import { StarterGalleryTab } from '../components/capabilities/StarterGallery.tsx';
import { MentionBox } from '../components/cards/MentionBox.tsx';
import { FollowUpPanel } from '../components/orgsettings/FollowUpPanel.tsx';
import { ReminderBadges, SnoozeSelect } from '../components/SnoozeReminder.tsx';
import { ToastProvider } from '../components/ui.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
type Handler = (method: string, url: string, body: any) => unknown;
let handler: Handler = () => ({});
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const out = handler(init?.method ?? 'GET', url, body);
    if (out instanceof Response) return out;
    return json(out ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: (init as RequestInit)?.method ?? 'GET',
    url: url as string,
    body: (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : null,
  }));

function wrap(ui: React.ReactElement, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const DRAFT: AgentDraftDto = {
  name: 'Penny',
  purpose: 'Writes release notes from merged changes.',
  instructions:
    'You write release notes for customers from the list of merged changes you are given. Never invent a change.',
  tools: ['read', 'edit'],
  model: 'haiku',
  skills: ['interview-techniques'],
  playbooks: ['release-notes'],
  permissions: {
    allowedTools: ['read', 'edit'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    riskTiers: ['small', 'large'],
    readOrgRepos: false,
    repoIds: null,
  },
  withheld: [],
};

describe('mention box', () => {
  const agents = [
    { agentId: 'a1', name: 'Una', handle: 'una', roleKey: 'builder' },
    { agentId: 'a2', name: 'Max Power', handle: 'max-power', roleKey: 'reviewer' },
  ];
  function Host({ list = agents }: { list?: typeof agents }) {
    const [v, setV] = useState('');
    return <MentionBox label="Comment" value={v} onChange={setV} agents={list} />;
  }

  it('offers the agents when @ is typed, narrows them, and inserts the handle', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const box = screen.getByRole('combobox', { name: 'Comment' });
    await user.type(box, 'hello @');
    expect(within(screen.getByTestId('mention-list')).getAllByRole('option')).toHaveLength(2);
    await user.type(box, 'ma');
    expect(within(screen.getByTestId('mention-list')).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('hello @max-power ');
    expect(screen.queryByTestId('mention-list')).toBeNull();
  });

  it('moves with the arrows, picks with a click, and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const box = screen.getByRole('combobox', { name: 'Comment' });
    await user.type(box, '@');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(box).toHaveValue('@max-power ');
    await user.type(box, 'and @');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('mention-list')).toBeNull();
    await user.type(box, 'u');
    await user.click(screen.getByTestId('mention-option-una'));
    expect((box as HTMLTextAreaElement).value.endsWith('@una ')).toBe(true);
  });

  it('shows nothing for an e-mail address or when the viewer may mention nobody', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Host />);
    await user.type(screen.getByRole('combobox'), 'mail me at bo@un');
    expect(screen.queryByTestId('mention-list')).toBeNull();
    unmount();
    render(<Host list={[]} />);
    await user.type(screen.getByRole('combobox'), '@un');
    expect(screen.queryByTestId('mention-list')).toBeNull();
    expect(screen.queryByText(/Type @ to ask an agent/)).toBeNull();
  });
});

describe('describe the agent you need', () => {
  const polls: Array<unknown> = [];
  beforeEach(() => {
    polls.length = 0;
    handler = (method, url, body) => {
      if (method === 'POST' && url === '/api/agents/draft') return json({ threadId: 'th1' }, 202);
      if (method === 'GET' && url === '/api/agents/draft/th1') return polls.shift() ?? { status: 'working' };
      if (method === 'POST' && url === '/api/agents/draft-clamp')
        return {
          draft: {
            ...DRAFT,
            ...body.draft,
            tools: ['read'],
            permissions: { ...DRAFT.permissions, allowedTools: ['read'], writableGlobs: [] },
            withheld: ['the edit tool'],
          },
        };
      return {};
    };
  });

  it('sends one sentence, waits for the draft, lets the person edit it, and hands it on without hiring', async () => {
    const user = userEvent.setup();
    polls.push({ status: 'working' }, { status: 'ready', draft: DRAFT });
    const onContinue = vi.fn();
    wrap(<DescribeAgentDialog open onOpenChange={() => undefined} onContinue={onContinue} />);
    await user.type(screen.getByLabelText('What should it do?'), 'An agent that writes our release notes');
    await user.click(screen.getByRole('button', { name: 'Draft the role' }));
    expect(sent().find((c) => c.url === '/api/agents/draft')?.body).toEqual({
      description: 'An agent that writes our release notes',
    });
    expect(await screen.findByTestId('draft-working')).toBeInTheDocument();
    expect(await screen.findByTestId('draft-review', undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Penny');
    expect(screen.getByLabelText('Instructions')).toHaveValue(DRAFT.instructions);
    expect(screen.getByTestId('draft-granted')).toHaveTextContent('read, edit');
    expect(screen.getByTestId('draft-suggestions')).toHaveTextContent('release-notes');
    // edit the name and untick a suggestion
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Penelope');
    await user.click(screen.getByRole('checkbox', { name: /May start the playbook/ }));
    // changing the tools asks the server again and shows what was withheld
    await user.click(screen.getByTestId('draft-tool-shell'));
    expect(await screen.findByTestId('draft-withheld')).toHaveTextContent('the edit tool');
    expect(screen.getByTestId('draft-granted')).toHaveTextContent('It will get: read.');
    await user.click(screen.getByTestId('draft-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    const handed = onContinue.mock.calls[0]?.[0] as AgentDraftDto;
    expect(handed).toMatchObject({ name: 'Penelope', playbooks: [], skills: ['interview-techniques'] });
    expect(handed.permissions.allowedTools).toEqual(['read']);
    // nothing was hired
    expect(sent().some((c) => c.url.includes('hire'))).toBe(false);
  }, 15000);

  it('says so when the drafting turn failed and offers another try', async () => {
    const user = userEvent.setup();
    polls.push({ status: 'failed', error: 'the reply held no draft; describe the agent again' });
    wrap(<DescribeAgentDialog open onOpenChange={() => undefined} onContinue={() => undefined} />);
    await user.type(screen.getByLabelText('What should it do?'), 'Something vague');
    await user.click(screen.getByRole('button', { name: 'Draft the role' }));
    expect(await screen.findByTestId('draft-failed', undefined, { timeout: 6000 })).toHaveTextContent(
      'held no draft',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByLabelText('What should it do?')).toBeInTheDocument();
  }, 15000);
});

describe('hire dialog with a draft', () => {
  const WS = '0192f3a0-0000-7000-8000-0000000000b1';
  const PROJ = '0192f3a0-0000-7000-8000-0000000000c1';
  beforeEach(() => {
    handler = (method, url) => {
      if (url.startsWith('/api/workstations'))
        return {
          workstations: [
            {
              id: WS,
              name: 'Desk',
              status: 'active',
              connected: true,
              runtimes: [
                { id: 'claude-code', version: '1', available: true, capabilities: ['shell', 'edit'] },
              ],
            },
          ],
        };
      if (url.startsWith('/api/projects') && method === 'GET')
        return {
          projects: [{ id: PROJ, orgId: 'o1', key: 'TOY', name: 'Toy', status: 'active', myRole: 'owner' }],
        };
      if (url.startsWith('/api/auth/me'))
        return { user: { id: 'u1' }, activeOrg: { id: 'o1', role: 'owner' }, orgs: [] };
      if (url.startsWith('/api/roles')) return { roles: [] };
      if (url.startsWith('/api/agents/name-suggestions')) return { names: ['Ada'] };
      if (method === 'POST' && url === '/api/agents/hire-from-draft') return { id: 'new' };
      return {};
    };
  });

  it('shows the drafted role in place of the role list and hires from the draft, with no role key', async () => {
    const user = userEvent.setup();
    wrap(<HireDialog open onOpenChange={() => undefined} draft={DRAFT} starterKey="security" />);
    expect(await screen.findByTestId('hire-draft-role')).toHaveTextContent('New role: Penny');
    expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Penny'));
    expect(screen.getByLabelText('Skills')).toHaveValue('interview-techniques');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workstation' })).toHaveValue(WS));
    await user.click(screen.getByRole('button', { name: 'Hire' }));
    await waitFor(() => expect(sent().some((c) => c.url === '/api/agents/hire-from-draft')).toBe(true));
    const body = sent().find((c) => c.url === '/api/agents/hire-from-draft')?.body;
    expect(body).toMatchObject({
      name: 'Penny',
      workstationId: WS,
      starterKey: 'security',
      draft: { name: 'Penny', tools: ['read', 'edit'], model: 'haiku', playbooks: ['release-notes'] },
    });
    expect(body.roleKey).toBeUndefined();
    // the clamp is the server's: the request carries the wish, not the permissions
    expect(body.draft.permissions).toBeUndefined();
    expect(body.draft.withheld).toBeUndefined();
  });
});

describe('starter gallery', () => {
  const GALLERY: StarterGalleryResponse = {
    firstRun: true,
    entries: [
      {
        kind: 'playbook',
        key: 'release-notes',
        title: 'Release notes',
        outcome: 'Customer-ready release notes from the list of what shipped.',
        group: 'Ship and report',
      },
      {
        kind: 'persona',
        key: 'security',
        title: 'Security reviewer',
        outcome: 'Reads a plan for abuse and data exposure and ranks them.',
        group: 'Look after it',
      },
    ],
  };
  beforeEach(() => {
    handler = (method, url) => {
      if (url === '/api/starter-gallery') return GALLERY;
      if (url === '/api/starter-gallery/security/draft') return { draft: { ...DRAFT, name: 'Security' } };
      if (method === 'POST' && url === '/api/playbooks/run') return { threadId: 't9', path: '/discovery/t9' };
      return [];
    };
  });

  it('lists the entries by group with their one-line outcomes', async () => {
    wrap(<StarterGalleryTab />);
    expect(await screen.findByTestId('starter-playbook-release-notes')).toHaveTextContent(
      'Customer-ready release notes',
    );
    expect(screen.getByTestId('starter-persona-security')).toHaveTextContent('Persona');
    expect(screen.getByRole('region', { name: 'Ship and report' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Look after it' })).toBeInTheDocument();
  });

  it('runs a playbook as a guided session and goes to it', async () => {
    const user = userEvent.setup();
    wrap(
      <Routes>
        <Route path="/" element={<StarterGalleryTab />} />
        <Route path="/discovery/:id" element={<p>session page</p>} />
      </Routes>,
    );
    await user.click(await screen.findByTestId('use-playbook-release-notes'));
    expect(await screen.findByText('session page')).toBeInTheDocument();
    expect(sent().find((c) => c.url === '/api/playbooks/run')?.body).toEqual({
      key: 'release-notes',
      input: '',
    });
  });

  it('opens a persona for review before the hire dialog, and hires nothing yet', async () => {
    const user = userEvent.setup();
    wrap(<StarterGalleryTab />);
    await user.click(await screen.findByTestId('use-persona-security'));
    expect(await screen.findByRole('dialog', { name: 'Review before hiring' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Security');
    await user.click(screen.getByTestId('starter-continue'));
    expect(await screen.findByRole('dialog', { name: 'Hire agent' })).toBeInTheDocument();
    expect(sent().some((c) => c.method === 'POST' && c.url.includes('/agents'))).toBe(false);
  });
});

describe('follow-up settings and desk reminders', () => {
  it('shows the period, saves a new one for those who may change it, and is read only for the rest', async () => {
    const user = userEvent.setup();
    handler = (method, url, body) => {
      if (url === '/api/org/follow-up') return method === 'PUT' ? { days: body.days } : { days: 3 };
      return {};
    };
    const { unmount } = wrap(<FollowUpPanel canChange />);
    const days = await screen.findByLabelText('Days');
    await waitFor(() => expect(days).toHaveValue(3));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(days);
    await user.type(days, '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent().find((c) => c.method === 'PUT')?.body).toEqual({ days: 5 }));
    unmount();
    wrap(<FollowUpPanel canChange={false} />);
    expect(await screen.findByLabelText('Days')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  const item = (over: Partial<DeskItemDto> = {}) =>
    ({
      id: '0192f3a0-0000-7000-8000-000000000078',
      status: 'open',
      title: 'Which provider?',
      canAnswer: true,
      ...over,
    }) as DeskItemDto;

  it('shows that an item was reminded or snoozed, and snoozes it', async () => {
    const user = userEvent.setup();
    handler = (method, url) =>
      method === 'POST' && url.endsWith('/snooze') ? { snoozedUntil: '2030-01-01T00:00:00Z' } : {};
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const { unmount } = wrap(
      <>
        <ReminderBadges
          item={item({ followUp: { nudgedAt: '2026-10-20T10:00:00Z', nudgeCount: 2, snoozedUntil: future } })}
        />
        <SnoozeSelect item={item()} />
      </>,
    );
    expect(screen.getByTestId('reminded-badge')).toHaveTextContent('Reminded x2');
    expect(screen.getByTestId('snoozed-badge')).toHaveTextContent('Snoozed until');
    await user.click(screen.getByRole('button', { name: 'Snooze reminders for Which provider?' }));
    await user.click(await screen.findByRole('menuitem', { name: '3 days' }));
    await waitFor(() =>
      expect(sent().find((c) => c.url.endsWith('/snooze'))).toMatchObject({
        url: '/api/desk/0192f3a0-0000-7000-8000-000000000078/snooze',
        body: { days: 3 },
      }),
    );
    unmount();
    // nothing for an item that was never chased, a closed one, or one the person cannot act on
    const { container } = wrap(
      <>
        <ReminderBadges item={item()} />
        <SnoozeSelect item={item({ status: 'answered' })} />
        <SnoozeSelect item={item({ canAnswer: false })} />
      </>,
    );
    expect(container.querySelector('button[aria-label^="Snooze reminders"]')).toBeNull();
    expect(screen.queryByTestId('reminded-badge')).toBeNull();
  });
});
