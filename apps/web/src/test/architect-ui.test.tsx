import { type CardDto, codeWorkflowV1, codeWorkflowV2, type ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitectPanel } from '../components/ArchitectPanel.tsx';
import { InvestigationPanel, MainSyncNote } from '../components/InvestigationPanel.tsx';
import { buildCardRequest, buildPatchRequest, emptyForm, formValuesFromCard } from '../lib/cardForm.ts';
import { CardNewForm } from '../pages/CardNew.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const REPO = '0192f3a0-0000-7000-8000-000000000002';
type Project = ProjectDetailResponse['project'];

const project = (over: Partial<Project> = {}): Project => ({
  id: PROJECT,
  orgId: '0192f3a0-0000-7000-8000-0000000000a1',
  key: 'TOY',
  name: 'Toy',
  workflowKey: 'code',
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
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (
  node: React.ReactNode,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('project settings: Architect', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/agents' || url.startsWith('/api/agents')) return json({ agents: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts with the design step off, the main merge on and reports in docs/investigations', () => {
    wrap(<ArchitectPanel projectId={PROJECT} project={project()} canChange />);
    expect(screen.getByTestId('architect-state')).toHaveTextContent('Investigate & design is off');
    expect(screen.getByTestId('design-step-toggle')).not.toBeChecked();
    expect(screen.getByTestId('merge-main-toggle')).toBeChecked();
    expect(screen.getByTestId('investigation-path')).toHaveValue('docs/investigations');
    expect(screen.getByTestId('investigation-location')).toHaveValue('repo');
  });

  it('saves the settings with one call, and only when something changed', async () => {
    const user = userEvent.setup();
    wrap(<ArchitectPanel projectId={PROJECT} project={project()} canChange />);
    expect(screen.getByTestId('architect-save')).toBeDisabled();
    await user.click(screen.getByTestId('design-step-toggle'));
    await user.selectOptions(screen.getByTestId('investigation-location'), 'vault');
    await user.clear(screen.getByTestId('investigation-path'));
    await user.type(screen.getByTestId('investigation-path'), 'research/design');
    await user.click(screen.getByTestId('architect-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => u === `/api/projects/${PROJECT}/architect-settings`)).toBe(
        true,
      ),
    );
    const call = fetchMock.mock.calls.find(([u]) => u === `/api/projects/${PROJECT}/architect-settings`) as [
      string,
      RequestInit,
    ];
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(String(call[1].body))).toEqual({
      designStep: true,
      mergeMainFirst: true,
      investigationPath: 'research/design',
      investigationLocation: 'vault',
    });
  });

  it('refuses an absolute or parent path before calling the server', async () => {
    const user = userEvent.setup();
    wrap(<ArchitectPanel projectId={PROJECT} project={project()} canChange />);
    await user.clear(screen.getByTestId('investigation-path'));
    await user.type(screen.getByTestId('investigation-path'), '../elsewhere');
    expect(screen.getByText(/relative folder/i)).toBeInTheDocument();
    expect(screen.getByTestId('architect-save')).toBeDisabled();
  });

  it('warns when the design step is on and nobody is hired as architect', async () => {
    const user = userEvent.setup();
    wrap(<ArchitectPanel projectId={PROJECT} project={project()} canChange />);
    await user.click(screen.getByTestId('design-step-toggle'));
    expect(await screen.findByTestId('no-architect')).toHaveTextContent('No architect is hired');
  });

  it('is read-only for people who cannot change it', () => {
    wrap(<ArchitectPanel projectId={PROJECT} project={project({ designStep: true })} canChange={false} />);
    expect(screen.getByTestId('design-step-toggle')).toBeDisabled();
    expect(screen.getByTestId('architect-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('architect-save')).toBeNull();
  });
});

describe('new card: Investigate & design flags', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({ card: { id: 'x', ref: 'TOY-1' } }, 201));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = (designDefault = false, workflow = codeWorkflowV2) => {
    wrap(
      <CardNewForm
        projectId={PROJECT}
        projectKey="TOY"
        projectKeys={['TOY']}
        onProject={() => {}}
        workflow={workflow}
        repos={[{ id: REPO, name: 'toy' }]}
        mockUi={false}
        designDefault={designDefault}
      />,
    );
    return userEvent.setup();
  };
  const body = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

  it('offers the flags on code v2 and not on code v1', () => {
    setup();
    expect(screen.getByTestId('architect-fields')).toBeInTheDocument();
    expect(screen.getByLabelText(/Investigate & design before build/)).not.toBeChecked();
    expect(screen.getByLabelText(/Investigation only/)).not.toBeChecked();
  });

  it('does not offer them on a workflow without the stage', () => {
    setup(false, codeWorkflowV1);
    expect(screen.queryByTestId('architect-fields')).toBeNull();
  });

  it('follows the project setting and says so', () => {
    setup(true);
    expect(screen.getByLabelText(/Investigate & design before build/)).toBeChecked();
    expect(screen.getByText(/On for this project/)).toBeInTheDocument();
  });

  it('sends nothing about the design when the form follows the project setting', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'Rough idea');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body()).not.toHaveProperty('designNeeded');
    expect(body()).not.toHaveProperty('investigationOnly');
    expect(body()).not.toHaveProperty('mergeMainFirst');
  });

  it('a card can switch the design on, set the merge and name a report path', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'Compare queues');
    await user.click(screen.getByLabelText(/Investigate & design before build/));
    await user.selectOptions(screen.getByLabelText('Merge the latest main branch first'), 'off');
    await user.type(screen.getByLabelText('Report path (optional)'), 'docs/answers/queues.md');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body()).toMatchObject({
      designNeeded: true,
      mergeMainFirst: false,
      fields: { reportPath: 'docs/answers/queues.md' },
    });
    expect(body()).not.toHaveProperty('investigationOnly');
  });

  it('a card can opt out of the project default', async () => {
    const user = setup(true);
    await user.type(screen.getByLabelText('Title'), 'Typo');
    await user.click(screen.getByLabelText(/Investigate & design before build/));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body().designNeeded).toBe(false);
  });

  it('an investigation-only card implies the design, and needs only the short field set', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'How should we queue?');
    await user.click(screen.getByLabelText(/Investigation only/));
    expect(screen.getByLabelText(/Investigate & design before build/)).toBeChecked();
    expect(screen.getByLabelText(/Investigate & design before build/)).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    // the build-only fields are not asked for ...
    for (const label of ['Acceptance criteria', 'Affected areas', 'Constraints', 'Test plan'])
      expect(screen.queryByText(`${label} is required to specify this card`)).toBeNull();
    // ... the short set is
    for (const label of ['Context', 'Requirements', 'Repository'])
      expect(screen.getByText(`${label} is required to specify this card`)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Context'), 'why');
    await user.type(screen.getByLabelText('Requirements'), 'what');
    await user.selectOptions(screen.getByLabelText('Repository'), REPO);
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body()).toMatchObject({ investigationOnly: true, designNeeded: true, specify: true });
  });

  it('refuses a report path that leaves the worktree', async () => {
    const user = setup(true);
    await user.type(screen.getByLabelText('Title'), 'Bad path');
    await user.type(screen.getByLabelText('Report path (optional)'), '../outside.md');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByText(/relative path without \.\./)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('card form helpers', () => {
  const full = {
    ...emptyForm('feature'),
    title: 'T',
    repoId: REPO,
    fields: { context: 'c', requirements: 'r' },
  };
  it('specify needs the full set for a build card, the short one for an investigation-only card', () => {
    const build = buildCardRequest(codeWorkflowV2, full, true);
    expect(Object.keys(build.errors).sort()).toEqual(
      ['acceptanceCriteria', 'affectedAreas', 'constraints', 'testPlan'].sort(),
    );
    const only = buildCardRequest(codeWorkflowV2, { ...full, investigationOnly: true }, true);
    expect(only.errors).toEqual({});
    expect(only).toMatchObject({ investigationOnly: true, designNeeded: true });
  });

  it('an edit sends the flags only when they changed (the server locks them after the investigation)', () => {
    const card = {
      title: 'T',
      cardType: 'feature',
      repoId: REPO,
      completionAction: null,
      docsNeeded: false,
      designNeeded: true,
      investigationOnly: false,
      mergeMainFirst: null,
      priority: 3,
      status: 'draft',
      fields: { context: 'c', requirements: 'r', reportPath: 'docs/x.md' },
    };
    const v = formValuesFromCard(codeWorkflowV2, card);
    expect(v).toMatchObject({ designNeeded: true, investigationOnly: false, mergeMainFirst: '' });
    expect(v.fields.reportPath).toBe('docs/x.md');
    const same = buildPatchRequest(codeWorkflowV2, v, card).patch;
    expect(same).not.toHaveProperty('designNeeded');
    expect(same).not.toHaveProperty('investigationOnly');
    expect(same).not.toHaveProperty('mergeMainFirst');
    expect(same.fields).toMatchObject({ reportPath: 'docs/x.md' });
    const changed = buildPatchRequest(
      codeWorkflowV2,
      { ...v, investigationOnly: true, mergeMainFirst: 'off', fields: { ...v.fields, reportPath: '' } },
      card,
    ).patch;
    expect(changed).toMatchObject({ investigationOnly: true, mergeMainFirst: false });
    expect(changed.fields?.reportPath).toBeNull(); // emptied: removed
  });
});

describe('card detail: the investigation report', () => {
  const base = {
    investigationOnly: false,
    investigation: {
      reportPath: 'docs/investigations/TOY-1-queue.md',
      location: 'repo' as const,
      summary: 'Use an outbox table.',
      commit: 'abcdef1234567890',
      url: 'https://github.com/acme/toy/blob/aom/toy-1/docs/investigations/TOY-1-queue.md',
      at: '2026-10-12T10:00:00.000Z',
    },
  } as unknown as CardDto;

  it('shows the summary and links the file on the forge', () => {
    wrap(<InvestigationPanel card={base} />);
    expect(screen.getByText('Design report')).toBeInTheDocument();
    expect(screen.getByTestId('investigation-summary')).toHaveTextContent('Use an outbox table.');
    const link = screen.getByRole('link', { name: 'docs/investigations/TOY-1-queue.md' });
    expect(link).toHaveAttribute('href', base.investigation?.url as string);
    expect(screen.getByTestId('investigation-path')).toHaveTextContent('@ abcdef1234');
  });

  it('an investigation-only report is titled so; a vault report shows its vault path, unlinked', () => {
    wrap(
      <InvestigationPanel
        card={
          {
            ...base,
            investigationOnly: true,
            investigation: {
              ...base.investigation,
              location: 'vault',
              url: null,
              commit: null,
              reportPath: 'projects/toy/docs/investigations/TOY-1.md',
            },
          } as unknown as CardDto
        }
      />,
    );
    expect(screen.getByText('Investigation report')).toBeInTheDocument();
    expect(screen.getByText('in the vault')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('investigation-path')).toHaveTextContent(
      'projects/toy/docs/investigations/TOY-1.md',
    );
  });

  it('does not link an unsafe url, and renders nothing without a report', () => {
    const { container, rerender } = wrap(
      <InvestigationPanel
        card={
          {
            ...base,
            investigation: { ...base.investigation, url: 'javascript:alert(1)' },
          } as unknown as CardDto
        }
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <InvestigationPanel card={{ investigation: null } as unknown as CardDto} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector('[data-testid="investigation"]')).toBeNull();
  });

  it('the main branch note names a conflict the architect resolves, and a skipped merge with its files', () => {
    wrap(
      <MainSyncNote
        card={
          {
            mainSync: {
              result: 'skipped_conflict',
              mainBranch: 'main',
              workingBranch: 'work',
              files: ['README.md'],
              at: 'x',
            },
          } as unknown as CardDto
        }
      />,
    );
    expect(screen.getByTestId('main-sync')).toHaveTextContent('was not merged');
    expect(screen.getByTestId('main-sync')).toHaveTextContent('README.md');
  });
});
