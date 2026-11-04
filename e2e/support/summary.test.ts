import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSummary, summarize } from './summary.ts';

const t = (projectName: string, ...statuses: string[]) => ({ projectName, results: statuses.map((status) => ({ status })) });
const report = {
  config: { metadata: { excludedProjects: [{ name: 'deploy-move', reason: 'Docker is not available in tester shifts: run by DevOps' }] } },
  stats: { duration: 792000 },
  suites: [
    {
      specs: [
        { title: 'a', file: 'a.spec.ts', line: 1, tests: [t('auth', 'passed')] },
        { title: 'b', file: 'b.spec.ts', line: 2, tests: [t('chat', 'failed')] },
        { title: 'c', file: 'c.spec.ts', line: 3, tests: [t('chat', 'skipped')] },
        { title: 'd', file: 'd.spec.ts', line: 4, tests: [t('hr')] },
        { title: 'e', file: 'e.spec.ts', line: 5, tests: [t('hr', 'failed', 'passed')] },
      ],
    },
  ],
};

test('counts each outcome, the duration and the not-run-here lines', () => {
  const s = summarize(report);
  assert.deepEqual([s.passed, s.failed, s.skipped, s.didNotRun, s.flaky], [2, 1, 1, 1, 1]);
  assert.equal(s.durationMin, 13.2);
  const out = formatSummary(s);
  assert.match(out, /passed 2, failed 1, skipped 1, did not run 1, flaky 1, duration 13.2 min/);
  assert.match(out, /chat: b \(b\.spec\.ts:2\)/);
  assert.match(out, /not run here: deploy-move/);
});
