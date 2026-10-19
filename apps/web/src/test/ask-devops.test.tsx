import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskDevOpsButton, AskDevOpsProvider } from '../components/devops/AskDevOps.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

vi.mock('../components/shell/useCurrentProject.ts', () => ({
  useCurrentProject: () => ({
    project: { id: ID(5), key: 'TOY', name: 'Toy' },
    projects: [],
    isPending: false,
  }),
}));
vi.mock('../components/ceo/useCeoName.ts', () => ({ useCeoName: () => 'Cora' }));

const calls: Array<{ method: string; url: string }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url });
      if (url === '/api/ceo/chat') return new Response(JSON.stringify({ threadId: ID(77) }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Where() {
  const loc = useLocation();
  return (
    <p data-testid="where">
      {loc.pathname}|{(loc.state as { ceoPrefill?: string } | null)?.ceoPrefill ?? ''}
    </p>
  );
}

const setup = (request?: Parameters<typeof AskDevOpsButton>[0]['request']) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/p/TOY/board?x=1']}>
        <AskDevOpsProvider>
          <Routes>
            <Route path="/chat/:id" element={<Where />} />
            <Route path="*" element={<AskDevOpsButton {...(request ? { request } : {})} />} />
          </Routes>
        </AskDevOpsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Ask DevOps goes through the CEO', () => {
  it('attaches the page and project, lets the user drop them, and asks for a description', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Ask DevOps/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask DevOps' });
    const chips = within(dialog).getByTestId('ask-devops-context');
    expect(chips).toHaveTextContent('/p/TOY/board?x=1');
    expect(chips).toHaveTextContent('Toy (TOY)');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Project' }));
    expect(chips).not.toHaveTextContent('Toy (TOY)');
    await user.click(within(dialog).getByRole('button', { name: 'Ask Cora' }));
    expect(await within(dialog).findByText('Describe what you need')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/ceo/chat')).toBe(false);
  });

  it('opens the CEO chat with the message and the context prefilled; no DevOps request or chat is created', async () => {
    const user = userEvent.setup();
    setup({
      origin: 'card',
      cardId: ID(7),
      cardLabel: 'TOY-7 Login',
      errorText: 'docker: command not found',
    });
    await user.click(screen.getByRole('button', { name: /Ask DevOps/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask DevOps' });
    await user.type(within(dialog).getByLabelText('What do you need?'), 'install docker');
    await user.click(within(dialog).getByRole('button', { name: 'Ask Cora' }));
    await waitFor(() => expect(screen.getByTestId('where')).toBeInTheDocument());
    const where = screen.getByTestId('where').textContent ?? '';
    expect(where).toContain(`/chat/${ID(77)}`);
    expect(where).toContain('Ask DevOps: install docker');
    expect(where).toContain('Card: TOY-7 Login');
    expect(where).toContain('Last error: docker: command not found');
    expect(calls.map((c) => c.url)).not.toContain('/api/devops/requests');
    expect(calls.map((c) => c.url)).not.toContain('/api/chats');
  });
});
