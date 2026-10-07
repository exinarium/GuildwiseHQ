import type { BaTaskShift } from '../phases/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import type { ReporterTaskKind, SignalBrief } from '../reporter/index.ts';
import { SIGNAL_LABEL } from '../reporter/index.ts';
import { commandForOutcome } from './commands.ts';

const TITLE: Record<ReporterTaskKind, string> = {
  desk_triage: 'Held items: decide what reaches the manager',
  urgent_note: 'Urgent items on the desk: add context',
  floor_alert: 'Urgent signals: report them to the manager',
  floor_report: 'Daily floor report',
  scheduled_brief: 'Scheduled task from the manager',
};

const JOB: Record<ReporterTaskKind, string[]> = {
  desk_triage: [
    'These desk items were raised while you were reachable, so they are held for you instead of going straight to the manager.',
    'For each one decide: pass (the manager should see it; add a note with context or a recommendation), dismiss (noise, or already covered; say why) or merge (fold it into another open item you name with `into`).',
    'You may search the ledger first (`aom ledger search "<query>"`): when the ledger already answers an item, dismiss it and quote the entry.',
    'Items you do not decide reach the manager unchanged, and so does everything when the time below runs out. Never merge or dismiss anything that needs a decision only the manager can make.',
  ],
  urgent_note: [
    'These items already reached the manager (urgent blocking questions and approvals are never delayed). Add what helps the manager decide: how often this was asked, what the ledger says, what the other open items have in common, your recommendation.',
    'Only write a note when you have something to add. Name related open items with `related`.',
  ],
  floor_alert: [
    'These signals were detected by the server and are urgent (they cost money or time while they continue). Analyse each: what is happening, the evidence, and a recommendation with the concrete action available to the manager (stop or release the card, grant access, hire an agent).',
    'When a signal already has a desk item (`item` below, for example the loop breaker alert) give its id as `annotateItemId` and your analysis becomes the note on that item; otherwise your analysis becomes a new item.',
  ],
  floor_report: [
    'Write the manager\'s daily floor report from the facts below. Use these headings, in this order, and say "none" under an empty one:',
    '1. Phases waiting or open (and which are held open by late bugs)',
    '2. Stuck, blocked and backing-off cards',
    '3. Repeated approvals',
    '4. Failures',
    '5. DevOps requests that are open',
    '6. What you resolved yourself without bothering the manager',
    "Lead with what needs the manager's decision. Be brief: a manager reads this at 08:00. Do not invent facts; link nothing you were not given.",
  ],
  scheduled_brief: [
    'The manager set up a schedule that asks you for a report. Do what the instructions below ask, using only what you can read (the ledger, the desk, the vault, the repositories read-only) and what the facts say. Do not change anything.',
    'Answer with one report in markdown: lead with the answer, then the evidence. Say plainly what you could not find out. Do not invent facts.',
  ],
};

export function renderReporterInstructions(brief: ShiftBrief, task: BaTaskShift): string {
  const kind = task.kind as ReporterTaskKind;
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA), reporting to the manager in the background: you are their eyes and ears on the floor. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  out.push('# Your job in this shift');
  out.push([`Task: ${TITLE[kind]}.`, ...JOB[kind]].join('\n'));
  out.push(
    'You are read-only. Never ask questions and never wait: anything the manager must decide goes into what you write.',
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      ...brief.shift.outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandForOutcome(o)}\``),
      '',
      'Write the file first (your scratch directory).',
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

function signalLine(s: SignalBrief): string {
  return `- signal ${s.id} [${s.urgency}] ${SIGNAL_LABEL[s.kind]}: ${s.subject.title}${s.subject.detail ? ` - ${s.subject.detail}` : ''}\n  seen ${s.count} time(s), first ${s.firstSeenAt}${s.subject.deskItemId ? `\n  item: ${s.subject.deskItemId}` : ''}${Object.keys(s.evidence).length ? `\n  evidence: ${JSON.stringify(s.evidence)}` : ''}`;
}

export function renderReporterPrompt(task: BaTaskShift): string {
  const kind = task.kind as ReporterTaskKind;
  const r = task.reporter;
  const out: string[] = [`# ${TITLE[kind]}`];
  if (!r) return `${out.join('\n\n')}\n\nNo data.\n`;
  if (kind === 'desk_triage' || kind === 'urgent_note') {
    out.push(
      kind === 'desk_triage'
        ? `You have ${r.triageWindowMinutes} minutes from when each item was raised; after that the manager sees it unchanged.`
        : "These are already on the manager's desk.",
    );
    out.push('## Items');
    out.push(
      r.items
        .map(
          (i) =>
            `- item ${i.id} [${i.kind}${i.subkind ? `/${i.subkind}` : ''}${i.blocking ? ', blocking' : ''}] ${i.title}\n  from ${i.askedBy}${i.projectKey ? `, project ${i.projectKey}` : ''}${i.cardRef ? `, card ${i.cardRef}` : ''}, raised ${i.createdAt}${i.held ? '' : ' (already on the desk)'}${i.body.trim() ? `\n  ${i.body.trim().replace(/\n/g, '\n  ')}` : ''}`,
        )
        .join('\n') || 'None.',
    );
    if (kind === 'desk_triage') {
      out.push('## Other open items you may merge into');
      out.push(r.openItems.map((i) => `- ${i.id}: ${i.title}`).join('\n') || 'None.');
    }
  }
  if (kind === 'scheduled_brief' && r.brief) {
    out.push(
      `Schedule: ${r.brief.scheduleName}${r.brief.projectKey ? ` (project ${r.brief.projectKey})` : ''}.`,
    );
    out.push('## Instructions');
    out.push(r.brief.instructions);
  }
  if (kind === 'floor_alert') {
    out.push('## Signals');
    out.push(r.signals.map(signalLine).join('\n') || 'None.');
  }
  if (kind === 'floor_report' && r.digest) {
    const d = r.digest;
    out.push(`Report for ${d.localDate}${d.since ? `, since ${d.since}` : ''}.`);
    out.push('## Phases');
    out.push(
      d.phases
        .map(
          (p) =>
            `- ${p.ref} ${p.name} (${p.projectKey}): ${p.status}${p.lateBugs.length ? `; held open by late bugs ${p.lateBugs.join(', ')}` : ''}`,
        )
        .join('\n') || 'None.',
    );
    out.push('## Signals');
    out.push(
      d.signals
        .map((s) => `${signalLine(s)}${s.isNew ? '\n  (new since the last report)' : ''}`)
        .join('\n') || 'None.',
    );
    out.push('## Backing off');
    out.push(
      d.backingOff
        .map((b) => `- ${b.ref} ${b.title}: ${b.failures} failed shifts, held until ${b.until}`)
        .join('\n') || 'None.',
    );
    out.push('## Failures');
    out.push(
      d.failures.map((f) => `- ${f.ref} ${f.title}: ${f.failedShifts} failed shifts`).join('\n') || 'None.',
    );
    out.push('## Open DevOps requests');
    out.push(
      d.devopsOpen.map((x) => `- ${x.summary} on ${x.workstation}: ${x.status}`).join('\n') || 'None.',
    );
    out.push('## Resolved without the manager');
    out.push(
      d.resolvedByBa.map((x) => `- ${x.title}: ${x.how}${x.note ? ` (${x.note})` : ''}`).join('\n') ||
        'None.',
    );
  }
  return `${out.join('\n\n')}\n`;
}
