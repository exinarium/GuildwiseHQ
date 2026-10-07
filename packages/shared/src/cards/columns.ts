import type { Stage, WorkflowDefinition } from '../workflows/schema.ts';
import type { CardStatus } from './types.ts';

export const COLUMN = {
  spec: 'Spec',
  todo: 'To do',
  rework: 'Rework',
  inProgress: 'In progress',
  blocked: 'Blocked',
  waiting: 'Test (waiting on bug)',
} as const;

/** Code board order from docs/ARCHITECTURE.md section 6.5 (the waiting column is added by `boardColumns`). */
export const CODE_BOARD_COLUMNS = [
  'Spec',
  'To do',
  'Rework',
  'In progress',
  'Blocked',
  'Review',
  'Test',
  'Docs',
  'Finalize',
  'Done',
] as const;

export interface ColumnCard {
  status: CardStatus;
  stage: string;
  reworkRound: number;
  cardType?: string;
  /** `awaiting_approval` / `running` while a Finalize merge is pending: such a waiting card stays in its stage column. */
  finalizeState?: string | null;
}

/** True while a Finalize attempt holds the card in `waiting` (waiting for the manager's approval, or running). */
export const isFinalizeWait = (card: Pick<ColumnCard, 'status' | 'finalizeState'>): boolean =>
  card.status === 'waiting' &&
  (card.finalizeState === 'awaiting_approval' || card.finalizeState === 'running');

/**
 * Board column of a card (section 6.5). `draft` -> Spec; `blocked` -> Blocked; `waiting` -> Test (waiting on bug);
 * `build` claimed -> In progress; `build` queued with rework or a bug -> Rework; `build` queued -> To do;
 * otherwise the stage's own column. Cancelled cards are not on the board (callers filter them).
 */
export function columnFor(card: ColumnCard, stage: Pick<Stage, 'id' | 'column'>): string {
  if (card.status === 'draft') return COLUMN.spec;
  if (card.status === 'blocked') return COLUMN.blocked;
  if (card.status === 'waiting' && !isFinalizeWait(card)) return COLUMN.waiting;
  if (stage.id === 'build') {
    if (card.status === 'claimed') return COLUMN.inProgress;
    if (card.status === 'queued')
      return card.reworkRound > 0 || card.cardType === 'bug' ? COLUMN.rework : COLUMN.todo;
  }
  return stage.column;
}

/**
 * The board of a project whose open cards run on other workflows than the project's own (research cards in a code
 * project, cards kept through a conversion): the project's columns, then the columns of those workflows, inserted before
 * the terminal column and de-duplicated by label. They appear only while such cards exist.
 */
export function boardColumnsWith(
  def: Pick<WorkflowDefinition, 'stages'>,
  others: ReadonlyArray<Pick<WorkflowDefinition, 'stages'>>,
): string[] {
  const own = boardColumns(def);
  const last = own[own.length - 1];
  const terminal = def.stages.some((s) => s.kind === 'terminal' && s.column === last) ? last : undefined;
  const head = terminal ? own.slice(0, -1) : [...own];
  for (const o of others) {
    for (const c of boardColumns(o)) {
      if (own.includes(c) || head.includes(c)) continue;
      // The other workflow's terminal column is the same "Done" in practice; any other terminal label stays last.
      head.push(c);
    }
  }
  return terminal ? [...head, terminal] : head;
}

/** Ordered, de-duplicated board columns for a workflow. For `code` this is CODE_BOARD_COLUMNS plus the waiting column after Test. */
export function boardColumns(def: Pick<WorkflowDefinition, 'stages'>): string[] {
  const out: string[] = [];
  const push = (c: string) => {
    if (!out.includes(c)) out.push(c);
  };
  const hasBuild = def.stages.some((s) => s.id === 'build');
  if (def.stages.some((s) => s.kind === 'manual')) push(COLUMN.spec);
  for (const s of def.stages) {
    if (s.kind === 'terminal') continue;
    if (s.id === 'build') {
      push(COLUMN.todo);
      push(COLUMN.rework);
      push(COLUMN.inProgress);
      push(COLUMN.blocked);
    } else {
      push(s.column);
    }
    if (s.outcomes.some((o) => o.effect === 'spawn_bug_child')) push(COLUMN.waiting);
  }
  if (!hasBuild) push(COLUMN.blocked);
  for (const s of def.stages) if (s.kind === 'terminal') push(s.column);
  return out;
}
