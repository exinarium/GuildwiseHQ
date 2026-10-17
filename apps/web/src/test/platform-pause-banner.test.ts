import type { PlatformPauseDto } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { pausesForProject } from '../components/platform/PlatformPauseBanner.tsx';

const pause = (over: Partial<PlatformPauseDto>): PlatformPauseDto => ({
  id: crypto.randomUUID(),
  projectId: null,
  projectKey: null,
  workflowKey: null,
  stageId: null,
  workstationId: null,
  workstationName: null,
  reason: 'a bug',
  source: 'auto',
  severity: 'critical',
  bugCardId: null,
  bugCardRef: null,
  createdAt: new Date().toISOString(),
  resumedAt: null,
  resumeReason: null,
  ...over,
});

describe('platform pause banner', () => {
  it('shows a project its own pauses and the ones that cover every project, not those of other projects or workstations', () => {
    const mine = pause({ projectId: 'p1' });
    const everyone = pause({ workflowKey: 'code', stageId: 'build' });
    const other = pause({ projectId: 'p2' });
    const ws = pause({ workstationId: 'w1' });
    expect(pausesForProject([mine, everyone, other, ws], 'p1')).toEqual([mine, everyone]);
  });
});
