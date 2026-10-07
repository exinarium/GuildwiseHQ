import { BUILTIN_ROLES, type ShiftBrief, uuidv7 } from '@aom/shared';
import { makeShiftStart } from './fixtures.ts';

export interface ResearchShiftOptions {
  stage: 'research' | 'factcheck';
  fields?: Record<string, unknown>;
  reworkRound?: number;
  handoffs?: ShiftBrief['handoffs'];
  vault?: { vaultId: string; kind: 'org' | 'project'; folder: string } | null;
  shiftId?: string;
}

/** A `shift.start` for a research card (researcher at `research`, checker at `factcheck`): no worktree, no repo. */
export function makeResearchShiftStart(o: ResearchShiftOptions): Record<string, unknown> {
  const base = makeShiftStart({
    remoteNormalized: 'unused',
    ref: 'SHOOT-1',
    title: 'Is 6mm ARC enough for deer?',
    shiftId: o.shiftId,
  });
  const roleKey = o.stage === 'research' ? 'researcher' : 'checker';
  const role = BUILTIN_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error('role missing');
  const brief = base.brief as ShiftBrief;
  const outcomes: ShiftBrief['shift']['outcomes'] =
    o.stage === 'research'
      ? [{ id: 'handoff', label: 'Hand off to fact check', kind: 'success', data: 'none' }]
      : [
          { id: 'published', label: 'Published', kind: 'success', data: 'publication' },
          { id: 'unsupported', label: 'Unsupported claims', kind: 'failure', data: 'none' },
        ];
  const agent = base.agent as Record<string, unknown>;
  return {
    ...base,
    agent: { ...agent, roleKey, permissions: role.permissions },
    worktree: null,
    vault: o.vault === undefined ? null : o.vault,
    brief: {
      ...brief,
      shift: {
        ...brief.shift,
        stage: o.stage,
        stageLabel: o.stage === 'research' ? 'Research' : 'Fact check',
        outcomes,
      },
      card: {
        ...brief.card,
        id: uuidv7(),
        cardType: 'research',
        reworkRound: o.reworkRound ?? 0,
        fields: {
          question: 'Is the 6mm ARC enough for deer at 300 yards?',
          depth: 'standard',
          subCategory: 'Hunting ballistics',
          ...o.fields,
        },
      },
      project: { ...brief.project, key: 'SHOOT', name: 'Shooting' },
      role: {
        key: role.key,
        name: role.name,
        instructions: role.instructions,
        coreRules: role.coreRules,
        skills: [],
      },
      handoffs: o.handoffs ?? [],
    },
  };
}

export const DRAFT = [
  '# Is 6mm ARC enough for deer?',
  '',
  '- 6mm ARC delivers about 1500 ft-lb at 300 yards [1]',
  '- Most states set a minimum of 1000 ft-lb for deer [2]',
  '',
  'References',
  '1. Hornady ballistics - https://example.test/research/1',
  '2. State regulations - https://example.test/research/2',
  '',
].join('\n');

export const researchHandoff = (note = DRAFT): ShiftBrief['handoffs'] => [
  { stage: 'research', agentName: 'Rhea', outcome: 'handoff', note, at: '2026-10-03T08:00:00.000Z' },
];
