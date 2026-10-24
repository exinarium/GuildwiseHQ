import {
  type BoardConfig,
  type DiscoveryConfig,
  discoveryElapsedMs,
  SESSION_TIME_TICK_MAX_MS,
  type SessionTimeDto,
} from '@aom/shared';

/**
 * Whether a boardroom's clock runs: a round or the Chair is working, or the room waits for the creator's answer to a
 * decision (Q51: the clock keeps running while waiting on the creator, as in Discovery). It stops when paused, at the
 * time-up choice, while the minutes are written and when archived.
 */
export const boardClockRuns = (cfg: Pick<BoardConfig, 'stage' | 'paused' | 'timeUp' | 'archived'>): boolean =>
  (cfg.stage === 'round' || cfg.stage === 'chair' || cfg.stage === 'decision') &&
  !cfg.paused &&
  !cfg.timeUp &&
  !cfg.archived;

/** The boardroom's time as the page shows it at `now` (the stored time plus the part since the last tick, capped). */
export function boardTime(cfg: BoardConfig, now: Date): SessionTimeDto {
  const running = boardClockRuns(cfg);
  const gap = cfg.tickAt ? Math.max(0, now.getTime() - new Date(cfg.tickAt).getTime()) : 0;
  return {
    limitMinutes: cfg.timeLimitMinutes,
    elapsedMs: cfg.elapsedMs + (running ? Math.min(gap, SESSION_TIME_TICK_MAX_MS) : 0),
    running: running && !!cfg.timeLimitMinutes,
    asOf: now.toISOString(),
    warned: cfg.timeWarned,
    up: cfg.timeUp,
  };
}

/** Discovery runs its clock whenever it is not paused (the existing `elapsedMs` / `activeSince` pair). */
export function discoveryTime(cfg: DiscoveryConfig, now: Date): SessionTimeDto {
  return {
    limitMinutes: cfg.timeBoxMinutes,
    elapsedMs: discoveryElapsedMs(cfg, now),
    running: !cfg.paused && !!cfg.activeSince && !cfg.timeUp && !cfg.archived,
    asOf: now.toISOString(),
    warned: cfg.timeWarned,
    up: cfg.timeUp,
  };
}
