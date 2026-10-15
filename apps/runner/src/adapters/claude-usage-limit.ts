import { execa } from 'execa';

/**
 * The Claude subscription's usage limit (backlog #73): detecting that it was hit ("You've hit your session limit · resets
 * 6pm (Africa/Johannesburg)"), working out when it resets, keeping the runtime paused until then, and probing cheaply
 * whether work can resume. Mirrors claude-auth.ts for the login.
 */

// -------------------------------------------------------------------------------------------- detection

const LIMIT_PATTERNS: RegExp[] = [
  // "You've hit your session limit", "You've hit your weekly limit", "You've hit your Opus limit"
  /\byou(?:'|’)?ve (?:hit|reached) (?:your|the) (?:[\w-]+ ){0,2}limit/i,
  // "5-hour limit reached ∙ resets 3am"
  /\b\d+-(?:hour|day) limit reached/i,
  // "Claude AI usage limit reached|1760000000", "usage limit reached|resets 3pm", "Weekly limit reached"
  /\b(?:usage|session|weekly|daily|monthly|opus) limit (?:reached|hit|exceeded)/i,
  /\blimit reached\b.{0,10}\bresets?\b/i,
  // "You're out of extra usage · resets 3pm"
  /\bout of (?:extra )?usage\b/i,
];

/** Does this text (a result, an error line, a stderr tail) say that the subscription's usage limit was hit? */
export function isUsageLimitText(text: string | undefined | null): boolean {
  if (!text) return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The zone of this machine. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const validZone = (z: string | undefined): string | undefined => {
  if (!z) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return undefined;
  }
};

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

/** The wall-clock parts of an instant in a zone. */
function wallIn(ms: number, zone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') % 24, min: g('minute') };
}

/** The instant at which a zone's wall clock shows y-m-d h:min. */
function instantOf(w: Wall, zone: string): number {
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const seen = wallIn(guess, zone);
    const offset = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min) - guess;
    guess = asUtc - offset;
  }
  return guess;
}

export interface UsageLimitHit {
  /** When the limit resets. */
  until: Date;
  /** The reset time was read from the text (false: assumed, so a probe will re-check). */
  parsed: boolean;
}

/** An unreadable reset time: probe again in an hour. */
export const FALLBACK_LIMIT_MS = 3_600_000;
/** Weekly limits are the longest there are; a reset further away than this is a misread. */
const MAX_LIMIT_MS = 8 * 86_400_000;

const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const RESET_RE = new RegExp(
  `\\bresets?\\s+(?:at\\s+)?(?:(?:on\\s+)?(?:${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}),?\\s*(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?(?:\\s*\\(([^)]+)\\))?`,
  'i',
);

/**
 * The reset time in a limit message. Forms: `resets 6pm (Africa/Johannesburg)` (that zone), `resets 3am` and
 * `resets 18:30` (the runner's zone), `resets Oct 20, 9am`, `resets Oct 20 at 9:30am (UTC)`, and the epoch form
 * `usage limit reached|1760000000` (seconds or milliseconds). The next such moment after `now` wins.
 */
export function parseResetTime(
  text: string,
  now: Date = new Date(),
  tz: string = localZone(),
): Date | undefined {
  const epoch = /limit reached\s*\|\s*(\d{10,13})\b/i.exec(text);
  if (epoch?.[1]) {
    const n = Number(epoch[1]);
    const ms = epoch[1].length >= 13 ? n : n * 1000;
    return ms > now.getTime() && ms - now.getTime() <= MAX_LIMIT_MS ? new Date(ms) : undefined;
  }
  const m = RESET_RE.exec(text);
  if (!m) return undefined;
  const monName = (m[1] ?? m[4])?.toLowerCase();
  const day = m[2] ?? m[3];
  let hour = Number(m[5]);
  const minute = m[6] ? Number(m[6]) : 0;
  const mer = m[7]?.toLowerCase();
  if (!mer && !m[6]) return undefined; // a bare number is not a time
  if (mer) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (mer === 'pm' ? 12 : 0);
  } else if (hour > 23) return undefined;
  if (minute > 59) return undefined;
  const zone = validZone(m[8]?.trim()) ?? validZone(tz) ?? 'UTC';
  const today = wallIn(now.getTime(), zone);
  let at: number;
  if (monName && day) {
    const month = MONTHS.indexOf(monName) + 1;
    at = instantOf({ y: today.y, m: month, d: Number(day), h: hour, min: minute }, zone);
    if (at <= now.getTime())
      at = instantOf({ y: today.y + 1, m: month, d: Number(day), h: hour, min: minute }, zone);
  } else {
    at = instantOf({ ...today, h: hour, min: minute }, zone);
    if (at <= now.getTime()) {
      const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
      at = instantOf(
        { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate(), h: hour, min: minute },
        zone,
      );
    }
  }
  if (at <= now.getTime() || at - now.getTime() > MAX_LIMIT_MS) return undefined;
  return new Date(at);
}

/** The usage limit this text reports, with its reset time (an hour from now when none can be read); undefined: not a limit. */
export function detectUsageLimit(
  text: string | undefined | null,
  now: Date = new Date(),
  tz: string = localZone(),
): UsageLimitHit | undefined {
  if (!text || !isUsageLimitText(text)) return undefined;
  const until = parseResetTime(text, now, tz);
  return until
    ? { until, parsed: true }
    : { until: new Date(now.getTime() + FALLBACK_LIMIT_MS), parsed: false };
}

/** A reset time as the owner reads it: `18:00 (Africa/Johannesburg)`, with the date when it is not today. */
export function formatLimitTime(until: Date, now: Date = new Date(), tz: string = localZone()): string {
  const zone = validZone(tz) ?? 'UTC';
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(until);
  const a = wallIn(until.getTime(), zone);
  const b = wallIn(now.getTime(), zone);
  const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
  const day = sameDay
    ? ''
    : `${new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(until)} `;
  return `${day}${hm} (${zone})`;
}

// -------------------------------------------------------------------------------------------- state

export type ClaudeUsageState = 'ok' | 'limited';

/** The subscription's usage state on this runner: `limited` pauses the runtime until `limitedUntil`. */
export class ClaudeUsageMonitor {
  private current: ClaudeUsageState = 'ok';
  private until: Date | undefined;
  private listeners: Array<(s: ClaudeUsageState) => void> = [];

  get state(): ClaudeUsageState {
    return this.current;
  }

  /** When the limit resets (ISO); undefined while not limited. */
  get limitedUntil(): string | undefined {
    return this.until?.toISOString();
  }

  get limitedUntilMs(): number | undefined {
    return this.until?.getTime();
  }

  onChange(fn: (s: ClaudeUsageState) => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.current);
      } catch {
        // a listener never breaks the monitor
      }
    }
  }

  /** Pauses until `until` (a later hit moves the time). Returns true when the state or the time changed. */
  markLimited(until: Date): boolean {
    const changed = this.current !== 'limited' || this.until?.getTime() !== until.getTime();
    this.current = 'limited';
    this.until = until;
    if (changed) this.emit();
    return changed;
  }

  markOk(): boolean {
    if (this.current === 'ok') return false;
    this.current = 'ok';
    this.until = undefined;
    this.emit();
    return true;
  }
}

// -------------------------------------------------------------------------------------------- probe

export type UsageProbeResult =
  | { state: 'ok' }
  | { state: 'limited'; hit: UsageLimitHit }
  | { state: 'unknown' };

export interface UsageProbeOpts {
  bin: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  tz?: string;
  /** A seam for tests: runs a command and returns what it printed. */
  run?: (
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const defaultRun: NonNullable<UsageProbeOpts['run']> = async (bin, args, env) => {
  const r = await execa(bin, args, {
    env,
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    timeout: 120_000,
  });
  return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

/**
 * `claude auth status` shows no limits, so the probe is one minimal call (one turn, the smallest model). A limit
 * message in its output re-parses the reset time (the pause is extended); a clean answer means work can resume.
 * Anything else (network, missing binary) is 'unknown' and leaves the state as it is.
 */
export async function probeClaudeUsage(opts: UsageProbeOpts): Promise<UsageProbeResult> {
  const run = opts.run ?? defaultRun;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  try {
    const r = await run(
      opts.bin,
      ['-p', 'Reply with: ok', '--max-turns', '1', '--output-format', 'json', '--model', 'haiku'],
      env,
    );
    const out = `${r.stdout}\n${r.stderr}`;
    const hit = detectUsageLimit(out, now(), opts.tz);
    if (hit) return { state: 'limited', hit };
    if (r.exitCode !== 0) return { state: 'unknown' };
    try {
      const j = JSON.parse(r.stdout) as { is_error?: unknown };
      if (j.is_error === true) return { state: 'unknown' };
    } catch {
      // plain text answer: exit 0 is enough
    }
    return { state: 'ok' };
  } catch {
    return { state: 'unknown' };
  }
}
