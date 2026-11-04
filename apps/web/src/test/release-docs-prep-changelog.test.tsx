import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangelogStepOutput, changelogSummary } from '../components/delivery/ChangelogStepOutput.tsx';
import { ReleaseDocsPrepPanel } from '../components/ReleaseDocsPrepPanel.tsx';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const output = {
  created: true,
  added: [
    { heading: 'Added', text: 'Export a board as a spreadsheet.', sources: ['e'.repeat(40)] },
    { heading: 'Fixed', text: 'Imports no longer stop <b>halfway</b>.', sources: ['f'.repeat(40)] },
  ],
  duplicates: [],
  covered: [{ source: 'a'.repeat(40), existing: 1 }],
  skipped: [{ source: 'c'.repeat(40), reason: 'internal' }],
  warnings: ['Unreleased has a heading the release page does not read: ### Notes'],
};

describe('Write changelog step output', () => {
  it('summarises per repository', () => {
    expect(changelogSummary('toy', 'passed', output)).toBe(
      'toy: CHANGELOG.md created, 2 entries added (Added 1, Fixed 1)',
    );
    expect(changelogSummary('toy', 'passed', { added: [] })).toBe('toy: no new changes');
    expect(changelogSummary('toy', 'running', null)).toBe('Writing entries…');
    expect(changelogSummary('toy', 'passed', null)).toBeNull();
  });

  it('lists the entries under their headings as plain text, with covered, skipped and warnings', async () => {
    render(<ChangelogStepOutput repoName="toy" state="passed" output={output} />);
    await userEvent.setup().click(screen.getByText(/2 entries added/));
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByText('Export a board as a spreadsheet.')).toBeInTheDocument();
    // Text, never HTML.
    expect(screen.getByText('Imports no longer stop <b>halfway</b>.')).toBeInTheDocument();
    expect(screen.getByText('Already in the changelog: 1 change')).toBeInTheDocument();
    expect(screen.getByText(/internal/)).toBeInTheDocument();
    expect(screen.getByText(/does not read/)).toBeInTheDocument();
  });
});

describe('settings checklist', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          enabled: true,
          canEdit: true,
          steps: [
            { id: 'analyse', label: 'Analyse changes', description: 'Lists the changes.', enabled: false },
            {
              id: 'changelog',
              label: 'Write changelog',
              description: 'Writes entries.',
              enabled: true,
              requires: ['analyse'],
            },
            { id: 'commit', label: 'Commit results', description: 'Commits.', enabled: true },
          ],
        }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows "Needs Analyse changes" under Write changelog while Analyse is unticked', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ReleaseDocsPrepPanel projectId="0192f3a0-0000-7000-8000-000000000001" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Needs Analyse changes')).toBeInTheDocument();
  });
});
