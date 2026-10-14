import { brandedMail, esc, type MailBlock } from './layout.ts';
import type { MailMessage } from './mailer.ts';

/** The Monday briefing (backlog #38): a short version for members and a longer one for Owners and Admins. */

export interface BriefingItem {
  title: string;
  detail?: string;
  /** App path the item opens (relative to the origin). */
  path?: string;
}

export interface BriefingData {
  orgName: string;
  manager: boolean;
  /** `2026-W42`. */
  week: string;
  /** Local date of the Monday, `2026-10-12`. */
  mondayLabel: string;
  done: { count: number; items: BriefingItem[] };
  waiting: { count: number; qa: number; approvals: number; items: BriefingItem[] };
  blocked: { count: number; items: BriefingItem[] };
  /** Claude login expired, an MCP server needs a sign-in, agents that fail often. */
  health: BriefingItem[];
  /** Managers only. */
  spend?: { total: string; lines: Array<[label: string, value: string]> } | undefined;
  /** Managers only: "This month so far: ..." and the trend sentence. */
  value?: { headline: string; trend: string } | undefined;
  /** Managers only: per project, one line each. */
  projects?: Array<[label: string, value: string]> | undefined;
  nextActions?: BriefingItem[] | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** True when there is nothing worth a mail. */
export function briefingIsEmpty(d: BriefingData): boolean {
  return (
    d.done.count === 0 &&
    d.waiting.count === 0 &&
    d.blocked.count === 0 &&
    d.health.length === 0 &&
    (d.spend?.total ?? '') === '' &&
    (d.nextActions?.length ?? 0) === 0
  );
}

export function briefingSubject(d: BriefingData): string {
  const bits = [`${plural(d.done.count, 'card')} done`];
  if (d.waiting.count > 0) bits.push(`${d.waiting.count} waiting on you`);
  if (d.blocked.count > 0) bits.push(`${d.blocked.count} blocked`);
  return `${d.orgName}: ${bits.join(', ')}`;
}

function list(items: BriefingItem[], total: number): MailBlock {
  const shown = items.map((i) => `${i.title}${i.detail ? ` (${i.detail})` : ''}`);
  if (total > items.length) shown.push(`and ${total - items.length} more`);
  return { list: shown };
}

const heading = (t: string): MailBlock => ({
  html: `<strong>${esc(t)}</strong>`,
  text: t.toUpperCase(),
});

export function briefingMail(opts: {
  to: string;
  name: string;
  origin: string;
  data: BriefingData;
  unsubscribeUrl: string;
}): MailMessage {
  const { data: d, origin } = opts;
  const body: MailBlock[] = [
    `Hello ${opts.name || 'there'}, here is your week in ${d.orgName} (week of ${d.mondayLabel}).`,
  ];
  body.push(heading(`Done this week: ${d.done.count}`));
  body.push(d.done.count > 0 ? list(d.done.items, d.done.count) : 'No cards were finished this week.');
  if (d.waiting.count > 0) {
    const parts = [];
    if (d.waiting.qa > 0) parts.push(`${plural(d.waiting.qa, 'test', 'tests')} to do (manual QA)`);
    if (d.waiting.approvals > 0) parts.push(plural(d.waiting.approvals, 'approval'));
    body.push(heading(`Waiting on you: ${d.waiting.count}${parts.length ? ` (${parts.join(', ')})` : ''}`));
    body.push(list(d.waiting.items, d.waiting.count));
  }
  if (d.blocked.count > 0) {
    body.push(heading(`Blocked: ${d.blocked.count}`));
    body.push(list(d.blocked.items, d.blocked.count));
  }
  if (d.health.length > 0) {
    body.push(heading('Agents and workstations'));
    body.push({ list: d.health.map((h) => (h.detail ? `${h.title}: ${h.detail}` : h.title)) });
  }
  if (d.manager) {
    if (d.value) {
      body.push(heading('Value so far this month'));
      body.push(d.value.headline);
      body.push({ small: d.value.trend });
    }
    if (d.spend) {
      body.push(heading(`Spend this month: ${d.spend.total}`));
      if (d.spend.lines.length > 0) body.push({ facts: d.spend.lines });
    }
    if (d.projects && d.projects.length > 0) {
      body.push(heading('By project'));
      body.push({ facts: d.projects });
    }
    if (d.nextActions && d.nextActions.length > 0) {
      body.push(heading('Next best actions'));
      body.push({ list: d.nextActions.map((a) => `${a.title}: ${a.detail ?? ''}`.trim()) });
    }
  }
  body.push({
    small:
      'You get this briefing every Monday for each organization you belong to. Hours are estimates of what a person would have needed, not measurements.',
  });
  return brandedMail({
    to: opts.to,
    subject: briefingSubject(d),
    preheader:
      d.waiting.count > 0
        ? `${plural(d.waiting.count, 'item')} waiting on you`
        : `${plural(d.done.count, 'card')} done this week`,
    heading: 'Your Monday briefing',
    origin,
    body,
    cta: {
      label: d.waiting.count > 0 ? 'Open your desk' : 'Open Guildwise HQ',
      url: `${origin}/${d.waiting.count > 0 ? 'desk' : ''}`,
    },
    note: `Do not want this mail? Switch it off in your profile settings: ${opts.unsubscribeUrl}`,
  });
}
