import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceReposPanel } from '../components/ReferenceReposPanel.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lib = {
  repoId: ID(50),
  name: 'lib',
  projectId: ID(3),
  projectName: 'Library',
  remoteUrl: 'https://github.com/acme/lib',
};
const api = {
  repoId: ID(51),
  name: 'api',
  projectId: ID(4),
  projectName: 'Backend',
  remoteUrl: 'https://github.com/acme/api',
};

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('reference repositories panel', () => {
  it('the owner adds a repository from the other projects and saves the whole list', async () => {
    const user = userEvent.setup();
    wrap(<ReferenceReposPanel projectId={ID(2)} referenceRepos={[lib]} candidates={[lib, api]} isOwner />);
    const list = screen.getByTestId('reference-repos');
    expect(within(list).getByText('Library / lib')).toBeInTheDocument();
    // already chosen repositories are not offered again
    const select = screen.getByLabelText('Add a reference repository');
    expect(within(select).queryByRole('option', { name: 'Library / lib' })).toBeNull();
    await user.selectOptions(select, ID(51));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        url: `/api/projects/${ID(2)}/reference-repos`,
        body: { repoIds: [ID(50), ID(51)], workstationRepos: [] },
      }),
    );
  });

  it('the owner removes one; the rest of the list is sent', async () => {
    const user = userEvent.setup();
    wrap(
      <ReferenceReposPanel projectId={ID(2)} referenceRepos={[lib, api]} candidates={[lib, api]} isOwner />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove Library / lib' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        repoIds: [ID(51)],
        workstationRepos: [],
      }),
    );
    expect(screen.getByTestId('reference-repos-none-left')).toHaveTextContent('already a reference');
  });

  it('says so when there is nothing to pick', () => {
    wrap(<ReferenceReposPanel projectId={ID(2)} referenceRepos={[]} candidates={[]} isOwner />);
    expect(screen.getByTestId('reference-repos-empty')).toBeInTheDocument();
    expect(screen.getByTestId('reference-repos-none-left')).toHaveTextContent('No other repositories');
  });

  it('a manager sees the list but gets no way to change it', () => {
    wrap(<ReferenceReposPanel projectId={ID(2)} referenceRepos={[lib]} candidates={[]} isOwner={false} />);
    expect(screen.getByText('Library / lib')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText('Add a reference repository')).toBeNull();
  });

  const desk = (localKey: string, remoteUrl: string | null = null) => ({
    workstationId: ID(70),
    workstationName: 'Desk',
    localKey,
    name: localKey.split('/').pop() as string,
    remoteUrl,
  });
  const acme = () => desk('clients/acme', 'github.com/acme/acme');

  it('offers "Projects" and "On <workstation>" sections, and saves a picked workstation clone', async () => {
    const user = userEvent.setup();
    wrap(
      <ReferenceReposPanel
        projectId={ID(2)}
        referenceRepos={[lib]}
        candidates={[lib, api]}
        workstationCandidates={[desk('notes'), acme()]}
        isOwner
      />,
    );
    const select = screen.getByLabelText('Add a reference repository');
    expect(within(select).getByRole('group', { name: 'Projects' })).toBeInTheDocument();
    const onDesk = within(select).getByRole('group', { name: 'On Desk' });
    expect(
      within(onDesk)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['notes (no remote)', 'clients/acme']);
    await user.selectOptions(select, `w:${ID(70)}:notes`);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        repoIds: [ID(50)],
        workstationRepos: [{ workstationId: ID(70), localKey: 'notes' }],
      }),
    );
  });

  it('lists picked workstation clones and removes one while keeping the rest', async () => {
    const user = userEvent.setup();
    wrap(
      <ReferenceReposPanel
        projectId={ID(2)}
        referenceRepos={[lib]}
        candidates={[lib]}
        workstationRepos={[desk('notes'), acme()]}
        workstationCandidates={[desk('notes'), acme()]}
        isOwner
      />,
    );
    const list = screen.getByTestId('reference-repos');
    expect(within(list).getByText('Desk / notes')).toBeInTheDocument();
    expect(within(list).getByText('no remote')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Desk / notes' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        repoIds: [ID(50)],
        workstationRepos: [{ workstationId: ID(70), localKey: 'clients/acme' }],
      }),
    );
  });

  it('a non-owner sees the picked clones but cannot change them', () => {
    wrap(
      <ReferenceReposPanel
        projectId={ID(2)}
        referenceRepos={[]}
        candidates={[]}
        workstationRepos={[desk('notes')]}
        isOwner={false}
      />,
    );
    expect(screen.getByText('Desk / notes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });
});
