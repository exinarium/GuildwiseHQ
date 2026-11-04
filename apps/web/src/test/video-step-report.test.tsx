import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stepReports } from '../components/delivery/ReleaseDocsPrepTab.tsx';
import { VideoStepReport } from '../components/delivery/VideoStepReport.tsx';

const row = (phase: string, report: Record<string, unknown> | null, state = 'passed') => ({
  step: 'videos',
  phase,
  state: state as 'passed',
  startedAt: null,
  finishedAt: null,
  error: null,
  files: [],
  report,
});

describe('Generate videos report', () => {
  it('names each video with its action, reasons and state, and the voice and rule', () => {
    render(
      <VideoStepReport
        report={{
          harness: true,
          rule: 'A changed screen re-renders every video that shows it.',
          voice: 'Kokoro af_heart',
          videos: [
            {
              slug: 'backlog',
              action: 'regenerate',
              reasons: ['screen Backlog changed: Backlog.tsx (GWP-12)'],
              state: 'rendered',
            },
            {
              slug: 'forms',
              title: 'Forms',
              action: 'create',
              reasons: ['new screen Forms'],
              state: 'rendered',
            },
          ],
          shared: ['apps/web/src/components/shell/Sidebar.tsx'],
          unmapped: [],
          ignoredCount: 3,
        }}
      />,
    );
    expect(screen.getByText(/voice Kokoro af_heart/)).toBeTruthy();
    expect(screen.getByText('How videos are chosen')).toBeTruthy();
    const backlog = screen.getByTestId('video-report-backlog');
    expect(backlog.textContent).toContain('Re-render');
    expect(backlog.textContent).toContain('screen Backlog changed: Backlog.tsx (GWP-12)');
    expect(screen.getByTestId('video-report-forms').textContent).toContain('New');
    expect(screen.getByText(/watch it on the test site/)).toBeTruthy();
    expect(screen.getByText(/Shared UI changed \(1\)/)).toBeTruthy();
  });

  it('shows a render failure with the video and its error inline', () => {
    render(
      <VideoStepReport
        report={{
          harness: true,
          videos: [
            {
              slug: 'backlog',
              action: 'regenerate',
              reasons: ['r'],
              state: 'failed',
              error: 'selector not found\nat line 3',
            },
          ],
        }}
      />,
    );
    const v = screen.getByTestId('video-report-backlog');
    expect(v.textContent).toContain('failed');
    expect(v.textContent).toContain('selector not found');
    expect(v.querySelector('pre')?.textContent).toContain('at line 3');
  });

  it("shows 'skipped: no videos' for a repository without a harness", () => {
    render(<VideoStepReport report={{ harness: false }} />);
    expect(screen.getByTestId('video-report-no-harness').textContent).toContain('skipped: no videos');
  });

  it('picks the latest phase report and ignores the author bookkeeping', () => {
    const plan = { harness: true, videos: [] };
    const rendered = {
      harness: true,
      videos: [{ slug: 'b', action: 'regenerate', reasons: [], state: 'rendered' }],
    };
    expect(stepReports([row('plan', plan), row('author', { authored: [] })])).toEqual([
      { step: 'videos', report: plan },
    ]);
    expect(
      stepReports([row('plan', plan), row('author', { authored: [] }), row('render', rendered)]),
    ).toEqual([{ step: 'videos', report: rendered }]);
    expect(stepReports([{ ...row('', { x: 1 }), step: 'analyse' }])).toEqual([]);
  });
});
