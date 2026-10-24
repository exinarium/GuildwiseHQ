import { z } from 'zod';

/**
 * The time limit of a Discovery or Boardroom session, like a meeting (docs/ARCHITECTURE.md section 38.7): optional,
 * visible as a countdown, a warning with five minutes left, and a choice for the creator when it runs out. Paused time
 * does not count. Pure helpers shared by the server (the sweep) and the pages (the countdown).
 */
export const SESSION_TIME_MIN = 5;
export const SESSION_TIME_MAX = 8 * 60;
/** The warning comes this many minutes before the end (less for a short limit: a third of it). */
export const SESSION_TIME_WARN_MINUTES = 5;
export const SESSION_TIME_EXTEND_CHOICES = [10, 15, 30] as const;
/**
 * The most time one clock tick counts. The sweep ticks every 15 s; a longer gap means the server was down, and a restart
 * does not eat the meeting.
 */
export const SESSION_TIME_TICK_MAX_MS = 60_000;

export const SessionTimeLimitSchema = z.number().int().min(SESSION_TIME_MIN).max(SESSION_TIME_MAX);

/** What the pages show: the limit, the time used at `asOf`, and whether the clock is running. */
export const SessionTimeSchema = z.object({
  limitMinutes: z.number().int().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  running: z.boolean(),
  asOf: z.iso.datetime(),
  /** The five-minute warning was given. */
  warned: z.boolean(),
  /** The time is up: nothing new starts until the creator extends or wraps up. */
  up: z.boolean(),
});
export type SessionTimeDto = z.infer<typeof SessionTimeSchema>;

export const SessionTimeActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('extend'),
    minutes: z.union([z.literal(10), z.literal(15), z.literal(30)]),
  }),
  z.object({ action: z.literal('wrap_up') }),
]);
export type SessionTimeAction = z.infer<typeof SessionTimeActionSchema>;

/** Minutes before the end at which the warning is given for this limit. */
export const warnMinutesFor = (limitMinutes: number): number =>
  Math.max(1, Math.min(SESSION_TIME_WARN_MINUTES, Math.floor(limitMinutes / 3)));

export interface SessionClock {
  elapsedMs: number;
  /** When the clock last ticked (ISO); null: not ticking yet. */
  tickAt: string | null;
}

/** The clock after a tick at `now`: running time since the last tick is added (capped), paused time is not. Pure. */
export function tickClock(c: SessionClock, now: Date, running: boolean): SessionClock {
  const gap = c.tickAt ? Math.max(0, now.getTime() - new Date(c.tickAt).getTime()) : 0;
  return {
    elapsedMs: c.elapsedMs + (running ? Math.min(gap, SESSION_TIME_TICK_MAX_MS) : 0),
    tickAt: now.toISOString(),
  };
}

export interface TimeStatus {
  remainingMs: number;
  /** In the warning window and not over. */
  warn: boolean;
  over: boolean;
}

export function timeStatus(limitMinutes: number | null, elapsedMs: number): TimeStatus | null {
  if (!limitMinutes) return null;
  const remainingMs = limitMinutes * 60_000 - elapsedMs;
  return {
    remainingMs: Math.max(0, remainingMs),
    warn: remainingMs > 0 && remainingMs <= warnMinutesFor(limitMinutes) * 60_000,
    over: remainingMs <= 0,
  };
}

/** The new limit after "Extend +N": N minutes from now, so an overshoot is not eaten by the extension. */
export const extendedLimitMinutes = (elapsedMs: number, minutes: number): number =>
  Math.min(SESSION_TIME_MAX + SESSION_TIME_EXTEND_CHOICES[2], Math.ceil(elapsedMs / 60_000) + minutes);

/** "12:05" / "1:02:10" for a countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
