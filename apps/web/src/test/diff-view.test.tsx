import type { ApprovalReviewInfo, CardApproval } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../components/ApprovalPanel.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { diffTotals, parseUnifiedDiff } from '../lib/diff.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old line
+new line
+another new line
 tail
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

describe('parseUnifiedDiff', () => {
  it('splits a diff into files with status, counts and numbered lines', () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['src/a.ts', 'modified', 2, 1],
      ['src/new.ts', 'added', 2, 0],
      ['old.txt', 'deleted', 0, 1],
    ]);
    expect(diffTotals(files)).toEqual({ files: 3, added: 4, removed: 2 });
    const a = files[0]!;
    expect(a.lines.filter((l) => l.kind === 'hunk')).toHaveLength(1);
    const kinds = a.lines.filter((l) => l.kind !== 'meta').map((l) => `${l.kind}:${l.text}`);
    expect(kinds).toEqual([
      expect.stringContaining('hunk:@@'),
      'ctx:keep',
      'del:old line',
      'add:new line',
      'add:another new line',
      'ctx:tail',
    ]);
    const add = a.lines.find((l) => l.kind === 'add');
    expect(add).toMatchObject({ newNo: 2 });
    expect(a.lines.find((l) => l.kind === 'del')).toMatchObject({ oldNo: 2 });
  });
  it('keeps a rename and a binary file and survives text that is not a diff', () => {
    const files = parseUnifiedDiff(
      'diff --git a/x.ts b/y.ts\nsimilarity index 90%\nrename from x.ts\nrename to y.ts\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n',
    );
    expect(files.map((f) => f.status)).toEqual(['renamed', 'binary']);
    expect(files[0]).toMatchObject({ path: 'y.ts', oldPath: 'x.ts' });
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('just a note\n')).toHaveLength(1);
  });
});

describe('DiffView', () => {
  it('shows a block per file with counts, colours added and removed lines and collapses per file', async () => {
    const user = userEvent.setup();
    render(<DiffView diff={DIFF} />);
    expect(screen.getByTestId('diff-totals')).toHaveTextContent('3 files changed');
    const blocks = screen.getAllByTestId('diff-file');
    expect(blocks).toHaveLength(3);
    const first = blocks[0] as HTMLElement;
    const added = within(first).getByText('new line').closest('tr') as HTMLElement;
    const removed = within(first).getByText('old line').closest('tr') as HTMLElement;
    expect(added).toHaveAttribute('data-kind', 'add');
    expect(added.className).toContain('success');
    expect(removed).toHaveAttribute('data-kind', 'del');
    expect(removed.className).toContain('danger');
    // collapse one file
    await user.click(within(first).getByTestId('diff-file-toggle'));
    expect(within(first).queryByTestId('diff-file-body')).toBeNull();
    expect(within(blocks[1] as HTMLElement).getByTestId('diff-file-body')).toBeInTheDocument();
    await user.click(screen.getByTestId('diff-collapse-all'));
    expect(screen.queryAllByTestId('diff-file-body')).toHaveLength(0);
    await user.click(screen.getByTestId('diff-expand-all'));
    expect(screen.getAllByTestId('diff-file-body')).toHaveLength(3);
  });
  it('says when the diff was cut and when it is empty', () => {
    const { rerender } = render(<DiffView diff={DIFF} truncated />);
    expect(screen.getByTestId('diff-truncated')).toHaveTextContent('larger than 2 MB');
    rerender(<DiffView diff="" />);
    expect(screen.getByTestId('diff-empty')).toBeInTheDocument();
  });
});

const CARD = '0192f3a0-0000-7000-8000-0000000000c1';
const ME = '0192f3a0-0000-7000-8000-0000000000a1';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const review = (over: Partial<ApprovalReviewInfo> = {}): ApprovalReviewInfo => ({
  sha: 'a1'.repeat(20),
  stale: false,
  highRisk: true,
  highRiskPaths: ['apps/server/migrations/2200_x.sql'],
  riskTier: 'large',
  reason: 'the change touches high-risk paths (data and migrations)',
  diff: { bytes: DIFF.length, truncated: false, files: 3 },
  evidence: {
    commands: [
      { kind: 'build', command: 'pnpm build', status: 'passed', result: 'ok' },
      { kind: 'test', command: 'pnpm test', status: 'passed', result: '3 passed' },
    ],
    waived: null,
  },
  verdicts: [{ reviewerName: 'Rex', score: 4, risk: 'medium', comments: 'Looks right' }],
  designSummary: 'Build it in module X.',
  cardBrief: 'Use the existing queue.',
  ...over,
});
const approval = (r: ApprovalReviewInfo | undefined): CardApproval => ({
  state: 'open',
  stageId: 'owner_approval',
  stageLabel: 'Owner approval',
  approver: { userId: ME, name: 'Pieter' },
  approverKind: 'project_owner',
  fellBack: false,
  openedAt: '2026-10-14T10:00:00.000Z',
  approveTo: 'Test deploy',
  sendBackTo: 'Build',
  decision: null,
  sentBackCount: 0,
  canAct: true,
  deskItemId: null,
  ...(r ? { review: r } : {}),
});

describe('the owner approval with the diff', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (String(url).includes('/diff'))
        return json({
          sha: 'a1'.repeat(20),
          base: 'origin/main',
          body: DIFF,
          bytes: DIFF.length,
          truncated: false,
          files: 3,
          at: '2026-10-14T10:00:00.000Z',
        });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const wrap = (ui: React.ReactElement) => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('shows why, the commit, the evidence and the verdicts, and loads the diff when it is opened (open by default for an open approval)', async () => {
    wrap(<ApprovalPanel cardId={CARD} approval={approval(review())} />);
    expect(screen.getByTestId('approval-sha')).toHaveTextContent('commit a1a1a1a1a1');
    expect(screen.getByTestId('approval-high-risk')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reason')).toHaveTextContent('high-risk paths');
    expect(screen.getByTestId('approval-evidence')).toHaveTextContent('pnpm test');
    expect(screen.getByTestId('approval-verdicts')).toHaveTextContent('Rex approved (score 4, risk medium)');
    await waitFor(() => expect(screen.getByTestId('diff-view')).toBeInTheDocument());
    expect(screen.getAllByTestId('diff-file')).toHaveLength(3);
    const [url] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/diff')) as [string];
    expect(url).toContain(`/cards/${CARD}/diff`);
  });

  it('warns when the code changed since the diff was shown, and says when no diff was stored', () => {
    wrap(<ApprovalPanel cardId={CARD} approval={approval(review({ stale: true, diff: null }))} />);
    expect(screen.getByTestId('approval-stale')).toBeInTheDocument();
    expect(screen.getByTestId('approval-no-diff')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/diff'))).toBe(false);
  });

  it('approving sends the commit whose diff is shown', async () => {
    const user = userEvent.setup();
    wrap(<ApprovalPanel cardId={CARD} approval={approval(review())} />);
    await user.click(screen.getByTestId('approval-approve'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/approval/approve'))).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/approval/approve')) as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ sha: 'a1'.repeat(20) });
  });

  it('an approval step of the older workflows has no review block', () => {
    wrap(<ApprovalPanel cardId={CARD} approval={approval(undefined)} />);
    expect(screen.queryByTestId('approval-review')).toBeNull();
    expect(screen.getByTestId('approval-approve')).toBeInTheDocument();
  });
});
