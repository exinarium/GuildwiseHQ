/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PlaybookRunState, SlashCommand } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../components/chat/Composer.tsx';
import { PlaybookSteps } from '../components/discovery/PlaybookSteps.tsx';
import { PlaybookGrants } from '../components/slash/PlaybookGrants.tsx';

const ITEMS: SlashCommand[] = [
  {
    kind: 'playbook',
    key: 'prd',
    name: 'PRD',
    description: 'Produce a product requirements document',
    source: 'builtin',
    canStartSession: true,
  },
  {
    kind: 'playbook',
    key: 'sample:create-epics-and-stories',
    name: 'Create Epics and Stories',
    description: 'Break a PRD into epics',
    source: 'pack',
    packName: 'sample',
    canStartSession: true,
  },
  {
    kind: 'playbook',
    key: 'mine:secret-play',
    name: 'Secret play',
    description: 'A private playbook',
    source: 'pack',
    visibility: 'private',
    canStartSession: true,
  },
  {
    kind: 'skill',
    key: 'interview-techniques',
    name: 'Interview techniques',
    description: 'How to interview an owner',
    source: 'builtin',
    canStartSession: false,
  },
];

function stub(over: Record<string, (init: RequestInit) => unknown> = {}) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.startsWith('/api/slash-commands')) {
        const session = url.includes('context=session');
        return new Response(
          JSON.stringify({ items: session ? ITEMS.filter((i) => i.kind === 'playbook') : ITEMS }),
        );
      }
      const key = Object.keys(over).find((k) => `${method} ${url}`.startsWith(k));
      if (key) return new Response(JSON.stringify((over[key] as (i: RequestInit) => unknown)(init)));
      return new Response('{}');
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
function Host({ context, onSend }: { context: 'chat' | 'session'; onSend?: () => void }) {
  const [v, setV] = useState('');
  return (
    <Composer
      value={v}
      onChange={setV}
      onSend={onSend ?? (() => undefined)}
      onStop={() => undefined}
      busy={false}
      slash={{ context }}
    />
  );
}
const mount = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/chat/1']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {ui}
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('the / menu of a chat composer', () => {
  it('opens on a slash with playbooks and skills, their descriptions and the private mark', async () => {
    stub();
    mount(<Host context="chat" />);
    await userEvent.type(screen.getByLabelText('Message'), '/');
    expect(await screen.findByTestId('slash-menu')).toBeInTheDocument();
    expect(await screen.findByTestId('slash-playbook-prd')).toHaveTextContent(
      'Produce a product requirements document',
    );
    expect(screen.getByTestId('slash-skill-interview-techniques')).toBeInTheDocument();
    expect(screen.getByTestId('slash-playbook-mine:secret-play')).toHaveTextContent('private');
    // an item of a pack says which pack
    expect(screen.getByTestId('slash-pack-sample:create-epics-and-stories')).toHaveTextContent('from sample');
    expect(screen.queryByTestId('slash-pack-prd')).toBeNull();
  });

  it('searches as you type, on the key, the name and the description', async () => {
    stub();
    mount(<Host context="chat" />);
    await userEvent.type(screen.getByLabelText('Message'), '/epics');
    expect(await screen.findByTestId('slash-playbook-sample:create-epics-and-stories')).toBeInTheDocument();
    expect(screen.queryByTestId('slash-playbook-prd')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Message'));
    await userEvent.type(screen.getByLabelText('Message'), '/interview');
    expect(await screen.findByTestId('slash-skill-interview-techniques')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Message'));
    await userEvent.type(screen.getByLabelText('Message'), '/zzzz');
    expect(await screen.findByTestId('slash-empty')).toBeInTheDocument();
  });

  it('puts the playbook into the chat as an instruction to the agent', async () => {
    stub();
    mount(<Host context="chat" />);
    await userEvent.type(screen.getByLabelText('Message'), '/pr');
    await userEvent.click(await screen.findByText('/prd'));
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.value).toContain('Run the playbook "PRD"');
    expect(box.value).toContain('aom skill show playbook:prd');
    expect(screen.queryByTestId('slash-menu')).toBeNull();
  });

  it('puts a skill into the chat as an instruction to use it', async () => {
    stub();
    mount(<Host context="chat" />);
    await userEvent.type(screen.getByLabelText('Message'), '/inter');
    await userEvent.click(await screen.findByText('/interview-techniques'));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toContain(
      'Use the skill "Interview techniques"',
    );
  });

  it('starts a playbook as a new session and goes to it', async () => {
    const calls = stub({
      'POST /api/playbooks/run': () => ({ threadId: 't1', path: '/discovery/t1' }),
    });
    mount(<Host context="chat" />);
    await userEvent.type(screen.getByLabelText('Message'), '/');
    await userEvent.click(await screen.findByTestId('slash-session-prd'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/discovery/t1'));
    expect(calls.find((c) => c.url === '/api/playbooks/run')?.body).toEqual({ key: 'prd', input: '' });
  });

  it('R3c: text after /command is the playbook input, in a chat instruction and in a new session', async () => {
    const calls = stub({
      'POST /api/playbooks/run': () => ({ threadId: 't2', path: '/discovery/t2' }),
    });
    mount(<Host context="chat" />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await userEvent.type(box, '/prd pricing for teams');
    expect(await screen.findByTestId('slash-input')).toHaveTextContent('pricing for teams');
    await userEvent.keyboard('{Enter}');
    expect(box.value).toContain('Run the playbook "PRD"');
    expect(box.value).toContain('What I want from it: pricing for teams');
    // the same words start a guided session from the session composer
    await userEvent.clear(box);
    await userEvent.type(box, '/prd pricing for teams');
    await userEvent.click(await screen.findByTestId('slash-session-prd'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/discovery/t2'));
    expect(calls.find((c) => c.url === '/api/playbooks/run')?.body).toEqual({
      key: 'prd',
      input: 'pricing for teams',
    });
  });

  it('R3c: ordinary text that starts with a slash is not a command', async () => {
    stub();
    const onSend = vi.fn();
    mount(<Host context="chat" onSend={onSend} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await userEvent.type(box, '/usr/bin is where it lives');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('slash-menu')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalled();
  });

  it('is driven by the keyboard: arrows choose, Enter picks without sending, Escape closes', async () => {
    stub();
    const onSend = vi.fn();
    mount(<Host context="chat" onSend={onSend} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await userEvent.type(box, '/');
    await screen.findByTestId('slash-playbook-prd');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(box.value).toContain('sample:create-epics-and-stories');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.clear(box);
    await userEvent.type(box, '/');
    await screen.findByTestId('slash-menu');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('slash-menu')).toBeNull();
    expect(box.value).toBe('/');
  });

  it('the / button opens the menu for a touch screen', async () => {
    stub();
    mount(<Host context="chat" />);
    await userEvent.click(screen.getByTestId('slash-button'));
    expect(await screen.findByTestId('slash-menu')).toBeInTheDocument();
  });
});

describe('the / menu of a session composer', () => {
  it('offers playbooks only and a click starts the session', async () => {
    const calls = stub({
      'POST /api/playbooks/run': () => ({ threadId: 't2', path: '/discovery/t2' }),
    });
    mount(<Host context="session" />);
    await userEvent.type(screen.getByLabelText('Message'), '/');
    await screen.findByTestId('slash-playbook-prd');
    expect(screen.queryByTestId('slash-skill-interview-techniques')).toBeNull();
    expect(screen.queryByTestId('slash-session-prd')).toBeNull();
    await userEvent.click(screen.getByText('/sample:create-epics-and-stories'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/discovery/t2'));
    expect(calls.find((c) => c.url === '/api/playbooks/run')?.body.key).toBe(
      'sample:create-epics-and-stories',
    );
  });
});

describe('a composer without the menu', () => {
  it('shows no / button and sends on Enter as before', async () => {
    const calls = stub();
    const onSend = vi.fn();
    function Plain() {
      const [v, setV] = useState('');
      return <Composer value={v} onChange={setV} onSend={onSend} onStop={() => undefined} busy={false} />;
    }
    mount(<Plain />);
    expect(screen.queryByTestId('slash-button')).toBeNull();
    await userEvent.type(screen.getByLabelText('Message'), '/hello{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.startsWith('/api/slash-commands'))).toBe(false);
  });
});

const RUN: PlaybookRunState = {
  key: 'prd',
  name: 'PRD',
  steps: ['Gather', 'Goals and users', 'Requirements'],
  step: 2,
  stepTitle: 'Goals and users',
  total: 3,
  startedBy: { kind: 'agent', agentId: '0192f3a0-0000-7000-8000-0000000000a1', agentName: 'Bea' },
};
describe('the steps of a playbook session', () => {
  it('shows the current step, the others and who started it', () => {
    render(<PlaybookSteps run={RUN} />);
    expect(screen.getByTestId('playbook-step-label')).toHaveTextContent('Step 2 of 3: Goals and users');
    expect(screen.getByTestId('playbook-started-by')).toHaveTextContent('started by Bea');
    expect(screen.getByText('Goals and users', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
  });
  it('says it has not started, and grows with a pack playbook whose steps are unknown', () => {
    render(
      <PlaybookSteps
        run={{
          ...RUN,
          steps: ['Validate'],
          step: null,
          stepTitle: null,
          total: null,
          startedBy: { kind: 'user', agentId: null, agentName: null },
        }}
      />,
    );
    expect(screen.getByTestId('playbook-step-label')).toHaveTextContent('not started');
    expect(screen.queryByTestId('playbook-started-by')).toBeNull();
  });
});

describe('the playbook grants of an agent', () => {
  const AGENT = '0192f3a0-0000-7000-8000-0000000000a1';
  it('is off by default and lets a manager allow and remove a playbook', async () => {
    let keys: string[] = [];
    const calls = stub({
      [`GET /api/agents/${AGENT}/playbook-grants`]: () => ({ agentId: AGENT, keys, canManage: true }),
      [`PUT /api/agents/${AGENT}/playbook-grants`]: (init) => {
        const b = JSON.parse(String(init.body));
        keys = b.granted ? [...keys, b.key] : keys.filter((k) => k !== b.key);
        return { agentId: AGENT, keys, canManage: true };
      },
    });
    mount(<PlaybookGrants agentId={AGENT} />);
    // nothing is fetched until it is opened
    expect(calls.some((c) => c.url.includes('playbook-grants'))).toBe(false);
    await userEvent.click(screen.getByTestId('playbook-grants-toggle'));
    expect(await screen.findByTestId('playbook-grants-none')).toHaveTextContent('cannot start a playbook');
    await screen.findByRole('option', { name: /PRD \(prd\)/ });
    await userEvent.selectOptions(screen.getByLabelText('Playbook to allow'), 'prd');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByTestId('playbook-grant-prd')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ key: 'prd', granted: true });
    await userEvent.click(screen.getByRole('button', { name: 'Remove PRD' }));
    await waitFor(() => expect(screen.queryByTestId('playbook-grant-prd')).toBeNull());
  });

  it('shows who may change it to everyone else, without the controls', async () => {
    stub({
      [`GET /api/agents/${AGENT}/playbook-grants`]: () => ({
        agentId: AGENT,
        keys: ['prd'],
        canManage: false,
      }),
    });
    mount(<PlaybookGrants agentId={AGENT} />);
    await userEvent.click(screen.getByTestId('playbook-grants-toggle'));
    expect(await screen.findByTestId('playbook-grant-prd')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByText(/Only an Owner, an Admin or the agent/)).toBeInTheDocument();
  });
});
