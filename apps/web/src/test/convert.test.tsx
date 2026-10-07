import {
  type BoardResponse,
  type ConvertPreview,
  codeWorkflowV1,
  feedWorkflowV1,
  type ProjectDto,
  type ProjectRepoDto,
  type PublicationDto,
  researchWorkflowV1,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView, NO_FILTER } from '../components/BoardView.tsx';
import { ConvertPanel } from '../components/ConvertPanel.tsx';
import { ConvertProjectDialog } from '../components/ConvertProjectDialog.tsx';
import { FollowupEditor } from '../components/FollowupEditor.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { useCanConvert } from '../lib/projectWorkflow.ts';
import { CardNewForm } from '../pages/CardNew.tsx';
import { ResearchTab } from '../pages/ResearchTab.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = U(1);
const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: PROJECT,
  orgId: U(99),
  key: 'RLD',
  name: 'Reload',
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
  startedAs: 'research',
  publishedNotes: 2,
  ...over,
});
const repo = (over: Partial<ProjectRepoDto> = {}): ProjectRepoDto => ({
  id: U(50),
  projectId: PROJECT,
  name: 'app',
  remoteUrl: 'https://github.com/acme/app.git',
  remoteUrlNormalized: 'github.com/acme/app',
  workingBranch: 'main',
  removedAt: null,
  ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const workflows = {
  workflows: [codeWorkflowV1, researchWorkflowV1, feedWorkflowV1].map((definition, i) => ({
    id: U(200 + i),
    orgId: null,
    status: 'active',
    definition,
  })),
};
const preview = (over: Partial<ConvertPreview> = {}): ConvertPreview => ({
  fromWorkflowKey: 'research',
  toWorkflowKey: 'code',
  toWorkflowName: 'Code',
  usesRepos: true,
  activeRepos: 0,
  publishedNotes: 2,
  foreignCards: [
    {
      id: U(70),
      ref: 'RLD-1',
      title: 'Which caliber?',
      cardType: 'research',
      workflowKey: 'research',
      stage: 'research',
      status: 'queued',
      claimed: false,
    },
    {
      id: U(71),
      ref: 'RLD-2',
      title: 'Where to buy?',
      cardType: 'research',
      workflowKey: 'research',
      stage: 'research',
      status: 'claimed',
      claimed: true,
    },
  ],
  placedCards: 0,
  suggested: 'code',
  ...over,
});

const fetchMock = vi.fn();
let previewBody: ConvertPreview = preview();
beforeEach(() => {
  previewBody = preview();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/workflows')) return json(workflows);
    if (url.includes('/convert-preview')) return json(previewBody);
    if (url.endsWith('/convert') && init?.method === 'POST')
      return json({ status: 'converted', cancelledCards: 1, keptCards: 1, repoRequests: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement, path = '/') =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const posted = () => {
  const call = fetchMock.mock.calls.find(
    (c) => String(c[0]).endsWith('/convert') && (c[1] as RequestInit | undefined)?.method === 'POST',
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

describe('convert dialog', () => {
  const open = (p = project(), repos: ProjectRepoDto[] = []) =>
    wrap(<ConvertProjectDialog project={p} repos={repos} open onOpenChange={() => {}} />);

  it('offers every workflow but feed and the current one, with code as the usual next step', async () => {
    open();
    const code = await screen.findByTestId('convert-workflow-code');
    expect(code).toHaveTextContent('Usual next step');
    expect(screen.queryByTestId('convert-workflow-feed')).toBeNull();
    expect(screen.queryByTestId('convert-workflow-research')).toBeNull();
    await waitFor(() => expect(screen.getByRole('radio', { name: /Code/ })).toBeChecked());
    expect(screen.getByText(/started as research and has 2 published notes/)).toBeInTheDocument();
  });

  it('needs a repository for code, takes an existing one and posts the decisions', async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByTestId('convert-needs-repo')).toBeInTheDocument();
    const submit = screen.getByTestId('convert-submit');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('convert-repo-name'), 'reload');
    await user.type(screen.getByTestId('convert-repo-url'), 'https://github.com/acme/reload.git');
    await user.click(screen.getByTestId('convert-repo-add'));
    expect(screen.getByTestId('convert-repo-entries')).toHaveTextContent('reload');
    await waitFor(() => expect(submit).toBeEnabled());
    // the cards list shows both open research cards; the second is cancelled
    const cards = await screen.findByTestId('convert-cards');
    expect(within(cards).getByText('RLD-2')).toBeInTheDocument();
    expect(screen.getByTestId('convert-summary')).toHaveTextContent('2 cards kept, 0 cards cancelled');
    await user.selectOptions(screen.getByLabelText('Decision for RLD-2'), 'cancel');
    expect(screen.getByTestId('convert-summary')).toHaveTextContent('1 card kept, 1 card cancelled');
    expect(screen.getByTestId('convert-handover')).toHaveTextContent(
      '2 research notes will be listed in PROJECT.md',
    );
    await user.type(screen.getByTestId('convert-note'), 'Go build');
    await user.click(submit);
    await waitFor(() => expect(posted()).toBeDefined());
    expect(posted()).toEqual({
      toWorkflowKey: 'code',
      repos: [{ name: 'reload', remoteUrl: 'https://github.com/acme/reload.git' }],
      defaultDecision: 'keep',
      cardDecisions: { [U(71)]: 'cancel' },
      note: 'Go build',
    });
  });

  it('a new GitHub repository is requested for approval: the button says so, and the body carries it', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('convert-needs-repo');
    await user.type(screen.getByTestId('convert-new-name'), 'acme/reload');
    await user.selectOptions(screen.getByTestId('convert-new-visibility'), 'public');
    await user.click(screen.getByTestId('convert-new-add'));
    expect(screen.getByTestId('convert-repo-entries')).toHaveTextContent('needs your approval');
    expect(screen.getByTestId('convert-waiting-note')).toBeInTheDocument();
    const submit = screen.getByTestId('convert-submit');
    expect(submit).toHaveTextContent('Request the repository');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(posted()).toBeDefined());
    expect(posted().repos).toEqual([{ create: { name: 'acme/reload', visibility: 'public' } }]);
  });

  it('rejects a bad repository name and URL before asking the server', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('convert-needs-repo');
    await user.click(screen.getByTestId('convert-repo-add'));
    expect(screen.getByText('Give the repository a name')).toBeInTheDocument();
    expect(screen.getByText(/Enter the git remote URL/)).toBeInTheDocument();
    await user.type(screen.getByTestId('convert-new-name'), 'noslash');
    await user.click(screen.getByTestId('convert-new-add'));
    expect(screen.getByText(/Use owner\/repo/)).toBeInTheDocument();
    expect(screen.getByTestId('convert-submit')).toBeDisabled();
  });

  it('with a repository on the project and no foreign cards there is nothing to decide', async () => {
    previewBody = preview({ foreignCards: [], activeRepos: 1 });
    open(project({ workflowKey: 'code', startedAs: 'code', publishedNotes: 0 }), [repo()]);
    // from code the research workflow is the only other target
    await screen.findByTestId('convert-workflow-research');
    await user_pickResearch();
    expect(await screen.findByTestId('convert-no-cards')).toHaveTextContent('nothing to decide');
    expect(screen.queryByTestId('convert-needs-repo')).toBeNull();
  });

  it('shows a server refusal in the dialog', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/workflows')) return json(workflows);
      if (url.includes('/convert-preview')) return json(previewBody);
      if (url.endsWith('/convert') && init?.method === 'POST')
        return json(
          {
            error: {
              code: 'forbidden',
              message: 'only the organization Owner and Admins can convert a project',
            },
          },
          403,
        );
      return json({});
    });
    previewBody = preview({ activeRepos: 1 });
    open(project(), [repo()]);
    await screen.findByTestId('convert-cards');
    await user.click(await screen.findByTestId('convert-submit'));
    expect(await screen.findByText(/only the organization Owner and Admins/)).toBeInTheDocument();
  });
});

async function user_pickResearch() {
  await userEvent.click(screen.getByRole('radio', { name: /Research/ }));
}

describe('stage panel', () => {
  it('Owner and Admins see Convert; others read why not', () => {
    wrap(<ConvertPanel project={project()} repos={[]} canConvert />);
    expect(screen.getByTestId('stage-current')).toHaveTextContent('Now a Research project');
    expect(screen.getByTestId('convert-open')).toHaveTextContent('Convert to project');
  });
  it('is read-only without the right', () => {
    wrap(<ConvertPanel project={project()} repos={[]} canConvert={false} />);
    expect(screen.queryByTestId('convert-open')).toBeNull();
    expect(screen.getByText(/Only the organization's Owner and Admins can convert/)).toBeInTheDocument();
  });
  it('a converted project says what it started as; a waiting conversion lists its requests and can be cancelled', async () => {
    const user = userEvent.setup();
    wrap(
      <ConvertPanel
        project={project({
          workflowKey: 'research',
          pendingConversion: {
            conversionId: U(80),
            toWorkflowKey: 'code',
            requests: [{ id: U(81), name: 'acme/new', status: 'pending', deskItemId: U(82), error: null }],
          },
        })}
        repos={[]}
        canConvert
      />,
    );
    expect(screen.getByTestId('pending-conversion')).toHaveTextContent('acme/new');
    expect(screen.queryByTestId('convert-open')).toBeNull();
    await user.click(screen.getByTestId('cancel-conversion'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(
        true,
      ),
    );
  });
  it('shows "Started as Research" once converted', () => {
    wrap(
      <ConvertPanel
        project={project({
          workflowKey: 'code',
          startedAs: 'research',
          convertedAt: '2026-10-05T10:00:00.000Z',
        })}
        repos={[repo()]}
        canConvert
      />,
    );
    expect(screen.getByTestId('stage-started-as')).toHaveTextContent('Started as Research');
    expect(screen.getByTestId('convert-open')).toHaveTextContent('Convert project');
  });
});

describe('research tab', () => {
  const note = (n: number): PublicationDto => ({
    id: U(300 + n),
    cardId: U(400 + n),
    cardRef: `RLD-${n}`,
    projectId: PROJECT,
    projectKey: 'RLD',
    vaultPath: `projects/rld/general/note-${n}.md`,
    title: `Note ${n}`,
    citations: [{ url: 'https://example.test/a', title: 'Source A', accessedAt: '2026-10-03T08:00:00.000Z' }],
    excerpt: 'Findings.',
    createdAt: '2026-10-03T08:00:00.000Z',
  });
  const board: BoardResponse = {
    projectId: PROJECT,
    workflowKey: 'code',
    columns: [
      {
        name: 'Research',
        cards: [
          {
            id: U(70),
            ref: 'RLD-9',
            title: 'Open question',
            cardType: 'research',
            stage: 'research',
            status: 'queued',
            assignee: null,
            updatedAt: '2026-10-03T08:00:00.000Z',
            queuedAt: null,
            riskTier: null,
            blocked: false,
            reworkRound: 0,
            priority: 2,
          } as BoardResponse['columns'][number]['cards'][number],
        ],
      },
    ],
  };
  const mount = (notes: PublicationDto[]) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/projects') return json({ projects: [project({ workflowKey: 'code' })] });
      if (url.startsWith('/api/research/publications')) return json({ publications: notes });
      if (url.startsWith('/api/board')) return json(board);
      return json({});
    });
    return wrap(
      <Routes>
        <Route path="/p/:projectKey/research" element={<ResearchTab />} />
      </Routes>,
      '/p/RLD/research',
    );
  };
  it('lists the published notes with citations, and the open research cards', async () => {
    mount([note(1), note(2)]);
    const notes = await screen.findAllByTestId('research-note');
    expect(notes).toHaveLength(2);
    expect(within(notes[0] as HTMLElement).getByText('Note 1')).toBeInTheDocument();
    expect(within(notes[0] as HTMLElement).getByText('Source A')).toBeInTheDocument();
    expect(screen.getByTestId('research-open')).toHaveTextContent('Open question');
    expect(screen.getByRole('heading', { name: 'Published notes (2)' })).toBeInTheDocument();
  });
  it('an empty tab points to the first research card', async () => {
    mount([]);
    expect(await screen.findByTestId('research-empty')).toHaveTextContent('No notes published yet');
  });
});

describe('navigation and board', () => {
  it('the Research entry shows for a project with notes or one that started as research', () => {
    const labels = (o: Parameters<typeof buildNav>[0]) =>
      buildNav(o).sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels({ projectKey: 'RLD', hasResearch: true })).toContain('Research');
    expect(labels({ projectKey: 'RLD' })).not.toContain('Research');
    const item = buildNav({ projectKey: 'RLD', hasResearch: true })
      .sections.flatMap((s) => s.items)
      .find((i) => i.id === 'research');
    expect(item?.to).toBe('/p/RLD/research');
  });
  it('repository events refresh the project and the desk', () => {
    expect(
      keysForEvent({ type: 'RepoCreateCompleted', streamId: 'repo-1', projectId: PROJECT }),
    ).toContainEqual(['project']);
    expect(
      keysForEvent({ type: 'ProjectConverted', streamId: `project-${PROJECT}`, projectId: PROJECT }),
    ).toContainEqual(['board']);
  });
  it('a research card on a code board carries a Research chip', () => {
    wrap(
      <BoardView
        filter={NO_FILTER}
        board={{
          projectId: PROJECT,
          workflowKey: 'code',
          columns: [
            {
              name: 'Research',
              cards: [
                {
                  id: U(70),
                  ref: 'RLD-9',
                  title: 'Open question',
                  cardType: 'research',
                  workflowKey: 'research',
                  stage: 'research',
                  status: 'queued',
                  assignee: null,
                  updatedAt: '2026-10-03T08:00:00.000Z',
                  queuedAt: null,
                  riskTier: null,
                  blocked: false,
                  reworkRound: 0,
                  priority: 2,
                } as never,
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('workflow-chip')).toHaveTextContent('Research');
  });
});

describe('research cards in a code project', () => {
  it('the type select offers research and the form asks for the question', async () => {
    const user = userEvent.setup();
    wrap(
      <CardNewForm
        projectId={PROJECT}
        projectKey="RLD"
        projectKeys={['RLD']}
        onProject={() => {}}
        workflow={codeWorkflowV1}
        extraWorkflows={[researchWorkflowV1]}
        repos={[{ id: U(50), name: 'app' }]}
      />,
    );
    const type = screen.getByLabelText('Card type');
    expect(
      within(type)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('research');
    expect(screen.queryByLabelText('Question')).toBeNull();
    await user.selectOptions(type, 'research');
    expect(screen.getByLabelText('Question')).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository')).toBeNull();
  });
});

describe('follow-ups the project cannot run', () => {
  it('are greyed out with the reason', () => {
    wrap(
      <FollowupEditor
        value={[]}
        onChange={() => {}}
        targets={[]}
        unavailable={{
          deploy: 'This project has no repository: convert it first.',
          regression: 'This project has no repository: convert it first.',
        }}
      />,
    );
    expect(screen.getByTestId('add-deploy')).toBeDisabled();
    expect(screen.getByTestId('add-regression')).toBeDisabled();
    expect(screen.getByTestId('add-custom')).toBeEnabled();
    expect(screen.getByTestId('followup-unavailable')).toHaveTextContent('no repository');
  });
});

describe('who may convert', () => {
  const me = (orgs: Array<{ id: string; role: string }>) => ({
    user: { id: U(5), email: 'a@b.test', displayName: 'A', role: 'member' },
    isAdmin: false,
    orgs: orgs.map((o) => ({ ...o, name: 'Org', status: 'active' })),
    activeOrg: null,
    visibleProjectIds: [],
  });
  function Probe({ orgId }: { orgId: string }) {
    return <p data-testid="can">{String(useCanConvert({ orgId }))}</p>;
  }
  const check = async (orgs: Array<{ id: string; role: string }>, expected: string) => {
    fetchMock.mockImplementation(async () => json(me(orgs)));
    wrap(<Probe orgId={U(99)} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('can')).toHaveTextContent(expected));
  };
  it('Owner and Admins of the project organization', async () => {
    await check([{ id: U(99), role: 'admin' }], 'true');
  });
  it('a Member of it may not', async () => {
    await check([{ id: U(99), role: 'member' }], 'false');
  });
  it('a guest who owns another organization may not: the project belongs to ' + 'someone else', async () => {
    await check([{ id: U(98), role: 'owner' }], 'false');
  });
});
