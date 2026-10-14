import { z } from 'zod';
import { formatMoney } from '../costs/index.ts';
import { LOOP_BREAKER } from '../testing/index.ts';

/**
 * Part B of docs/design/phases.md: the BA as the manager's reporter. Contract shared by the server, the runner and
 * the web app: thresholds, signal kinds, routing preferences, the data of the BA's reporter tasks and the template
 * texts the server posts when no BA is available.
 */

// --------------------------------------------------------------------------------------------- thresholds

/** Owner decision B1 and friends: every number the detectors and the routing use, in one place. */
export const REPORTER = {
  /** A card whose shifts failed this often in this window is looping (the loop breaker's own numbers). */
  loop: { failures: LOOP_BREAKER.failures, windowMinutes: LOOP_BREAKER.windowMinutes },
  /** The same DevOps or approval action asked this many times in the window. */
  repeatedApproval: { count: 3, windowHours: 24, similarity: 0.6 },
  /** A blocked card waits on the manager longer than this. */
  blockedHours: 4,
  /** A queued card nobody is able to take for longer than this. */
  unclaimedMinutes: 30,
  /** Repeated failures (normal urgency): rework rounds on one card, failed finalizes on one card. */
  reworkRounds: 3,
  finalizeFailures: 2,
  /** A held item the BA has not triaged within this window reaches the manager unchanged. */
  triageWindowMinutes: 10,
  /** The detectors and the report timer run this often. */
  sweepSeconds: 60,
  /** The daily floor report, local time of the manager (owner decision B4: no quiet hours). */
  defaultDailyAt: '08:00',
} as const;

export const REPORT_DESK_SUBKIND = {
  /** One urgent or notable signal, analysed by the BA (or a template when no BA is available). */
  baReport: 'ba_report',
  /** The daily floor report. */
  floorReport: 'floor_report',
} as const;
export const isReporterDeskSubkind = (s: string | null | undefined): boolean =>
  s === REPORT_DESK_SUBKIND.baReport || s === REPORT_DESK_SUBKIND.floorReport;

/** Subkinds the routing never holds or annotates: the BA's own output and the phase items. */
export const ROUTING_EXEMPT_SUBKINDS: readonly string[] = [
  REPORT_DESK_SUBKIND.baReport,
  REPORT_DESK_SUBKIND.floorReport,
  'phase_proposal',
  'phase_done',
  'phase_results',
  'unmapped_ticket',
  'batch_question',
  /** The CEO's own output: its daily report, its recommendations and its notifications are never held or noted. */
  'ceo_report',
  'ceo_recommendation',
  'ceo_notice',
];

// ----------------------------------------------------------------------------------------------- prefs

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time of day as HH:MM');

/** Organization setting (stored on the owner). `routeViaBa` defaults to on. */
export const ReportingPrefsSchema = z.object({
  /** Route every agent-raised desk item through the BA first (owner decision B2/B3). */
  routeViaBa: z.boolean(),
  /** Local time of the daily floor report. */
  dailyAt: HHMM,
  /**
   * The quiet cap (docs/design/restructure.md): at most this many interest digest items reach the desk per day across all
   * interests of the organization; the rest wait for the next delivery. Null: no cap.
   */
  interestDigestCap: z.number().int().min(1).max(1000).nullable().default(null),
});
export type ReportingPrefs = z.infer<typeof ReportingPrefsSchema>;
export const DEFAULT_REPORTING: ReportingPrefs = {
  routeViaBa: true,
  dailyAt: REPORTER.defaultDailyAt,
  interestDigestCap: null,
};

export const UpdateReportingRequestSchema = z
  .object({
    routeViaBa: z.boolean().optional(),
    dailyAt: HHMM.optional(),
    interestDigestCap: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine((v) => v.routeViaBa !== undefined || v.dailyAt !== undefined || v.interestDigestCap !== undefined, {
    message: 'nothing to change',
  });
export type UpdateReportingRequest = z.infer<typeof UpdateReportingRequestSchema>;

/** `GET /api/reporting`. `timezone` is the manager's own setting; reports use UTC while it is unset. */
export const ReportingResponseSchema = ReportingPrefsSchema.extend({
  timezone: z.string().nullable(),
  /** The zone the daily report actually uses (`timezone`, or UTC). */
  effectiveTimezone: z.string(),
  /** Org owner only. */
  canEdit: z.boolean(),
});
export type ReportingResponse = z.infer<typeof ReportingResponseSchema>;

export const UpdateTimezoneRequestSchema = z.object({ timezone: z.string().min(1).max(64) });
export type UpdateTimezoneRequest = z.infer<typeof UpdateTimezoneRequestSchema>;

// ------------------------------------------------------------------------------------- time zone maths

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The date (`YYYY-MM-DD`) and minutes since midnight at `date` in `timeZone` (UTC when the zone is unknown). */
export function localParts(
  date: Date,
  timeZone: string | null | undefined,
): { date: string; minutes: number } {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export const hhmmToMinutes = (s: string): number => {
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * Is the day's floor report due? Once the local clock passes `dailyAt` and none was queued for this local date (a server
 * that was down at 08:00 reports when it is back). An organization created after today's `dailyAt` waits for tomorrow's,
 * so a brand-new org is not reported on at 14:00 because its first card failed.
 */
export function floorReportDue(
  now: Date,
  timeZone: string | null | undefined,
  dailyAt: string,
  lastLocalDate: string | null | undefined,
  orgCreatedAt?: Date | null,
): { due: boolean; localDate: string } {
  const lp = localParts(now, timeZone);
  const sinceBoundary = lp.minutes - hhmmToMinutes(dailyAt);
  if (sinceBoundary < 0 || lastLocalDate === lp.date) return { due: false, localDate: lp.date };
  const boundary = new Date(now.getTime() - sinceBoundary * 60_000);
  return { due: !orgCreatedAt || orgCreatedAt < boundary, localDate: lp.date };
}

// ---------------------------------------------------------------------------------------------- signals

export const SignalKind = z.enum([
  'loop',
  'repeated_approval',
  'blocked',
  'unclaimed',
  'rework',
  'finalize_failures',
  /** Repository hygiene could not resolve something (conflict, dirty tree on another branch, auth failure, ...). */
  'repo_hygiene',
  /** A project used 80% or more of its monthly budget (urgent once it is used up and paused). */
  'budget',
]);
export type SignalKind = z.infer<typeof SignalKind>;
export const SignalUrgency = z.enum(['urgent', 'normal']);
export type SignalUrgency = z.infer<typeof SignalUrgency>;
export const SignalStatus = z.enum(['open', 'reported', 'resolved']);
export type SignalStatus = z.infer<typeof SignalStatus>;

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  loop: 'Shift loop',
  repeated_approval: 'Repeated approval',
  blocked: 'Blocked card',
  unclaimed: 'Unclaimed card',
  rework: 'Repeated rework',
  finalize_failures: 'Repeated finalize failures',
  repo_hygiene: 'Repository hygiene',
  budget: 'Budget',
};

/** What a signal is about; free-form evidence the BA and the template read. */
export const SignalSubjectSchema = z.object({
  title: z.string(),
  detail: z.string().default(''),
  cardId: z.uuid().optional(),
  cardRef: z.string().optional(),
  projectKey: z.string().optional(),
  /** The desk item the signal is about when one exists already (the loop breaker's alert). */
  deskItemId: z.uuid().optional(),
  /** Repeated approvals: the desk items that asked. */
  deskItemIds: z.array(z.uuid()).optional(),
  wasRejected: z.boolean().optional(),
});
export type SignalSubject = z.infer<typeof SignalSubjectSchema>;

export const SignalBriefSchema = z.object({
  id: z.uuid(),
  kind: SignalKind,
  urgency: SignalUrgency,
  fingerprint: z.string(),
  count: z.number().int().nonnegative(),
  status: SignalStatus,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  subject: SignalSubjectSchema,
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type SignalBrief = z.infer<typeof SignalBriefSchema>;

// --------------------------------------------------------------------------------------- floor digest

/** Everything the daily floor report is built from. The BA writes the prose; the server supplies the facts. */
export const FloorDigestSchema = z.object({
  generatedAt: z.string(),
  localDate: z.string(),
  /** The previous report (null for the first). */
  since: z.string().nullable(),
  phases: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      status: z.string(),
      projectKey: z.string(),
      /** Open bug cards filed after the phase's work finished: they hold the phase open (A6). */
      lateBugs: z.array(z.string()).default([]),
    }),
  ),
  signals: z.array(SignalBriefSchema.extend({ isNew: z.boolean() })),
  /** Cards in the loop breaker's back-off right now. */
  backingOff: z.array(
    z.object({ ref: z.string(), title: z.string(), failures: z.number().int(), until: z.string() }),
  ),
  devopsOpen: z.array(
    z.object({ id: z.uuid(), summary: z.string(), status: z.string(), workstation: z.string() }),
  ),
  resolvedByBa: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      how: z.enum(['answered', 'dismissed', 'merged']),
      note: z.string().nullable(),
    }),
  ),
  /** Failed shifts and other failures since the last report, by card. */
  failures: z.array(z.object({ ref: z.string(), title: z.string(), failedShifts: z.number().int() })),
  /**
   * The organization's interests (docs/design/restructure.md decision 13): a count line, the top delivered items per
   * interest since the last report (only what a delivery put on the desk, within the quiet cap) and the interests that
   * cannot run.
   */
  interests: z
    .object({
      count: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      runs: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      unrated: z.number().int().nonnegative(),
      highlights: z.array(
        z.object({
          interest: z.string(),
          items: z.array(
            z.object({ title: z.string(), kind: z.string(), source: z.string(), url: z.string() }),
          ),
          more: z.number().int().nonnegative(),
        }),
      ),
      failing: z.array(
        z.object({ interest: z.string(), failCount: z.number().int(), error: z.string().nullable() }),
      ),
    })
    .default({ count: 0, active: 0, runs: 0, delivered: 0, unrated: 0, highlights: [], failing: [] }),
  /**
   * Spend (cost tracking): since the last report and this month, the projects that cost the most and the ones near or
   * over their budget. Money is in micro-units of the organization's currency.
   */
  spend: z
    .object({
      currency: z.string(),
      sinceMicros: z.number().int().nonnegative(),
      monthMicros: z.number().int().nonnegative(),
      overheadMonthMicros: z.number().int().nonnegative(),
      projects: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          monthMicros: z.number().int().nonnegative(),
          budgetMicros: z.number().int().nullable(),
          percent: z.number().nullable(),
          state: z.enum(['none', 'ok', 'warning', 'paused', 'overridden']),
        }),
      ),
    })
    .default({ currency: 'USD', sinceMicros: 0, monthMicros: 0, overheadMonthMicros: 0, projects: [] }),
});
export type FloorDigest = z.infer<typeof FloorDigestSchema>;

export const floorDigestIsEmpty = (d: FloorDigest): boolean =>
  d.phases.length === 0 &&
  d.signals.length === 0 &&
  d.backingOff.length === 0 &&
  d.devopsOpen.length === 0 &&
  d.resolvedByBa.length === 0 &&
  d.failures.length === 0 &&
  d.interests.highlights.length === 0 &&
  d.interests.failing.length === 0;
// (spend alone does not make a day worth a report: it rides along when there is one, and a project near or over its
// budget is a signal, which does.)

// ------------------------------------------------------------------------------------ BA reporter tasks

export const ReporterTaskKind = z.enum([
  'desk_triage',
  'urgent_note',
  'floor_alert',
  'floor_report',
  /** A schedule's `ba_task` action: free-text instructions from the manager, answered with one report. */
  'scheduled_brief',
]);
export type ReporterTaskKind = z.infer<typeof ReporterTaskKind>;
export const isReporterTaskKind = (k: string): k is ReporterTaskKind => ReporterTaskKind.safeParse(k).success;

export const REPORTER_OUTCOME = {
  triage: 'triage_done',
  notes: 'notes_done',
  signals: 'signal_report',
  floor: 'floor_report',
  brief: 'scheduled_brief',
} as const;

/** `desk_triage`: what to do with each held item. Items without a decision reach the manager unchanged. */
export const TriageDecisionSchema = z.object({
  itemId: z.uuid(),
  /** pass: the manager sees it (with the note); dismiss: noise or already covered; merge: fold into `into`. */
  action: z.enum(['pass', 'dismiss', 'merge']),
  note: z.string().max(4000).optional(),
  into: z.uuid().optional(),
});
export const TriageDataSchema = z.object({
  decisions: z.array(TriageDecisionSchema).min(1).max(100),
});
export type TriageData = z.infer<typeof TriageDataSchema>;

/** `urgent_note`: context added to items that already reached the manager. */
export const NotesDataSchema = z.object({
  notes: z
    .array(
      z.object({
        itemId: z.uuid(),
        note: z.string().min(1).max(4000),
        related: z.array(z.uuid()).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type NotesData = z.infer<typeof NotesDataSchema>;

/** `floor_alert`: the BA's analysis of each urgent signal. */
export const SignalReportsDataSchema = z.object({
  reports: z
    .array(
      z.object({
        signalId: z.uuid(),
        summary: z.string().min(1).max(20000),
        /** Put the analysis on this existing desk item (the loop breaker's alert) instead of a new one. */
        annotateItemId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type SignalReportsData = z.infer<typeof SignalReportsDataSchema>;

export const FloorReportDataSchema = z.object({ report: z.string().min(1).max(40000) });
export const ScheduledBriefDataSchema = z.object({ report: z.string().min(1).max(40000) });

export const ReporterItemBriefSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  subkind: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  projectKey: z.string().nullable(),
  cardRef: z.string().nullable(),
  blocking: z.boolean(),
  askedBy: z.string(),
  createdAt: z.string(),
  /** Still held (triage) or already on the manager's desk (note). */
  held: z.boolean(),
});
export type ReporterItemBrief = z.infer<typeof ReporterItemBriefSchema>;

/** The `baTask.reporter` block of a reporter task's `shift.start`. */
export const ReporterTaskSchema = z.object({
  items: z.array(ReporterItemBriefSchema).default([]),
  signals: z.array(SignalBriefSchema).default([]),
  digest: FloorDigestSchema.optional(),
  /** Open desk items of the same org the BA may fold held ones into (id, title). */
  openItems: z.array(z.object({ id: z.uuid(), title: z.string() })).default([]),
  /** How long the BA has before the held items reach the manager unchanged. */
  triageWindowMinutes: z.number().int().positive(),
  /** `scheduled_brief`: what the manager's schedule asks for. */
  brief: z
    .object({
      scheduleName: z.string(),
      instructions: z.string(),
      deliver: z.enum(['desk_notice', 'chat']),
      projectKey: z.string().nullable().optional(),
    })
    .optional(),
});
export type ReporterTask = z.infer<typeof ReporterTaskSchema>;

export function reporterBriefOutcomes(kind: ReporterTaskKind) {
  const o = (id: string, label: string, data: string) => ({ id, label, kind: 'success' as const, data });
  switch (kind) {
    case 'desk_triage':
      return [o(REPORTER_OUTCOME.triage, 'Decide what happens to each held item', 'triageDone')];
    case 'urgent_note':
      return [o(REPORTER_OUTCOME.notes, 'Add context to the items', 'notesDone')];
    case 'floor_alert':
      return [o(REPORTER_OUTCOME.signals, 'Report each urgent signal to the manager', 'signalReport')];
    case 'floor_report':
      return [o(REPORTER_OUTCOME.floor, 'Write the daily floor report', 'floorReport')];
    case 'scheduled_brief':
      return [o(REPORTER_OUTCOME.brief, 'Report on the scheduled task', 'scheduledBrief')];
  }
}

// ------------------------------------------------------------------------------------ template texts

/** The count line and the top items per interest of a floor report or an interests e-mail. */
export function renderInterestHighlights(i: FloorDigest['interests']): string[] {
  const lines = [
    `Interests: ${i.active} active of ${i.count}, ${i.runs} run${i.runs === 1 ? '' : 's'} since the last report, ${i.delivered} item${i.delivered === 1 ? '' : 's'} delivered, ${i.unrated} unrated`,
  ];
  for (const h of i.highlights) {
    lines.push(`- ${h.interest}`);
    for (const x of h.items) lines.push(`  - ${x.title} (${x.kind}, ${x.source}) ${x.url}`);
    if (h.more > 0) lines.push(`  - and ${h.more} more on the desk`);
  }
  return lines;
}

/** The spend section of a floor report: totals, then each project with its budget when it has one. */
export function renderSpendLines(sp: FloorDigest['spend']): string[] {
  const money = (v: number) => formatMoney(v, sp.currency);
  const lines = [
    `Since the last report ${money(sp.sinceMicros)}; this month ${money(sp.monthMicros)}${sp.overheadMonthMicros > 0 ? ` (org overhead ${money(sp.overheadMonthMicros)})` : ''}`,
  ];
  for (const p of sp.projects)
    lines.push(
      `- ${p.key} ${p.name}: ${money(p.monthMicros)}${
        p.budgetMicros === null
          ? ''
          : ` of ${money(p.budgetMicros)} (${Math.round(p.percent ?? 0)}%${p.state === 'paused' ? ', paused' : p.state === 'overridden' ? ', overridden' : ''})`
      }`,
    );
  return lines;
}

const list = (xs: string[]): string => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');

/** The daily floor report the server posts when no BA is available (and the base the BA starts from). */
export function renderFloorReportFallback(d: FloorDigest): string {
  const out: string[] = [`# Floor report ${d.localDate}`, ''];
  out.push('## Phases');
  out.push(
    list(
      d.phases.map(
        (p) =>
          `${p.ref} ${p.name}: ${p.status}${p.lateBugs.length ? `, held open by late bugs ${p.lateBugs.join(', ')}` : ''}`,
      ),
    ),
  );
  out.push('', '## Stuck, blocked and backing-off cards');
  out.push(
    list([
      ...d.signals
        .filter((s) => s.kind === 'blocked' || s.kind === 'unclaimed' || s.kind === 'loop')
        .map((s) => `${s.subject.title}${s.subject.detail ? ` (${s.subject.detail})` : ''}`),
      ...d.backingOff.map((b) => `${b.ref} ${b.title}: backing off after ${b.failures} failed shifts`),
    ]),
  );
  out.push('', '## Repeated approvals');
  out.push(
    list(
      d.signals
        .filter((s) => s.kind === 'repeated_approval')
        .map((s) => `${s.subject.title} (asked ${s.count} times)`),
    ),
  );
  out.push('', '## Failures');
  out.push(
    list([
      ...d.signals
        .filter((s) => s.kind === 'rework' || s.kind === 'finalize_failures' || s.kind === 'repo_hygiene')
        .map((s) => `${s.subject.title}${s.subject.detail ? ` (${s.subject.detail})` : ''}`),
      ...d.failures.map((f) => `${f.ref} ${f.title}: ${f.failedShifts} failed shifts`),
      ...d.interests.failing.map(
        (f) => `Interest ${f.interest} cannot run (${f.failCount} tries)${f.error ? `: ${f.error}` : ''}`,
      ),
    ]),
  );
  out.push('', '## Spend');
  out.push(...renderSpendLines(d.spend));
  out.push('', '## Interests highlights');
  out.push(...renderInterestHighlights(d.interests));
  out.push('', '## DevOps requests that are open');
  out.push(list(d.devopsOpen.map((r) => `${r.summary} on ${r.workstation}: ${r.status}`)));
  out.push('', '## Resolved by the BA without bothering you');
  out.push(list(d.resolvedByBa.map((r) => `${r.title} (${r.how}${r.note ? `: ${r.note}` : ''})`)));
  return `${out.join('\n')}\n`;
}

/** The urgent notice for a signal when no BA is available. */
export function renderSignalFallback(s: SignalBrief): string {
  return [
    `${SIGNAL_LABEL[s.kind]}: ${s.subject.title}`,
    '',
    s.subject.detail || 'The server detected this on its own.',
    '',
    `Seen ${s.count} time${s.count === 1 ? '' : 's'} since ${s.firstSeenAt}. No BA was available to analyse it, so this is the plain finding.`,
  ].join('\n');
}
