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
}

/**
 * Board column of a card (section 6.5). `draft` -> Spec; `blocked` -> Blocked; `waiting` -> Test (waiting on bug);
 * `build` claimed -> In progress; `build` queued with rework or a bug -> Rework; `build` queued -> To do;
 * otherwise the stage's own column. Cancelled cards are not on the board (callers filter them).
 */
export function columnFor(card: ColumnCard, stage: Pick<Stage, 'id' | 'column'>): string {
  if (card.status === 'draft') return COLUMN.spec;
  if (card.status === 'blocked') return COLUMN.blocked;
  if (card.status === 'waiting') return COLUMN.waiting;
  if (stage.id === 'build') {
    if (card.status === 'claimed') return COLUMN.inProgress;
    if (card.status === 'queued')
      return card.reworkRound > 0 || card.cardType === 'bug' ? COLUMN.rework : COLUMN.todo;
  }
  return stage.column;
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
