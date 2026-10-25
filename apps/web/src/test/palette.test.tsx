import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../components/palette/CommandPalette.tsx';
import { ShortcutsDialog } from '../components/palette/ShortcutsDialog.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { useGlobalShortcuts } from '../lib/shortcuts.ts';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

vi.mock('../api/queries/agents.ts', () => ({
  useAgents: () => ({
    data: [
      { id: '0192f3a0-0000-7000-8000-000000000003', name: 'Marlowe', roleKey: 'builder', status: 'active' },
    ],
  }),
}));
vi.mock('../api/queries/desk.ts', () => ({
  useDesk: () => ({
    data: {
      items: [
        {
          id: '0192f3a0-0000-7000-8000-000000000009',
          kind: 'approval',
          title: 'Approve the deploy',
          blocking: false,
        },
      ],
    },
  }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/search/cards'))
      return json({
        cards: [
          {
            id: U(7),
            ref: 'TOY-7',
            title: 'Autosave drafts',
            status: 'queued',
            projectKey: 'TOY',
            projectName: 'Toy',
          },
        ],
      });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const nav = buildNav({ projectKey: 'TOY', canManage: true });

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search + l.hash}</p>;
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  useGlobalShortcuts({
    palette: () => setOpen((o) => !o),
    help: () => setHelp(true),
    newCard: () => setPath((p) => [...p, 'new']),
    search: () => setPath((p) => [...p, 'search']),
    go: (page) => setPath((p) => [...p, page]),
  });
  return (
    <>
      <input aria-label="a field" />
      <p data-testid="log">{path.join(',')}</p>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        ctx={{
          sections: nav.sections,
          footer: nav.footer,
          projects: [{ id: U(1), key: 'TOY', name: 'Toy' }],
          projectKey: 'TOY',
          onChat: () => {},
          onAskDevOps: () => setPath((p) => [...p, 'devops']),
          onHelp: () => setHelp(true),
        }}
      />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
      <Where />
    </>
  );
}

const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('keyboard shortcuts', () => {
  it('g b / g d / n / / map to their targets, and are ignored while typing', async () => {
    const user = userEvent.setup();
    setup();
    await user.keyboard('gb');
    await user.keyboard('gd');
    await user.keyboard('n');
    await user.keyboard('/');
    expect(screen.getByTestId('log')).toHaveTextContent('board,desk,new,search');
    await user.click(screen.getByLabelText('a field'));
    await user.keyboard('gdn/');
    expect(screen.getByTestId('log')).toHaveTextContent('board,desk,new,search');
  });

  it('? opens the help dialog listing the shortcuts', async () => {
    const user = userEvent.setup();
    setup();
    await user.keyboard('?');
    const dlg = await screen.findByTestId('shortcuts-dialog');
    expect(dlg).toHaveTextContent('Your desk');
    expect(dlg).toHaveTextContent('New card');
  });
});

describe('command palette', () => {
  it('G-Q1: "Ask DevOps..." is an action, found by install/docker/fix keywords', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox');
    await user.type(input, 'docker');
    await user.click(await screen.findByText('Ask DevOps...'));
    await waitFor(() => expect(screen.getByTestId('log')).toHaveTextContent('devops'));
  });

  it('Ctrl+K opens it; pages, projects, agents and desk items are listed and filterable; Enter jumps', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox');
    expect(await screen.findByText('Marlowe')).toBeInTheDocument();
    expect(await screen.findByText('Approve the deploy')).toBeInTheDocument();
    expect(screen.getByText('Toggle theme', { exact: false })).toBeInTheDocument();
    await user.type(input, 'workst');
    await waitFor(() => expect(screen.queryByText('Marlowe')).not.toBeInTheDocument());
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/workstations');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('finds a card by its ref or title and opens it', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox');
    await user.type(input, 'autosave');
    const hit = await screen.findByText('Autosave drafts');
    await user.click(hit);
    expect(screen.getByTestId('where')).toHaveTextContent('/cards/TOY-7');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/search/cards?q=autosave'))).toBe(true);
  });

  it('New card goes to the new-card form of the current project', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await user.click(await screen.findByText('New card'));
    expect(screen.getByTestId('where')).toHaveTextContent('/cards/new?project=TOY');
  });
});
