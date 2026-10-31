import { BUSINESS_ROLES } from '../roles/business.ts';
import { type WorkflowDefinition, WorkflowDefinitionSchema } from './schema.ts';

export const BRIEF_STAGE_ID = 'brief';
export const BRIEF_DONE_STAGE_ID = 'done';
export const BRIEF_WORKFLOW_PREFIX = 'business-brief-';

export const briefWorkflowKey = (roleKey: string): string =>
  `${BRIEF_WORKFLOW_PREFIX}${roleKey.replace(/_/g, '-')}`;
export const isBriefWorkflowKey = (key: string | null | undefined): boolean =>
  !!key?.startsWith(BRIEF_WORKFLOW_PREFIX);

/** Business roles whose Patterns column in the role table names Brief. */
export const BRIEF_OWNER_ROLES = ['personal_assistant', 'operations_analyst', 'billing_clerk'] as const;
export type BriefOwnerRole = (typeof BRIEF_OWNER_ROLES)[number];

const outcome = (id: string, to: string, event: 'StageCompleted' | 'CardSpecified') => ({
  id,
  label: id,
  kind: 'success' as const,
  to,
  event,
  data: 'none' as const,
  rework: false,
  effect: 'none' as const,
});

const base = {
  seniorOnly: false,
  worktree: 'none' as const,
  rebaseBefore: false,
  syncMainBefore: false,
  requiredCapabilities: [],
  environment: 'none' as const,
};

/**
 * The Brief pattern: request -> brief (an agent of the owner role writes a short brief from the snapshot of what
 * changed) -> done. No approval, no repository, branch, build, review or merge step: the brief is delivered when the
 * card is done.
 */
export function briefWorkflow(roleKey: string): WorkflowDefinition {
  const role = BUSINESS_ROLES.find((r) => r.key === roleKey);
  return WorkflowDefinitionSchema.parse({
    key: briefWorkflowKey(roleKey),
    version: 1,
    name: `Brief (${role?.name ?? roleKey})`,
    builtIn: false,
    fieldSet: 'custom',
    customFields: [
      { key: 'requirements', label: 'What to write', type: 'markdown', required: true },
      { key: 'maxWords', label: 'Word cap', type: 'number', required: true },
      { key: 'context', label: 'What changed', type: 'markdown', required: false },
      { key: 'period', label: 'Period', type: 'text', required: false },
    ],
    cardTypes: ['report'],
    initialStage: 'request',
    stages: [
      {
        ...base,
        id: 'request',
        label: 'Request',
        column: 'Request',
        kind: 'manual',
        claimRole: null,
        requiredFields: [],
        doneCriteria: 'The card is started.',
        outcomes: [outcome('specified', BRIEF_STAGE_ID, 'CardSpecified')],
        maxShiftMinutes: 60,
      },
      {
        ...base,
        id: BRIEF_STAGE_ID,
        label: 'Brief',
        column: 'Writing',
        kind: 'agent',
        claimRole: roleKey,
        requiredFields: ['requirements', 'maxWords'],
        doneCriteria:
          'The brief is your full handoff note: plain language, at most the word cap, every card named by its ref and every rule by its ledger id from the Context, nothing that is not in the Context or the knowledge folder.',
        outcomes: [outcome('done', BRIEF_DONE_STAGE_ID, 'StageCompleted')],
        maxShiftMinutes: 20,
      },
      {
        ...base,
        id: BRIEF_DONE_STAGE_ID,
        label: 'Done',
        column: 'Done',
        kind: 'terminal',
        claimRole: null,
        requiredFields: [],
        doneCriteria: '',
        outcomes: [],
        maxShiftMinutes: 60,
      },
    ],
  });
}
