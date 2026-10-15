import { BUILTIN_ROLES, type ShiftBrief, uuidv7 } from '@aom/shared';

export type Stage = 'investigate' | 'build' | 'review' | 'test' | 'finalize';

const OUTCOMES: Record<Stage, ShiftBrief['shift']['outcomes']> = {
  investigate: [
    { id: 'handoff', label: 'Hand off the design to build', kind: 'success', data: 'investigation' },
  ],
  build: [{ id: 'handoff', label: 'Hand off for review', kind: 'success', data: 'diffStats' }],
  review: [
    { id: 'approve', label: 'Approve', kind: 'success', data: 'review' },
    { id: 'changes', label: 'Request changes', kind: 'failure', data: 'review' },
  ],
  test: [
    { id: 'pass', label: 'Pass', kind: 'success', data: 'testEvidence' },
    { id: 'fail', label: 'Fail', kind: 'failure', data: 'testEvidence' },
  ],
  finalize: [{ id: 'finalized', label: 'Finalized', kind: 'success', data: 'finalize' }],
};
const ROLE: Record<Stage, string> = {
  investigate: 'architect',
  build: 'builder',
  review: 'reviewer',
  test: 'tester',
  finalize: 'ba',
};

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
  mode?: 'create' | 'reuse' | 'readonly';
  worktreePath?: string;
  rebase?: boolean;
  cardType?: string;
  /** Extra card fields (e.g. `mockEnv`). */
  fields?: Record<string, unknown>;
  /** Files attached to the card (the brief carries their metadata). */
  attachments?: NonNullable<ShiftBrief['card']['attachments']>;
  /** Merged into the brief (e.g. `investigation`, a card with `investigationOnly`). */
  briefExtra?: Partial<ShiftBrief>;
  /** Replaces the brief's outcomes (e.g. the architect's `report` outcome). */
  outcomes?: ShiftBrief['shift']['outcomes'];
  /** Merged into `prepare` (e.g. `syncMain`). */
  prepare?: Record<string, unknown>;
  /** Merged into the `shift.start` message (e.g. `orgId`, `vault`, `readRepos`). */
  startExtra?: Record<string, unknown>;
  /** Merged into the worktree spec (e.g. `baseBranch`, `mainBranch`). */
  worktreeExtra?: Record<string, unknown>;
}

const projectIds = new Map<string, string>();
/**
 * One stable project id per key, as in production: the worktree directory is `<KEY>-<project id prefix>/<REF>`, so a
 * fresh id per shift would put each shift of a card in a different directory. (A fresh uuidv7 keeps its first 8 hex
 * digits for ~65 s, which is why that bug only showed when a run crossed the boundary.)
 */
export function projectIdFor(key: string): string {
  let id = projectIds.get(key);
  if (!id) {
    id = uuidv7();
    projectIds.set(key, id);
  }
  return id;
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
      outcomes: o.outcomes ?? OUTCOMES[stage],
      maxShiftMinutes: o.maxShiftMinutes ?? 30,
    },
    agent: { id: agentId, name, seniority: 'senior' },
    card: {
      id: uuidv7(),
      ref,
      title,
      cardType: o.cardType ?? 'feature',
      fields: {
        context: 'ctx',
        affectedAreas: 'src/greeting.ts',
        ...(o.mock ? { mock: o.mock } : {}),
        ...(o.fields ?? {}),
      },
      riskTier: 'small',
      reworkRound: o.reworkRound ?? 0,
      completionAction: 'merge',
      docsNeeded: false,
      dependencies: [],
      ...(o.attachments ? { attachments: o.attachments } : {}),
    },
    project: {
      id: projectIdFor(key),
      key,
      name: 'Toy',
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
    ...(o.briefExtra ?? {}),
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
      mode:
        o.mode ?? ((stage === 'build' || stage === 'investigate') && !o.worktreePath ? 'create' : 'reuse'),
      repoId: uuidv7(),
      remoteUrlNormalized: o.remoteNormalized,
      baseBranch: 'main',
      branchName: branch,
      ...(o.worktreePath ? { path: o.worktreePath } : {}),
      ...(o.worktreeExtra ?? {}),
    },
    prepare: { rebase: o.rebase ?? false, ...(o.prepare ?? {}) },
    maxShiftMinutes: o.maxShiftMinutes ?? 30,
    ...(o.startExtra ?? {}),
  };
}
