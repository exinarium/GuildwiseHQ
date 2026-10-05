import { type PublicationDto, researchWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationPanel } from '../components/PublicationPanel.tsx';
import { CardNewForm } from '../pages/CardNew.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardNewForm
          projectId={PROJECT}
          projectKey="SHOOT"
          projectKeys={['SHOOT']}
          onProject={() => {}}
          workflow={researchWorkflowV1}
          repos={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('research card form', () => {
  it('asks for the question, scope, depth, sub-category and preferred sites, and nothing about repositories', () => {
    renderForm();
    for (const label of ['Question', 'Scope', 'Depth', 'Sub-category', 'Preferred sites'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mock research claims')).toBeNull();
    expect(screen.queryByLabelText('Mock script')).toBeNull();
    expect(screen.queryByLabelText('Repository')).toBeNull();
    expect(screen.queryByLabelText('Completion action')).toBeNull();
    expect(screen.queryByText('Docs needed')).toBeNull();
    expect(screen.getByLabelText('Card type')).toHaveValue('research');
  });

  it('Specify needs the question and the depth, then posts a research card with its fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ card: { id: 'x', ref: 'SHOOT-1' } }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = renderForm();
    // Pasting, not typing: keystroke-by-keystroke typing re-renders the whole form per character, which is what made
    // this test time out when the packages' suites ran side by side.
    await user.click(screen.getByLabelText('Title'));
    await user.paste('Is 6mm ARC enough for deer?');
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    expect(screen.getByText('Question is required to specify this card')).toBeInTheDocument();
    expect(screen.getByText('Depth is required to specify this card')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText('Question'));
    await user.paste('Is the 6mm ARC enough for deer at 300 yards?');
    await user.selectOptions(screen.getByLabelText('Depth'), 'deep');
    await user.click(screen.getByLabelText('Sub-category'));
    await user.paste('hunting');
    await user.click(screen.getByLabelText('Preferred sites'));
    await user.paste('https://a.test\nhttps://b.test');
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cards');
    expect(JSON.parse(String(init.body))).toMatchObject({
      projectId: PROJECT,
      title: 'Is 6mm ARC enough for deer?',
      cardType: 'research',
      specify: true,
      fields: {
        question: 'Is the 6mm ARC enough for deer at 300 yards?',
        depth: 'deep',
        subCategory: 'hunting',
        preferredSites: ['https://a.test', 'https://b.test'],
      },
    });
  });
});

describe('published note panel', () => {
  const pub: PublicationDto = {
    id: '0192f3a0-0000-7000-8000-0000000000a1',
    cardId: '0192f3a0-0000-7000-8000-0000000000c1',
    cardRef: 'SHOOT-1',
    projectId: PROJECT,
    projectKey: 'SHOOT',
    vaultPath: 'projects/shoot/hunting/is-6mm-arc-enough-for-deer.md',
    title: 'Is 6mm ARC enough for deer?',
    citations: [
      {
        url: 'https://source.example.test/1',
        title: 'Hornady ballistics',
        accessedAt: '2026-10-03T08:00:00.000Z',
      },
      {
        url: 'https://source.example.test/2',
        title: 'State regulations',
        accessedAt: '2026-10-03T08:00:00.000Z',
      },
    ],
    excerpt: 'Short answer: yes within 300 yards. [1]',
    createdAt: '2026-10-03T08:05:00.000Z',
  };

  it('shows where the note lives, a preview and linked citations', () => {
    render(<PublicationPanel publication={pub} />);
    const panel = screen.getByTestId('publication');
    expect(within(panel).getByTestId('publication-title')).toHaveTextContent('Is 6mm ARC enough for deer?');
    expect(within(panel).getByTestId('publication-path')).toHaveTextContent(pub.vaultPath);
    expect(within(panel).getByTestId('publication-preview')).toHaveTextContent('Short answer');
    const links = within(within(panel).getByTestId('publication-citations')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(pub.citations.map((c) => c.url));
    expect(panel).toHaveTextContent('Citations (2)');
  });

  it('shows a Transcript expander on a video citation that has one and loads its text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              url: 'https://video.example.test/talk',
              title: 'The talk',
              language: 'en',
              autoGenerated: false,
              path: 'projects/shoot/transcripts/2026-10-03-talk-ab12.md',
              text: 'Reloading helps consistency.',
              truncated: false,
            }),
            { status: 200 },
          ),
      ),
    );
    const withVideo = {
      ...pub,
      citations: [
        ...pub.citations,
        {
          url: 'https://video.example.test/talk',
          title: 'The talk',
          accessedAt: '2026-10-03T08:00:00.000Z',
          transcriptPath: 'projects/shoot/transcripts/2026-10-03-talk-ab12.md',
        },
      ],
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PublicationPanel publication={withVideo} />
      </QueryClientProvider>,
    );
    const list = within(screen.getByTestId('publication-citations'));
    expect(list.getAllByRole('button', { name: 'Transcript' })).toHaveLength(1);
    await userEvent.setup().click(list.getByRole('button', { name: 'Transcript' }));
    expect(await screen.findByTestId('transcript-text')).toHaveTextContent('Reloading helps consistency.');
  });

  it('never renders a non-http(s) citation as a link (review low)', () => {
    const evil = {
      ...pub,
      citations: [
        { url: 'javascript:alert(1)', title: 'Click me', accessedAt: '2026-10-03T08:00:00.000Z' },
        { url: 'https://ok.example.test/', title: 'Fine', accessedAt: '2026-10-03T08:00:00.000Z' },
      ],
    };
    render(<PublicationPanel publication={evil} />);
    const list = within(screen.getByTestId('publication-citations'));
    expect(list.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      'https://ok.example.test/',
    ]);
    expect(list.getByText('Click me').closest('a')).toBeNull();
  });
});
