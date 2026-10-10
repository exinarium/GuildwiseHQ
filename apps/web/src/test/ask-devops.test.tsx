import type { AgentDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskDevOpsButton, AskDevOpsProvider, pickDevopsAgent } from '../components/devops/AskDevOps.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const agent = (n: number, name: string, workstationId: string, over: Partial<AgentDto> = {}) =>
  ({
    id: ID(n),
    name,
    isDevops: true,
    status: 'active',
    workstationId,
    roleKey: 'devops',
    ...over,
  }) as unknown as AgentDto;

let agents: AgentDto[];
vi.mock('../api/queries/agents.ts', () => ({ useAgents: () => ({ data: agents }) }));
vi.mock('../api/queries/workstations.ts', () => ({
  useWorkstations: () => ({
    data: [
      { id: ID(10), name: 'Desk' },
      { id: ID(11), name: 'Laptop' },
    ],
  }),
}));
vi.mock('../components/shell/useCurrentProject.ts', () => ({
  useCurrentProject: () => ({
    project: { id: ID(5), key: 'TOY', name: 'Toy' },
    projects: [],
    isPending: false,
  }),
}));

const calls: Array<{ method: string; url: string; body: unknown }> = [];
beforeEach(() => {
  agents = [agent(1, 'Atlas', ID(10)), agent(2, 'Forge', ID(11))];
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === '/api/devops/requests') return new Response(JSON.stringify({}), { status: 201 });
      return new Response('{}', { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const setup = (request?: Parameters<typeof AskDevOpsButton>[0]['request']) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/p/TOY/board?x=1']}>
        <AskDevOpsProvider>
          <AskDevOpsButton {...(request ? { request } : {})} />
        </AskDevOpsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('pickDevopsAgent', () => {
  it('takes the engineer of the named workstation, or the only one, else asks', () => {
    expect(pickDevopsAgent(agents, ID(11))?.name).toBe('Forge');
    expect(pickDevopsAgent(agents, ID(99))).toBeUndefined();
    expect(pickDevopsAgent(agents)).toBeUndefined();
    expect(pickDevopsAgent([agents[0] as AgentDto])?.name).toBe('Atlas');
    // two engineers, but only one on a workstation of the user
    expect(pickDevopsAgent(agents, undefined, [ID(11)])?.name).toBe('Forge');
    expect(pickDevopsAgent([agent(1, 'Atlas', ID(10), { status: 'retired' })])).toBeUndefined();
  });
});

describe('Ask DevOps dialog', () => {
  it('attaches the page and project, lets the user drop them and asks which workstation when unclear', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Ask DevOps/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask DevOps' });
    const chips = within(dialog).getByTestId('ask-devops-context');
    expect(chips).toHaveTextContent('/p/TOY/board?x=1');
    expect(chips).toHaveTextContent('Toy (TOY)');
    // two engineers and no workstation named: the user chooses
    expect(within(dialog).queryByTestId('ask-devops-target')).toBeNull();
    expect(within(dialog).getByLabelText('Workstation')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove Project' }));
    expect(chips).not.toHaveTextContent('Toy (TOY)');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));
    expect(await within(dialog).findByText('Choose which workstation to ask')).toBeInTheDocument();
  });

  it('chooses the workstation DevOps automatically and sends a task with the origin and context', async () => {
    const user = userEvent.setup();
    setup({
      origin: 'card',
      workstationId: ID(11),
      cardId: ID(7),
      cardLabel: 'TOY-7 Login',
      errorText: 'docker: command not found',
    });
    await user.click(screen.getByRole('button', { name: /Ask DevOps/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask DevOps' });
    expect(within(dialog).getByTestId('ask-devops-target')).toHaveTextContent('Forge on Laptop');
    await user.type(within(dialog).getByLabelText('What do you need?'), 'install docker');
    await user.click(within(dialog).getByRole('button', { name: 'Send as a task' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/devops/requests')).toBe(true));
    const post = calls.find((c) => c.url === '/api/devops/requests');
    expect(post?.body).toMatchObject({
      workstationId: ID(11),
      summary: 'install docker',
      origin: 'card',
      cardId: ID(7),
      context: {
        route: '/p/TOY/board?x=1',
        projectId: ID(5),
        cardId: ID(7),
        errorText: 'docker: command not found',
      },
    });
    expect(await within(dialog).findByText(/Request sent to Forge/)).toBeInTheDocument();
  });
});
