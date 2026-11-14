import { z } from 'zod';
import { type CardTemplate, OutputDestinationSchema } from '../events/schedule.ts';
import type { RulePack } from '../ledger/rule-packs.ts';
import { BRIEF_OWNER_ROLES, briefWorkflowKey } from '../workflows/brief.ts';

/** The ready-made Brief playbooks. (Not related to the `/` playbooks of the capabilities.) */
export const BriefPlaybookKey = z.enum([
  'morning_plan',
  'weekly_owner_brief',
  'accounting_deadline_brief',
  'law_matter_dates_brief',
]);
export type BriefPlaybookKey = z.infer<typeof BriefPlaybookKey>;

export interface BriefPlaybook {
  key: BriefPlaybookKey;
  /** Set on the playbooks of an industry bundle; those show only once installed. */
  industry?: NonNullable<RulePack['industry']>;
  version: number;
  name: string;
  description: string;
  cadence: 'workdays' | 'weekly';
  /** 'HH:MM' */
  defaultTime: string;
  /** Weekly: 0-6, Monday = 1. */
  defaultWeekday?: number;
  defaultOwnerRole: (typeof BRIEF_OWNER_ROLES)[number];
  /** The cap on the words of the brief. */
  maxWords: number;
  /** How far back the brief looks (days). */
  periodDays: number;
  /** Instructions for the agent: what the brief covers. */
  requirements: string;
}

export const BRIEF_PLAYBOOKS: Record<BriefPlaybookKey, BriefPlaybook> = {
  morning_plan: {
    key: 'morning_plan',
    version: 1,
    name: 'Morning plan',
    description:
      "Every working day: today's priorities, follow-ups and reminders that are due, and overdue items.",
    cadence: 'workdays',
    defaultTime: '07:00',
    defaultOwnerRole: 'personal_assistant',
    maxWords: 150,
    periodDays: 1,
    requirements: [
      'Write a morning plan in plain language, as a short read-only digest. Use only what the Context holds. Use these headings:',
      "- Today's priorities",
      '- Due follow-ups and reminders',
      '- Overdue items',
    ].join('\n'),
  },
  weekly_owner_brief: {
    key: 'weekly_owner_brief',
    version: 1,
    name: 'Weekly owner brief',
    description: 'Every week: what was done, what is stuck, decisions made, and what needs the owner.',
    cadence: 'weekly',
    defaultTime: '07:00',
    defaultWeekday: 1,
    defaultOwnerRole: 'operations_analyst',
    maxWords: 300,
    periodDays: 7,
    requirements: [
      'Write the weekly brief for the owner in plain language, as a short read-only digest. Use only what the Context holds. Use these headings:',
      '- What was done',
      '- What is stuck',
      '- Decisions made',
      '- What needs the owner',
    ].join('\n'),
  },
  accounting_deadline_brief: {
    key: 'accounting_deadline_brief',
    industry: 'accounting',
    version: 1,
    name: 'Accounting deadlines brief',
    description:
      'Every week: deadlines coming up, client documents still outstanding, work waiting for review, and what needs a partner.',
    cadence: 'weekly',
    defaultTime: '07:00',
    defaultWeekday: 1,
    defaultOwnerRole: 'operations_analyst',
    maxWords: 250,
    periodDays: 7,
    requirements: [
      'Write the weekly deadlines brief for the accounting firm in plain language, as a short read-only digest. Use only what the Context holds. Use these headings:',
      '- Deadlines in the next 14 days',
      '- Client documents still outstanding',
      '- Work waiting for review or sign-off',
      '- What needs a partner',
      'List dates as found; do not calculate or confirm deadlines. Process guidance, not legal/tax advice.',
    ].join('\n'),
  },
  law_matter_dates_brief: {
    key: 'law_matter_dates_brief',
    industry: 'law',
    version: 1,
    name: 'Matter dates brief',
    description:
      'Every week: matter dates coming up, matters waiting on the client, work waiting for partner review, and what needs a partner.',
    cadence: 'weekly',
    defaultTime: '07:00',
    defaultWeekday: 1,
    defaultOwnerRole: 'operations_analyst',
    maxWords: 250,
    periodDays: 7,
    requirements: [
      'Write the weekly matter dates brief for the law firm in plain language, as a short read-only digest. Use only what the Context holds. Use these headings:',
      '- Dates in the next 14 days (each to be verified by the fee-earner)',
      '- Matters waiting on the client',
      '- Work waiting for partner review',
      '- What needs a partner',
      'List dates as found; do not calculate or confirm deadlines. Process guidance, not legal/tax advice.',
    ].join('\n'),
  },
};

export const BRIEF_PLAYBOOK_KEYS = Object.keys(BRIEF_PLAYBOOKS) as BriefPlaybookKey[];
export const isBriefPlaybookKey = (k: string): k is BriefPlaybookKey => k in BRIEF_PLAYBOOKS;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Cron for a playbook: working days (1-5) or one weekday. */
export function briefPlaybookCron(p: BriefPlaybook, time: string, weekday?: number): string {
  const [h = '7', m = '0'] = time.split(':');
  const dow = p.cadence === 'workdays' ? '1-5' : String(weekday ?? p.defaultWeekday ?? 1);
  return `${Number(m)} ${Number(h)} * * ${dow}`;
}

/** The card each run starts: a report card on the owner role's Brief workflow. */
export function briefPlaybookTemplate(p: BriefPlaybook, ownerRole: string, maxWords?: number): CardTemplate {
  return {
    title: `${p.name} {date}`,
    cardType: 'report',
    workflowKey: briefWorkflowKey(ownerRole),
    fields: { requirements: p.requirements, maxWords: maxWords ?? p.maxWords },
    start: 'queued',
  };
}

export const InstallBriefPlaybookRequestSchema = z.object({
  /** Only needed when the organization has more than one project. */
  projectId: z.uuid().optional(),
  time: z.string().regex(TIME).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  /** Default: the organization's time zone. */
  timezone: z.string().min(1).max(60).optional(),
  ownerRole: z.enum(BRIEF_OWNER_ROLES).optional(),
  maxWords: z.number().int().min(30).max(1000).optional(),
  destinations: z.array(OutputDestinationSchema).min(1).max(5),
});
export type InstallBriefPlaybookRequest = z.infer<typeof InstallBriefPlaybookRequestSchema>;

export const PatchBriefPlaybookRequestSchema = InstallBriefPlaybookRequestSchema.omit({ projectId: true })
  .partial()
  .extend({ enabled: z.boolean().optional() });
export type PatchBriefPlaybookRequest = z.infer<typeof PatchBriefPlaybookRequestSchema>;

export const BriefPlaybookDtoSchema = z.object({
  key: BriefPlaybookKey,
  name: z.string(),
  description: z.string(),
  cadence: z.enum(['workdays', 'weekly']),
  defaultTime: z.string(),
  defaultWeekday: z.number().nullable(),
  defaultOwnerRole: z.string(),
  maxWords: z.number(),
  /** The schedule when installed, else null. */
  scheduleId: z.string().nullable(),
  /** The industry of a bundle playbook, else null. */
  industry: z.enum(['real_estate', 'accounting', 'law']).nullable().optional(),
});
export type BriefPlaybookDto = z.infer<typeof BriefPlaybookDtoSchema>;
