import type { RoleDraftInput } from '../api/org.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import type { Seniority } from '../roles/schema.ts';
import { renderInstructions } from './instructions.ts';

/** The step a role preview is rendered for (a step of a custom workflow), or a generic one. */
export interface PreviewStage {
  workflowKey?: string;
  stageId: string;
  stageLabel: string;
  doneCriteria: string;
  outcomes: ShiftBrief['shift']['outcomes'];
  maxShiftMinutes: number;
  /** Card fields to show in the sample card (key -> sample value). */
  fields?: Record<string, unknown>;
}

/** Used when no workflow step is chosen: one success route. */
export const GENERIC_PREVIEW_STAGE: PreviewStage = {
  stageId: 'work',
  stageLabel: 'Work',
  doneCriteria: 'The work described on the card is complete.',
  outcomes: [{ id: 'done', label: 'Done', kind: 'success', data: 'none' }],
  maxShiftMinutes: 60,
};

const ZERO = '00000000-0000-4000-8000-000000000000';

type PreviewRole = Pick<
  RoleDraftInput,
  'key' | 'name' | 'instructions' | 'coreRules' | 'skills' | 'seniorityLevels'
>;

/**
 * A synthetic shift brief for previewing a role's instructions: a sample agent, project and card, no real data. The
 * preview never runs an agent (docs/design/workflow-builder.md section 3).
 */
export function buildPreviewBrief(
  role: PreviewRole,
  stage: PreviewStage = GENERIC_PREVIEW_STAGE,
  seniority?: Seniority,
): ShiftBrief {
  return {
    shift: {
      id: ZERO,
      kind: 'card',
      stage: stage.stageId,
      stageLabel: stage.stageLabel,
      doneCriteria: stage.doneCriteria,
      outcomes: stage.outcomes,
      maxShiftMinutes: stage.maxShiftMinutes,
    },
    agent: { id: ZERO, name: 'Sample Agent', seniority: seniority ?? role.seniorityLevels[0] ?? 'junior' },
    card: {
      id: ZERO,
      ref: 'SAMPLE-1',
      title: 'A sample card',
      cardType: 'support',
      fields: stage.fields ?? {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: ZERO,
      key: 'SAMPLE',
      name: 'Sample project',
      workingBranch: 'main',
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: {
      key: role.key || 'role',
      name: role.name || 'Unnamed role',
      instructions: role.instructions,
      coreRules: role.coreRules,
      skills: role.skills,
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: [],
    ledger: [],
  };
}

/** The `CLAUDE.md` text an agent with this role would get on a sample shift (the real renderer, a sample brief). */
export function renderRolePreview(role: PreviewRole, stage?: PreviewStage, seniority?: Seniority): string {
  return renderInstructions(buildPreviewBrief(role, stage, seniority));
}
