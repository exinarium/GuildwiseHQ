import { z } from 'zod';

/**
 * Delivery gates (docs/design/ceo-front-door.md section 9.3, with the Owner's decisions of section 14.2).
 *
 * A gate says what must be TRUE before an environment may be released: facts the server already has (an earlier
 * environment healthy on this commit, the regression run passed, the phase is done), a time window and a freeze switch.
 * WHO releases is not part of the gate: the recipe names the releaser per environment (`releasedBy`), so that the Owner's
 * approval of the recipe (a content hash) is also his decision about who may press the button.
 */

export const GATE_ENV_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const EnvNameSchema = z
  .string()
  .regex(GATE_ENV_NAME, 'an environment name is [a-z0-9-], 1-40 characters');

export const GateRequireSchema = z.union([
  /** An earlier environment runs this commit and its health check passed (for `forMinutes`, when given). */
  z.object({
    envHealthy: EnvNameSchema,
    sameCommit: z.literal(true).default(true),
    forMinutes: z.number().int().min(1).max(10080).optional(),
  }),
  /** The latest run of that kind for this commit passed. */
  z.object({
    checksPassed: z.enum(['regression', 'e2e', 'ci']),
    sameCommit: z.literal(true).default(true),
  }),
  /** The commit is the merge of a done phase. */
  z.object({ phaseDone: z.literal(true) }),
]);
export type GateRequire = z.infer<typeof GateRequireSchema>;

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** `mon-fri`, `mon,wed,fri` or `sat`. */
export const WINDOW_DAYS = /^(mon|tue|wed|thu|fri|sat|sun)((-|,)(mon|tue|wed|thu|fri|sat|sun))*$/;
/** `08-16` (from inclusive, to exclusive) in whole hours. */
export const WINDOW_HOURS = /^([01]?\d|2[0-3])-([01]?\d|2[0-4])$/;

export const GateWindowSchema = z.object({
  days: z.string().regex(WINDOW_DAYS, 'days look like mon-fri or mon,wed,fri'),
  hours: z.string().regex(WINDOW_HOURS, 'hours look like 08-16'),
  /** `org`: the organization's time zone when it has one, else UTC. */
  tz: z.enum(['org', 'utc']).default('org'),
});
export type GateWindow = z.infer<typeof GateWindowSchema>;

export const GateSchema = z.object({
  requires: z.array(GateRequireSchema).max(20).default([]),
  window: GateWindowSchema.optional(),
  /** A hard stop the Owner toggles: nothing is released while it is on. */
  freeze: z.boolean().optional(),
});
export type Gate = z.infer<typeof GateSchema>;

/** The gate of an environment that has none. */
export const NO_GATE: Gate = { requires: [] };

/** One fact a satisfied requirement rests on; `ref` is an id the audit can open (a run id, a test run id, a phase id). */
export interface GateEvidence {
  requirement: string;
  ref: string | null;
  detail: string;
}

export interface GateFacts {
  now: Date;
  /** The organization's IANA time zone, when it has one. */
  timezone?: string | null | undefined;
  /** The commit being released (null: not known yet; every `sameCommit` requirement then fails). */
  commit: string | null;
  /** Healthy runs per environment: succeeded, and the health check passed at `healthyAt`. */
  envRuns: Record<string, Array<{ id: string; commit: string | null; healthyAt: Date }>>;
  /** The latest finished check of each kind: `commit` null when the test run does not name one. */
  checks: Partial<Record<'regression' | 'e2e' | 'ci', { id: string; passedAt: Date; commit: string | null }>>;
  /** Merge commits of phases that are done. */
  phaseDoneCommits: Array<{ id: string; commit: string }>;
}

export interface GateVerdict {
  satisfied: boolean;
  missing: string[];
  evidence: GateEvidence[];
}

const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));

/** The weekday (0 = mon) and hour of `now` in `tz`. An unknown zone falls back to UTC. */
export function gateLocalParts(now: Date, tz: string | null | undefined): { day: number; hour: number } {
  let zone = tz ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const wd = (parts.find((p) => p.type === 'weekday')?.value ?? 'Mon').slice(0, 3).toLowerCase();
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return { day: Math.max(0, DAYS.indexOf(wd as (typeof DAYS)[number])), hour };
}

/** The days a `days` string names (`mon-fri` is a range, a comma list names each). */
export function windowDays(days: string): Set<number> {
  const out = new Set<number>();
  for (const part of days.split(',')) {
    const [a, b] = part.split('-') as [string, string | undefined];
    const from = DAYS.indexOf(a as (typeof DAYS)[number]);
    const to = b ? DAYS.indexOf(b as (typeof DAYS)[number]) : from;
    if (from < 0 || to < 0) continue;
    // a range that wraps the week (fri-mon) runs through the weekend
    for (let d = from; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === to) break;
    }
  }
  return out;
}

export function inWindow(w: GateWindow, now: Date, orgTimezone: string | null | undefined): boolean {
  const { day, hour } = gateLocalParts(now, w.tz === 'utc' ? 'UTC' : orgTimezone);
  if (!windowDays(w.days).has(day)) return false;
  const [from, to] = w.hours.split('-').map(Number) as [number, number];
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

export const describeRequire = (r: GateRequire): string =>
  'envHealthy' in r
    ? `${r.envHealthy} healthy on this commit${r.forMinutes ? ` for ${r.forMinutes} minutes` : ''}`
    : 'checksPassed' in r
      ? `${r.checksPassed} checks passed for this commit`
      : 'the commit is the merge of a done phase';

/**
 * Evaluates a gate over facts. Pure and deterministic: the same facts always give the same verdict, and the evidence names
 * the records the verdict rests on (the audit links to facts, not text).
 */
export function evaluateGate(gate: Gate, facts: GateFacts): GateVerdict {
  const missing: string[] = [];
  const evidence: GateEvidence[] = [];
  if (gate.freeze) missing.push('releases are frozen');
  if (gate.window && !inWindow(gate.window, facts.now, facts.timezone))
    missing.push(`outside the release window (${gate.window.days} ${gate.window.hours})`);
  for (const r of gate.requires) {
    const label = describeRequire(r);
    if ('envHealthy' in r) {
      const runs = (facts.envRuns[r.envHealthy] ?? []).filter((x) => sameCommit(x.commit, facts.commit));
      const need = r.forMinutes ? r.forMinutes * 60_000 : 0;
      const ok = runs.find((x) => facts.now.getTime() - x.healthyAt.getTime() >= need);
      if (ok)
        evidence.push({
          requirement: label,
          ref: ok.id,
          detail: `healthy since ${ok.healthyAt.toISOString()}`,
        });
      else if (runs.length > 0) missing.push(`${label}: not long enough yet`);
      else missing.push(label);
    } else if ('checksPassed' in r) {
      const c = facts.checks[r.checksPassed];
      // A test run that names no commit counts only when it is the latest one: the server passes `commit: null` for those.
      if (c && (c.commit === null ? !!facts.commit : sameCommit(c.commit, facts.commit)))
        evidence.push({ requirement: label, ref: c.id, detail: `passed at ${c.passedAt.toISOString()}` });
      else missing.push(label);
    } else {
      const p = facts.phaseDoneCommits.find((x) => sameCommit(x.commit, facts.commit));
      if (p) evidence.push({ requirement: label, ref: p.id, detail: `phase merge ${p.commit.slice(0, 10)}` });
      else missing.push(label);
    }
  }
  return { satisfied: missing.length === 0, missing, evidence };
}
