import { BUILTIN_ROLES, type ShiftBrief } from '../src/index.ts';

export const U = {
  a: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  b: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
  c: '019e3f6a-7b1c-7a2d-8c3e-0123456789a3',
  d: '019e3f6a-7b1c-7a2d-8c3e-0123456789a4',
  e: '019e3f6a-7b1c-7a2d-8c3e-0123456789a5',
};
export const TS = '2026-10-03T12:00:00.000Z';
export const env = <T extends string>(type: T) => ({ v: 1 as const, id: U.e, type, ts: TS });

export const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
export const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer')!;

export const agentSpec = {
  agentId: U.b,
  name: 'Ada',
  roleKey: 'builder',
  seniority: 'junior' as const,
  runtime: 'claude-code',
  model: 'sonnet',
  effort: 'medium',
  skills: [],
  permissions: builder.permissions,
  isDevops: false,
};

export const buildBrief = (): ShiftBrief => ({
  shift: {
    id: U.a,
    kind: 'card',
    stage: 'build',
    stageLabel: 'Build',
    doneCriteria: 'The change builds, all unit tests pass, and the work is committed.',
    outcomes: [{ id: 'handoff', label: 'Hand off for review', kind: 'success', data: 'diffStats' }],
    maxShiftMinutes: 60,
  },
  agent: { id: U.b, name: 'Ada', seniority: 'junior' },
  card: {
    id: U.c,
    ref: 'WEB-12',
    title: 'Add login page',
    cardType: 'feature',
    fields: {
      context: 'Users cannot sign in yet.',
      requirements: 'A login form posting to /api/auth/login.',
      acceptanceCriteria: ['Form validates email', 'Errors are shown inline'],
      affectedAreas: 'apps/web/src/pages/Login.tsx',
      constraints: 'No new dependencies.',
      testPlan: 'Unit test the form validation.',
    },
    riskTier: 'small',
    reworkRound: 0,
    completionAction: 'pr',
    docsNeeded: false,
    dependencies: [{ ref: 'WEB-3', title: 'Auth API', status: 'done' }],
  },
  project: {
    id: U.d,
    key: 'WEB',
    name: 'Web app',
    workingBranch: 'main',
    e2eGlobs: ['e2e/**'],
    architecturalGlobs: ['apps/web/src/router.tsx'],
  },
  role: {
    key: 'builder',
    name: 'Builder',
    instructions: 'Build the card.\nRun the tests.',
    coreRules: ['Never push.', 'Never edit E2E tests.'],
    skills: [],
  },
  handoffs: [],
  reviewComments: [],
  thread: [{ authorName: 'Pieter', kind: 'comment', body: 'Please keep it simple.', at: TS }],
  standingOrders: [{ title: 'Commit style', body: 'Use conventional commits.' }],
  ledger: [{ id: U.e, scope: 'decision', title: 'Use cookies', body: 'Session cookie auth.' }],
});

export const reworkReviewBrief = (): ShiftBrief => {
  const b = buildBrief();
  return {
    ...b,
    shift: {
      ...b.shift,
      stage: 'review',
      stageLabel: 'Review',
      doneCriteria: 'Every acceptance criterion was checked.',
      outcomes: [
        { id: 'approve', label: 'Approve', kind: 'success', data: 'review' },
        { id: 'changes', label: 'Request changes', kind: 'failure', data: 'review' },
      ],
    },
    card: { ...b.card, reworkRound: 1, riskTier: 'large', parent: { ref: 'WEB-1', title: 'Epic' } },
    handoffs: [
      { stage: 'build', agentName: 'Ada', outcome: 'handoff', note: 'Implemented the form.', at: TS },
    ],
    reviewComments: [
      {
        reviewerName: 'Grace',
        reasons: ['weak_tests'],
        criteriaMissed: ['Errors are shown inline'],
        comments: 'Add a test for the error state.',
        at: TS,
      },
    ],
    role: { ...b.role, key: 'reviewer', name: 'Reviewer', extensions: 'Be kind.' },
    agent: { id: U.b, name: 'Grace', seniority: 'senior' },
  };
};
