import { BUILTIN_ROLES, type ShiftBrief, uuidv7 } from '@aom/shared';

export type Stage = 'build' | 'review' | 'test';

const OUTCOMES: Record<Stage, ShiftBrief['shift']['outcomes']> = {
  build: [{ id: 'handoff', label: 'Hand off for review', kind: 'success', data: 'diffStats' }],
  review: [
    { id: 'approve', label: 'Approve', kind: 'success', data: 'review' },
    { id: 'changes', label: 'Request changes', kind: 'failure', data: 'review' },
  ],
  test: [
    { id: 'pass', label: 'Pass', kind: 'success', data: 'testEvidence' },
    { id: 'fail', label: 'Fail', kind: 'failure', data: 'none' },
  ],
};
const ROLE: Record<Stage, string> = { build: 'builder', review: 'reviewer', test: 'tester' };

export interface ShiftOptions {
  stage?: Stage;
  remoteNormalized: string;
  projectKey?: string;
  ref?: string;
  title?: string;
  mock?: Record<string, string[]>;
  reworkRound?: number;
  e2eGlobs?: string[];
  architecturalGlobs?: string[];
  maxShiftMinutes?: number;
  shiftId?: string;
  agentId?: string;
  agentName?: string;
  mode?: 'create' | 'reuse';
  worktreePath?: string;
  rebase?: boolean;
  cardType?: string;
}

/** A valid `shift.start` payload for the runner (the server's gateway builds the real one). */
export function makeShiftStart(o: ShiftOptions): Record<string, unknown> {
  const stage = o.stage ?? 'build';
  const role = BUILTIN_ROLES.find((r) => r.key === ROLE[stage]);
  if (!role) throw new Error('role missing');
  const ref = o.ref ?? 'TOY-1';
  const title = o.title ?? 'Add greeting';
  const shiftId = o.shiftId ?? uuidv7();
  const agentId = o.agentId ?? uuidv7();
  const name = o.agentName ?? 'Ada';
  const key = o.projectKey ?? 'TOY';
  const branch = `aom/${ref.toLowerCase()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const brief: ShiftBrief = {
    shift: {
      id: shiftId,
      kind: 'card',
      stage,
      stageLabel: stage[0]?.toUpperCase() + stage.slice(1),
      doneCriteria: 'Done.',
      outcomes: OUTCOMES[stage],
      maxShiftMinutes: o.maxShiftMinutes ?? 30,
    },
    agent: { id: agentId, name, seniority: 'senior' },
    card: {
      id: uuidv7(),
      ref,
      title,
      cardType: o.cardType ?? 'feature',
      fields: { context: 'ctx', affectedAreas: 'src/greeting.ts', ...(o.mock ? { mock: o.mock } : {}) },
      riskTier: 'small',
      reworkRound: o.reworkRound ?? 0,
      completionAction: 'push_branch',
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: uuidv7(),
      key,
      name: 'Toy',
      domain: 'work',
      workingBranch: 'main',
      e2eGlobs: o.e2eGlobs ?? ['e2e/**'],
      architecturalGlobs: o.architecturalGlobs ?? [],
    },
    role: {
      key: role.key,
      name: role.name,
      instructions: role.instructions,
      coreRules: role.coreRules,
      skills: [],
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: [],
    ledger: [],
  };
  return {
    shiftId,
    claimId: uuidv7(),
    kind: 'card',
    agent: {
      agentId,
      name,
      roleKey: role.key,
      seniority: 'senior',
      runtime: 'mock',
      model: 'mock',
      skills: [],
      permissions: role.permissions,
      isDevops: false,
    },
    brief,
    worktree: {
      mode: o.mode ?? (stage === 'build' && !o.worktreePath ? 'create' : 'reuse'),
      repoId: uuidv7(),
      remoteUrlNormalized: o.remoteNormalized,
      baseBranch: 'main',
      branchName: branch,
      ...(o.worktreePath ? { path: o.worktreePath } : {}),
    },
    prepare: { rebase: o.rebase ?? false },
    maxShiftMinutes: o.maxShiftMinutes ?? 30,
  };
}
