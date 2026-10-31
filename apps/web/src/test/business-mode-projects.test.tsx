import { BUILTIN_WORKFLOWS, type ProjectDto, type Workability } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { WorkabilityWarning } from '../components/WorkabilityWarning.tsx';
import { Projects } from '../pages/Projects.tsx';

const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const PROJECT = '0192f3a0-0000-7000-8000-000000000101';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const project: ProjectDto = {
  id: PROJECT,
  orgId: ORG,
  key: 'AAA',
  name: 'Project AAA',
  workflowKey: 'research',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
};
const workflows = [...new Map(BUILTIN_WORKFLOWS.map((d) => [d.key, d])).values()].map((definition, n) => ({
  id: `0192f3a0-0000-7000-8000-00000000020${n}`,
  orgId: null,
  status: 'active',
  definition,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function page(mode: 'dev' | 'business') {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/auth/me')
      return json({
        user: { id: ORG, email: 'a@b.test', displayName: 'A', role: 'member' },
        isAdmin: false,
        orgs: [{ id: ORG, name: 'Acme', status: 'active', role: 'owner' }],
        activeOrg: { id: ORG, name: 'Acme', status: 'active', role: 'owner', mode },
        visibleProjectIds: [],
      });
    if (url.startsWith('/api/projects?status=archived')) return json({ projects: [] });
    if (url.startsWith('/api/projects')) return json({ projects: [project] });
    if (url.includes('invitations')) return json({ invitations: [] });
    if (url.startsWith('/api/workflows')) return json({ workflows });
    return json({});
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Projects />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const openNewProject = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
  const form = await screen.findByRole('form', { name: 'New project' });
  await waitFor(() => expect(within(form).getAllByRole('radio').length).toBeGreaterThan(1));
  return form;
};
const radios = (form: HTMLElement) =>
  within(form)
    .getAllByRole('radio')
    .map((r) => r as HTMLInputElement);

describe('New project by organization mode', () => {
  it('offers and defaults to the Code workflow in dev mode, with the repository hint', async () => {
    page('dev');
    const form = await openNewProject();
    expect(radios(form).map((r) => r.value)).toContain('code');
    expect(radios(form).find((r) => r.checked)?.value).toBe('code');
    expect(within(form).getByTestId('workflow-hint')).toHaveTextContent(
      'Add repositories in project settings.',
    );
  });

  it('offers no repository workflow in business mode and defaults to the first one left', async () => {
    page('business');
    const form = await openNewProject();
    const values = radios(form).map((r) => r.value);
    expect(values).not.toContain('code');
    expect(values).toEqual(expect.arrayContaining(['research', 'feed']));
    expect(radios(form).find((r) => r.checked)?.value).toBe(values[0]);
    expect(within(form).getByTestId('workflow-hint')).not.toHaveTextContent('Add repositories');
    expect(screen.queryByText(/Code projects also own repositories/)).toBeNull();
  });
});

describe('workability warning by organization mode', () => {
  const blocked: Workability = {
    ok: false,
    level: 'blocked',
    reason: 'Not workable: nobody can take the Build stage. Hire a builder.',
    hire: { roleKey: 'builder', seniority: 'junior' },
  };
  const repoWarning: Workability = {
    ok: false,
    level: 'waiting',
    reason: 'Last attempt failed: the working branch does not exist.',
    settings: 'repositories',
  };
  const show = (w: Workability, business?: boolean) =>
    render(
      <MemoryRouter>
        <WorkabilityWarning workability={w} projectId={PROJECT} {...(business ? { business } : {})} />
      </MemoryRouter>,
    );

  it('links to the developer hire and the repository settings in dev mode', () => {
    show(blocked);
    expect(screen.getByTestId('workability-hire')).toHaveTextContent('Hire junior builder');
    show(repoWarning);
    expect(screen.getByTestId('workability-settings')).toHaveAttribute(
      'href',
      `/projects/${PROJECT}/settings#repos`,
    );
  });

  it('keeps the reason but drops the developer hire and repository links in business mode', () => {
    show(blocked, true);
    expect(screen.getByTestId('workability-warning')).toHaveTextContent('nobody can take the Build stage');
    expect(screen.queryByTestId('workability-hire')).toBeNull();
    show(repoWarning, true);
    expect(screen.getAllByTestId('workability-warning')[1]).toHaveTextContent(
      'working branch does not exist',
    );
    expect(screen.queryByTestId('workability-settings')).toBeNull();
  });

  it('still links to hire a business role in business mode', () => {
    show({ ok: false, level: 'blocked', reason: 'Hire an analyst.', hire: { roleKey: 'ba' } }, true);
    expect(screen.getByTestId('workability-hire')).toHaveAttribute(
      'href',
      `/agents?hire=ba&projectId=${PROJECT}`,
    );
  });
});
